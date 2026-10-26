import { expect, test } from "bun:test";
import { createAgentAdapter } from "../lib/app/tui/agent-adapter.js";
import { waitingForUser } from "../lib/app/host/question-bridge.js";
import { agentInfo } from "../lib/app/web/agent-info.js";

test("web agent snapshots warn for an unanswered question and clear when answered", async () => {
  const agent = { question: null, name: "worker", model: "", ioState: "working", busy: true, context: { id: "s", save: false }, children: [], toolMessages: () => [] };
  let answer;
  const { questionBridgeInstall } = await import("../lib/app/host/question-bridge.js");
  const dispose = questionBridgeInstall(agent, { ask: () => new Promise((resolve) => { answer = resolve; }) });
  try {
    const request = agent.question.ask([]);
    expect(agentInfo(agent, agent).waitingForUser).toBe(true);
    answer([]);
    await request;
    expect(agentInfo(agent, agent).waitingForUser).toBe(false);
  } finally { dispose(); }
});

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
    expect(waitingForUser(first)).toBe(true);
    expect(waitingForUser(second)).toBe(true);
    first.question.timeout();
    expect(await a).toBeNull();
    expect(waitingForUser(first)).toBe(false);
    expect(waitingForUser(second)).toBe(true);
    await Promise.resolve();
    expect(settledA).toBe(true);
    expect(settledB).toBe(false);
    expect(packets.filter((message) => message.type === "agent.question.timed-out").map(({ origin }) => origin)).toEqual([first]);
    adapter.abandonPending();
    expect(await b).toBeNull();
    expect(waitingForUser(second)).toBe(false);
  } finally { adapter.abandonPending(); restoreA(); restoreB(); }
});
