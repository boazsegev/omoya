// Agent.request: fresh responders, agent-bound contacts, replies, resume and permissions.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent } from "../lib/agent.js";
import Env from "../lib/env.js";
import { request as requestTool } from "../tools/request.js";
import { scriptedIO, testEnv, TEXT } from "./fakes.js";

const createIO = () => scriptedIO([[...TEXT(0, "ok"), { type: "done" }]]);
const opened = [];

async function caller(can = { request: true }, settings = {}) {
  const env = await testEnv(settings);
  opened.push(env);
  const agent = await Agent.create({ env, model: "p/m", can, createIO, contextId: crypto.randomUUID() });
  return { env, agent };
}

/** The agent's latest received request text (queued or in context). */
function lastRequest(agent) {
  const messages = [...agent.context.messages(), ...agent.pending].filter((message) => message.type === 2);
  return messages.at(-1)?.content.map((part) => part.text).join("") ?? "";
}

const settle = async (agent) => { while (agent.busy) await Bun.sleep(5); };
const responderOf = (env, agent) => env.agents().find((candidate) => candidate !== agent && !candidate.parent);

afterAll(async () => {
  for (const env of opened) {
    await Promise.allSettled(env.agents().map((agent) => agent.close()));
    await env.close().catch(() => {});
  }
});

