// test/agent-compact.test.js — proof that /context-compact is an Agent
// concern (agent.compact(), lib/agent/compact.js), usable headless with
// no TUI: the summary lands as an ASSISTANT message (never a user one),
// system messages survive, and a turn with no usable summary is a no-op.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { scriptedIO, testEnv, TEXT, USER } from "./fakes.js";

describe("Agent.compact: headless context compaction", () => {
  test("rebuilds the context as system messages + one ASSISTANT summary", async () => {
    const env = await testEnv();
    const agent = new Agent({
      env, model: "p/m",
      context: [
        { type: MessageType.System, content: [{ type: "text", text: "be terse" }] },
        { type: MessageType.User, content: [{ type: "text", text: "long question" }] },
        { type: MessageType.Assistant, content: [{ type: "text", text: "long answer" }] },
      ],
      createIO: () => scriptedIO([[...TEXT(0, "concise summary"), { type: "done" }]]),
    });
    const result = await agent.compact();
    expect(result).toEqual({ ok: true, before: 3, summaryText: "concise summary" });
    expect(agent.context.messages()).toHaveLength(2);
    expect(agent.context.at(0).type).toBe(MessageType.System);
    expect(agent.context.at(1).type).toBe(MessageType.Assistant); // never User
    expect(agent.context.at(1).content[0].text).toContain("concise summary");
  });

  test("a headless /compact user message invokes compaction instead of reaching the model literally", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "focused summary"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("task")], createIO: () => io });
    agent.send(USER("/compact Prioritize unresolved tests"));
    await agent.run();
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].context.at(-1).content[0].text).toContain("Prioritize unresolved tests");
    expect(io.writes[0].context.at(-1).content[0].text).toContain("Create a detailed summary");
    expect(io.writes[0].context.at(-1).content[0].text).not.toContain("/compact");
    expect(agent.context.messages()).toHaveLength(1);
    expect(agent.context.at(-1).type).toBe(MessageType.Assistant);
    expect(agent.context.at(-1).content[0].text).toContain("focused summary");
  });

  test("directly appended /compact is consumed before IO, retaining its focus", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "summary"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("task")], createIO: () => io });
    agent.context.append(USER("/compact keep the decisions"), { merge: false });
    await agent.run();
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].context.at(-1).content[0].text).toContain("Create a detailed summary");
    expect(io.writes[0].context.at(-1).content[0].text).toContain("keep the decisions");
    expect(agent.context.messages()).toHaveLength(1);
  });

  test("seeded /compact is consumed before the first IO write", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "summary"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("task"), USER("/compact keep the decisions")], createIO: () => io });
    await agent.run();
    expect(io.writes[0].context.at(-1).content[0].text).toContain("keep the decisions");
    expect(io.writes[0].context.at(-1).content[0].text).toContain("Create a detailed summary");
  });

  test("/compact waits for an active turn before summarizing its completed reply", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "first reply"), { type: "done" }],
      [...TEXT(0, "summary"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("task")], createIO: () => io });
    const turn = agent.run();
    agent.send(USER("/compact focus on the reply"));
    await turn;
    expect(io.writes).toHaveLength(2);
    expect(io.writes[0].context[0]).toEqual(USER("task"));
    expect(io.writes[1].context.at(-1).content[0].text).toContain("focus on the reply");
    expect(io.writes[1].context.some((message) => message.content?.[0]?.text === "first reply")).toBe(true);
  });

  test("only a standalone text /compact command is intercepted", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "reply"), { type: "done" }], [...TEXT(0, "reply"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    await agent.send(USER("/compactness details"));
    await agent.send({ ...USER("/compact focus"), content: [...USER("/compact focus").content, { type: "image", data: "x" }] });
    expect(io.writes[0].context.at(-1)).toEqual(USER("/compactness details"));
    expect(io.writes[1].context.at(-1).content).toHaveLength(2);
  });

  test("compact(focus) appends guidance to the summary instruction", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "focused summary"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [{ type: MessageType.User, content: [{ type: "text", text: "task" }] }], createIO: () => io });
    const result = await agent.compact("Prioritize unresolved tests");
    expect(result.ok).toBe(true);
    expect(io.writes[0].context.at(-1).content[0].text).toContain("Prioritize unresolved tests");
    expect(agent.context.at(-1).content[0].text).toContain("focused summary");
  });

  test("a compact turn with no assistant text is a no-op — context untouched", async () => {
    const env = await testEnv();
    env.settings.retry = { attempts: 1 }; // one shot: the no-op assertion needs the failed turn settled
    const agent = new Agent({
      env, model: "p/m",
      context: [{ type: MessageType.User, content: [{ type: "text", text: "q" }] }],
      createIO: () => scriptedIO([[{ type: "error", error: "boom", kind: "provider" }]]),
    });
    const result = await agent.compact();
    expect(result.ok).toBe(false);
    // untouched apart from the compact instruction the failed turn appended
    // (merges into the same adjacent User message — ordinary context merge)
    expect(agent.context.at(0).content[0].text.startsWith("q")).toBe(true);
  });
});
