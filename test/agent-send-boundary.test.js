import { expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER } from "./fakes.js";

test("send converts a plain string to a user message before the request", async () => {
  const env = await testEnv();
  const io = scriptedIO([[{ type: "done" }]]);
  const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
  await agent.send("  hello  ");
  expect(io.writes[0].context.at(-1)).toEqual(USER("hello"));
  agent.close();
});

test("send rejects malformed input without queueing or modifying context", async () => {
  const env = await testEnv();
  const agent = await Agent.create({ env });
  const before = agent.context.messages();
  for (const input of [null, 42, {}, { type: 2 }, { type: 2, content: "bad" }]) {
    const result = agent.send(input);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow();
    expect(agent.pending).toEqual([]);
    expect(agent.context.messages()).toEqual(before);
  }
  agent.close();
  await expect(agent.send("late")).rejects.toThrow(/closed/);
});

test("busy send rejects bad input before it can enter the pending queue", async () => {
  const env = await testEnv();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const io = scriptedIO([]);
  io.write = async () => { await held; return { type: "done" }; };
  const agent = await Agent.create({ env, model: "p/m", createIO: () => io });
  const run = agent.send("first");
  await expect(agent.send({ type: 2, content: null })).rejects.toThrow();
  expect(agent.pending).toEqual([]);
  release();
  await run;
  agent.close();
});

test("Agent.open acquires a ready environment for provider and tool registries", async () => {
  const agent = await Agent.create();
  try {
    const tools = await agent.tools;
    expect(tools.has("read")).toBe(true);
    await agent.env.modelsReady;
    expect(agent.env.loginPresets().length).toBeGreaterThan(0);
    expect(await agent.env.toolCall("read", { path: "package.json" })).toBeDefined();
  } finally { await agent.close(); await agent.env.close(); }
});
