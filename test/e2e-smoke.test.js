// test/e2e-smoke.test.js — ** MVP gate **: the whole stack end to end
// through the scripted "test" provider (lib/providers/test.js — pre-
// determined turns, ZERO network, ZERO model dependence): read
// full round trip, session write + resume, both bindings (the headless
// agent CLI and the in-process library), plus the TUI REPL.
//
// A REAL model was the old gate (gpt-oss:20b via Ollama): flaky by
// construction (response variance, availability, a dependence on the
// model's intelligence). The scripted provider makes the gate
// deterministic: each spawned process gets its own script file (the
// namespace test-script variable); the in-process Agent gets an inline script
// (settings.script). The passphrase nonce still travels only through
// the session log — each later turn proves resume by recalling it.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { appAlias, cli } from "./bin-names.js";
import { findSessionFile } from "../lib/agent.js";

// spawned children get a THROWAWAY user settings folder (see agent-cancel)
mkdirSync("./ai-tmp", { recursive: true });
const SPAWN_SETTINGS = mkdtempSync("./ai-tmp/e2e-settings-");
import { writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";

const NONCE = `narwhal${Math.floor(1000 + Math.random() * 9000)}`;
const TARGET = `./ai-tmp/e2e-smoke-target-${process.pid}.txt`;
const SESSION = `e2e-smoke-${process.pid}`;
// the sessions folder moved under namespace settings (outside the
// project tree — see lib/agent/session.js); the spawned CLI pins its
// settings folder to SPAWN_SETTINGS. The file name is no longer a
// direct function of the id (a date + sessionUUID prefix leads it —
// see the module doc), so it's found by a scan, not built from a string.
const SESSIONS_DIR = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
const sessionFile = () => findSessionFile(SESSIONS_DIR, SESSION);
const SCRIPT = `./ai-tmp/e2e-smoke-script-${process.pid}.json`;
const T = 30_000; // per-test budget (scripted provider: no model latency)

const alnum = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Write the script a spawned process will consume (one file per test). */
function script(turns) {
  writeFileSync(SCRIPT, JSON.stringify(turns));
  return SCRIPT;
}

// ai persists its selected combo at ./last-model.json — preserve
// the user's real state across the gate's spawned processes.
let savedLast = null;

beforeAll(() => {
  savedLast = existsSync("./last-model.json") ? readFileSync("./last-model.json") : null;
  const stale = sessionFile();
  if (stale) rmSync(stale, { force: true });
  writeFileSync(TARGET, `The passphrase is: ${NONCE}\n`);
});

afterAll(() => {
  rmSync(TARGET, { force: true });
  const stale = sessionFile();
  if (stale) rmSync(stale, { force: true });
  rmSync(SCRIPT, { force: true });
  // restore the user's real combo ONLY when a spawn actually changed it
  // (an unconditional rewrite churns the mtime — iCloud conflict files)
  const now = existsSync("./last-model.json") ? readFileSync("./last-model.json") : null;
  if (savedLast === null) rmSync("./last-model.json", { force: true });
  else if (now === null || !now.equals(savedLast)) writeFileSync("./last-model.json", savedLast);
});

/** Spawn a project executable with the scripted provider isolated. */
async function run(bin, { input = "", args = [] } = {}) {
  const proc = Bun.spawn(["bun", bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [NAMES.testScriptEnv]: SCRIPT, [NAMES.settingsEnv]: SPAWN_SETTINGS },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit };
}

describe("e2e smoke (MVP gate): scripted test provider + read + sessions + all bindings", () => {
  test("headless CLI binding: read round trip + session write", async () => {
    // turn 1: the model calls read; turn 2 (after the tool result
    // lands in the context): it answers with the passphrase.
    script([
      [{ toolCall: { name: "read", arguments: { path: TARGET } } }],
      [{ text: `The passphrase is: ${NONCE}` }],
    ]);
    const { stdout, stderr, exit } = await run(cli.agent, {
      input: `Use the read tool to read the file at ${TARGET} and reply with only the passphrase it contains.`,
      args: ["--model", "test/test-model", "--session", SESSION],
    });
    expect(exit).toBe(0);
    expect(stderr).toContain("tool read: ok");

    const events = stdout.trim().split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
    const done = events.at(-1);
    expect(done.type).toBe("done");
    expect(alnum(done.message.content.map((b) => b.text ?? "").join(" "))).toContain(alnum(NONCE));

    // session write: user + assistant(tool call) + tool result + assistant
    // (a leading system message, filtered out, is the real package
    // folder's own AGENTS.md prefill — see lib/env.js resolveSystemPrompt
    // — Agent seeds it at construction, ALWAYS the context's first message)
    const allRecords = readFileSync(sessionFile(), "utf8").trim().split("\n").map(JSON.parse)
      .filter((record) => record?.type !== "session-metadata");
    expect(allRecords.every((m) => typeof m.type === "number" && m.op === undefined)).toBe(true);
    const records = allRecords.filter((m) => m.type !== 1);
    expect(records.map((m) => m.type)).toEqual([2, 3, 4, 3]); // deterministic now
    // the read result really landed in the context (nonce from disk)
    const toolResult = records[2];
    expect(toolResult.name).toBe("read");
    expect(alnum(toolResult.content.map((b) => b.text ?? "").join(" "))).toContain(alnum(NONCE));
  }, T);

  test("headless CLI binding: --resume recalls the passphrase (replay proof)", async () => {
    script([[{ text: `The passphrase was: ${NONCE}` }]]);
    const { stdout, exit } = await run(cli.agent, {
      input: "What was the passphrase from the file you read earlier? Reply with only the passphrase.",
      args: ["--model", "test/test-model", "--resume", SESSION],
    });
    expect(exit).toBe(0);
    const events = stdout.trim().split("\n").filter((l) => l.startsWith("{")).map(JSON.parse);
    const done = events.at(-1);
    expect(done.type).toBe("done");
    expect(alnum(done.message.content.map((b) => b.text ?? "").join(" "))).toContain(alnum(NONCE));
  }, T);

  test("library binding: in-process Agent resumes the CLI-written session", async () => {
    const { default: API } = await import("../lib/index.js");
    const Env = API.Env;
    const Agent = API.Agent;
    const { userMessage } = API.Context;
    // resume the CLI-written session from the same pinned settings folder
    const env = new Env({ settingsDir: SPAWN_SETTINGS });
    await env.loadProviders();
    await env.loadTools({ dirs: ["./tools"] }); // explicit root keeps the proof self-contained

    const agent = new Agent({
      env, model: "test/test-model", session: SESSION,
      // inline script through per-invocation settings (the in-process path)
      settings: { script: [[{ text: `Still: ${NONCE}` }]] },
    });
    // resume restored the prior exchange before this turn
    expect(agent.context.length).toBeGreaterThanOrEqual(4);

    agent.append(userMessage("Again, what was the passphrase? Reply with only the passphrase."));
    let text = "";
    agent.onEvent(Agent.EVENT.TEXT_DELTA, (event) => { text += event.text ?? ""; });
    const terminal = await agent.run();
    agent.session?.close?.();
    expect(terminal.type).toBe("done");
    expect(alnum(text)).toContain(alnum(NONCE));
  }, T);

  test("the TUI REPL: interactive turn over the same session", async () => {
    script([[{ text: `Once more: ${NONCE}` }]]);
    const { stdout, stderr, exit } = await run(cli.app, {
      input: "One more time, the passphrase? Reply with only the passphrase.\n",
      args: ["--model", "test/test-model", "--resume", SESSION],
    });
    expect(exit).toBe(0);
    expect(stderr).not.toContain(`${appAlias}> `); // no prompt indicator (bordered input area in the app)
    expect(alnum(stdout)).toContain(alnum(NONCE)); // rendered response stream
  }, T);
});