describe("Agent.request", () => {
  test("new:<name>@this starts an inheriting responder that can reply to its contact", async () => {
    const { env, agent } = await caller({ request: true, delegate: true });
    agent.name = "asker";
    const address = await agent.request({ to: "new:math@this", prompt: "What is 2+2?", safe: true });
    expect(address).toBe("math@this");
    expect(env.agents().some((candidate) => candidate.name === "math")).toBe(true);
    expect(agent.contacts).toEqual([address]);
    const responder = responderOf(env, agent);
    expect(responder.parent).toBeUndefined();
    expect(responder.can.write).toBe(false);
    expect(responder.can.delegate).toBe(true);
    expect(responder.can.request).toBe(true);
    expect(responder.model).toBe(agent.model);
    expect(responder.context.save).toBe(true);
    expect(responder.contacts).toEqual(["asker@this"]);
    expect(lastRequest(responder)).toContain('[Request from agent "asker@this"; not the user.');
    expect(lastRequest(responder)).toContain("What is 2+2?");
    await settle(responder);
    expect(await responder.request({ to: "asker@this", prompt: "4" })).toBe("asker@this");
    expect(lastRequest(agent)).toContain(`[Request from agent "${address}"`);
    expect(agent.contacts).toEqual([address]); // no duplicate contact on reply
    expect(await agent.request({ to: "new:math@this", prompt: "again" })).toBe("math-2@this");
    responder.can.request = false; // every request, replies included, needs permission
    await expect(responder.request({ to: "asker@this", prompt: "again" })).rejects.toThrow(/can.request/);
  });

  test("permission, worker and input refusals leave no responder", async () => {
    const { env, agent } = await caller({});
    await expect(agent.request({ to: "new:x@this", prompt: "hi" })).rejects.toThrow(/can.request/);
    agent.can.request = true;
    await expect(agent.request({ to: "this", prompt: "hi" })).rejects.toThrow('to: "new:<role-name>@<project>"');
    await expect(agent.request({ to: "new:x@elsewhere", prompt: "hi" })).rejects.toThrow(/Unknown project "elsewhere"; reachable projects: this/);
    await expect(agent.request({ to: "nobody@this", prompt: "hi" })).rejects.toThrow('No agent nobody@this; to start one use: to: "new:nobody@this".');
    await expect(agent.request({ to: "new@this", prompt: "hi" })).rejects.toThrow('to start one use: to: "new:<role-name>@this"');
    await expect(agent.request({ to: "new:x@this", prompt: " " })).rejects.toThrow(/prompt/);
    await expect(agent.request({ to: "new:x@this", prompt: "hi", other: true })).rejects.toThrow(/unknown option/);
    await expect(agent.request({ to: "new:x@this", prompt: "hi", model: "p/none" })).rejects.toThrow(/unknown model/);
    await expect(agent.request({ to: "new:admin@this", prompt: "hi" })).rejects.toThrow(/role name/);
    await expect(agent.request({ to: "new:two words@this", prompt: "hi" })).rejects.toThrow(/role name/);
    expect(env.agents().filter((candidate) => !candidate.parent)).toEqual([agent]);
  });

  test("workers read false for delegate/request, ignore writes, and fall back to ask once detached", async () => {
    const { agent } = await caller({ request: true, delegate: true });
    const child = await agent.childCreate({ name: "w", can: { request: true, delegate: true } });
    expect(child.can.request).toBe(false);
    expect(child.can.delegate).toBe(false);
    child.can.request = true;
    child.can.delegate = true;
    await expect(child.request({ to: "new:x@this", prompt: "hi" })).rejects.toThrow(/workers cannot/);
    await agent.close();
    expect(child.can.request).toBeUndefined();
    expect(child.can.delegate).toBeUndefined();
    child.can.request = true;
    expect(child.can.request).toBe(true);
  });

  test("contacts persist in session metadata without dirtying the chain and resume closed agents once", async () => {
    const { env, agent } = await caller();
    const address = await agent.request({ to: "new:memo@this", prompt: "remember me" });
    const responder = responderOf(env, agent);
    await settle(responder);
    await settle(agent);
    expect(agent.context.dirty).toBe(false);
    expect(Object.keys(agent.context.settings.contacts)).toEqual([address]);
    const id = responder.context.id;
    await responder.close();
    await expect(agent.request({ to: address, prompt: "x", safe: true })).rejects.toThrow(/only to new:/);
    const [first, second] = await Promise.all([agent.request({ to: address, prompt: "again", safe: false, model: agent.model }), agent.request({ to: address, prompt: "and again", model: null })]);
    expect([first, second]).toEqual([address, address]);
    const resumed = env.agents().filter((candidate) => candidate.context.id === id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).not.toBe(responder);
    expect(resumed[0].contacts.length).toBe(1);
  });

  test("inert creation options on a contact are ignored, but changed safety/model options are refused", async () => {
    const { env, agent } = await caller();
    const address = await agent.request({ to: "new:options@this", prompt: "start" });
    const responder = responderOf(env, agent);
    await settle(responder);
    const before = lastRequest(responder);
    for (const options of [
      { safe: false }, { model: "" }, { model: false }, { model: null },
      { model: responder.model }, { safe: false, model: responder.model },
    ]) {
      expect(await agent.request({ to: address, prompt: `next ${JSON.stringify(options)}`, ...options })).toBe(address);
    }
    expect(lastRequest(responder)).toContain('next {"safe":false,"model":"p/m"}');
    for (const options of [{ safe: true }, { model: "p/different" }, { safe: false, model: "p/different" }]) {
      await expect(agent.request({ to: address, prompt: "must not deliver", ...options })).rejects.toThrow(/only to new:/);
    }
    expect(lastRequest(responder)).not.toContain("must not deliver");
    expect(lastRequest(responder)).not.toBe(before);
  });

  test("inert model options on a new agent inherit the caller model", async () => {
    const { env, agent } = await caller();
    for (const model of ["", false, null]) {
      const address = await agent.request({ to: "new:inherit@this", prompt: "hello", model });
      expect(env.agents().find((candidate) => candidate !== agent && `${candidate.name}@this` === address)?.model).toBe(agent.model);
    }
  });

  test("a closed contact whose session was not saved is an error", async () => {
    const { env } = await caller();
    const agent = await Agent.create({ env, model: "p/m", can: { request: true }, createIO, contextId: false });
    const address = await agent.request({ to: "new:eph@this", prompt: "ephemeral" });
    const responder = env.agents().find((candidate) => candidate.contacts.length && candidate !== agent);
    await settle(responder);
    await responder.close();
    await expect(agent.request({ to: address, prompt: "hello?" })).rejects.toThrow(/not saved/);
  });

  test("a grouped project is reachable by name; folders never appear", async () => {
    const root = resolve(mkdtempSync("./ai-tmp/request-group-"));
    const [own, lib] = ["own", "lib"].map((name) => join(root, name));
    for (const dir of [own, lib]) mkdirSync(dir);
    const target = await Env.open(lib);
    opened.push(target);
    target.settings.providers.reqtest = { provider: "test", url: "test://script" };
    const env = await testEnv({ providers: { reqtest: { provider: "test", url: "test://script" } } }, { cwd: own });
    opened.push(env);
    await Env.ready();
    Env.settings.projects[own] = { models: {}, groups: { team: true } };
    Env.settings.projects[lib] = { models: {}, groups: { team: true } };
    try {
      const agent = await Agent.create({ env, model: "reqtest/test-model", can: { request: true }, createIO, contextId: false });
      const address = await agent.request({ to: "new:libhelp@lib", prompt: "How do I use lib?" });
      expect(address).toBe("libhelp@lib");
      const responder = target.agents().find((candidate) => candidate.contacts.length);
      expect(responder.folder).toBe(target.folder);
      expect(responder.contacts[0]).toMatch(/@own$/);
      expect(JSON.stringify(agent.contacts) + lastRequest(responder)).not.toContain(root);
      await settle(responder);
    } finally {
      delete Env.settings.projects[own];
      delete Env.settings.projects[lib];
      await Env.settingsFlush();
      delete target.settings.providers.reqtest;
    }
  });
});

