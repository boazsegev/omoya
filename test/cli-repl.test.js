// test/cli-repl.test.js — proof for the TUI REPL: one long-lived
// Agent in-process (context retained across turns, visible in the
// provider request bodies), streamed rendering on stdout, prompt +
// diagnostics on stderr, session persistence (default random UUID,
// --session 0/false anonymous, named + resume, command tombstones
// surviving ^C), /endpoint-model combo switching + last-used restore, SIGINT
// cancellation, and the --help contract matching the io/agent CLIs.
// Every executable name derives from bin-names.js — rename-safe.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach, beforeAll, afterAll } from "bun:test";
import { appAlias, binName, cli } from "./bin-names.js";
import { writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { findSessionFile } from "../lib/agent.js";

// The REPL persists state in the project root (last-model.json, and
// auth-ollama.json when a live models() refresh lands). Preserve the
// user's real state across this file's spawned processes.
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// spawned children get a THROWAWAY user settings folder PER TEST:
// last-model.json and auth-*.json now live under namespace settings, not
// the project root (SPAWN_SETTINGS is rebound per test below)
mkdirSync("./ai-tmp", { recursive: true });
// ABSOLUTE: spawned children have their own cwd — a relative settings dir
// would miss and drop the child into the user's real settings dir.
let SPAWN_SETTINGS = mkdtempSync(resolvePath("./ai-tmp/cli-repl-settings-") + "");

const STATE_FILES = ["./last-model.json", "./auth-ollama.json"];
let savedState = {};
beforeAll(() => {
  savedState = Object.fromEntries(STATE_FILES.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
  for (const f of STATE_FILES) rmSync(f, { force: true });
});
afterAll(() => {
  for (const [f, content] of Object.entries(savedState)) {
    if (content === null) rmSync(f, { force: true });
    else writeFileSync(f, content);
  }
});

let server;
let pending = []; // never-resolving handlers park here; afterEach releases them
afterEach(() => {
  rmSync(SPAWN_SETTINGS, { recursive: true, force: true });
  SPAWN_SETTINGS = mkdtempSync(resolvePath("./ai-tmp/cli-repl-settings-") + "");
  for (const resolve of pending.splice(0)) resolve(frames(DONE_FRAME("released")));
  server?.stop(true);
});

function startServer(handler) {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

/** Spawn the REPL; returns handles for incremental stdin + final capture. */
function spawnRepl(args, { settingsDir } = {}) {
  // A startup refreshModels() on a live local server caches its real model
  // list into the settings dir; a second spawn sharing that dir would then
  // reject the suite's synthetic model names. Callers that don't need a
  // shared dir (--resume continuity) get a fresh throwaway one per spawn.
  const dir = settingsDir ?? mkdtempSync(resolvePath("./ai-tmp/cli-repl-spawn-") + "");
  const proc = Bun.spawn(["bun", cli.app, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [NAMES.settingsEnv]: dir },
  });
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exit]) => ({ stdout, stderr, exit }));
  return { proc, done };
}

/** Full round trip: write all lines, EOF, await exit. */
async function runRepl({ input = "", args = [], settingsDir } = {}) {
  const { proc, done } = spawnRepl(args, { settingsDir });
  proc.stdin.write(input);
  proc.stdin.end();
  return done;
}

/** Poll fn() until it returns truthy (or ~5s pass). */
async function until(fn) {
  for (let i = 0; i < 50; i++) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(100);
  }
  return fn();
}

