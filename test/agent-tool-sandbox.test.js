// test/agent-tool-sandbox.test.js — proof for lib/tool-sandbox.js +
// lib/tool-worker.js + Agent's toolCall options: file-scanned tools
// execute in a FORKED child by default, so a tool that destroys its
// own process (exit 1) can never crush the Agent; timeout kills stuck
// calls; async dispatches one message's calls concurrently.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { Env, osSandboxKind } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { callToolSandboxed } from "../lib/agent.js";
import { scriptedIO, TOOLCALL, TEXT } from "./fakes.js";

const FIXTURES = "./test/tool-fixtures";
const DONE = { type: "done" };

async function fixtureEnv() {
  // dir AND cwd pinned to the same throwaway folder: the jail's
  // working folder is env.cwd, so the outside-write probes (HOME —
  // the preload redirects it inside ./ai-tmp, outside THIS folder)
  // stay hermetic: denied for the jailed tool, allowed for the
  // control, neither touching anything outside the project.
  const dir = mkdtempSync("./ai-tmp/sandbox-");
  const env = new Env({ dir, cwd: dir, settings: { providers: { p: { provider: "test", url: "test://script" } } } });
  await env.loadTools({ dirs: [FIXTURES] });
  return env;
}

const toolResults = (agent) => agent.context.filter((m) => m.type === 4);

describe("tool sandbox: crash-proof forked tool calls", () => {
  test("a tool that exits its process (exit 1) does NOT crush the Agent — fork is the default", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "crash", {}), DONE],
      [...TEXT(0, "still alive"), DONE],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const terminal = await agent.run({}); // the test process itself surviving is half the proof

    expect(terminal.type).toBe("done");
    expect(io.turns()).toBe(2); // the tool loop CONTINUED after the crash
    const [result] = toolResults(agent);
    expect(result).toMatchObject({ type: 4, error: true, name: "crash", callId: "c1" }); // an ordinary tool-result error, not a crash
    // and the model's follow-up rendered fine — the Agent kept working
    expect(agent.context.at(-1).content[0].text).toBe("still alive");
  });

  test("megabytes of tool noise never truncate the worker's result line", async () => {
    // a chatty tool dumps megabytes onto the worker's stdout while
    // RUNNING (import-time printing is suppressed by the tool scan);
    // the result line must still arrive COMPLETE and parseable — the
    // worker writes it on its own line and exits only after the pipe
    // flushed (lib/tool-worker.js)
    const env = await fixtureEnv();
    // a parent whose event loop is "busy": nothing drains the pipe
    // for a beat, so the worker's pending output backs up behind it
    const slowDrainSpawn = (file, argv, opts) => {
      const child = spawn(file, argv, opts);
      const stdout = new PassThrough();
      child.stdout.pause();
      const timer = setTimeout(() => child.stdout.pipe(stdout), 400);
      timer.unref?.();
      return {
        stdin: child.stdin,
        stdout,
        stderr: child.stderr,
        pid: child.pid,
        on: (event, cb) => child.on(event, cb),
        kill: (signal) => child.kill(signal),
      };
    };
    const result = await callToolSandboxed({
      env, name: "noisy", args: {}, timeout: 20_000, spawnImpl: slowDrainSpawn,
    });
    expect(result).toEqual({ ok: true, value: "noisy done" });
  });

  test("a forked tool's thrown `system` payload survives the worker boundary", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "guardfail", {}), DONE],
      [...TEXT(0, "ok"), DONE],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    await agent.run({});

    const [result] = toolResults(agent);
    expect(result).toMatchObject({ type: 4, error: true, name: "guardfail", callId: "c1" });
    // the payload the worker serialized rides back and appends as a System message
    const systems = agent.context.filter((m) => m.type === 1);
    expect(systems.map((m) => m.content[0].text)).toContain("Stay in the current directory tree. Use relative path names only.");
  });

  test("forked file tools return values through the worker (env reconstruction)", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "slow", { ms: 50 }), DONE],
      [...TEXT(0, "ok"), DONE],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    await agent.run({});
    const [result] = toolResults(agent);
    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toBe("slept 50ms");
  });

  test("the worker loads the registry-named module ONLY — a stray duplicate file in the root never fails the call", async () => {
    // the parent validated its registry; a sync-conflict duplicate
    // (<base> <n>.js) appearing afterwards must not break forked calls
    const env = await fixtureEnv();
    const { writeFileSync, rmSync } = await import("node:fs");
    const dup = `${FIXTURES}/slow 2.js`;
    writeFileSync(dup, 'export function slow() { return "STALE"; }\nexport function toolDescription() { return { slow: { description: "d", inputSchema: { type: "object" } } }; }\n');
    try {
      const io = scriptedIO([
        [...TOOLCALL(0, "c1", "slow", { ms: 10 }), DONE],
        [...TEXT(0, "ok"), DONE],
      ]);
      const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
      await agent.run({});
      const [result] = toolResults(agent);
      expect(result.error).toBeUndefined();
      expect(result.content[0].text).toBe("slept 10ms");
    } finally {
      rmSync(dup);
    }
  });

  test("timeout kills a stuck tool call; the run continues", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "slow", { ms: 30_000 }), DONE],
      [...TEXT(0, "recovered"), DONE],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      toolCall: { timeout: 300 },
    });
    const started = Date.now();
    const terminal = await agent.run({});
    const elapsed = Date.now() - started;

    expect(terminal.type).toBe("done");
    expect(elapsed).toBeLessThan(10_000); // nowhere near the tool's 30s
    const [result] = toolResults(agent);
    expect(result).toMatchObject({ type: 4, error: true, name: "slow", callId: "c1" });
  });

  test("timeout accepts unit strings (\"1s\" style durations)", async () => {
    const env = await fixtureEnv();
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => null,
      toolCall: { timeout: "2s" },
    });
    expect(agent._toolCall.timeout).toBe(2000);
  });

  test("toolCall.async runs one message's calls CONCURRENTLY, results appended in order", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "slow", { ms: 600 }), ...TOOLCALL(1, "c2", "slow", { ms: 600 }), DONE],
      [...TEXT(0, "both done"), DONE],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      toolCall: { async: true },
    });
    const started = Date.now();
    await agent.run({});
    const elapsed = Date.now() - started;

    // sequential would be ≥ 2×600ms of sleep alone; concurrent is ~one
    expect(elapsed).toBeLessThan(1_100);
    const results = toolResults(agent);
    expect(results.map((m) => m.callId)).toEqual(["c1", "c2"]); // call order preserved
    expect(results.map((m) => m.content[0].text)).toEqual(["slept 600ms", "slept 600ms"]);
  });

  test("fork:false executes file tools in-process (sandbox off)", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "slow", { ms: 20 }), DONE],
      [...TEXT(0, "ok"), DONE],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      toolCall: { fork: false },
    });
    await agent.run({});
    const [result] = toolResults(agent);
    expect(result.error).toBeUndefined();
    expect(result.content[0].text).toBe("slept 20ms");
  });
});

