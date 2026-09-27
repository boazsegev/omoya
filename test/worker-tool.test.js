import { describe, expect, test } from "bun:test";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { worker_create } from "../tools/worker-create.js";

function setup() {
  const env = new Env({ settings: { maxActive: 4 } });
  env._endpoints.ep = { provider: "test" };
  env.agentsAvailable = () => 1;
  const manager = new Agent({ env, model: "ep/m", spawnPermission: true, createIO: () => ({ state: "idle" }) });
  manager.send = function send(message) { this._pending.push(message); return Promise.resolve({ type: "done" }); };
  const create = env.agentCreate.bind(env);
  env.agentCreate = (options) => create({ ...options, createIO: () => ({ state: "idle", write: async () => ({ type: "done" }) }) });
  return { manager };
}

describe("worker response routing", () => {
  test("routes completed responses from every direct worker without invoking worker tools", () => {
    const { manager } = setup();
    const child = manager.childCreate({ name: "direct", model: "ep/m" });
    child.send = function send(message) { this._pending.push(message); return Promise.resolve({ type: "done" }); };
    const grandchild = child.childCreate({ name: "nested", model: "ep/m" });
    const text = { type: "text", text: "finished" };
    for (const message of [
      { type: MessageType.Assistant, content: [{ type: "thinking", text: "private" }] },
      { type: MessageType.Assistant, content: [text], incomplete: true },
      { type: MessageType.Assistant, content: [{ type: "toolCall", name: "read" }] },
    ]) child._emit(Agent.EVENT.MESSAGE_COMMITTED, message);
    expect(manager.pending).toHaveLength(0);
    child._emit(Agent.EVENT.MESSAGE_COMMITTED, { type: MessageType.Assistant, content: [text] });
    expect(manager.pending.at(-1)).toEqual({ type: MessageType.User, content: [
      { type: "text", text: '[Message from worker: "direct"]\n' }, text,
    ], worker: "direct" });
    grandchild._emit(Agent.EVENT.MESSAGE_COMMITTED, { type: MessageType.Assistant, content: [text] });
    expect(manager.pending).toHaveLength(1);
    expect(child.pending.at(-1)?.worker).toBe("nested");
  });

  test("routes immutable mixed assistant content with provenance", async () => {
    const { manager } = setup();
    await worker_create({ workers: [{ name: "r" }], prompt: "work" }, { agent: manager });
    const child = manager.children[0];
    const content = [{ type: "text", text: "done" }, { type: "image", mime: "image/png", content: "x" }];
    const message = { type: MessageType.Assistant, content };
    child._emit(Agent.EVENT.MESSAGE_COMMITTED, message);
    const report = manager.pending.at(-1);
    expect(report.worker).toBe("r");
    expect(report.content).toEqual([{ type: "text", text: "[Message from worker: \"r\"]\n" }, ...content]);
    expect(message.content).toBe(content);
    child._parentClosed();
    child._emit(Agent.EVENT.MESSAGE_COMMITTED, message);
    expect(manager.pending.filter((item) => item.worker === "r")).toHaveLength(1);
  });
});