const frames = (...list) =>
  new Response(list.map((f) => JSON.stringify(f) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

const DONE_FRAME = (text, input = 5, output = 3) => ({
  message: { role: "assistant", content: text },
  done: true,
  prompt_eval_count: input,
  eval_count: output,
});

/** Server answering each request with the i-th text; records bodies. */
function scriptServer(texts, { models } = {}) {
  const requests = [];
  const url = startServer(async (req) => {
    // A startup refreshModels() probes /api/tags: answer it with the
    // test's own model list so a live local server (this dev machine's
    // ollama) never poisons the spawn settings dir with real model names
    // that would reject the suite's synthetic "ollama/m" on a later spawn.
    if (models && new URL(req.url).pathname === "/api/tags") {
      return Response.json({ models });
    }
    requests.push(await req.json());
    return frames(DONE_FRAME(texts[Math.min(requests.length - 1, texts.length - 1)]));
  });
  return { requests, url };
}

describe("the TUI REPL: one long-lived Agent across turns", () => {
  test("two piped lines run two turns; turn 2's request carries turn 1's exchange", async () => {
    const { requests, url } = scriptServer(["answer one", "answer two"], { models: [{ name: "m" }] });
    const { stdout, stderr, exit } = await runRepl({
      input: "question one\nquestion two\n",
      args: ["--model", "ollama/m", "--url", url, "--session", "0"],
    });

    expect(exit).toBe(0);
    expect(requests).toHaveLength(2);
    // context retained across turns: the second request holds the
    // whole first exchange plus the new user message (a leading
    // "system" role, filtered out, is the real package folder's own
    // AGENTS.md prefill — see lib/env.js resolveSystemPrompt)
    expect(requests[1].messages.filter((m) => m.role !== "system")).toEqual([
      { role: "user", content: "question one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "question two" },
    ]);

    // stdout: both responses rendered, in turn order
    const iOne = stdout.indexOf("answer one");
    const iTwo = stdout.indexOf("answer two");
    expect(iOne).toBeGreaterThanOrEqual(0);
    expect(iTwo).toBeGreaterThan(iOne);

    // stderr: diagnostics only, no payload, no prompt indicator (the
    // prompt was removed — the TUI draws a bordered writing
    // area instead; piped mode prints no prompt at all) and no per-turn
    // usage line (usage accumulates into the cross-run totals shown in
    // the TUI's status bar)
    // no prompt indicator (the bordered input area replaced the old "<name>> " echo)
    expect(stderr).not.toContain(`${appAlias}> `);
    expect(stderr).not.toContain("usage: in=");
    expect(stderr.trim().split("\n").every((l) => !l.startsWith("{"))).toBe(true);
  });

  test("empty lines never reach the provider", async () => {
    const { requests, url } = scriptServer(["real answer"], { models: [{ name: "m" }] });
    const { exit } = await runRepl({
      input: "\n   \nreal question\n",
      args: ["--model", "ollama/m", "--url", url, "--session", "0"],
    });
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1).content).toBe("real question");
  });

  test("/endpoint-model between turns switches the combo the next request carries", async () => {
    const { requests, url } = scriptServer(["answer one", "answer two"], { models: [{ name: "m" }] });
    const { stdout, stderr, exit } = await runRepl({
      input: "question one\n/endpoint-model ollama/other-model\nquestion two\n",
      args: ["--model", "ollama/m", "--url", url, "--session", "0"],
    });

    expect(exit).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe("m");
    expect(requests[1].model).toBe("other-model"); // the switch reached the wire
    expect(stderr).toContain("endpoint: ollama, model: other-model");
    expect(stdout).toContain("answer two");
  });

  test("/endpoint-model with only a provider selects its first available model (live /api/tags)", async () => {
    const requests = [];
    const url = startServer(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/tags") {
        return Response.json({ models: [{ name: "first-model" }, { name: "second-model" }] });
      }
      if (path === "/api/show") {
        // models() probes each model's context window (best-effort metadata)
        return Response.json({ model_info: { "llama.context_length": 8192 } });
      }
      requests.push(await req.json());
      return frames(DONE_FRAME("answer"));
    });
    const { stderr, exit } = await runRepl({
      input: "/endpoint-model ollama\nquestion\n",
      args: ["--model", "ollama/m", "--url", url, "--session", "0"],
    });

    expect(exit).toBe(0);
    expect(stderr).toContain("endpoint: ollama, model: first-model");
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("first-model"); // live discovery reached the wire
  });

  test("no --model restores the last-used combo", async () => {
    writeFileSync(`${SPAWN_SETTINGS}/last-model.json`, JSON.stringify({ model: "ollama/last-m" }) + "\n");
    const { requests, url } = scriptServer(["answer"], { models: [{ name: "m" }] });
    const { stderr, exit } = await runRepl({
      input: "question\n",
      args: ["--url", url, "--session", "0"],
      settingsDir: SPAWN_SETTINGS, // the test seeds last-model.json here
    });
    expect(requests[0].model).toBe("last-m");
    // (last-model.json lives in the per-test SPAWN_SETTINGS now)
  });
});

