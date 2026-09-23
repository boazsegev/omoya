// Agent owns context and reuses IO by endpoint, never protocol.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, recordingFactory, testEnv, USER, TEXT } from "./fakes.js";

describe("Agent core: context ownership", () => {
  test("owns ordered context and appends assistant messages", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi there"), { type: "done" }]]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("hello")], createIO: () => io });
    expect((await agent.run()).type).toBe("done");
    expect(agent.context.map((message) => message.type)).toEqual([2, 3]);
    expect(agent.context[1].content).toEqual([{ type: "text", text: "hi there" }]);
  });

  test("refuses a secret tool even when a provider calls it by name", async () => {
    const env = await testEnv();
    let invoked = 0;
    env.registerTool("human-only", () => { invoked++; return "should not run"; }, {
      secret: true, description: "human only", inputSchema: { type: "object" },
    });
    const io = scriptedIO([
      [{ type: "toolcall_start", contentIndex: 0, callId: "secret-call", name: "human-only", arguments: {} }, { type: "toolcall_end", contentIndex: 0, arguments: {} }, { type: "done" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fake/m", context: [USER("call it")], createIO: () => io });
    await agent.run();

    expect(invoked).toBe(0);
    const result = agent.context.find((message) => message?.type === 4 && message.name === "human-only");
    expect(result).toMatchObject({ error: true });
    expect(result.content[0].text).toContain("not available to agents");
  });

  test("passes complete context on every provider request", async () => {
    const env = await testEnv();
    env.registerTool("fake-tool", ({ x }) => `got ${x}`, { description: "fake", inputSchema: {} });
    const io = scriptedIO([
      [{ type: "toolcall_start", contentIndex: 0, callId: "c1", name: "fake-tool", arguments: { x: 7 } }, { type: "toolcall_end", contentIndex: 0, arguments: { x: 7 } }, { type: "done" }],
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
  test("selects endpoint/model per request; run options override defaults", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const agent = new Agent({ env, model: "p1/m1", createIO: factory });
    await agent.run();
    await agent.run({ model: "p2/m2" });
    expect(factory.made.map(({ opts }) => opts.model)).toEqual(["p1/m1", "p2/m2"]);
  });

  test("reuses an IO per endpoint and reconstructs after cancellation", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const agent = new Agent({ env, model: "p1/m", createIO: factory });
    await agent.run();
    await agent.run();
    expect(factory.made).toHaveLength(1);
    await factory.made[0].io.kill();
    await agent.run();
    expect(factory.made).toHaveLength(2);
  });

  test("requires a loaded endpoint and model", async () => {
    const env = await testEnv();
    const factory = recordingFactory(() => scriptedIO([[{ type: "done" }]]));
    const events = [];
    const agent = new Agent({ env, createIO: factory });
    agent.onEvent(Agent.EVENT.ERROR, (event) => events.push(event));
    const terminal = await agent.run();
    expect(terminal).toEqual({ type: "error", error: "Please load a model" });
    expect(events).toEqual([{ error: terminal.error }]);
    expect(factory.made).toHaveLength(0);
  });
});
