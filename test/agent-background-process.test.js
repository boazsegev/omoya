import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import Sandbox from "../lib/sandbox.js";
import { processJoin, processList, processOutput, processStop, toolDescription as processDescription } from "../tools/process.js";
import { scriptedIO } from "./fakes.js";

const ROOT = `./ai-tmp/procs/${process.pid}`;
const instances = [];
afterEach(async () => {
  for (const [agent, env] of instances.splice(0)) { await agent.close(); await env.close(); }
  rmSync(ROOT, { recursive: true, force: true });
});

async function setup(name) {
  mkdirSync(`${ROOT}/${name}`, { recursive: true });
  const cwd = resolve(`${ROOT}/${name}`);
  const env = await Env.open(cwd, { dir: cwd, settingsDir: cwd, settings: { providers: { fixture: { provider: "test", url: "test://script" } } }, init: { providers: false, models: false } });
  const agent = await Agent.create({ env, model: "fixture/m", createIO: () => scriptedIO([]) });
  instances.push([agent, env]);
  return { agent, env };
}

const backgroundFor = (agent) => ({
  list: () => Sandbox.backgroundList(agent),
  output: (id, from) => Sandbox.backgroundOutput(agent, id, from),
  stop: (id) => Sandbox.backgroundStop(agent, id),
  join: (id, timeout) => Sandbox.backgroundJoin(agent, id, timeout),
});

async function invoke(agent, name, args) {
  return agent._callTool(name, args, { name, callId: "test" });
}

async function started(agent, command) {
  return invoke(agent, "bash", { command, background: true });
}