describe("ai REPL: session persistence", () => {
  test("no --session persists a fresh random-UUID session and names it on stderr", async () => {
    const { requests, url } = scriptServer(["answer one"], { models: [{ name: "m" }] });
    const { stderr, exit } = await runRepl({
      input: "question one\n",
      args: ["--model", "ollama/m", "--url", url],
      settingsDir: SPAWN_SETTINGS, // the test locates the session file here
    });

    expect(exit).toBe(0);
    // the path is absolute now (namespace sessions folder) and may
    // contain spaces (iCloud's "Mobile Documents") — never \S*
    const started = stderr.match(/session: ([0-9a-f-]{36}) — (.+)/);
    expect(started).not.toBeNull();
    const [, id] = started;
    // the STARTUP line's path is provisional (no name yet — nothing had
    // been said): the file itself may since have moved once the first
    // real message named it (see lib/agent/session.js's module doc) —
    // find it by id, the STABLE identity, rather than trusting that path
    const file = findSessionFile(`${SPAWN_SETTINGS}/${NAMES.sessionsDir}`, id);
    expect(file).not.toBeUndefined();
    expect(existsSync(file)).toBe(true);
    const records = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
      .filter((record) => record?.type !== "session-metadata"); // the first, origin line
    expect(records.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    // a leading system message (type 1) is the real package folder's own
    // AGENTS.md prefill (see lib/env.js resolveSystemPrompt) — legitimate
    // whenever the repo has one; this test is about session persistence
    expect(records.map((m) => m.type).filter((t) => t !== 1)).toEqual([2, 3]);
    // the exit line hands the user the --resume invocation
    expect(stderr).toContain(`resume with: ${binName("app")} --resume ${id}`);
    expect(requests).toHaveLength(1);
    rmSync(file, { force: true });
  });

  test('--session 0 and --session false are anonymous: nothing is written', async () => {
    for (const value of ["0", "false"]) {
      // A fresh settings dir per spawn: a startup model-catalog refresh on a
      // live local server would otherwise cache its real model list into a
      // shared dir, and the second spawn's synthetic "ollama/m" would then
      // be rejected against it. Session anonymity needs no shared state.
      const settingsDir = mkdtempSync(resolvePath("./ai-tmp/cli-repl-anon-") + "");
      const dir = `${settingsDir}/${NAMES.sessionsDir}`;
      const before = existsSync(dir) ? readdirSync(dir) : [];
      const { requests, url } = scriptServer(["answer"], { models: [{ name: "m" }] });
      const { stderr, exit } = await runRepl({
        input: "question\n",
        args: ["--model", "ollama/m", "--url", url, "--session", value],
        settingsDir,
      });
        expect(exit).toBe(0);
      expect(stderr).toContain("session: anonymous (not persisted)");
      expect(stderr).not.toContain("resume with");
      expect(requests).toHaveLength(1); // the turn still ran
      const after = existsSync(dir) ? readdirSync(dir) : [];
      expect(after).toEqual(before); // no session file appeared
    }
  });

  test("--session <id> writes the JSONL mirror; a second REPL --resume continues it", async () => {
    const sessionId = `cli-repl-${process.pid}`;
    const dir = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
    const stale = findSessionFile(dir, sessionId);
    if (stale) rmSync(stale, { force: true });

    const first = scriptServer(["answer one"], { models: [{ name: "m" }] });
    // The resume spawn shares run 1's settings dir, and each spawn's startup
    // refreshModels() probes the endpoint's auth-record URL. Pin that URL to
    // the test server (which answers /api/tags with the synthetic "m") so a
    // LIVE local server (a dev machine's ollama) can never replace the cache
    // with real model names that reject "ollama/m" on the resume spawn.
    writeFileSync(`${SPAWN_SETTINGS}/auth-ollama.json`, JSON.stringify({
      ollama: { provider: "ollama", url: first.url, local: true, models: { m: { label: "m", reasoning: false, input: ["text"] } } },
    }));

    const run1 = await runRepl({
      input: "question one\n",
      args: ["--model", "ollama/m", "--url", first.url, "--session", sessionId],
      settingsDir: SPAWN_SETTINGS, // the test asserts the session file lands here
    });
    expect(run1.exit).toBe(0);
    // a chosen --session id finalizes the file's name at construction
    // (see lib/agent/session.js) — only the uuid8 disambiguator is
    // unknown ahead of time, so find it by id rather than the path
    const file = findSessionFile(dir, sessionId);
    expect(file).not.toBeUndefined();
    expect(existsSync(file)).toBe(true);
    const records = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
      .filter((record) => record?.type !== "session-metadata"); // the first, origin line
    expect(records.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    // a leading system message (type 1) is the real package folder's own
    // AGENTS.md prefill (see lib/env.js resolveSystemPrompt) — legitimate
    // whenever the repo has one; this test is about session persistence
    expect(records.map((m) => m.type).filter((t) => t !== 1)).toEqual([2, 3]);

    const second = scriptServer(["answer two"], { models: [{ name: "m" }] });
    const run2 = await runRepl({
      input: "question two\n",
      args: ["--model", "ollama/m", "--url", second.url, "--resume", sessionId],
      settingsDir: SPAWN_SETTINGS, // --resume reads run 1's session from here
    });
    expect(run2.exit).toBe(0);
    // the replayed context reached the provider: turn 1 precedes the new
    // line (a leading "system" role, filtered out, replays run 1's own
    // AGENTS.md prefill — see lib/env.js resolveSystemPrompt)
    const roles = second.requests[0].messages.map((m) => m.role).filter((r) => r !== "system");
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(second.requests[0].messages.find((m) => m.role === "user").content).toBe("question one");
    rmSync(file, { force: true });
  });

  test("command tombstones are flushed immediately — they survive ^C at the prompt", async () => {
    const sessionId = `cli-repl-flush-${process.pid}`;
    const dir = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
    const stale = findSessionFile(dir, sessionId);
    if (stale) rmSync(stale, { force: true });

    const { url } = scriptServer(["answer one"], { models: [{ name: "m" }] });
    const { proc, done } = spawnRepl([
      "--model", "ollama/m", "--url", url,
      "--session", sessionId,
    ], { settingsDir: SPAWN_SETTINGS });
    proc.stdin.write("question one\n");
    // wait for the completed turn, then roll it back, then ^C at the prompt.
    // rollback index 1 keeps only message 0 — a possible leading system
    // message (the real package folder's own AGENTS.md prefill; see
    // lib/env.js resolveSystemPrompt) means that's no longer necessarily
    // the user message, so roll back to AFTER whatever message 0 turns
    // out to be instead of hardcoding "1".
    let file; // resolved once the subprocess's Agent creates its file
    const readRecords = () => {
      const text = readFileSync(file, "utf8").trim();
      return text === "" ? [] : text.split("\n").map(JSON.parse)
        .filter((record) => record?.type !== "session-metadata"); // the first, origin line
    };
    await until(() => {
      file = findSessionFile(dir, sessionId);
      return file !== undefined && readFileSync(file, "utf8").includes("answer one");
    });
    const keep = readRecords().length - 1; // drop just the assistant answer, keep everything up to the user's question
    proc.stdin.write(`/context-rollback ${keep}\n`);
    await until(() => readRecords().length === keep);
    proc.kill("SIGINT"); // at the prompt: no cancel armed — dies by the signal
    const { exit } = await done;

    expect(exit).toBe(130);
    // rewrite-on-flush: the rolled-back file holds only the remaining message(s)
    const records = readRecords();
    expect(records).toHaveLength(keep);
    if (keep > 0) expect(records.at(-1).type).toBe(2); // the user's question survived
    rmSync(file, { force: true });
  }, 20000);
});

describe("ai REPL: SIGINT cancellation via lib/signals.js", () => {
  test("SIGINT mid-response renders + persists the partial, then the REPL continues", async () => {
    const sessionId = `cli-repl-cancel-${process.pid}`;
    const dir = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
    const stale = findSessionFile(dir, sessionId);
    if (stale) rmSync(stale, { force: true });

    // stream one partial frame, then hang forever
    const url = startServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                JSON.stringify({ message: { role: "assistant", content: "par" }, done: false }) + "\n",
              ));
              // never closes; SIGINT kills the request
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );

    const { proc, done } = spawnRepl([
      "--model", "ollama/m", "--url", url,
      "--timeout", "15000", "--session", sessionId,
    ], { settingsDir: SPAWN_SETTINGS });
    proc.stdin.write("hello\n");
    await Bun.sleep(600); // let the partial frame stream in
    proc.kill("SIGINT");

    // wait until the partial lands in the session log (Agent persists it)
    let log = "";
    let file;
    for (let i = 0; i < 50 && !log.includes('"par"'); i++) {
      await Bun.sleep(100);
      file = findSessionFile(dir, sessionId);
      if (file !== undefined) log = readFileSync(file, "utf8");
    }
    proc.stdin.end(); // EOF: the REPL exits cleanly after cancellation
    const { stdout, stderr, exit } = await done;

    expect(exit).toBe(0); // REPL continued to EOF, not 130
    expect(stderr).toContain("SIGINT");
    expect(stdout).toContain("par"); // partial rendered as it streamed
    expect(stdout).toContain("[error] cancelled");

    const records = log.trim().split("\n").map(JSON.parse);
    const assistant = records.find((m) => m.type === 3);
    expect(assistant.content).toEqual([{ type: "text", text: "par" }]);
    rmSync(file, { force: true });
  }, 20000);
});

