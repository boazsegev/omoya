import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import Env from "../lib/env.js";
import { scriptedIO, testEnv, TEXT, USER } from "./fakes.js";


function pausableIO() {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const io = scriptedIO([]);
  io.write = async (_context, callbacks) => {
    await held;
    return (await import("./fakes.js")).emitScript(
      [{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }], callbacks,
    );
  };
  return { io, release };
}

async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(5);
  }
  return Boolean(fn());
}

describe("Agent close lifecycle", () => {
  test("construction registers once and Env exposes only active-session methods", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });

    expect(env.agents()).toEqual([agent]);
    expect(env._agentAdd(agent)).toBe(agent);
    expect(env.agents()).toEqual([agent]);
    expect(env.listAgents).toBeUndefined();
    expect(env.terminateAgent).toBeUndefined();
    expect(agent.terminateAgent).toBeUndefined();
    expect(() => env._agentAdd(null)).toThrow(/agent must be an object/i);
    expect(() => env._agentRemove(null)).toThrow(/agent must be an object/i);
  });

  test("Env creates registered Agents through its instance factory", async () => {
    const env = await testEnv();
    const agent = await env.agentCreate({ name: "factory" });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.env).toBe(env);
    expect(agent.name).toBe("factory");
    expect(env.agents()).toEqual([agent]);
  });

  test("registration retains user-facing agents until Agent.close expressly removes them", async () => {
    const env = await testEnv();
    (async () => { await env.agentCreate({ name: "persistent" }); })();
    Bun.gc(true);
    await Bun.sleep(0);

    expect(env.agents().map((agent) => agent.name)).toContain("persistent");
  });

  test("stores generic identity metadata for user interfaces", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env });
    const child = await Agent.create({ env, parent, name: "planner", description: "Plans work." });
    const standalone = await Agent.create({ env, parent: {} });

    expect(child.parent).toBe(parent);
    expect(standalone.parent).toBeUndefined();
    expect(child.name).toBe("planner");
    expect(child.description).toBe("Plans work.");
    (child.name = "reviewer");
    (child.description = "");
    expect(child.name).toBe("reviewer");
    expect(child.description).toBe("");
    expect(standalone.name).toMatch(/^agent-\d+$/);
    expect(() => { (child.name = 1); }).toThrow(/name must be a string/i);
    expect(() => { (child.description = null); }).toThrow(/description must be a string/i);
  });

  test("tracks direct children through construction and close", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env });
    const child = await Agent.create({ env, parent });
    const grandchild = await Agent.create({ env, parent: child });

    expect(parent.children).toEqual([child]);
    expect(child.children).toEqual([grandchild]);
    expect(child.parent).toBe(parent);
    expect(grandchild.parent).toBe(child);
    const snapshot = parent.children;
    snapshot.pop();
    expect(parent.children).toEqual([child]);

    await child.close();
    expect(parent.children).toEqual([]);
    expect(child.parent).toBeUndefined();
    expect(grandchild.parent).toBeUndefined();
  });

  test("parent close detaches children and clears its child registry", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env });
    const first = await Agent.create({ env, parent });
    const second = await Agent.create({ env, parent });

    await parent.close();
    expect(parent.children).toEqual([]);
    expect(first.parent).toBeUndefined();
    expect(second.parent).toBeUndefined();
    expect(env.agents()).toEqual(expect.arrayContaining([first, second]));
  });

  test("stores generic spawn permission while children always report false", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, can: { delegate: true } });
    const child = await Agent.create({ env, parent: agent, can: { delegate: true } });
    expect(agent.can.delegate).toBe(true);
    expect(child.can.delegate).toBe(false);
    expect((child.can.delegate = false)).toBe(false);
    expect((child.can.delegate = true)).toBe(true);
    expect(child.can.delegate).toBe(false);
    expect((agent.can.delegate = undefined)).toBeUndefined();
    agent.can.delegate = "yes";
    expect(agent.can.delegate).toBe("yes");
    expect(agent.can.read).toBe(true);
    expect(typeof agent.can.write).toBe("boolean");
    agent.can.customTool = false;
    expect(agent.can.customTool).toBe(false);
    agent.can.read = false;
    expect(agent.can.read).toBe(true);
  });

  test("childCreate defaults to the parent's model and rejects duplicate worker names", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env, model: "p/m" });
    const child = await parent.childCreate({ name: "review" });
    expect(child).toMatchObject({ model: "p/m" });
    await expect(parent.childCreate({ name: "review" })).rejects.toThrow(/already in use/);
    await expect(parent.childCreate({ name: "*" })).rejects.toThrow(/name other than/);
    expect(parent.children).toEqual([child]);
    await parent.close();
    await child.close();
  });

  test("close after a busy send drains queued handoff before closing and rejects later messages", async () => {
    const env = await testEnv();
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const requests = [];
    const io = scriptedIO([]);
    io.write = async (messages, callbacks) => {
      requests.push(messages.messages().filter((m) => m.type === 2).map((m) => m.content[0].text));
      if (requests.length === 1) await waiting;
      return (await import("./fakes.js")).emitScript([{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }], callbacks);
    };
    const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
    const running = agent.send(USER("first"));
    await until(() => requests.length === 1);
    agent.send(USER("/handoff"));
    const completion = agent.close();
    await expect(agent.send(USER("late"))).rejects.toThrow(/closed/);
    release();
    await running;
    await completion;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("/handoff");
    expect(agent.closed).toBe(true);
  });

  test("Env lifecycle events are multi-consumer and use non-string values", async () => {
    const env = await testEnv();
    const seen = [];
    const first = env.onEvent(Env.EVENT.AGENT_ADDED, ({ agent }) => seen.push(["first", agent]));
    env.onEvent(Env.EVENT.AGENT_ADDED, ({ agent }) => seen.push(["second", agent]));
    const agent = await Agent.create({ env });
    expect(seen).toEqual([["first", agent], ["second", agent]]);
    expect(env.offEvent(first)).toBe(true);
    expect(env.offEvent(first)).toBe(false);
    await agent.close();
  });

  test("idle close marks, closes, and evicts the agent exactly once", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });
    const seen = [];
    agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => seen.push("marked"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    await agent.close();
    expect(agent.closed).toBe(true);
    expect(seen).toEqual(["marked", "closed"]);
    expect(env.agents()).not.toContain(agent);
    await agent.close();
    expect(seen).toEqual(["marked", "closed"]);
    await expect(agent.send(USER("late"))).rejects.toThrow(/closed/i);
  });

  test("busy close waits until DONE listeners finish, then closes and evicts", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const seen = [];
    agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => seen.push("marked"));
    agent.onEvent(Agent.EVENT.REQUEST_DONE, () => seen.push("done"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    const running = agent.run();
    await until(() => agent.busy);
    const completion = agent.close();
    expect(agent.closed).toBe(false);
    await expect(agent.send(USER("late"))).rejects.toThrow(/closed/i);
    expect(env.agents()).toContain(agent);
    release();
    await running;
    await completion;

    expect(seen).toEqual(["marked", "done", "closed"]);
    expect(agent.closed).toBe(true);
    expect(env.agents()).not.toContain(agent);
  });

  test("enqueue on an idle agent starts its turn, so immediate close waits for that message", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
    const seen = [];
    agent.onEvent(Agent.EVENT.REQUEST_DONE, () => seen.push("done"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    const turn = agent.send(USER("process me"));
    expect(turn).toBeInstanceOf(Promise);
    expect(agent.busy).toBe(true);
    const completion = agent.close();
    expect(agent.closed).toBe(false);
    await expect(agent.send(USER("too late"))).rejects.toThrow(/closed/i);
    release();
    await turn;
    await completion;

    expect(agent.context.messages().some((message) => JSON.stringify(message).includes("process me"))).toBe(true);
    expect(agent.context.messages().some((message) => JSON.stringify(message).includes("answer"))).toBe(true);
    expect(seen).toEqual(["done", "closed"]);
    expect(env.agents()).not.toContain(agent);
  });
});
