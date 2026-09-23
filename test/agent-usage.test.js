// test/agent-usage.test.js — proof for Agent's cumulative usage
// surface: IO reports a per-turn envelope on every terminal event
// (see lib/context/usage.js); Agent alone sums it in memory, across
// every request a run() makes (including intermediate tool-call
// turns) and across multiple run() calls. Never persisted — no
// usage.json, ever (see lib/env.js's doc header).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

describe("Agent: cumulative usage", () => {
  test("starts at zero", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "fake/m", context: [] });
    expect(agent.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  test("sums the terminal usage envelope across run() calls", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
      [...TEXT(0, "again"), { type: "done", usage: { inputTokens: 50, outputTokens: 10, cost: 0.0125 } }],
    ]);
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(agent.usage).toEqual({ inputTokens: 100, outputTokens: 20, cost: 0 });
    agent.append(USER("again"));
    await agent.run();
    expect(agent.usage).toEqual({ inputTokens: 150, outputTokens: 30, cost: 0.0125 });
  });

  test("sums EVERY request inside one run() — a tool-call turn's usage isn't dropped", async () => {
    const env = await testEnv();
    env.registerTool("fake-tool", () => "ok", { description: "fake", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "fake-tool", {}), { type: "done", usage: { inputTokens: 30, outputTokens: 5 } }],
      [...TEXT(0, "done now"), { type: "done", usage: { inputTokens: 40, outputTokens: 8 } }],
    ]);
    const agent = new Agent({
      env, model: "fake/m", context: [USER("call the tool")], createIO: () => io,
    });
    await agent.run();
    expect(io.writes).toHaveLength(2); // both requests counted
    expect(agent.usage).toEqual({ inputTokens: 70, outputTokens: 13, cost: 0 });
  });

  test("contextUsage: the provider's IO report wins; the estimate is marked approximate", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }]]);
    io.contextUsage = { used: 4096, total: 128000 }; // the provider's own report via IO
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    // before any request: a pure estimate (no total known)
    const fresh = agent.contextUsage;
    expect(fresh.approximate).toBe(true);
    expect(fresh.total).toBeNull();
    await agent.run();
    expect(agent.contextUsage).toEqual({ used: 4096, total: 128000, approximate: false });
  });

  test("contextUsage: a provider-sourced usage envelope is the runner-up, settings window the total", async () => {
    const env = await testEnv();
    env.authSet("fake", { models: { m: { contextWindow: 64000 } } });
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }]]);
    // emitScript's envelopes carry no source tag — tag it like IO's finalizeUsage does
    const origWrite = io.write.bind(io);
    io.write = async (context, callbacks, options) => {
      const terminal = await origWrite(context, callbacks, options);
      if (terminal?.usage && terminal.usage.source === undefined) terminal.usage.source = "provider";
      return terminal;
    };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(agent.contextUsage).toEqual({ used: 100, total: 64000, approximate: false });
  });

  test("planUsage: the provider's IO report is exposed; null when none", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done" }]]);
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    expect(agent.planUsage).toBeNull();
    io.planUsage = { quotas: { requests: { total: 500, remaining: 499 } } };
    await agent.run();
    expect(agent.planUsage).toEqual({ quotas: { requests: { total: 500, remaining: 499 } } });
  });

  test("EVENT.DONE fires only once usage/context/plan bookkeeping for THAT terminal has run — a listener sees this turn's numbers, never the previous (or no) turn's", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }]]);
    io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtDone = null;
    agent.onEvent(Agent.EVENT.DONE, () => {
      seenAtDone = { usage: agent.usage, plan: agent.planUsage };
    });
    await agent.run();
    expect(seenAtDone).toEqual({
      usage: { inputTokens: 100, outputTokens: 20, cost: 0 },
      plan: { quotas: { requests: { total: 500, remaining: 470 } } },
    });
  });

  test("EVENT.ERROR fires only once bookkeeping for that terminal has run, same as EVENT.DONE", async () => {
    const env = await testEnv();
    // "malformed" is not in Env.RETRYABLE_KINDS — one attempt, settles immediately.
    const io = scriptedIO([[{ type: "error", error: "boom", kind: "malformed", usage: { inputTokens: 5, outputTokens: 0 } }]]);
    io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtError = null;
    agent.onEvent(Agent.EVENT.ERROR, () => {
      seenAtError = { usage: agent.usage, plan: agent.planUsage };
    });
    await agent.run();
    expect(seenAtError).toEqual({
      usage: { inputTokens: 5, outputTokens: 0, cost: 0 },
      plan: { quotas: { requests: { total: 500, remaining: 470 } } },
    });
  });

  test("never persists — no usage.json, ever", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }]]);
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(existsSync(`${env.dir}/usage.json`)).toBe(false);
  });
});
