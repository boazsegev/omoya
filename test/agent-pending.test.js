// test/agent-pending.test.js — proof for the Agent pending-message
// queue: user messages submitted mid-turn are an AGENT concern — they
// send only after the in-flight IO turn settles, append-merged into
// one user message, AFTER any tool results; pendingPop recalls them.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../lib/agent.js";
import { scriptedIO, fakeIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

function pausableIO() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { io: fakeIO(async () => { await gate; return { type: "done" }; }), release };
}

describe("Agent pending queue", () => {
  test("agent-to-agent slash prompts expand before reaching the model, with trailing instructions", async () => {
    const env = await testEnv();
    mkdirSync(join(env._dir, "prompts"), { recursive: true });
    writeFileSync(join(env._dir, "prompts", "handoff.md"), "---\nname: handoff\ndescription: handoff\n---\nPrepare a handoff.\n");
    const io = scriptedIO([[...TEXT(0, "done"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    agent.send(USER("/handoff next steps\nsecond line"));
    await agent.run();
    expect(io.writes[0].context[0]).toEqual(USER("Prepare a handoff.\nnext steps\nsecond line"));
  });

  test("directly appended and seeded user prompts expand before IO", async () => {
    const env = await testEnv();
    mkdirSync(join(env._dir, "prompts"), { recursive: true });
    writeFileSync(join(env._dir, "prompts", "handoff.md"), "---\nname: handoff\ndescription: handoff\n---\nPrepare a handoff.\n");
    const io = scriptedIO([[...TEXT(0, "done"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("/handoff seeded")], createIO: () => io });
    agent.context.append(USER("/handoff directly appended"), { merge: false });
    await agent.run();
    expect(io.writes[0].context.slice(0, 2)).toEqual([
      USER("Prepare a handoff.\nseeded"), USER("Prepare a handoff.\ndirectly appended"),
    ]);
  });

  test("a prompt expanding to another slash prompt is not expanded again on retry", async () => {
    const env = await testEnv();
    mkdirSync(join(env._dir, "prompts"), { recursive: true });
    writeFileSync(join(env._dir, "prompts", "handoff.md"), "---\nname: handoff\ndescription: handoff\n---\n/other\n");
    writeFileSync(join(env._dir, "prompts", "other.md"), "---\nname: other\ndescription: other\n---\nWRONG\n");
    const io = scriptedIO([[...TEXT(0, "first"), { type: "done" }], [...TEXT(0, "second"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("/handoff")], createIO: () => io });
    await agent.run();
    await agent.run();
    expect(io.writes[0].context[0]).toEqual(USER("/other"));
    expect(io.writes[1].context[0]).toEqual(USER("/other"));
  });

  test("queued slash prompt expands while busy and unknown slash text stays literal", async () => {
    const env = await testEnv();
    mkdirSync(join(env._dir, "prompts"), { recursive: true });
    writeFileSync(join(env._dir, "prompts", "handoff.md"), "---\nname: handoff\ndescription: handoff\n---\nPrepare a handoff.\n");
    const { io, release } = pausableIO();
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const turn = agent.run();
    expect(agent.send(USER("//handoff details"))).toBe(turn);
    agent.send(USER("/unknown details"));
    agent.send(USER("a /handoff mention"));
    agent.send({ ...USER("/handoff"), worker: "parent" });
    expect(agent.pending).toEqual([USER("//handoff details"), USER("/unknown details"), USER("a /handoff mention"), { ...USER("/handoff"), worker: "parent" }]);
    release();
    await turn;
  });

  test("await send resolves to the terminal event for the active run", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const terminal = await agent.send(USER("hello"));
    expect(terminal.type).toBe("done");
    expect(io.writes[0].context.at(-1)).toEqual(USER("hello"));
  });

  test("a busy send shares its run terminal even when the queue survives an error", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "error", error: "failed" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const turn = agent.run();
    const sent = agent.send(USER("later"));
    expect(sent).toBe(turn);
    expect((await sent).type).toBe("error");
    expect(agent.pending).toEqual([USER("later")]);
  });

  test("a message queued mid-turn flushes after done — the SAME run continues with it", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "first answer"), { type: "done" }],
      [...TEXT(0, "second answer"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.send(USER("queued mid-turn")); // lands after the first flush: mid-turn
    const terminal = await run;

    expect(terminal.type).toBe("done");
    expect(io.writes).toHaveLength(2); // one run, two requests
    expect(agent.context.messages()).toEqual([
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
    const first = agent.send(USER("submit once"));
    expect(agent.send(USER("submit once"))).toBe(first);
    await agent.run();
    expect(io.writes[0].context).toEqual([USER("submit once")]);
    expect(agent.context.messages().map((message) => message.type)).toEqual([2, 3]);
  });

  test("different consecutive submissions still append-merge into ONE user message", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "answer one"), { type: "done" }],
      [...TEXT(0, "answer two"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.send(USER("queued one"));
    agent.send(USER("queued two"));
    await run;

    const users = agent.context.messages().filter((m) => m.type === 2);
    expect(users).toHaveLength(2); // "go" + one merged queued message
    expect(users[1].content[0].text).toBe("queued one\n\nqueued two"); // folded with "\n\n"
    expect(io.writes).toHaveLength(2);
  });

  test("tool results land BEFORE the queued messages (tool calls answer first)", async () => {
    const env = await testEnv();
    env.toolAdd("fake-tool", () => "tool output", { description: "t", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "fake-tool", {}), { type: "done" }],
      [...TEXT(0, "final answer"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const run = agent.run();
    agent.send(USER("queued during tools"));
    const terminal = await run;

    expect(terminal.type).toBe("done");
    expect(agent.context.messages().map((m) => m.type)).toEqual([2, 3, 4, 2, 3]);
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
    agent.send(USER("still waiting"));
    const terminal = await run;

    expect(terminal.type).toBe("error");
    expect(agent.pending).toHaveLength(1); // NOT flushed on error
    expect(io.writes).toHaveLength(1);
    // the next run flushes it first (folding into the open user message)
    const second = await agent.run();
    expect(second.type).toBe("done");
    expect(agent.context.messages().map((m) => m.type)).toEqual([2, 3]);
    expect(agent.context.at(0).content[0].text).toBe("go\n\nstill waiting");
  });

  test("pendingPop recalls every message queued while busy (the TUI's Alt+↑ edit recall)", async () => {
    const env = await testEnv();
    const { io, release } = pausableIO();
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const turn = agent.run();
    agent.send(USER("one"));
    agent.send(USER("two"));
    expect(agent.pending).toHaveLength(2);
    const drained = agent.pendingPop();
    expect(drained).toEqual([USER("one"), USER("two")]);
    expect(agent.pending).toEqual([]);
    release();
    await turn;
  });

  test("a pending message is durable before a provider read begins", async () => {
    const env = await testEnv();
    let file;
    const io = fakeIO(async () => {
      expect(file).toBeDefined();
      expect(await Bun.file(file).text()).toContain("durable before read");
      return { type: "done" };
    });
    const agent = new Agent({ env, model: "p/m", contextId: "pending-durable", createIO: () => io });
    file = agent.context.file;
    agent.send(USER("durable before read"));
    await agent.run();
  });

  test("send starts an idle run and flushes the submitted message before IO", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "answer"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const terminal = await agent.send(USER("the question"));
    expect(terminal.type).toBe("done");
    expect(agent.context.messages().map((m) => m.type)).toEqual([2, 3]);
    expect(io.writes[0].context.map((m) => m.type)).toEqual([2]);
  });
});
