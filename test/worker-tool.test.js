import { describe, expect, test } from "bun:test";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { worker, toolDescription } from "../tools/worker.js";

function setup(permission = true) {
  const env = new Env({ settings: { maxActive: 4 } });
  env.endpoints.ep = { provider: "test" };
  env.agentEndpointAvailable = () => 1;
  const manager = new Agent({ env, model: "ep/m", ...(permission === null ? {} : { spawnPermission: permission }), createIO: () => ({ state: "idle" }) });
  manager.enqueue = function enqueue(message) { this._pending.push(message); return message; };
  return { env, manager };
}

describe("worker tool", () => {
  test("rejects an unknown worker endpoint or model without creating a child", async () => {
    const { env, manager } = setup();
    env.endpoints.ep.models = { known: {} };
    await expect(worker({ name: "x", prompt: "go", model: "missing/m" }, { agent: manager })).rejects.toThrow(/unknown endpoint/);
    await expect(worker({ name: "x", prompt: "go", model: "ep/missing" }, { agent: manager })).rejects.toThrow(/unknown model/);
    expect(manager.children).toHaveLength(0);
  });

  test("publishes non-secret provider/model candidates in one model field", () => {
    const env = new Env();
    env.endpoints.public = { provider: "test", models: { alpha: {} } };
    env.endpoints.private = { provider: "test", secret: true, models: { hidden: {} } };
    const schema = toolDescription(env).worker.inputSchema.properties.model;
    expect(schema.enum).toEqual(["public/alpha"]);
    expect(schema.description).toContain("public/alpha");
    expect(schema.description).not.toContain("private");
    expect(toolDescription(env).worker.description).toContain("role, concrete task, relevant context, constraints, deliverable, and acceptance checks");
    expect(schema.description).toContain("Omit to use your own model");
  });

  test("requires permission and the exact first prompt guidance", async () => {
    const { manager } = setup(false);
    await expect(worker({ name: "x", prompt: "go" }, { agent: manager })).rejects.toThrow("Proceed without a worker.");
    expect(manager.children).toHaveLength(0);
    manager.setSpawnPermission(true);
    await expect(worker({ name: "x" }, { agent: manager })).rejects.toThrow();
  });

  test("asks when permission is unset and persists only Allow or Deny", async () => {
    const { manager } = setup(null);
    const args = { name: "x", description: "Review the UI", prompt: "Inspect the flow." };
    let question;
    const allow = { ask: async (questions) => { question = questions[0]; return [{ labels: ["Allow"] }]; } };
    await worker(args, { agent: manager, question: allow });
    expect(manager.spawnPermission).toBe(true);
    expect(question.details).toBe("Review the UI");
    expect(question.options.map(({ label }) => label)).toEqual(["Allow", "Deny"]);

    const denied = setup(null).manager;
    await expect(worker(args, { agent: denied, question: { ask: async () => [{ labels: ["Deny"] }] } })).rejects.toThrow("Proceed without a worker.");
    expect(denied.spawnPermission).toBe(false);

    const custom = setup(null).manager;
    await expect(worker(args, { agent: custom, question: { ask: async () => [{ text: "please explain delegation for me to consider" }] } }))
      .rejects.toThrow("please explain delegation for me to consider");
    expect(custom.spawnPermission).toBeUndefined();
  });

  test("refuses unset permission without an available question bridge", async () => {
    const { manager } = setup(null);
    await expect(worker({ name: "x", prompt: "go" }, { agent: manager })).rejects.toThrow();
    expect(manager.spawnPermission).toBeUndefined();
  });

  test("creates through child ownership, inserts notice, and fans out overlaps", async () => {
    const { env, manager } = setup();
    env.endpoints.other = { provider: "test", models: { "child/model": {} } };
    await worker({ name: "selected", prompt: "work", model: "other/child/model" }, { agent: manager });
    expect(manager.children.find((child) => child.name === "selected").endpoint).toBe("other");
    expect(manager.children.find((child) => child.name === "selected").model).toBe("child/model");
    const first = manager.createChild({ name: "same", model: "ep/m" });
    const second = manager.createChild({ name: "same", model: "ep/m" });
    for (const child of [first, second]) child.enqueue = function enqueue(message) { this._pending.push(message); return message; };
    await worker({ name: "same", prompt: "work", info: true }, { agent: manager });
    expect(first.pending.at(-1).content[0].text).toBe("work");
    expect(second.pending.at(-1).content[0].text).toBe("work");
    expect(first.parent).toBe(manager);
    expect(first.spawnPermission).toBe(false);
  });

  test("creates a safe read-only worker only when requested", async () => {
    const { manager } = setup();
    await worker({ name: "reader", prompt: "inspect only", safe: true }, { agent: manager });
    const child = manager.children.find(({ name }) => name === "reader");
    expect(child.safe).toBe(true);

    const schema = toolDescription(manager.env).worker.inputSchema.properties.safe;
    expect(schema).toMatchObject({ type: "boolean" });
    expect(schema.description).toContain("read-only tools");

    await worker({ name: "reader", reset: true }, { agent: manager });
    expect(manager.children.find(({ name }) => name === "reader").safe).toBe(true);
  });

  test("routes immutable mixed assistant content with provenance", async () => {
    const { manager } = setup();
    await worker({ name: "r", prompt: "work" }, { agent: manager });
    const child = manager.children[0];
    const content = [{ type: "text", text: "done" }, { type: "image", mime: "image/png", content: "x" }];
    const message = { type: MessageType.Assistant, content };
    child._emit(Agent.EVENT.MESSAGE_COMMITTED, message);
    const report = manager.pending.at(-1);
    expect(report.worker).toBe("r");
    expect(report.content).toEqual([{ type: "text", text: "[Message from worker: \"r\"]" }, ...content]);
    expect(message.content).toBe(content);
    child._parentClosed();
    child._emit(Agent.EVENT.MESSAGE_COMMITTED, message);
    expect(manager.pending.filter((item) => item.worker === "r")).toHaveLength(1);
  });

  test("validates reset group before mutation and lists duplicate names", async () => {
    const { manager } = setup();
    const a = manager.createChild({ name: "x", model: "ep/m" });
    const b = manager.createChild({ name: "x", model: "ep/m" });
    Object.defineProperty(b, "busy", { value: true });
    await expect(worker({ name: "x", reset: true }, { agent: manager })).rejects.toThrow("Wait for every matched worker");
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
    const result = await worker({ name: "x", list: true }, { agent: manager });
    expect(result.workers.filter((child) => child.name === "x")).toHaveLength(2);
  });
});
