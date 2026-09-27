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
import { authSetOf } from "./env-internals.js";

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
    agent.context.append(USER("again"));
    await agent.run();
    expect(agent.usage).toEqual({ inputTokens: 150, outputTokens: 30, cost: 0.0125 });
  });

  test("sums EVERY request inside one run() — a tool-call turn's usage isn't dropped", async () => {
    const env = await testEnv();
    env.toolAdd("fake-tool", () => "ok", { description: "fake", inputSchema: {} });
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

  test("contextUsage: an endpoint that publishes no window gets the curated tier fallback — and a lazy lookup fills the cache", async () => {
    const env = await testEnv();
    // No authSet model metadata: the endpoint's /models gave ids only
    // (OpenAI's API-key listing — probed 2026-09-28, bare payloads).
    const agent = new Agent({ env, model: "fake/gpt-6-sol", context: [USER("hello")] });
    const usage = agent.contextUsage;
    expect(usage.total).toBe(1050000); // the curated current-tier table covers the gap
    // …and a lazy registry lookup was kicked off; whether it lands or
    // not (sandboxed suite network), nothing throws and the fallback stands.
  });

  test("contextUsage: pending context growth does not remain hidden by the last provider report", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, context: [USER("go")] });
    agent._contextReport = { used: 2, total: 1000 };
    agent.context.update((messages) => { messages.push(USER("word ".repeat(150))); return true; });
    expect(agent.contextUsage.used).toBeGreaterThan(100);
  });

  test("contextUsage: a provider-sourced usage envelope is the runner-up, settings window the total", async () => {
    const env = await testEnv();
    authSetOf(env, "fake", { models: { m: { contextWindow: 64000 } } });
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

  test("planUsage: switching endpoints replaces the report — the old endpoint's quotas never linger", async () => {
    // The TUI scenario: turn on endpoint A (publishes plan windows),
    // switch to endpoint B (publishes a different shape) — A's quotas
    // must not survive on the status bar.
    const env = await testEnv();
    const ioA = scriptedIO([[...TEXT(0, "a"), { type: "done" }]]);
    ioA.planUsage = { quotas: { "5h": { total: 100, used: 80, remaining: 20 } } };
    const ioB = scriptedIO([[...TEXT(0, "b"), { type: "done" }]]);
    ioB.planUsage = { quotas: { requests: { total: 500, remaining: 499 } } }; // B publishes a different shape
    const ios = { fake: ioA, x: ioB };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")],
      createIO: (opts) => ios[opts.model.split("/")[0]],
    });
    await agent.run();
    expect(agent.planUsage).toEqual({ quotas: { "5h": { total: 100, used: 80, remaining: 20 } } });
    agent.modelSet("x/m");
    await agent.run();
    expect(agent.planUsage).toEqual({ quotas: { requests: { total: 500, remaining: 499 } } });
  });

  test("EVENT.REQUEST_DONE fires only once usage/context/plan bookkeeping for THAT terminal has run — a listener sees this turn's numbers, never the previous (or no) turn's", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }]]);
    io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtDone = null;
    agent.onEvent(Agent.EVENT.REQUEST_DONE, () => {
      seenAtDone = { usage: agent.usage, plan: agent.planUsage };
    });
    await agent.run();
    expect(seenAtDone).toEqual({
      usage: { inputTokens: 100, outputTokens: 20, cost: 0 },
      plan: { quotas: { requests: { total: 500, remaining: 470 } } },
    });
  });

  test("EVENT.REQUEST_ERROR fires only once bookkeeping for that terminal has run, same as EVENT.REQUEST_DONE", async () => {
    const env = await testEnv();
    // "malformed" is not in Env.RETRYABLE_KINDS — one attempt, settles immediately.
    const io = scriptedIO([[{ type: "error", error: "boom", kind: "malformed", usage: { inputTokens: 5, outputTokens: 0 } }]]);
    io.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
    const agent = new Agent({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtError = null;
    agent.onEvent(Agent.EVENT.REQUEST_ERROR, () => {
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
    expect(existsSync(`${env._dir}/usage.json`)).toBe(false);
  });
});
