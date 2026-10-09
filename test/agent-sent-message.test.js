import { expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { AgentSession } from "../lib/app/web/session.js";
import { scriptedIO, testEnv, TEXT, USER } from "./fakes.js";

async function fixture(script = [[...TEXT(0, "reply"), { type: "done" }]]) {
  const env = await testEnv();
  const io = scriptedIO(script);
  const agent = await Agent.create({ env, model: "p/m", context: [], createIO: () => io });
  return { env, agent, io };
}

test("SENT_MESSAGE fires once for an idle user append", async () => {
  const { agent, env } = await fixture();
  const events = [];
  agent.onEvent(Agent.EVENT.SENT_MESSAGE, (message) => events.push([message.content[0].text, agent.context.at(-1).content[0].text]));
  try {
    await agent.send(USER("hello"));
    expect(events).toEqual([["hello", "hello"]]);
  } finally { await agent.close(); env.close(); }
});

test("SENT_MESSAGE fires once when queued user enters context, not when queued", async () => {
  const { agent, env } = await fixture([[...TEXT(0, "first"), { type: "done" }], [...TEXT(0, "second"), { type: "done" }]]);
  const sent = [];
  agent.onEvent(Agent.EVENT.SENT_MESSAGE, (message) => sent.push(message.content[0].text));
  try {
    const turn = agent.send(USER("first"));
    agent.send(USER("queued"));
    expect(sent).toEqual(["first"]);
    await turn;
    expect(sent).toEqual(["first", "queued"]);
  } finally { await agent.close(); env.close(); }
});

test("SENT_MESSAGE covers the internal compact instruction", async () => {
  const { agent, env } = await fixture([[...TEXT(0, "summary"), { type: "done" }]]);
  const sent = [];
  agent.onEvent(Agent.EVENT.SENT_MESSAGE, (message) => sent.push(message.content[0].text));
  try {
    await agent.compact();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Create a detailed summary");
  } finally { await agent.close(); env.close(); }
});

test("Web session emits one idle chat.user and preserves queued chat.queue behavior", async () => {
  const { agent, env } = await fixture([[...TEXT(0, "first"), { type: "done" }], [...TEXT(0, "second"), { type: "done" }]]);
  const session = new AgentSession(agent);
  const packets = [];
  session.addSink((packet) => packets.push(packet));
  try {
    session.submit("first");
    expect(packets.filter((packet) => packet.type === "chat.user").map((packet) => packet.message.text)).toEqual(["first"]);
    session.submit("second");
    expect(packets.filter((packet) => packet.type === "chat.queue").at(-1)?.messages).toEqual(["second"]);
    await agent.run();
    expect(packets.filter((packet) => packet.type === "chat.user").map((packet) => packet.message.text)).toEqual(["first", "second"]);
    expect(packets.filter((packet) => packet.type === "chat.queue").at(-1)?.messages).toEqual([]);
  } finally { session.dispose(); await agent.close(); env.close(); }
});

test("SENT_MESSAGE does not fire if context append fails", async () => {
  const { agent, env } = await fixture();
  const sent = [];
  agent.onEvent(Agent.EVENT.SENT_MESSAGE, (message) => sent.push(message));
  const append = agent.context.append;
  agent.context.append = () => { throw new Error("append failed"); };
  try {
    expect(() => agent._append(USER("nope"))).toThrow("append failed");
    expect(sent).toEqual([]);
  } finally { agent.context.append = append; await agent.close(); env.close(); }
});