describe("the TUI: --help contract and usage errors (matching the io/agent CLIs)", () => {
  test("--help prints the harness contract and exits 0", async () => {
    const { stdout, exit } = await runRepl({ args: ["--help"] });
    expect(exit).toBe(0);
    for (const expected of [
      "usage:", "stdin:", "stdout:", "stderr:",
      "--model <endpoint>/<model>", "--session", "--resume", "--tools",
      "/endpoint-model", "/context-edit", "/context-rollback", "/context-pop", "exit codes:",
      "anonymous", "last-used",
    ]) {
      expect(stdout).toContain(expected);
    }
  });

  test("1 on usage errors (unknown flag, missing value, bad number, session+resume)", async () => {
    for (const args of [
      ["--nope"], ["--model"], ["--timeout", "abc"],
      ["--session", "x", "--resume", "y"],
    ]) {
      const { exit, stderr } = await runRepl({ args });
      expect(exit).toBe(1);
      expect(stderr).toContain("--help");
    }
  });

  test("starts model-less and tells a sender to load a model", async () => {
    // (last-model.json lives in the per-test SPAWN_SETTINGS now)
    const url = startServer(() => frames(DONE_FRAME("x")));
    const { exit, stderr } = await runRepl({ input: "hi\n", args: ["--url", url, "--session", "0"] });
    expect(exit).toBe(0);
    expect(stderr).toContain("Please load a model");
  });
});
