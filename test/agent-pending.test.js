// test/agent-pending.test.js — proof for the Agent pending-message
// queue: user messages submitted mid-turn are an AGENT concern — they
// send only after the in-flight IO turn settles, append-merged into
// one user message, AFTER any tool results; drainPending recalls them.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, fakeIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

describe("Agent pending queue", () => {
  test("a message queued mid-turn flushes after done — the SAME run continues with it", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "first answer"), { type: "done" }],
      [...TEXT(0, "second answer"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.enqueue(USER("queued mid-turn")); // lands after the first flush: mid-turn
    const terminal = await run;

    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(2); // one run, two requests
    expect(agent.context).toEqual([
      USER("go"),
      { type: 3, content: [{ type: "text", text: "first answer" }] },
      USER("queued mid-turn"),
      { type: 3, content: [{ type: "text", text: "second answer" }] },
    ]);
    // the second request's context carries the queued message
    expect(io.writes[1].context.map((m) => m.type)).toEqual([2, 3, 2]);
    expect(agent.pending).toEqual([]); // flushed
  });

  test("identical consecutive submissions are ignored", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const first = agent.enqueue(USER("submit once"));
    expect(agent.enqueue(USER("submit once"))).toBe(first);
    await agent.run();
    expect(io.writes[0].context).toEqual([USER("submit once")]);
    expect(agent.context.map((message) => message.type)).toEqual([2, 3]);
  });

  test("different consecutive submissions still append-merge into ONE user message", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "answer one"), { type: "done" }],
      [...TEXT(0, "answer two"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.enqueue(USER("queued one"));
    agent.enqueue(USER("queued two"));
    await run;

    const users = agent.context.filter((m) => m.type === 2);
    expect(users).toHaveLength(2); // "go" + one merged queued message
    expect(users[1].content[0].text).toBe("queued one\nqueued two"); // folded with "\n"
    expect(io.writes).toHaveLength(2);
  });

  test("tool results land BEFORE the queued messages (tool calls answer first)", async () => {
    const env = await testEnv();
    env.registerTool("fake-tool", () => "tool output", { description: "t", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "fake-tool", {}), { type: "done" }],
      [...TEXT(0, "final answer"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.enqueue(USER("queued during tools"));
    const terminal = await run;

    expect(terminal.type).toBe("done");
    expect(agent.context.map((m) => m.type)).toEqual([2, 3, 4, 2, 3]);
    // order in the second request: assistant toolCall → tool result → merged queue
    expect(io.writes[1].context.map((m) => m.type)).toEqual([2, 3, 4, 2]);
  });

  test("an interrupted (error) turn leaves the queue behind — nothing is silently sent", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [{ type: "error", error: "provider exploded" }],
      [...TEXT(0, "recovered"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.enqueue(USER("still waiting"));
    const terminal = await run;

    expect(terminal.type).toBe("error");
    expect(agent.pending).toHaveLength(1); // NOT flushed on error
    expect(io.writes).toHaveLength(1);
    // the next run flushes it first (folding into the open user message)
    const second = await agent.run();
    expect(second.type).toBe("done");
    expect(agent.context.map((m) => m.type)).toEqual([2, 3]);
    expect(agent.context[0].content[0].text).toBe("go\nstill waiting");
  });

  test("drainPending recalls every message queued while busy (the TUI's Alt+↑ edit recall)", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => null });
    agent._running = true;
    agent.enqueue(USER("one"));
    agent.enqueue(USER("two"));
    agent._running = false;
    expect(agent.pending).toHaveLength(2);
    const drained = agent.drainPending();
    expect(drained).toEqual([USER("one"), USER("two")]);
    expect(agent.pending).toEqual([]);
  });

  test("a pending message is durable before a provider read begins", async () => {
    const env = await testEnv();
    let file;
    const io = fakeIO(async () => {
      expect(file).toBeDefined();
      expect(await Bun.file(file).text()).toContain("durable before read");
      return { type: "done" };
    });
    const agent = new Agent({ env, model: "p/m", session: "pending-durable", createIO: () => io });
    file = agent.session.file;
    agent.enqueue(USER("durable before read"));
    await agent.run();
  });

  test("an idle run flushes the queue at the top (enqueue-then-run is the submit path)", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    agent.enqueue(USER("the question"));
    const terminal = await agent.run();
    expect(terminal.type).toBe("done");
    expect(agent.context.map((m) => m.type)).toEqual([2, 3]);
    expect(io.writes[0].context.map((m) => m.type)).toEqual([2]);
  });
});
