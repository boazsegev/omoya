import { describe, expect, test } from "bun:test";
import { mcpConnect } from "../lib/env/mcp-client.js";
import { once } from "node:events";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, TOOLCALL, TEXT } from "./fakes.js";
import { toolsLoad } from "./env-internals.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("cancellation did not settle")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function register(env, fn, extra = {}) {
  env.toolAdd("pending", fn, { safe: true, description: "Cancellation probe",
    inputSchema: { type: "object", properties: {} }, ...extra });
}

function createAgent(env, calls, options = {}) {
  const io = scriptedIO([[...calls, { type: "done" }], [...TEXT(0, "resumed"), { type: "done" }]]);
  const agent = new Agent({ env, model: "p/m", contextId: false, context: [], createIO: () => io, ...options });
  return { agent, io };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

describe("dispatch-owned cancellation", () => {
  test("cancellation from TOOL_EXECUTE never invokes the call or its concurrent siblings", async () => {
    const env = await testEnv();
    let invoked = 0;
    register(env, () => { invoked++; return "wrong"; });
    const calls = [0, 1, 2].flatMap((id) => TOOLCALL(id, `c${id}`, "pending", {}));
    const { agent, io } = createAgent(env, calls);
    agent.onEvent(Agent.EVENT.TOOL_EXECUTE, () => { void agent.cancel(); });
    try {
      expect(await bounded(agent.run())).toMatchObject({ kind: "cancelled" });
      expect(invoked).toBe(0);
      expect(agent._activeTools.size).toBe(0);
      expect(io.turns()).toBe(1);
    } finally { agent.close(); }
  });

  test("one cancel interrupts every active call but never starts queued calls", async () => {
    const env = await testEnv({ tools: { concurrency: 2 } });
    const ready = deferred();
    const started = [];
    const aborted = [];
    register(env, ({ id }, { signal }) => new Promise((resolve) => {
      started.push(id);
      signal.addEventListener("abort", () => { aborted.push(id); resolve("stopped"); }, { once: true });
      if (started.length === 2) ready.resolve();
    }));
    const calls = [0, 1, 2, 3].flatMap((id) => TOOLCALL(id, `c${id}`, "pending", { id }));
    const { agent, io } = createAgent(env, calls);
    const run = agent.run();
    try {
      await bounded(ready.promise);
      await bounded(Promise.all([agent.cancel(), agent.cancel()]));
      expect(await bounded(run)).toMatchObject({ kind: "cancelled" });
      expect(started).toEqual([0, 1]);
      expect(aborted).toEqual([0, 1]);
      expect(io.turns()).toBe(1);
      expect(agent._activeTools.size).toBe(0);
      expect((await agent.run()).type).toBe("done");
    } finally { await agent.cancel(); agent.close(); }
  });

  test("cancel interrupts a pending onTimeout callback without waiting for its grace period", async () => {
    const env = await testEnv({ tools: { timeout: 10 } });
    const ready = deferred();
    const cleanup = deferred();
    register(env, () => new Promise(() => {}), {
      onTimeout: () => { ready.resolve(); return cleanup.promise; },
    });
    const { agent } = createAgent(env, TOOLCALL(0, "c1", "pending", {}));
    const run = agent.run();
    try {
      await bounded(ready.promise);
      await bounded(agent.cancel());
      expect(await bounded(run, 250)).toMatchObject({ kind: "cancelled" });
      expect(agent._activeTools.size).toBe(0);
    } finally { cleanup.resolve(); await run; agent.close(); }
  });

  test("cancel tears down a process spawned by an in-process tool through its sandbox", async () => {
    const env = await testEnv();
    const ready = deferred();
    let child;
    register(env, (_args, context) => new Promise(() => {
      child = context.sandbox.spawn(process.execPath, ["--eval", "setTimeout(() => {}, 30000)"],
        { stdio: "ignore" });
      child.once("spawn", () => ready.resolve());
    }));
    const { agent } = createAgent(env, TOOLCALL(0, "c1", "pending", {}));
    const run = agent.run();
    try {
      await bounded(ready.promise);
      await bounded(agent.cancel());
      expect(await bounded(run)).toMatchObject({ kind: "cancelled" });
      expect(isAlive(child.pid)).toBe(false);
    } finally { child?.kill("SIGKILL"); await agent.cancel(); await run; agent.close(); }
  });

  test("cancel after a pooled MCP handshake but before the next RPC still closes its server", async () => {
    const server = `cancel-gap-${process.pid}`;
    const env = await testEnv({ mcp: { [server]: { command: process.execPath,
      args: ["./test/fixtures/mcp-server.js"], safe: true } } });
    let conn;
    let invoked = false;
    register(env, async (_args, context) => {
      const { childEnv } = await import("../lib/util.js");
      conn = await mcpConnect(env._mcpPool, server, { ...env.settings.mcp[server],
        env: childEnv(env.settings) }, context);
      await new Promise((resolve) => {
        invoked = true;
        context.signal.addEventListener("abort", resolve, { once: true });
      });
    });
    const { agent } = createAgent(env, TOOLCALL(0, "c1", "pending", {}));
    const run = agent.run();
    try {
      for (let attempts = 0; attempts < 100 && !invoked; attempts++) await Bun.sleep(5);
      expect(invoked).toBe(true);
      await bounded(agent.cancel());
      expect(await bounded(run)).toMatchObject({ kind: "cancelled" });
      expect(isAlive(conn.child.pid)).toBe(false);
    } finally { conn?.child?.kill("SIGKILL"); await agent.cancel(); await run; agent.close(); }
  });

  test("onTimeout's final answer still closes running processes at dispatch teardown", async () => {
    const env = await testEnv({ tools: { timeout: 30 } });
    let child;
    register(env, (_args, context) => new Promise(() => {
      child = context.sandbox.spawn(process.execPath, ["--eval", "setTimeout(() => {}, 30000)"],
        { stdio: "ignore" });
    }), { onTimeout: () => "finished" });
    const { agent } = createAgent(env, TOOLCALL(0, "c1", "pending", {}));
    try {
      expect((await bounded(agent.run())).type).toBe("done");
      expect(agent.context.messages().find((entry) => entry.type === 4)?.content[0]?.text).toBe("finished");
      expect(isAlive(child.pid)).toBe(false);
    } finally { child?.kill("SIGKILL"); agent.close(); }
  });

  test("one cancel kills Bash and its command descendants, not just the worker", async () => {
    const env = await testEnv();
    env.cwd = process.cwd(); // the worker needs an existing absolute working directory
    await toolsLoad(env, { dirs: ["./tools"] });
    const ready = deferred();
    const pids = [];
    const command = "sleep 30 & printf 'ready:%s:%s\\n' \"$$\" \"$!\"; wait";
    const { agent } = createAgent(env, TOOLCALL(0, "c1", "bash", { command }));
    agent.onEvent(Agent.EVENT.TOOL_DATA, ({ chunk }) => {
      if (chunk.startsWith("ready:")) { pids.push(...chunk.slice(6).split(":").map(Number)); ready.resolve(); }
    });
    const run = agent.run();
    try {
      await bounded(ready.promise, 3000);
      await bounded(agent.cancel());
      expect(await bounded(run)).toMatchObject({ kind: "cancelled" });
      await Bun.sleep(100); // allow the OS to reap killed descendants
      expect(pids.map(isAlive)).toEqual([false, false]);
    } finally { pids.forEach(killGroup); await agent.cancel(); await run; agent.close(); }
  }, 10000);

  for (const phase of ["initialize", "tools/list", "tools/call"]) {
    test(`cancel tears down an MCP process and pending RPC during ${phase}`, async () => {
      const server = `cancel-${phase}`;
      const env = await testEnv({ mcp: { [server]: { command: process.execPath,
        args: ["./test/fixtures/mcp-cancel-server.js", phase], safe: true } } });
      await toolsLoad(env, { dirs: ["./tools"] });
      const ready = deferred();
      let conn;
      const args = phase === "tools/call" ? { action: "call", server, tool: "hang" } : { action: "tools", server };
      const { agent } = createAgent(env, TOOLCALL(0, "c1", "mcp", args));
      // Attach to the real process through the protocol pool at the spawn boundary.
      const run = agent.run();
      try {
        for (let attempt = 0; attempt < 100 && !conn; attempt++) {
          conn = [...env._mcpPool.values()].find((entry) => entry.name === server && !entry.closed);
          if (!conn) await Bun.sleep(5);
        }
        expect(conn).toBeDefined();
        conn.child.stderr.on("data", (chunk) => { if (String(chunk).includes("pending:")) ready.resolve(); });
        await bounded(ready.promise, 3000);
        const closed = once(conn.child, "close");
        await bounded(agent.cancel());
        expect(await bounded(run)).toMatchObject({ kind: "cancelled" });
        await bounded(closed, 500);
        expect(isAlive(conn.child.pid)).toBe(false);
        expect(conn.pending.size).toBe(0);
      } finally {
        conn?.child?.kill("SIGKILL");
        await agent.cancel(); await run; agent.close();
        for (const [key, value] of env._mcpPool) if (value === conn) env._mcpPool.delete(key);
      }
    }, 10000);
  }
});
