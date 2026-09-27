// Env plugins (Env.extend): a higher layer installs its Env members after
// the fact; Env itself knows nothing about Agents or IO.
import { describe, expect, test } from "bun:test";
import { Env } from "../lib/env.js";
import "../lib/agent.js"; // installs Agent's plugin (and, through IO, IO's)
import { testEnv } from "./fakes.js";

describe("Env.extend", () => {
  test("Agent installs its members and membership events onto Env; IO installs none", () => {
    for (const name of ["agents", "agentAdd", "agentRemove", "agentCreate"]) {
      expect(typeof Env.prototype[name]).toBe("function");
    }
    expect(Object.keys(Env.EVENT)).toEqual(expect.arrayContaining(["AGENT_ADDED", "AGENT_REMOVED"]));
    // Env events report membership only: activity is each object's own events
    for (const gone of ["AGENT_START", "AGENT_DONE", "IO_START", "IO_DONE"]) expect(Env.EVENT[gone]).toBeUndefined();
    for (const value of Object.values(Env.EVENT)) expect(typeof value).toBe("symbol");
  });

  test("an existing member or event name throws — plugins never override", () => {
    expect(() => Env.extend({ methods: { tools() {} } })).toThrow(/tools/);
    expect(() => Env.extend({ methods: { agentCreate() {} } })).toThrow(/agentCreate/);
    expect(() => Env.extend({ events: ["AGENT_ADDED"] })).toThrow(/AGENT_ADDED/);
  });

  test("a plugin emits only its own events", async () => {
    const env = await testEnv();
    const plugin = Env.extend({ events: ["TEST_EXTEND_PING"] });
    const seen = [];
    env.onEvent(Env.EVENT.TEST_EXTEND_PING, (payload) => seen.push(payload));
    plugin.emit(env, plugin.EVENT.TEST_EXTEND_PING, { n: 1 });
    expect(seen).toEqual([{ n: 1 }]);
    expect(() => plugin.emit(env, Env.EVENT.AGENT_ADDED, {})).toThrow(/not owned/);
  });

  test("plugin members run on the Env; plugin state lives on it", async () => {
    const env = await testEnv();
    const plugin = Env.extend({ methods: { testExtendReceiver() { return this; } } });
    expect(plugin.EVENT).toEqual({});
    expect(env.testExtendReceiver()).toBe(env);
    const agent = env.agentCreate({ model: undefined });
    expect(agent.env).toBe(env);
    expect(env.agents()).toContain(agent);
    agent.close();
    expect(env.agents()).not.toContain(agent);
    delete Env.prototype.testExtendReceiver; // test-only member; the process-wide Env stays clean
  });

  test("AGENT_ADDED delivers a fully built agent: its listeners can subscribe to it at once", async () => {
    const env = await testEnv();
    const { Agent } = await import("../lib/agent.js");
    const { scriptedIO, TEXT } = await import("./fakes.js");
    const seen = [];
    const handle = env.onEvent(Env.EVENT.AGENT_ADDED, ({ agent }) => {
      seen.push({ name: agent.name, messages: agent.context.length });
      agent.onEvent(Agent.EVENT.REQUEST_DONE, () => seen.push("request done"));
    });
    const agent = new Agent({ env, model: "p/m", createIO: () => scriptedIO([[...TEXT(0, "hi"), { type: "done" }]]) });
    expect(seen[0]).toEqual({ name: agent.name, messages: agent.context.length });
    agent.context.append({ type: 2, content: [{ type: "text", text: "go" }] });
    await agent.run();
    expect(seen).toContain("request done");
    env.offEvent(handle);
    agent.close();
  });
});
