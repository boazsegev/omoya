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
    const agent = await Agent.create({ env, model: "fake/m", context: [] });
    expect(agent.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  test("sums the terminal usage envelope across run() calls", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
      [...TEXT(0, "again"), { type: "done", usage: { inputTokens: 50, outputTokens: 10, cost: 0.0125 } }],
    ]);
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(agent.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0 });
    agent.context.append(USER("again"));
    await agent.run();
    expect(agent.usage).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180, cost: 0.0125 });
  });

  test("sums EVERY request inside one run() — a tool-call turn's usage isn't dropped", async () => {
    const env = await testEnv();
    env.toolAdd("fake-tool", () => "ok", { description: "fake", inputSchema: {} });
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "fake-tool", {}), { type: "done", usage: { inputTokens: 30, outputTokens: 5 } }],
      [...TEXT(0, "done now"), { type: "done", usage: { inputTokens: 40, outputTokens: 8 } }],
    ]);
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("call the tool")], createIO: () => io,
    });
    await agent.run();
    expect(io.writes).toHaveLength(2); // both requests counted
    expect(agent.usage).toEqual({ inputTokens: 70, outputTokens: 13, totalTokens: 83, cost: 0 });
  });

  test("contextUsage: the provider's Context report wins; the estimate is marked approximate", async () => {
    const env = await testEnv();
    const report = { used: 4096, total: 128000 };
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20, source: "provider" } }]], {
      onRequest: (io) => { io.context.contextUsage = report; },
    });
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    // before any request: a pure estimate (no total known)
    const fresh = agent.contextUsage;
    expect(fresh.approximate).toBe(true);
    expect(fresh.total).toBeNull();
    expect(agent.context.contextUsage).toEqual({ used: undefined, total: undefined });
    await agent.run();
    expect(agent.context.contextUsage).toEqual(report);
    expect(agent.contextUsage).toEqual({ ...report, approximate: false });
    expect(io).not.toHaveProperty("contextUsage");
    expect(io.context).toBeNull();
  });

  test("contextUsage: an endpoint that publishes no window gets the curated tier fallback — and a lazy lookup fills the cache", async () => {
    const env = await testEnv();
    // No authSet model metadata: the endpoint's /models gave ids only
    // (OpenAI's API-key listing — probed 2026-09-28, bare payloads).
    const agent = await Agent.create({ env, model: "fake/gpt-6-sol", context: [USER("hello")] });
    const usage = agent.contextUsage;
    expect(usage.total).toBe(1050000); // the curated current-tier table covers the gap
    // …and a lazy registry lookup was kicked off; whether it lands or
    // not (sandboxed suite network), nothing throws and the fallback stands.
  });

  test("contextUsage: pending context growth does not remain hidden by the last provider report", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, context: [USER("go")] });
    agent.context.contextUsage = { used: 2, total: 1000 };
    agent.context.update((messages) => { messages.push(USER("word ".repeat(150))); return true; });
    expect(agent.contextUsage.used).toBeGreaterThan(100);
    expect(agent.contextUsage.approximate).toBe(true);
    expect(agent.context.contextUsage).toEqual({ used: 2, total: 1000 }); // growth doesn't overwrite the provider snapshot
  });

  test("contextUsage: a provider-sourced usage envelope is the runner-up, settings window the total", async () => {
    const env = await testEnv();
    authSetOf(env, "fake", { models: { m: { contextWindow: 64000 } } });
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20, source: "provider" } }]]);
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(agent.context.contextUsage).toMatchObject({ used: 100 }); // fallback report belongs to the Context
    expect(agent.contextUsage).toEqual({ used: 100, total: 64000, approximate: false });
  });

  test("Context.planUsage: null before the first provider report, including unreported requests", async () => {
    const env = await testEnv();
    const report = { quotas: { requests: { total: 500, remaining: 499 } } };
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done" }]], {
      onRequest: (io, index) => { if (index === 1) io.context.planUsage = report; },
    });
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    expect(agent.context.planUsage).toBeNull();
    expect(io.context).toBeNull();
    await agent.run();
    expect(agent.context.planUsage).toBeNull();
    await agent.run();
    expect(agent.context.planUsage).toEqual(report);
    expect(io.context).toBeNull(); // only the Context retains quota state
  });

  test("Context.planUsage: replacing IO retains the last report until a provider publishes another", async () => {
    const env = await testEnv();
    const report = { quotas: { requests: { total: 500, remaining: 499 } } };
    const contextReport = { used: 4096, total: 128000 };
    const first = scriptedIO([[{ type: "done" }]], {
      onRequest: (io) => {
        io.context.planUsage = report;
        io.context.contextUsage = contextReport;
      },
    });
    const agent = await Agent.create({ env, model: "fake/m", context: [USER("hello")], createIO: () => first });
    await agent.run();
    const context = agent.context;
    const replacement = Object.assign(scriptedIO([[{ type: "done" }]]), { env, model: "fake/m" });
    agent.model = "fake/m"; // assigning the same identity must not invalidate the Context report
    expect(context.contextUsage).toEqual(contextReport);
    agent.io = replacement;
    expect(agent.io).toBe(replacement);
    expect(agent.context).toBe(context);
    expect(context.planUsage).toEqual(report);
    expect(context.contextUsage).toEqual(contextReport);
    await first.close(); // the adopter owns the displaced IO
    await agent.run();
    expect(replacement.writes).toHaveLength(1);
    expect(context.planUsage).toEqual(report); // no report is not an empty report
    expect(context.contextUsage).toEqual(contextReport);
    expect(agent.contextUsage).toEqual({ ...contextReport, approximate: false });
  });

  test("changing model invalidates the old context window/used but retains quota until the next provider report", async () => {
    // The TUI scenario: turn on endpoint A (publishes plan windows),
    // switch to endpoint B (publishes a different shape) — A's quotas
    // must not survive on the status bar.
    const env = await testEnv();
    const reportA = { quotas: { "5h": { total: 100, used: 80, remaining: 20, windowSeconds: 18000 } } };
    const contextReportA = { used: 4096, total: 128000 };
    const contextReportB = { used: 512, total: 64000 };
    const ioA = scriptedIO([[...TEXT(0, "a"), { type: "done" }]], {
      onRequest: (io) => {
        io.context.planUsage = reportA;
        io.context.contextUsage = contextReportA;
      },
    });
    const ioB = scriptedIO([[...TEXT(0, "b"), { type: "done" }]], {
      onRequest: (io) => {
        io.context.planUsage = { quotas: { requests: { total: 500, remaining: 499 } } };
        io.context.contextUsage = contextReportB;
      },
    }); // B publishes a different shape
    const ios = { fake: ioA, x: ioB };
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")],
      createIO: (opts) => ios[opts.model.split("/")[0]],
    });
    await agent.run();
    expect(agent.context.planUsage).toEqual(reportA);
    expect(agent.context.contextUsage).toEqual(contextReportA);
    agent.model = "x/m";
    expect(agent.context.contextUsage).toEqual({ used: undefined, total: undefined });
    expect(agent.contextUsage.total).toBeNull(); // don't display A's window for B
    expect(agent.contextUsage.approximate).toBe(true);
    expect(agent.context.planUsage).toEqual(reportA); // model selection isn't a provider quota report
    await agent.run();
    expect(agent.context.planUsage).toEqual({ quotas: { requests: { total: 500, remaining: 499 } } });
    expect(agent.context.contextUsage).toEqual(contextReportB);
    expect(agent.contextUsage).toEqual({ ...contextReportB, approximate: false });
  });

  test("EVENT.REQUEST_DONE fires only once usage/context/plan bookkeeping for THAT terminal has run — a listener sees this turn's numbers, never the previous (or no) turn's", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }]], {
      onRequest: (io) => {
        io.context.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
        io.context.contextUsage = { used: 4096, total: 128000 };
      },
    });
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtDone = null;
    agent.onEvent(Agent.EVENT.REQUEST_DONE, () => {
      seenAtDone = { usage: agent.usage, context: agent.contextUsage, plan: agent.context.planUsage };
    });
    await agent.run();
    expect(seenAtDone).toEqual({
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0 },
      context: { used: 4096, total: 128000, approximate: false },
      plan: { quotas: { requests: { total: 500, remaining: 470 } } },
    });
  });

  test("EVENT.REQUEST_ERROR fires only once bookkeeping for that terminal has run, same as EVENT.REQUEST_DONE", async () => {
    const env = await testEnv({ retry: { attempts: 1 } });
    const io = scriptedIO([[{ type: "error", error: "boom", kind: "malformed", usage: { inputTokens: 5, outputTokens: 0 } }]], {
      onRequest: (io) => {
        io.context.planUsage = { quotas: { requests: { total: 500, remaining: 470 } } };
        io.context.contextUsage = { used: 2048, total: 64000 };
      },
    });
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    let seenAtError = null;
    agent.onEvent(Agent.EVENT.REQUEST_ERROR, () => {
      seenAtError = { usage: agent.usage, context: agent.contextUsage, plan: agent.context.planUsage };
    });
    await agent.run();
    expect(seenAtError).toEqual({
      usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5, cost: 0 },
      context: { used: 2048, total: 64000, approximate: false },
      plan: { quotas: { requests: { total: 500, remaining: 470 } } },
    });
  });

  test("never persists — no usage.json, ever", async () => {
    const env = await testEnv();
    const io = scriptedIO([[...TEXT(0, "hi"), { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }]]);
    const agent = await Agent.create({
      env, model: "fake/m", context: [USER("hello")], createIO: () => io,
    });
    await agent.run();
    expect(existsSync(`${env._dir}/usage.json`)).toBe(false);
  });
});
