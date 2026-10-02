import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Core from "../lib/index.js";
import Agent from "../lib/agent.js";
import Context from "../lib/context.js";
import IO from "../lib/io.js";
import { callToolSandboxed } from "../lib/agent/tool-sandbox.js";
import { testEnv, USER } from "./fakes.js";

describe("revised API ownership and lifecycle", () => {
  test("a Context deeply owns its seeds while its read APIs remain live", () => {
    const source = new Context({ messages: [{ ...USER("original"), extra: { nested: [1] } }], save: false });
    const fork = new Context({ messages: source.messages(), save: false });
    fork.at(0).content[0].text = "fork";
    fork.at(0).extra.nested.push(2);
    expect(source.at(0).content[0].text).toBe("original");
    expect(source.at(0).extra.nested).toEqual([1]);
    expect(fork.messages()[0]).toBe(fork.at(0));
    source.close(); fork.close();
  });

  test("Agent model assignments validate, resolve policy, and record settings", async () => {
    const env = await testEnv();
    env.settings.providers.p.models = { a: { context: { cap: 0.1 } }, b: { context: { cap: 0.8 } } };
    const agent = new Agent({ env, model: "p/a" });
    expect(() => { agent.model = "p/missing"; }).toThrow(/unknown model/);
    expect(agent.model).toBe("p/a");
    agent._contextReport = { used: 100, total: 100 };
    agent._planUsage = { quotas: { old: { remaining: 0 } } };
    agent.model = "p/b";
    expect(agent.contextUsage.total).not.toBe(100);
    expect(agent.planUsage).toBeNull();
    expect(agent.policy.context.cap).toBe(0.8);
    expect(agent.context.settings.model).toBe("p/b");
    expect(agent.modelSet).toBeUndefined();
    expect(() => agent.run({ model: "p/a" })).toThrow(/model/);
    agent.close(); env.close();
  });

  test("a model assignment during a request governs subsequent tool rounds", async () => {
    const env = await testEnv({ providers: { p: { provider: "test", models: { a: {}, b: {} } } } });
    const used = []; let agent;
    const createIO = ({ model }) => ({ state: "idle", async write() {
      used.push(model);
      if (model === "p/a") {
        agent.model = "p/b";
        return { type: "done", message: { type: 3, content: [{ type: "toolCall", name: "probe", arguments: {}, callId: "probe" }] } };
      }
      return { type: "done" };
    } });
    env.toolAdd("probe", (_, context) => context.selector, { safe: true, inputSchema: {} });
    agent = new Agent({ env, model: "p/a", createIO });
    await agent.run();
    expect(used).toEqual(["p/a", "p/b"]);
    expect(agent.context.at(-1).content[0].text).toBe("p/b");
    agent.close(); env.close();
  });

  test("IO model assignments validate the same endpoint and preserve failed state", async () => {
    const env = await testEnv();
    await env._providersLoad({ detect: false });
    const io = new IO({ env, model: "p/a", remember: false });
    io.model = "p/b";
    expect(io.model).toBe("p/b");
    expect(() => { io.model = "p2/b"; }).toThrow(/endpoint/);
    expect(io.model).toBe("p/b");
    await io.close();
    expect(() => { io.model = "p/c"; }).toThrow(/closed/);
    env.close();
  });

  test("failed child construction leaves no child or environment membership", async () => {
    const env = await testEnv();
    const parent = new Agent({ env });
    expect(() => new Agent({ env, parent, toolCall: { timeout: "bad" } })).toThrow();
    expect(parent.children).toEqual([]);
    expect(env.agents()).toEqual([parent]);
    parent.close(); env.close();
  });

  test("an Agent closed by its registration observer retains no finish hook", async () => {
    const env = await testEnv();
    env.onEvent(Agent.Env.EVENT.AGENT_ADDED, ({ agent }) => agent.close());
    const agent = new Agent({ env });
    let flushed = false;
    agent.context.flush = () => { flushed = true; };
    Agent.finishRun();
    expect(flushed).toBe(false);
    expect(env.agents()).toEqual([]);
    env.close();
  });

  test("failed membership notifications roll back child ownership", async () => {
    const env = await testEnv();
    const parent = new Agent({ env });
    const handle = env.onEvent(Agent.Env.EVENT.AGENT_ADDED, () => { throw new Error("registration refused"); });
    expect(() => parent.childCreate({ name: "failed" })).toThrow(/registration refused/);
    expect(parent.children).toEqual([]);
    expect(env.agents()).toEqual([parent]);
    env.offEvent(handle); parent.close(); env.close();
  });

  test("question bridge disposers cannot remove a newer installation", async () => {
    const env = await testEnv(); const agent = new Agent({ env });
    const first = { ask: async () => [] }, second = { ask: async () => [] };
    const release = agent.questionInstall(first);
    const releaseSecond = agent.questionInstall(second);
    release();
    expect(agent.question).toBe(second);
    releaseSecond();
    expect(agent.question).toBe(first);
    agent.question = null;
    agent.close(); env.close();
  });

  test("throwing lifecycle subscribers cannot prevent cleanup", async () => {
    const env = await testEnv();
    const agent = new Agent({ env });
    agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => { throw new Error("marked listener"); });
    agent.onEvent(Agent.EVENT.CLOSED, () => {
      expect(env.agents()).not.toContain(agent);
      throw new Error("closed listener");
    });
    expect(() => agent.close()).toThrow();
    expect(agent.closed).toBe(true);
    expect(env.agents()).not.toContain(agent);
    expect(() => agent.context.append(USER("late"))).toThrow(/closed/);
    expect(agent.close()).toBe(false);
    env.close();
  });

  test("worker environment cannot reload auth from its settings files", async () => {
    const env = await testEnv();
    const root = resolve(env.folders.find(({ kind }) => kind === "harness").path);
    env._dir = root;
    writeFileSync(join(root, "auth-review.json"), JSON.stringify({ review: { auth: { token: "disk-secret" } } }));
    const file = join(root, "auth-probe.js");
    writeFileSync(file, `export function toolDescription() { return { probe: { description: "probe", safe: true, inputSchema: {} } }; }
export function probe(_, {env}) { return JSON.stringify(env.settings).includes('"auth"'); }
`);
    const result = await callToolSandboxed({ env, name: "probe", file, args: {} });
    expect(result).toEqual({ ok: true, value: false });
    env.close();
  });

  test("model catalogs no longer expose endpoint classification", async () => {
    const env = await testEnv({ providers: { p: { models: { a: {} } } } });
    expect(env.settingsSchema().modelAccess).toBeUndefined();
    expect(env.models(true).get("p/a")).not.toHaveProperty("local");
    expect(env.models(true).get("p/a")).not.toHaveProperty("remote");
    env.close();
  });

  test("root namespace publishes no private statics", () => {
    expect(Object.keys(Core).filter((name) => name.startsWith("_"))).toEqual([]);
  });

  test("tool worker data strips every nested auth field without altering Env", async () => {
    const env = await testEnv({ extra: { auth: { token: "secret" }, records: [{ auth: "secret", keep: 1 }] }, test: { auth: { token: "secret" } } });
    let request;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdio = [];
      child.stdin = { on() {}, end(raw) {
        request = JSON.parse(raw);
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from('{"ok":true,"value":null}\n')); child.emit("close", 0); });
      } };
      return child;
    };
    await callToolSandboxed({ env, name: "read", file: "./tools/read.js", args: { nested: { auth: "secret", keep: true } }, scope: { track() {} }, spawnImpl });
    expect(JSON.stringify(request)).not.toContain('"auth"');
    expect(request.settings.extra.records).toEqual([{ keep: 1 }]);
    expect(env.settings.extra.auth.token).toBe("secret");
    env.close();
  });
});
