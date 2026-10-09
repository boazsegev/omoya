import { expect, test } from "bun:test";
import { createAgentAdapter } from "../lib/app/tui/agent-adapter.js";

test("one Agent's question timeout does not refuse another Agent's pending question", async () => {
  const first = { question: null };
  const second = { question: null };
  const adapter = createAgentAdapter(first);
  const packets = [];
  const restoreA = adapter.installQuestionBridge((message) => packets.push(message), first);
  const restoreB = adapter.installQuestionBridge((message) => packets.push(message), second);
  try {
    let settledA = false;
    let settledB = false;
    const a = first.question.ask([]).then((value) => { settledA = true; return value; });
    const b = second.question.ask([]).then((value) => { settledB = true; return value; });
    first.question.timeout();
    expect(await a).toBeNull();
    await Promise.resolve();
    expect(settledA).toBe(true);
    expect(settledB).toBe(false);
    expect(packets.filter((message) => message.type === "agent.question.timed-out").map(({ origin }) => origin)).toEqual([first]);
    adapter.abandonPending();
    expect(await b).toBeNull();
  } finally { adapter.abandonPending(); restoreA(); restoreB(); }
});
