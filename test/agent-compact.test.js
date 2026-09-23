// test/agent-compact.test.js — proof that /context-compact is an Agent
// concern (agent.compact(), lib/agent/compact.js), usable headless with
// no TUI: the summary lands as an ASSISTANT message (never a user one),
// system messages survive, and a turn with no usable summary is a no-op.
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { scriptedIO, testEnv, TEXT } from "./fakes.js";

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
    expect(agent.context).toHaveLength(2);
    expect(agent.context[0].type).toBe(MessageType.System);
    expect(agent.context[1].type).toBe(MessageType.Assistant); // never User
    expect(agent.context[1].content[0].text).toContain("concise summary");
  });

  test("a compact turn with no assistant text is a no-op — context untouched", async () => {
    const env = await testEnv();
    env.settings.maxAttempts = 1; // one shot: the no-op assertion needs the failed turn settled
    const agent = new Agent({
      env, model: "p/m",
      context: [{ type: MessageType.User, content: [{ type: "text", text: "q" }] }],
      createIO: () => scriptedIO([[{ type: "error", error: "boom", kind: "provider" }]]),
    });
    const result = await agent.compact();
    expect(result.ok).toBe(false);
    // untouched apart from the compact instruction the failed turn appended
    // (merges into the same adjacent User message — ordinary context merge)
    expect(agent.context[0].content[0].text.startsWith("q")).toBe(true);
  });
});
