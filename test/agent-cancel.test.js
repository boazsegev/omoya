// test/agent-cancel.test.js — proof for cancellation + session:
// aiio.cancel() emits a terminal partial, Agent persists it (synced
// onDone), resume restores it — the Agent-side half of the pattern
// proven for stores in test/test-wiki-store.test.js.
import { NAMES } from "../lib/namespace.js";
import { resolve } from "node:path";
import { describe, expect, test, afterEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { cli } from "./bin-names.js";
import { Agent } from "../lib/agent.js";
import { Context } from "../lib/context.js";
import { callbacksNormalize, eventDispatch } from "../lib/context.js";
import { fakeIO, scriptedIO, testEnv, USER, TOOLCALL, TEXT } from "./fakes.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { Env } from "../lib/env.js";
import { toolEntry, toolsLoad } from "./env-internals.js";

// spawned children get a THROWAWAY user settings folder (dynamic writes
// — last-model.json, auth — never touch the shared suite layer)
mkdirSync("./ai-tmp", { recursive: true });
const SPAWN_SETTINGS = mkdtempSync("./ai-tmp/agent-cancel-settings-");

const ROOT = `./ai-tmp/agent-cancel-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));
const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
  .filter((record) => record?.type !== "session-metadata"); // the first, origin line

/** A fake IO that streams a partial then blocks until interrupted.
 *  `streaming` resolves for the first partial; nextStreaming() arms another. */
function hangingIO(partialText) {
  let started;
  const streaming = new Promise((resolve) => { started = resolve; });
  const io = fakeIO(async (io, callbacks) => {
    const set = callbacksNormalize(callbacks, {});
    eventDispatch(set, { type: "text_start", contentIndex: 0 });
    eventDispatch(set, { type: "text_delta", contentIndex: 0, text: partialText });
    started();
    return new Promise((resolve) => {
      io._onKill = () => resolve({
        type: "error",
        error: "cancelled",
        kind: "cancelled",
        cancelled: true,
        message: { type: 3, content: [{ type: "text", text: partialText }] },
      });
    });
  });
  io.streaming = streaming;
  io.nextStreaming = () => new Promise((resolve) => { started = resolve; });
  return io;
}

describe("Agent cancellation: interrupt → partial persisted → resume restores", () => {
  test("partial assistant message lands in the session log and replays", async () => {
    const env = await testEnv({ sessions: resolve(ROOT) });
    const io = hangingIO("partial ans");
    const agent = await Agent.create({
      env, model: "p/m", contextId: "cancel", context: [USER("long question")], createIO: () => io,
    });

    const runPromise = agent.run();
    await io.streaming;
    await agent.cancel();
    const terminal = await runPromise;

    expect(terminal).toMatchObject({ type: "error", kind: "cancelled", cancelled: true });
    expect(io.state).toBe("idle"); // interruption leaves the same IO reusable
    expect(io.cancels).toBe(1);
    expect(io.closes).toBe(0);
    expect(agent.io).toBe(io);

    // persisted WITHOUT manual flush (Agent syncs on the terminal)
    const file = agent.context.file;
    expect(lines(file)).toEqual([
      USER("long question"),
      { type: 3, content: [{ type: "text", text: "partial ans" }] },
    ]);

    // resume restores the partial exactly
    const resumed = Context.resume({ id: "cancel", dir: ROOT });
    expect(resumed.at(-1)).toEqual({
      type: 3,
      content: [{ type: "text", text: "partial ans" }],
    });
  });

  test("the run after cancellation reuses the same IO and re-arms interruption", async () => {
    const env = await testEnv();
    let made = 0;
    const io = hangingIO("part");
    const agent = await Agent.create({
      env, model: "p/m", context: [USER("q")],
      createIO: () => { made++; return io; },
    });
    const first = agent.run();
    await io.streaming;
    await agent.cancel();
    expect(await first).toMatchObject({ type: "error", kind: "cancelled", cancelled: true });
    expect(io.state).toBe("idle");
    const secondStreaming = io.nextStreaming();
    agent.context.append(USER("continue"));
    const second = agent.run();
    await secondStreaming;
    await agent.cancel();
    expect(await second).toMatchObject({ type: "error", kind: "cancelled", cancelled: true });
    expect(made).toBe(1);
    expect(io.writes).toHaveLength(2);
    expect(io.cancels).toBe(2);
    expect(io.closes).toBe(0);
    expect(io.state).toBe("idle");
  });

  test("explicit IO.close interrupts permanently; the next run constructs a replacement", async () => {
    const env = await testEnv();
    const firstIO = hangingIO("partial");
    const replacement = scriptedIO([[...TEXT(0, "continued"), { type: "done" }]]);
    let made = 0;
    const agent = await Agent.create({
      env, model: "p/m", context: [USER("q")],
      createIO: () => ++made === 1 ? firstIO : replacement,
    });
    const first = agent.run();
    await firstIO.streaming;
    await firstIO.close();
    expect(await first).toMatchObject({ type: "error", kind: "cancelled", cancelled: true });
    expect(firstIO.state).toBe("closed");
    expect(firstIO.cancels).toBe(0);
    expect(firstIO.closes).toBe(1);
    await firstIO.close();
    await firstIO.cancel();
    expect(firstIO.state).toBe("closed");
    expect(firstIO.closes).toBe(1);
    await expect(firstIO.write(agent.context)).rejects.toThrow("closed");
    agent.context.append(USER("continue"));
    expect((await agent.run()).type).toBe("done");
    expect(agent.io).toBe(replacement);
    expect(made).toBe(2);
  });
});

describe("CLI-level: SIGINT persists the partial into --session", () => {
  let server;
  let release = [];
  afterEach(() => {
    for (const close of release.splice(0)) close();
    server?.stop(true);
  });

  test("kill → partial on disk → resume continues", async () => {
    const sessionId = `cancel-cli-${process.pid}`;
    const dir = `${SPAWN_SETTINGS}/${NAMES.sessionsDir}`;
    const stale = Context.fileOf({ dir: dir, id: sessionId });
    if (stale) rmSync(stale, { force: true });

    let requestStarted;
    const started = new Promise((resolveStarted) => { requestStarted = resolveStarted; });
    server = Bun.serve({
      port: 0,
      fetch: () => {
        requestStarted();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                JSON.stringify({ message: { role: "assistant", content: "par" }, done: false }) + "\n",
              ));
              release.push(() => { try { controller.close(); } catch { /* client gone */ } }); // hang until afterEach
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      },
    });

    const proc = Bun.spawn(
      ["bun", cli.agent, "--model", "ollama/m",
        "--url", `http://127.0.0.1:${server.port}`, "--timeout", "10000",
        "--session", sessionId],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, [NAMES.settingsEnv]: SPAWN_SETTINGS } },
    );
    proc.stdin.write("stream me");
    proc.stdin.end();
    // Wait for the CLI's actual request instead of guessing startup latency.
    await Promise.race([started, Bun.sleep(5000).then(() => { throw new Error("CLI request did not start"); })]);
    await Bun.sleep(50); // let the delivered partial frame reach the client
    proc.kill("SIGINT");
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exit).toBe(130);
    expect(stderr).toContain("SIGINT");
    const last = stdout.trim().split("\n").filter((l) => l.startsWith("{")).map(JSON.parse).at(-1);
    expect(last).toMatchObject({ type: "error", kind: "cancelled" });
    expect(last.message.content).toEqual([{ type: "text", text: "par" }]);

    // the partial was persisted before exit — resume restores it
    const file = Context.fileOf({ dir: dir, id: sessionId });
    expect(lines(file).at(-1)).toEqual({ type: 3, content: [{ type: "text", text: "par" }] });
    const resumed = Context.resume({ id: sessionId, dir });
    expect(resumed.at(-1).content).toEqual([{ type: "text", text: "par" }]);
    rmSync(file, { force: true });
  }, 15000);
});

