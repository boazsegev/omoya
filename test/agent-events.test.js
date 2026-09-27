import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, TEXT, USER } from "./fakes.js";

describe("Agent event subscriptions", () => {
  test("constants are dense zero-based integers", () => {
    expect(Object.values(Agent.EVENT)).toEqual(Array.from({ length: 21 }, (_, index) => index));
  });

  test("supports multiple and duplicate listeners with independent random handles", async () => {
    const agent = new Agent({ env: await testEnv() });
    const seen = [];
    const callback = (value) => seen.push(value);
    const first = agent.onEvent(Agent.EVENT.LOG, callback);
    const second = agent.onEvent(Agent.EVENT.LOG, callback);

    expect(Number.isSafeInteger(first)).toBe(true);
    expect(second).not.toBe(first);
    agent._emit(Agent.EVENT.LOG, "both");
    expect(seen).toEqual(["both", "both"]);
    expect(agent.offEvent(first)).toBe(true);
    expect(agent.offEvent(first)).toBe(false);
    agent._emit(Agent.EVENT.LOG, "one");
    expect(seen).toEqual(["both", "both", "one"]);
    expect(agent.offEvent(second)).toBe(true);
  });

  test("publishes response events to multiple consumers and commits completed messages after storage", async () => {
    const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env: await testEnv(), model: "p/m", context: [USER("go")], createIO: () => io });
    const deltas = [[], []];
    agent.onEvent(Agent.EVENT.TEXT_DELTA, (event) => deltas[0].push({ text: event.text, type: event.type, content: event.content?.text }));
    agent.onEvent(Agent.EVENT.TEXT_DELTA, (event) => deltas[1].push({ text: event.text, type: event.type, content: event.content?.text }));
    const ends = [];
    agent.onEvent(Agent.EVENT.TEXT_END, (event) => ends.push(event.content?.text));
    const committed = [];
    agent.onEvent(Agent.EVENT.MESSAGE_COMMITTED, (message) => committed.push({ message, stored: agent.context.messages().includes(message) }));

    await agent.run();

    expect(deltas).toEqual([
      [{ text: "answer", type: undefined, content: "answer" }],
      [{ text: "answer", type: undefined, content: "answer" }],
    ]);
    expect(ends).toEqual(["answer"]);
    expect(committed).toHaveLength(1);
    expect(committed[0].stored).toBe(true);
  });

  test("forwards a completed child response to its parent without tool registration", async () => {
    const env = await testEnv();
    const parent = new Agent({ env, model: "p/m" });
    const forwarded = [];
    parent.send = (message) => { forwarded.push(message); return Promise.resolve({ type: "done" }); };
    const child = new Agent({
      env, parent, name: "child", model: "p/m", context: [USER("go")],
      createIO: () => scriptedIO([[{ type: "start" }, ...TEXT(0, "answer"), { type: "done" }]]),
    });
    await child.run();
    expect(forwarded).toEqual([{ type: 2, worker: "child", content: [
      { type: "text", text: '[Message from worker: "child"]\n' },
      { type: "text", text: "answer" },
    ] }]);
  });

  test("publishes each queued message as it enters context", async () => {
    let release;
    const io = {
      state: "idle",
      async close() {},
      async write(_context, callbacks) {
        callbacks.onStart?.({ type: "start" });
        if (!release) return await new Promise((resolve) => { release = () => resolve({ type: "done" }); });
        callbacks.onDone?.({ type: "done" });
        return { type: "done" };
      },
    };
    const agent = new Agent({ env: await testEnv(), model: "p/m", context: [USER("first")], createIO: () => io });
    const sent = [];
    agent.onEvent(Agent.EVENT.SENT_MESSAGE, (message) => sent.push(message));
    const running = agent.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    agent.send(USER("queued"));
    release();
    await running;
    expect(sent).toEqual([USER("queued")]);
  });

  test("does not commit failed partial messages", async () => {
    const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "partial"), { type: "error", error: "failed" }]]);
    const agent = new Agent({ env: await testEnv(), model: "p/m", context: [USER("go")], createIO: () => io });
    const committed = [];
    agent.onEvent(Agent.EVENT.MESSAGE_COMMITTED, (message) => committed.push(message));
    await agent.run();
    expect(committed).toEqual([]);
  });

  test("rejects invalid registrations and ignores invalid removals", async () => {
    const agent = new Agent({ env: await testEnv() });
    expect(() => agent.onEvent(-1, () => {})).toThrow(TypeError);
    expect(() => agent.onEvent(99, () => {})).toThrow(TypeError);
    expect(() => agent.onEvent(Agent.EVENT.REQUEST_START, null)).toThrow(TypeError);
    expect(agent.offEvent("not-a-handle")).toBe(false);
  });
});
