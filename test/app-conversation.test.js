import { expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import Context from "../lib/context.js";
import { conversationCreate, conversationActivate } from "../lib/app/host/conversation.js";
import { readFileSync } from "node:fs";
import { questionBridgeInstall } from "../lib/app/host/question-bridge.js";
import { testEnv } from "./fakes.js";

const { messageUser } = Context;

test("fork creates an independent agent and leaves the old file and messages unchanged", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, contextId: "app-fork-source" });
  old.context.append(messageUser("one"));
  old.context.append({ type: Context.MessageType.Assistant, content: [{ type: "text", text: "two" }] });
  old.context.flush();
  const count = old.context.length;
  const original = readFileSync(old.context.file, "utf8");
  const fresh = await conversationCreate(old, { kind: "fork", id: "app-fork-child", through: count - 1 });
  expect(fresh).not.toBe(old);
  expect(old.context.length).toBe(count);
  expect(fresh.context.length).toBe(count - 1);
  expect(fresh.context.messages()).toEqual(old.context.messages().slice(0, count - 1));
  expect(fresh.context.id).toBe("app-fork-child");
  conversationActivate(fresh);
  expect(readFileSync(old.context.file, "utf8")).toBe(original);
  await expect(conversationCreate(old, { kind: "fork", id: "app-fork-child" })).rejects.toThrow(/already exists/);
  expect(readFileSync(old.context.file, "utf8")).toBe(original);
  expect(fresh.usage.inputTokens).toBe(0);
  expect(fresh.pending).toEqual([]);
  await fresh.close(); await old.close(); await env.close();
});

test("failed resume retains the old agent and the environment", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, contextId: "app-existing" });
  await expect(conversationCreate(old, { kind: "resume", id: "app-missing" })).rejects.toThrow(/no session/);
  expect(old.closed).toBe(false);
  expect(env.agents()).toContain(old);
  await old.close(); await env.close();
});

test("new Agent keeps Agent preferences but not pending work", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, model: "p/m", contextId: false,
    folder: env.folder, can: { write: false, delegate: false } });
  old.thinking = "high";
  const fresh = await conversationCreate(old, { kind: "new" });
  expect(fresh.model).toBe(old.model);
  expect(fresh.can.write).toBe(false);
  expect(fresh.thinking).toBe("high");
  expect(fresh.folder).toBe(old.folder);
  expect(fresh.can.delegate).toBe(false);
  expect(fresh.pending).toEqual([]);
  expect(fresh.usage.inputTokens).toBe(0);
  await fresh.close(); await old.close(); await env.close();
});

test("replacement checks idle and input bounds before constructing", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, contextId: "app-guard-source" });
  await expect(conversationCreate(old, { kind: "fork", through: -1 })).rejects.toThrow(/boundary/);
  await expect(conversationCreate(old, { kind: "fork", through: 1.5 })).rejects.toThrow(/boundary/);
  await expect(conversationCreate(old, { kind: "wrong" })).rejects.toThrow(/unknown conversation/);
  Object.defineProperty(old, "busy", { configurable: true, value: true });
  await expect(conversationCreate(old, { kind: "new" })).rejects.toThrow(/running/);
  delete old.busy;
  const fresh = await conversationCreate(old, { kind: "new" });
  expect(fresh.pending).toEqual([]);
  expect(fresh.usage.inputTokens).toBe(0);
  await fresh.close(); await old.close(); await env.close();
});

test("same-id restart stages until the previous file closes", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, contextId: "app-restart-source" });
  old.context.append(messageUser("previous"));
  old.context.flush();
  const original = readFileSync(old.context.file, "utf8");
  const fresh = await conversationCreate(old, { kind: "new", id: old.context.id });
  expect(readFileSync(old.context.file, "utf8")).toBe(original);
  expect(fresh.context.save).toBe(false);
  expect(fresh.context.file).toBe(old.context.file);
  await old.close();
  conversationActivate(fresh);
  expect(fresh.context.save).toBe(true);
  expect(fresh.context.messages().some((message) => JSON.stringify(message).includes("previous"))).toBe(false);
  expect(Context.fileOf({ id: "app-restart-source", dir: env.settings.sessions })).toBeUndefined();
  await fresh.close(); await env.close();
});

test("factory failure leaves the source file and Agent usable", async () => {
  const env = await testEnv();
  const old = await Agent.create({ env, contextId: "app-failure-source" });
  old.context.append(messageUser("keep")); old.context.flush();
  const original = readFileSync(old.context.file, "utf8");
  const factory = env.agentCreate;
  env.agentCreate = () => { throw new Error("factory failed"); };
  try {
    await expect(conversationCreate(old, { kind: "new", id: old.context.id })).rejects.toThrow(/factory failed/);
    expect(readFileSync(old.context.file, "utf8")).toBe(original);
    expect(old.closed).toBe(false);
    expect(env.agents()).toContain(old);
  } finally { env.agentCreate = factory; await old.close(); await env.close(); }
});

test("an acquired environment remains alive while the replacement is built", async () => {
  const old = await Agent.create({ contextId: false });
  const env = old.env;
  try {
    const fresh = await conversationCreate(old, { kind: "new" });
    expect(fresh.env).toBe(env);
    expect(env.agents()).toContain(fresh);
    await old.close();
    expect(env.agents()).toContain(fresh);
    await fresh.close();
  } finally { if (!old.closed) await old.close(); await env.close(); }
});

test("question bridge restores conditionally", () => {
  const agent = { question: { ask: () => null } };
  const prior = agent.question;
  const bridge = { ask: () => [] };
  const restore = questionBridgeInstall(agent, bridge);
  expect(agent.question).toBe(bridge);
  restore();
  expect(agent.question).toBe(prior);
  const newer = questionBridgeInstall(agent, bridge);
  restore(); // stale disposer cannot clobber a newer installation of the same object
  expect(agent.question).toBe(bridge);
  newer();
  expect(agent.question).toBe(prior);
  const conditional = questionBridgeInstall(agent, bridge);
  agent.question = prior;
  conditional();
  expect(agent.question).toBe(prior);
});
