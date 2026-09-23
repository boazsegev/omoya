import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import Env, { ENV_EVENT } from "../lib/env.js";
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
    const agent = new Agent({ env });

    expect(env.agents()).toEqual([agent]);
    expect(env.registerAgent(agent)).toBe(agent);
    expect(env.agents()).toEqual([agent]);
    expect(env.listAgents).toBeUndefined();
    expect(env.terminateAgent).toBeUndefined();
    expect(agent.terminateAgent).toBeUndefined();
    expect(() => env.registerAgent(null)).toThrow(/agent must be an object/i);
    expect(() => env.removeAgent(null)).toThrow(/agent must be an object/i);
  });

  test("Env creates registered Agents through its instance factory", async () => {
    const env = await testEnv();
    const agent = env.createAgent({ name: "factory" });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.env).toBe(env);
    expect(agent.name).toBe("factory");
    expect(env.agents()).toEqual([agent]);
  });

  test("registration retains user-facing agents until Agent.close expressly removes them", async () => {
    const env = await testEnv();
    (() => { env.createAgent({ name: "persistent" }); })();
    Bun.gc(true);
    await Bun.sleep(0);

    expect(env.agents().map((agent) => agent.name)).toContain("persistent");
  });

  test("stores generic identity metadata for user interfaces", async () => {
    const env = await testEnv();
    const parent = new Agent({ env });
    const child = new Agent({ env, parent, name: "planner", description: "Plans work." });
    const standalone = new Agent({ env, parent: {} });

    expect(child.parent).toBe(parent);
    expect(standalone.parent).toBeUndefined();
    expect(child.name).toBe("planner");
    expect(child.description).toBe("Plans work.");
    child.name = "reviewer";
    child.description = "";
    expect(child.name).toBe("reviewer");
    expect(child.description).toBe("");
    expect(standalone.name).toMatch(/^agent-\d+$/);
    expect(() => { child.name = 1; }).toThrow(/name must be a string/i);
    expect(() => { child.description = null; }).toThrow(/description must be a string/i);
  });

  test("tracks direct children through construction and close", async () => {
    const env = await testEnv();
    const parent = new Agent({ env });
    const child = new Agent({ env, parent });
    const grandchild = new Agent({ env, parent: child });

    expect(parent.children).toEqual([child]);
    expect(child.children).toEqual([grandchild]);
    expect(child.parent).toBe(parent);
    expect(grandchild.parent).toBe(child);
    const snapshot = parent.children;
    snapshot.pop();
    expect(parent.children).toEqual([child]);

    expect(child.close()).toBe(true);
    expect(parent.children).toEqual([]);
    expect(child.parent).toBeUndefined();
    expect(grandchild.parent).toBeUndefined();
  });

  test("parent close detaches children and clears its child registry", async () => {
    const env = await testEnv();
    const parent = new Agent({ env });
    const first = new Agent({ env, parent });
    const second = new Agent({ env, parent });

    parent.close();
    expect(parent.children).toEqual([]);
    expect(first.parent).toBeUndefined();
    expect(second.parent).toBeUndefined();
    expect(env.agents()).toEqual(expect.arrayContaining([first, second]));
  });

  test("stores generic spawn permission while children always report false", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, spawnPermission: true });
    const child = new Agent({ env, parent: agent, spawnPermission: true });
    expect(agent.spawnPermission).toBe(true);
    expect(child.spawnPermission).toBe(false);
    expect(child.setSpawnPermission(false)).toBe(false);
    expect(child.setSpawnPermission(true)).toBe(true);
    expect(child.spawnPermission).toBe(false);
    expect(agent.setSpawnPermission()).toBeUndefined();
    expect(agent.setSpawnPermission("yes")).toBeUndefined();
    expect(agent.spawnPermission).toBeUndefined();
  });

  test("Env lifecycle events are multi-consumer and use non-string values", async () => {
    const env = await testEnv();
    const seen = [];
    const first = env.onEvent(ENV_EVENT.AGENT_ADDED, ({ agent }) => seen.push(["first", agent]));
    env.onEvent(ENV_EVENT.AGENT_ADDED, ({ agent }) => seen.push(["second", agent]));
    const agent = new Agent({ env });
    expect(seen).toEqual([["first", agent], ["second", agent]]);
    expect(env.offEvent(first)).toBe(true);
    expect(env.offEvent(first)).toBe(false);
    agent.close();
  });

  test("idle close marks, closes, and evicts the agent exactly once", async () => {
    const env = await testEnv();
    const agent = new Agent({ env });
    const seen = [];
    agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => seen.push("marked"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    expect(agent.close()).toBe(true);
    expect(agent.closed).toBe(true);
    expect(seen).toEqual(["marked", "closed"]);
    expect(env.agents()).not.toContain(agent);
    expect(agent.close()).toBe(false);
    expect(seen).toEqual(["marked", "closed"]);
    expect(() => agent.enqueue(USER("late"))).toThrow(/closed/i);
  });

  test("busy close waits until DONE listeners finish, then closes and evicts", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const seen = [];
    agent.onEvent(Agent.EVENT.CLOSE_MARKED, () => seen.push("marked"));
    agent.onEvent(Agent.EVENT.DONE, () => seen.push("done"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    const running = agent.run();
    await until(() => agent.busy);
    expect(agent.close()).toBe(true);
    expect(agent.closed).toBe(false);
    expect(() => agent.enqueue(USER("late"))).toThrow(/closed/i);
    expect(env.agents()).toContain(agent);
    release();
    await running;

    expect(seen).toEqual(["marked", "done", "closed"]);
    expect(agent.closed).toBe(true);
    expect(env.agents()).not.toContain(agent);
  });

  test("enqueue on an idle agent starts its turn, so immediate close waits for that message", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const seen = [];
    agent.onEvent(Agent.EVENT.DONE, () => seen.push("done"));
    agent.onEvent(Agent.EVENT.CLOSED, () => seen.push("closed"));

    expect(agent.enqueue(USER("process me"))).toEqual(USER("process me"));
    expect(agent.busy).toBe(true);
    expect(agent.close()).toBe(true);
    expect(agent.closed).toBe(false);
    expect(() => agent.enqueue(USER("too late"))).toThrow(/closed/i);
    release();
    await until(() => agent.closed);

    expect(agent.context.some((message) => JSON.stringify(message).includes("process me"))).toBe(true);
    expect(agent.context.some((message) => JSON.stringify(message).includes("answer"))).toBe(true);
    expect(seen).toEqual(["done", "closed"]);
    expect(env.agents()).not.toContain(agent);
  });
});
