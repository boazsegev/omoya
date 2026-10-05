import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import { process as processTool, toolDescription as processDescription } from "../tools/process.js";
import { scriptedIO } from "./fakes.js";

const ROOT = `./ai-tmp/procs/${process.pid}`;
const instances = [];
afterEach(() => {
  for (const [agent, env] of instances.splice(0)) { agent.close(); env.close(); }
  rmSync(ROOT, { recursive: true, force: true });
});

async function setup(name) {
  mkdirSync(`${ROOT}/${name}`, { recursive: true });
  const cwd = resolve(`${ROOT}/${name}`);
  const env = await Env.create({ dir: cwd, cwd, settingsDir: cwd, settings: { providers: { fixture: { provider: "test", url: "test://script" } } } }, { providers: false, models: false });
  const agent = new Agent({ env, model: "fixture/m", createIO: () => scriptedIO([]) });
  instances.push([agent, env]);
  return { agent, env };
}

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
    expect((await processTool({ action: "list" }, { agent }))[0].state).toBe("running");
    const output = agent.backgroundOutput(first.id, first.next);
    expect(output.output).toBe("");
    await Bun.sleep(2200);
    expect(agent.backgroundOutput(first.id, first.next).output).toContain("end");
    expect(agent.backgroundList()[0].state).toBe("exited(3)");
  });

  test("inherits foreground cwd and filtered child environment", async () => {
    const key = "OMOYA_BACKGROUND_REFUSE_TEST";
    const previous = process.env[key];
    process.env[key] = "secret";
    const { agent, env } = await setup("child-env");
    env.settings["env-refuse"] = [key];
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
    const output = agent.backgroundOutput(result.id);
    expect(output.next).toBe(300000);
    expect(output.dropped).toBe(300000 - 256 * 1024);
    expect(Buffer.byteLength(output.output)).toBe(256 * 1024);
    expect(agent.backgroundOutput(result.id, output.next).output).toBe("");
  });

  test("stop kills process group, and Agent and Env close stop retained commands", async () => {
    const { agent, env } = await setup("lifecycle");
    const child = await started(agent, "sleep 30 & wait");
    await agent.backgroundStop(child.id);
    expect(agent.backgroundList()[0].state).not.toBe("running");
    const second = await started(agent, "sleep 30 & wait");
    const pid = agent.backgroundList()[1].id;
    expect(pid).toBe(second.id);
    agent.close();
    await Bun.sleep(1200);
    const another = await setup("envclose");
    const third = await started(another.agent, "sleep 30");
    another.env.close();
    await Bun.sleep(1200);
    expect(another.agent.backgroundList().find((item) => item.id === third.id).state).not.toBe("running");
    env.close();
  }, 12000);

  test("limits eight running commands and isolates ids by Agent", async () => {
    const { agent } = await setup("limit");
    const other = await setup("other");
    const results = await Promise.all(Array.from({ length: 8 }, () => started(agent, "sleep 30")));
    expect(results.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    await expect(started(agent, "sleep 30")).rejects.toThrow(/limit/);
    expect((await started(other.agent, "printf other")).id).toBe("1");
    await expect(processTool({ action: "output", id: "8" }, { agent: other.agent })).rejects.toThrow(/Unknown process/);
  });

  test("safe mode rejects background bash and stop but allows list/output", async () => {
    expect(processDescription().process.readOnly({ action: "stop" })).toBe(false);
    expect(processDescription().process.readOnly({ action: "output" })).toBe(true);
    const { agent } = await setup("safe");
    const startedProcess = await started(agent, "sleep 30");
    await expect(processTool({ action: "stop", id: startedProcess.id }, { agent, safe: true })).rejects.toThrow(/safe mode/);
    expect((await processTool({ action: "list" }, { agent, safe: true })).length).toBe(1);
    expect((await processTool({ action: "output", id: startedProcess.id }, { agent, safe: true })).next).toBe(0);
    const previous = agent.safe;
    agent.safe = true;
    try {
      await expect(started(agent, "echo bad")).rejects.toThrow(/safe mode/);
      const refused = await agent._execute({ name: "process", callId: "safe-stop", arguments: { action: "stop", id: startedProcess.id } });
      expect(refused.message.error).toBe(true);
      expect(agent.backgroundList()[0].state).toBe("running");
    } finally { agent.safe = previous; }
  });
});
