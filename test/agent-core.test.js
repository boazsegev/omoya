// Agent owns context and reuses IO by qualified model, never protocol.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, recordingFactory, testEnv, USER, TEXT } from "./fakes.js";

describe("Agent core: context ownership", () => {
  test("owns ordered context and appends assistant messages", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi there"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("hello")], createIO: () => io });
    expect((await agent.run()).type).toBe("done");
    expect(agent.context.messages().map((message) => message.type)).toEqual([2, 3]);
    expect(agent.context.at(1).content).toEqual([{ type: "text", text: "hi there" }]);
  });

  test("refuses a secret tool even when a provider calls it by name", async () => {
    const env = await testEnv();
    let invoked = 0;
    env.toolAdd("human-only", () => { invoked++; return "should not run"; }, {
      secret: true, description: "human only", inputSchema: { type: "object" },
    });
    const io = scriptedIO([
      [{ type: "tool_call_start", contentIndex: 0, callId: "secret-call", name: "human-only", arguments: {} }, { type: "tool_call_end", contentIndex: 0, arguments: {} }, { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("call it")], createIO: () => io });
    await agent.run();

    expect(invoked).toBe(0);
    const result = agent.context.messages().find((message) => message?.type === 4 && message.name === "human-only");
    expect(result).toMatchObject({ error: true });
    expect(result.content[0].text).toContain("not available to agents");
  });

  test("passes complete context on every provider request", async () => {
    const env = await testEnv();
    env.toolAdd("fake-tool", ({ x }) => `got ${x}`, { description: "fake", inputSchema: {} });
    const io = scriptedIO([
      [{ type: "tool_call_start", contentIndex: 0, callId: "c1", name: "fake-tool", arguments: { x: 7 } }, { type: "tool_call_end", contentIndex: 0, arguments: { x: 7 } }, { type: "done" }],
      [...TEXT(0, "done now"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("call the tool")], createIO: () => io });
    await agent.run();
    expect(io.writes).toHaveLength(2);
    expect(io.writes[1].context).toEqual([
      USER("call the tool"),
      { type: 3, content: [{ type: "toolCall", callId: "c1", name: "fake-tool", arguments: { x: 7 } }] },
      { type: 4, callId: "c1", name: "fake-tool", content: [{ type: "text", text: "got 7" }] },
    ]);
  });
});

describe("Agent endpoint/model selection and reuse", () => {
  test("selects endpoint/model through property assignments", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const agent = new Agent({ env, model: "p1/m1", createIO: factory });
    await agent.run();
    agent.model = "p2/m2";
    await agent.run();
    expect(factory.made.map(({ opts }) => opts.model)).toEqual(["p1/m1", "p2/m2"]);
  });

  test("reuses an IO per qualified model and reconstructs after cancellation", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const agent = new Agent({ env, model: "p1/m", createIO: factory });
    await agent.run();
    await agent.run();
    expect(factory.made).toHaveLength(1);
    await factory.made[0].io.close();
    await agent.run();
    expect(factory.made).toHaveLength(2);
  });

  test("requires a loaded endpoint and model", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const events = [];
    const agent = new Agent({ env, createIO: factory });
    agent.onEvent(Agent.EVENT.REQUEST_ERROR, (event) => events.push(event));
    const terminal = await agent.run();
    expect(terminal).toEqual({ type: "error", error: "Please load a model" });
    expect(events).toEqual([{ error: terminal.error }]);
    expect(factory.made).toHaveLength(0);
  });

  test("retains qualified models through assignments, children and IO reuse", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const agent = new Agent({ env, model: "p1/org/first", createIO: factory });
    expect(Object.hasOwn(agent, "endpoint")).toBeFalse();
    agent.model = "p1/org/second";
    await agent.run();
    agent.model = "p1/org/first";
    await agent.run();
    agent.model = "p1/org/second";
    await agent.run();
    expect(factory.made.map(({ opts }) => opts.model)).toEqual(["p1/org/second", "p1/org/first"]);
    expect(factory.made.map(({ io }) => io.writes.length)).toEqual([2, 1]);
    expect(factory.made.flatMap(({ io }) => io.writes).every(({ options }) => !Object.hasOwn(options, "model"))).toBe(true);
    expect(agent.model).toBe("p1/org/second");
    expect(agent.childCreate({ name: "child" }).model).toBe("p1/org/second");
    expect((agent.model = "p2/org/third")).toBe("p2/org/third");
    expect((agent.model = undefined)).toBeUndefined();
    expect(agent.model).toBeUndefined();
    agent.close();
  });

  test("routes tool contexts and capacity to the assigned model", async () => {
    const env = await testEnv({ providers: {
      p1: { provider: "test", models: { base: {} } },
      p2: { provider: "test", models: { "org/next": {} } },
    } });
    let seen;
    env.toolAdd("inspect-model", (_, context) => {
      seen = [context.selector, context.io.model, env.models(true).get("p2/org/next")?.active];
      return "ok";
    }, { safe: true, inputSchema: { type: "object" } });
    const factory = recordingFactory((opts) => {
      const io = scriptedIO([
        [{ type: "done", message: { type: 3, content: [{ type: "toolCall", name: "inspect-model", callId: "inspect", arguments: {} }] } }],
        [{ type: "done" }],
      ]);
      io.model = opts.model;
      return io;
    });
    const agent = new Agent({ env, model: "p1/base", createIO: factory });
    agent.model = "p2/org/next";
    await agent.run();
    expect(seen).toEqual(["p2/org/next", "p2/org/next", 1]);
    expect(factory.made).toHaveLength(1);
    expect(agent.model).toBe("p2/org/next");
    agent.close();
  });

  test("rejects split options and bare run models without changing the selection", async () => {
    const env = await testEnv();
    expect(() => new Agent({ env, endpoint: "p", model: "m" })).toThrow(/use model/);
    expect(env.agents()).toHaveLength(0);
    const agent = new Agent({ env, model: "p/m" });
    expect(() => agent.run({ endpoint: "p2", model: "p2/m" })).toThrow(/assign agent.model/);
    expect(() => agent.run({ model: "m" })).toThrow(/assign agent.model/);
    expect(agent.model).toBe("p/m");
    expect(agent.busy).toBeFalse();
    agent.close();
  });
});