describe("callToolSandboxed (unit)", () => {
  test("an unknown tool is an ordinary error result, never a throw", async () => {
    const env = await fixtureEnv();
    const result = await callToolSandboxed({ env, name: "no-such-tool", args: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown tool");
  });
});

describe("sandbox: true — the shared OS write sandbox for any tool", () => {
  test("the registry carries the flag; the published catalog strips it", async () => {
    const env = await fixtureEnv();
    expect(env.toolEntry("jailed").sandbox).toBe(true);
    expect(env.toolEntry("slow").sandbox).toBeUndefined();
    const published = env.toolSchemas().find((t) => t.name === "jailed");
    expect(published.sandbox).toBeUndefined(); // harness metadata never reaches the provider
    expect(published.description).toContain("TEST ONLY");
  });

  test("a sandboxed tool forks even with toolCall.fork:false (the jail needs the boundary)", async () => {
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "jailed", {}), DONE],
      [...TEXT(0, "ok"), DONE],
    ]);
    const agent = new Agent({
      env, model: "p/m", context: [], createIO: () => io,
      toolCall: { fork: false }, // crash-proofing off — the sandbox still forks
    });
    await agent.run({});
    const [result] = toolResults(agent);
    const pid = Number(/^pid (\d+):/.exec(result.content[0].text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid); // ran in the worker, not in-process
  });

  test("a forked write tool retains the agent cwd and may write a project sibling", async () => {
    const project = mkdtempSync("./ai-tmp/sandbox-project-");
    const folder = `${project}/agent`;
    mkdirSync(folder);
    const env = new Env({ dir: project, cwd: project, settings: {} });
    await env.loadTools();
    const agent = new Agent({ env });
    agent.setFolder("agent");
    const result = await callToolSandboxed({
      env, name: "write", args: { path: "../sibling.txt", content: "sibling" },
      sandbox: true, cwd: agent.folder,
    });
    expect(result).toEqual({ ok: true, value: "Successfully wrote to ../sibling.txt" });
    expect(readFileSync(`${project}/sibling.txt`, "utf8")).toBe("sibling");
  });

  test("the kernel denies every unsafe untrusted tool's outside write", async () => {
    const kind = osSandboxKind();
    if (kind === null || kind === "delegated") return; // no LOCAL jail (an outer jail's profile is not ours to probe)
    const env = await fixtureEnv();
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "jailed", {}), ...TOOLCALL(1, "c2", "unjailed", {}), DONE],
      [...TEXT(0, "ok"), DONE],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    await agent.run({});
    const results = toolResults(agent);
    const jailed = results.find((m) => m.name === "jailed");
    const unjailed = results.find((m) => m.name === "unjailed");
    expect(jailed.content[0].text).toContain("outside write refused");
    expect(unjailed.content[0].text).toContain("outside write refused");
  });

  test("callToolSandboxed sandbox:true wraps the worker argv in the OS sandbox (and spawns detached)", async () => {
    const env = await fixtureEnv();
    const spawned = [];
    const { EventEmitter } = await import("node:events");
    const spawnImpl = (file, argv, options) => {
      spawned.push({ file, argv, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const pipe = () => ({ ended: 0, destroyed: 0, end() { this.ended++; }, destroy() { this.destroyed++; }, on() {}, setEncoding() {} });
      child.stdin = { end: () => {}, on: () => {}, write: () => {} };
      child.stdio = [child.stdin, child.stdout, child.stderr, pipe(), pipe()];
      child.pid = 424242;
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 1)); // no result line: ordinary failure
      return child;
    };
    const result = await callToolSandboxed({ env, name: "slow", args: {}, sandbox: true, spawnImpl });
    expect(result.ok).toBe(false); // the fake child produced no result
    const [call] = spawned;
    expect(call.options.detached).toBe(true);
    await callToolSandboxed({ env, name: "slow", args: {}, sandbox: true, detached: false, spawnImpl });
    expect(spawned[1].options.detached).toBe(false);
    expect(call.options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", "pipe"]);
    expect(call.options).toHaveProperty("detached");
    const kind = osSandboxKind();
    if (kind === null || kind === "delegated") {
      expect(call.file).toBe(process.execPath); // no local wrap (none, or the outer jail enforces)
    } else {
      expect(call.file).not.toBe(process.execPath); // the sandbox wrapper leads
      expect(call.argv).toContain(process.execPath); // ...with the worker program inside
      if (process.platform !== "win32") expect(call.options.detached).toBe(true); // group kill reaches the jailed child
    }
  });
});