describe("request tool", () => {
  test("asks the user when can.request is undecided and refuses without a question bridge", async () => {
    const { agent } = await caller({});
    await expect(requestTool({ to: "new:helper@this", prompt: "hi" }, { agent })).rejects.toThrow(/permit requests/);
    const asked = [];
    const question = { ask: async (questions) => { asked.push(questions); return [{ labels: ["Allow"] }]; } };
    const result = await requestTool({ to: "new:helper@this", prompt: "hi", safe: true }, { agent, question });
    expect(result).toMatch(/^Sent to helper@this\./);
    expect(asked).toHaveLength(1);
    expect(agent.can.request).toBe(true);
    expect(await requestTool({ to: agent.contacts[0], prompt: "follow-up", safe: false, model: "" }, { agent })).toMatch(/^Sent to/);
    expect(await requestTool({ to: agent.contacts[0], prompt: "follow-up", model: false }, { agent })).toMatch(/^Sent to/);
    expect(await requestTool({ to: agent.contacts[0], prompt: "follow-up", model: null }, { agent })).toMatch(/^Sent to/);
    expect(await requestTool({ to: agent.contacts[0], prompt: "follow-up", model: agent.model }, { agent })).toMatch(/^Sent to/);
    await expect(requestTool({ to: agent.contacts[0], prompt: "no", safe: true }, { agent })).rejects.toThrow(/only to new:/);
    expect(await requestTool({ to: "flagged@this", new: true, prompt: "hi" }, { agent })).toMatch(/^Sent to flagged@this\./);
    expect(await requestTool({ to: "named@this", new: "named", prompt: "hi" }, { agent })).toMatch(/^Sent to named@this\./);
    expect(await requestTool({ to: "full@this", new: "full@this", prompt: "hi" }, { agent })).toMatch(/^Sent to full@this\./);
    await expect(requestTool({ to: "other@this", new: "mismatch", prompt: "hi" }, { agent })).rejects.toThrow('to: "new:other@this"');
    agent.can.request = false;
    await expect(requestTool({ to: agent.contacts[0], prompt: "hi" }, { agent, question })).rejects.toThrow(/permit requests/);
  });
});