describe("Agent-owned background bash", () => {
  test("starts, reports first output and reads incremental byte offsets and exit code", async () => {
    const { agent } = await setup("read");
    const first = await started(agent, "printf 'begin\\n'; sleep 2; printf 'end\\n'; exit 3");
    expect(first.id).toBe("1");
    expect(first.output).toContain("begin");
    expect((await processList({}, { agent, background: backgroundFor(agent) }))[0].state).toBe("running");
    expect((await invoke(agent, "process-list", {}))[0].id).toBe(first.id);
    expect((await invoke(agent, "process-output", { id: first.id, from: first.next })).output).toBe("");
    const output = Sandbox.backgroundOutput(agent, first.id, first.next);
    expect(output.output).toBe("");
    await Bun.sleep(2200);
    expect(Sandbox.backgroundOutput(agent, first.id, first.next).output).toContain("end");
    expect(Sandbox.backgroundList(agent)[0].state).toBe("exited(3)");
  });

  test("join returns bash-formatted streams and exit code, including completed processes", async () => {
    const { agent } = await setup("join-output");
    const startedProcess = await started(agent, "printf 'out\\n'; printf 'err\\n' >&2; sleep 1; exit 7");
    expect(await invoke(agent, "process-join", { id: startedProcess.id, timeout: 3000 })).toBe("[exit code 7]\nout\n[stderr]\nerr");
    expect(await invoke(agent, "process-join", { id: startedProcess.id })).toBe("[exit code 7]\nout\n[stderr]\nerr");
    expect(await invoke(agent, "bash", { command: "printf 'out\\n'; printf 'err\\n' >&2; exit 7" })).toBe("[exit code 7]\nout\n[stderr]\nerr");
    await expect(invoke(agent, "process-join", { id: "unknown" })).rejects.toThrow(/Unknown process/);
  });

  test("join timeout starts on join, stops process group and returns bash-style result", async () => {
    const { agent } = await setup("join-timeout");
    const startedProcess = await started(agent, "printf 'before\\n'; sleep 30 & wait");
    await Bun.sleep(150);
    const before = Date.now();
    const result = await invoke(agent, "process-join", { id: startedProcess.id, timeout: 100 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(90);
    expect(Date.now() - before).toBeLessThan(2500);
    expect(result).toMatch(/^\[exit code (\?|\d+)\]\nbefore$/);
    expect(Sandbox.backgroundList(agent)[0].state).not.toBe("running");
    expect(await processJoin({ id: startedProcess.id, timeout: 10 }, { background: backgroundFor(agent) })).toBe(result);
  });

  test("inherits foreground cwd and filtered child environment", async () => {
    const key = "OMOYA_BACKGROUND_REFUSE_TEST";
    const previous = process.env[key];
    process.env[key] = "secret";
    const { agent, env } = await setup("child-env");
    env.settings.env[key] = false;
    try {
      const result = await started(agent, `printf '%s:%s' "$PWD" "\${${key}-absent}"`);
      expect(result.output).toContain(`${resolve(`${ROOT}/child-env`)}:absent`);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("bounds captured output and reports dropped bytes", async () => {
    const { agent } = await setup("ring");
    const result = await started(agent, "head -c 300000 /dev/zero | tr '\\0' X");
    expect(result.previewTruncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4000);
    const output = Sandbox.backgroundOutput(agent, result.id);
    expect(output.next).toBe(300000);
    expect(output.dropped).toBe(300000 - 256 * 1024);
    expect(Buffer.byteLength(output.output)).toBe(256 * 1024);
    expect(Sandbox.backgroundOutput(agent, result.id, output.next).output).toBe("");
  });

  test("stop kills process group, and Agent and Env close stop retained commands", async () => {
    const { agent, env } = await setup("lifecycle");
    const child = await started(agent, "sleep 30 & wait");
    await processStop({ id: child.id }, { agent, background: backgroundFor(agent) });
    expect(Sandbox.backgroundList(agent)[0].state).not.toBe("running");
    const managed = await started(agent, "sleep 30 & wait");
    await invoke(agent, "process-stop", { id: managed.id });
    expect(Sandbox.backgroundList(agent).find((item) => item.id === managed.id).state).not.toBe("running");
    const second = await started(agent, "sleep 30 & wait");
    const pid = Sandbox.backgroundList(agent)[2].id;
    expect(pid).toBe(second.id);
    await agent.close();
    const another = await setup("envclose");
    const third = await started(another.agent, "sleep 30");
    await another.env.close();
    expect(Sandbox.backgroundList(another.agent).find((item) => item.id === third.id)?.state).not.toBe("running");
    await env.close();
  }, 12000);

  test("backgroundStopAll never signals an exited leader's stale process group", async () => {
    const { agent } = await setup("exited-group");
    const finished = await started(agent, "printf done");
    expect(Sandbox.backgroundList(agent).find((item) => item.id === finished.id)?.state).not.toBe("running");
    const originalKill = process.kill;
    const signalled = [];
    process.kill = (pid, signal) => { signalled.push([pid, signal]); return true; };
    try { await Sandbox.backgroundStopAll(agent); }
    finally { process.kill = originalKill; }
    expect(signalled).toEqual([]);
  });

  test("backgroundStopAll exposes the pending process close barrier", async () => {
    const { agent } = await setup("close-barrier");
    const child = await started(agent, "trap '' TERM; while :; do sleep 1; done");
    const stopped = Sandbox.backgroundStopAll(agent);
    expect(stopped).toBeInstanceOf(Promise);
    let complete = false;
    void stopped.then(() => { complete = true; });
    expect(complete).toBe(false);
    await stopped;
    expect(complete).toBe(true);
    expect(Sandbox.backgroundList(agent)).toEqual([]);
    expect(child.id).toBe("1");
  }, 12000);

  test("limits eight running commands and isolates ids by Agent", async () => {
    const { agent } = await setup("limit");
    const other = await setup("other");
    const results = await Promise.all(Array.from({ length: 8 }, () => started(agent, "sleep 30")));
    expect(results.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    await expect(started(agent, "sleep 30")).rejects.toThrow(/limit/);
    expect((await started(other.agent, "printf other")).id).toBe("1");
    await expect(processOutput({ id: "8" }, { agent: other.agent, background: backgroundFor(other.agent) })).rejects.toThrow(/Unknown process/);
  });

  test("safe mode rejects background bash and stop but allows list/output", async () => {
    expect(processDescription()["process-stop"].safe).not.toBe(true);
    expect(processDescription()["process-join"].safe).not.toBe(true);
    expect(processDescription()["process-output"].safe).toBe(true);
    expect(processDescription()["process-list"].safe).toBe(true);
    expect(processDescription()["process-output"].inputSchema.required).toEqual(["id"]);
    expect(processDescription()["process-stop"].inputSchema.required).toEqual(["id"]);
    expect(processDescription().process).toBeUndefined();
    const { agent, env } = await setup("safe");
    const startedProcess = await started(agent, "sleep 30");
    await expect(processStop({ id: startedProcess.id }, { agent, background: backgroundFor(agent), safe: true })).rejects.toThrow(/safe mode/);
    expect((await processList({}, { agent, background: backgroundFor(agent), safe: true })).length).toBe(1);
    expect((await processOutput({ id: startedProcess.id }, { agent, background: backgroundFor(agent), safe: true })).next).toBe(0);
    const previous = agent.can.write;
    agent.can.write = false;
    try {
      await expect(started(agent, "echo bad")).rejects.toThrow(/safe mode/);
      const safeTools = await env.tools(true, agent.model);
      expect(safeTools.has("process-stop")).toBe(false);
      expect(safeTools.has("process-join")).toBe(false);
      expect(safeTools.has("process-list")).toBe(true);
      expect(safeTools.has("process-output")).toBe(true);
      const refused = await agent._execute({ name: "process-stop", callId: "safe-stop", arguments: { id: startedProcess.id } });
      expect(refused.message.error).toBe(true);
      expect(Sandbox.backgroundList(agent)[0].state).toBe("running");
    } finally { agent.can.write = previous; }
  });
});
