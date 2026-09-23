// test/agent-cli.test.js — proof for the agent headless CLI: shared
// stdin-to-EOF grammar, tool-loop events + final output on stdout,
// diagnostics-only stderr, --session/--resume wholly inside Agent,
// exit codes + --help matching the io CLI. Buffered-to-EOF input LOOPS
// tools until done — unlike the io CLI's single request.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach } from "bun:test";
import { binName, cli } from "./bin-names.js";
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { findSessionFile } from "../lib/agent.js";

let server;
let pending = []; // never-resolving handlers park here; afterEach releases them
afterEach(() => {
  for (const resolve of pending.splice(0)) resolve(frames(DONE_FRAME("released")));
  server?.stop(true);
});

import { mkdtempSync, mkdirSync } from "node:fs";

// spawned children get a THROWAWAY user settings folder (see agent-cancel)
// with ONE request attempt configured: the retry policy's waits
// (agent-retry.test.js owns their proof) would stretch the
// failure-class exit-code assertions past their timeouts
mkdirSync("./ai-tmp", { recursive: true });
const SPAWN_SETTINGS = mkdtempSync("./ai-tmp/agent-cli-settings-");
writeFileSync(`${SPAWN_SETTINGS}/settings.json`, JSON.stringify({ maxAttempts: 1 }));

const ROOT = `./ai-tmp/agent-cli-${process.pid}`;

function startServer(handler) {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli({ input = "", args = [], signal } = {}) {
  const proc = Bun.spawn(["bun", cli.agent, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [NAMES.settingsEnv]: SPAWN_SETTINGS },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  if (signal) setTimeout(() => proc.kill(signal), 300);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events = stdout.trim() === ""
    ? []
    : stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { stdout, stderr, exit, events };
}

const frames = (...list) =>
  new Response(list.map((f) => JSON.stringify(f) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });

const TOOLCALL_FRAME = (name, args) => ({
  message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] },
  done: false,
});
const DONE_FRAME = (text, input = 5, output = 3) => ({
  message: { role: "assistant", content: text },
  done: true,
  prompt_eval_count: input,
  eval_count: output,
});

/** Two-turn script: tool call, then final text. Records request bodies. */
function toolLoopServer(toolName, toolArgs, finalText = "loop finished") {
  const requests = [];
  const url = startServer(async (req) => {
    requests.push(await req.json());
    return requests.length === 1
      ? frames(TOOLCALL_FRAME(toolName, toolArgs), DONE_FRAME("", 5, 2))
      : frames(DONE_FRAME(finalText, 9, 4));
  });
  return { requests, url };
}