describe("Agent cancellation: in-flight TOOL children", () => {
  const FIXTURES = "./test/tool-fixtures";
  const fixtureEnv = async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/cancel-tool-"), { dir: mkdtempSync("./ai-tmp/cancel-tool-"), settings: { providers: { p: { provider: "test", url: "test://script" } } }, init: { providers: false, tools: false, detect: false, models: false } });
    await toolsLoad(env, { dirs: [FIXTURES] });
    return env;
  };
  const toolResults = (agent) => agent.context.messages().filter((m) => m.type === 4);

  test("cancel during a tool call ends the turn cancelled — no further provider request", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "slow", { ms: 2_000 }), { type: "done" }],
      [...TEXT(0, "should never stream"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    const run = agent.run({});
    await Bun.sleep(200); // the forked "slow" tool is in flight
    await agent.cancel(); // SIGINT (a BUN worker shrugs it off; the loop still stops)
    const terminal = await run;

    expect(terminal).toMatchObject({ type: "error", kind: "cancelled" });
    expect(io.turns()).toBe(1); // NO further provider request after the cancel
    const [result] = toolResults(agent);
    // Cancellation settles the Agent boundary immediately and destroys the
    // process group; it never waits for a tool's signal handler or timeout.
    expect(result).toMatchObject({ type: 4, error: true, name: "slow", callId: "c1" });
  }, 15000);

  test("one cancel settles even a SIGINT-proof child", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "stubborn", { ms: 30_000 }), { type: "done" }], // ignores SIGINT
      [...TEXT(0, "should never stream"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    const run = agent.run({});
    await Bun.sleep(300); // the forked tool is in flight, SIGINT-proof
    await agent.cancel();
    const terminal = await run;

    expect(terminal).toMatchObject({ type: "error", kind: "cancelled" });
    expect(agent._activeTools.size).toBe(0);
    const [result] = toolResults(agent);
    expect(result).toMatchObject({ type: 4, error: true, name: "stubborn", callId: "c1" });
  }, 15000);

  test("one cancel settles even a SIGTERM-proof child", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "unkillable", { ms: 30_000 }), { type: "done" }], // ignores SIGINT+SIGTERM
      [...TEXT(0, "should never stream"), { type: "done" }],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    const run = agent.run({});
    await Bun.sleep(300);
    await agent.cancel();
    const terminal = await run;

    expect(terminal).toMatchObject({ type: "error", kind: "cancelled" });
    expect(agent._activeTools.size).toBe(0);
    const [result] = toolResults(agent);
    expect(result).toMatchObject({ type: 4, error: true, name: "unkillable", callId: "c1" });
  }, 15000);

  test("cancel kills the sandboxed bash process group before it can stream again", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/cancel-bash-"), { dir: mkdtempSync("./ai-tmp/cancel-bash-"), settings: { providers: { p: { provider: "test", url: "test://script" } } }, init: { providers: false, tools: false, detect: false, models: false } });
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolEntry(env, "bash")).toMatchObject({ sandbox: true });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "bash", { command: "printf 'first\\n'; sleep 2; printf 'late\\n'" }), { type: "done" }]]);
    const chunks = [];
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_DATA, ({ chunk }) => chunks.push(chunk));
    const run = agent.run({});
    await Bun.sleep(200);
    await agent.cancel();
    await run;
    await Bun.sleep(300);

    expect(chunks).toEqual(["first"]);
    expect(agent._activeTools.size).toBe(0);
  }, 15000);

  test("a fresh run re-arms the cancel path (no stale cancel flag)", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([[...TEXT(0, "fine"), { type: "done" }]]);
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    await agent.cancel(); // outside a run: only the flag sets
    const terminal = await agent.run({});
    expect(terminal.type).toBe("done");
    expect(agent.context.at(-1).content[0].text).toBe("fine");
  });
});