describe("agent CLI: tool loop over the shared stdin grammar", () => {
  test("buffered-to-EOF input LOOPS tools until done (unlike the io CLI's one request)", async () => {
    writeFileSync(`${ROOT}-target.txt`, "target file body");
    const { requests, url } = toolLoopServer("read", { path: `./ai-tmp/agent-cli-${process.pid}-target.txt` });
    const { events, stderr, exit } = await runCli({
      input: JSON.stringify([{ type: 2, content: [{ type: "text", text: "read the target" }] }]),
      args: ["--model", "ollama/m", "--url", url],
    });

    expect(exit).toBe(0);
    expect(requests).toHaveLength(2); // the loop: not one request
    // request 2 carries the tool result back to the provider
    expect(requests[1].messages.at(-2)).toMatchObject({
      role: "assistant",
      tool_calls: [{ function: { name: "read", arguments: expect.any(Object) } }],
    });
    expect(requests[1].messages.at(-1)).toEqual({
      role: "tool", name: "read", content: "target file body",
    });
    // both requests carried the tool catalog (built-in + read)
    expect(requests[0].tools.map((t) => t.function.name)).toContain("read");
    expect(requests[0].tools.map((t) => t.function.name)).toContain("tool-refresh");

    // stdout: every request's events stream in order; final done wins
    const types = events.map((e) => e.type);
    expect(types).toContain("toolcall_start");
    expect(types.at(-1)).toBe("done");
    expect(events.at(-1).message.content).toEqual([{ type: "text", text: "loop finished" }]);
    expect(events.at(-1).usage).toEqual({ inputTokens: 9, outputTokens: 4, source: "provider" });

    // stderr: diagnostics only — tool execution + usage, no JSON
    expect(stderr).toContain("tool read: ok");
    expect(stderr).toContain("usage: in=9 out=4 (provider)");
    expect(stderr.trim().split("\n").every((l) => !l.startsWith("{"))).toBe(true);
    rmSync(`${ROOT}-target.txt`, { force: true });
  });

  test("--tools restricts the advertised catalog", async () => {
    const { requests, url } = toolLoopServer("read", { path: "./AI-TODO.md" });
    await runCli({
      input: "hi",
      args: ["--model", "ollama/m", "--url", url, "--tools", "read"],
    });
    expect(requests[0].tools.map((t) => t.function.name)).toEqual(["read"]);
  });

  test("--session writes the JSONL mirror; --resume continues it", async () => {
    const sessionId = `cli-${process.pid}`;
    const dir = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
    const stale = findSessionFile(dir, sessionId);
    if (stale) rmSync(stale, { force: true });

    const first = toolLoopServer("read", { path: "./AI-TODO.md" }, "answer one");
    const run1 = await runCli({
      input: "question one",
      args: ["--model", "ollama/m", "--url", first.url, "--session", sessionId],
    });
    expect(run1.exit).toBe(0);
    // a chosen --session id finalizes the file's NAME at construction
    // (see lib/agent/session.js) — only the uuid8 disambiguator prefix
    // is unknown ahead of time, so find it by id, not by path
    const file = findSessionFile(dir, sessionId);
    expect(file).not.toBeUndefined();
    expect(existsSync(file)).toBe(true);
    // a leading system message, filtered out, is the real package
    // folder's own AGENTS.md prefill (see lib/env.js
    // resolveSystemPrompt) — Agent seeds it at construction, ALWAYS the
    // context's first message
    const allRecords = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
      .filter((record) => record?.type !== "session-metadata");
    expect(allRecords.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    const records = allRecords.filter((m) => m.type !== 1);
    expect(records.map((m) => m.type))
      .toEqual([2, 3, 4, 3]); // seed + loop messages mirrored

    const second = toolLoopServer("read", { path: "./AI-TODO.md" }, "answer two");
    const run2 = await runCli({
      input: "question two",
      args: ["--model", "ollama/m", "--url", second.url, "--resume", sessionId],
    });
    expect(run2.exit).toBe(0);
    // the resumed context reached the provider: first exchange precedes question two
    // (a leading system role is the real package folder's AGENTS.md —
    // seeded FIRST at construction, always; filter it for the exchange assertions)
    const roles = second.requests[0].messages.filter((m) => m.role !== "system").map((m) => m.role);
    expect(roles[0]).toBe("user"); // question one
    expect(roles.at(-1)).toBe("user"); // question two
    const texts = second.requests[0].messages.filter((m) => m.role !== "system");
    expect(texts[0].content).toBe("question one");
    rmSync(file, { force: true });
  });
});

describe("agent CLI: exit codes and --help (matching the io CLI)", () => {
  test("1 on usage errors (unknown flag, missing value, bad number, session+resume)", async () => {
    for (const args of [
      ["--nope"], ["--model"], ["--timeout", "abc"],
      ["--session", "x", "--resume", "y"],
    ]) {
      const { exit, stderr } = await runCli({ args });
      expect(exit).toBe(1);
      expect(stderr).toContain("--help");
    }
  });

  test("1 when no model is selected", async () => {
    const url = startServer(() => frames(DONE_FRAME("x")));
    const { exit, stderr } = await runCli({ input: "hi", args: ["--url", url] });
    expect(exit).toBe(1);
    expect(stderr).toContain("Please load a model");
  });

  test("4 on provider error (404 model missing)", async () => {
    const url = startServer(
      () => new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404 }),
    );
    const { exit } = await runCli({ input: "hi", args: ["--model", "ollama/m", "--url", url] });
    expect(exit).toBe(4);
  });

  test("130 on SIGINT cancellation of an in-flight request", async () => {
    const url = startServer(() => new Promise((resolve) => pending.push(resolve))); // responds only in afterEach
    const { exit, stderr, events } = await runCli({
      input: "hi",
      args: ["--model", "ollama/m", "--url", url, "--timeout", "10000"],
      signal: "SIGINT",
    });
    expect(exit).toBe(130);
    expect(stderr).toContain("SIGINT");
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "cancelled" });
  }, 15000);

  test("--help prints the harness contract and exits 0", async () => {
    const { stdout, exit } = await runCli({ args: ["--help"] });
    expect(exit).toBe(0);
    for (const expected of [
      "usage:", "stdin:", "stdout:", "stderr:",
      "--model <endpoint>/<model>", "--session", "--resume", "--tools", "exit codes:",
    ]) {
      expect(stdout).toContain(expected);
    }
    // the usage names the invoked wrapper (dynamic argv[1] basename)
    expect(stdout).toContain(`usage: ${binName("agent")}`);
    expect(stdout.startsWith(`${binName("agent")} — `)).toBe(true);
  });
});
