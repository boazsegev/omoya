import { describe, expect, test } from "bun:test";
import { Context } from "../lib/context.js";
import { Agent } from "../lib/agent.js";
import { providerComplete } from "../lib/io/provider.js";
import OpenAI from "../providers/openai.js";
import Anthropic from "../providers/anthropic.js";
import Claude from "../providers/claude.js";
import Kimi from "../providers/kimi.js";
import Gemini from "../providers/gemini.js";
import Ollama from "../providers/ollama.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const details = { reasoning_tokens: 3, cached_tokens: 2 };
const extra = { cost: 0.0125, token_details: details, service_tier: "standard" };
const cases = [
  ["OpenAI", OpenAI, [{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, ...extra } } }]],
  ...[Anthropic, Claude].map((Provider) => [Provider.name, Provider, [
    { type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 1, token_details: details } } },
    { type: "message_delta", usage: { output_tokens: 5, cost: extra.cost, service_tier: extra.service_tier } },
    { type: "message_stop" },
  ]]),
  ["Kimi", Kimi, [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, ...extra } }]],
  ["Gemini", Gemini, [{ event_type: "interaction.completed", interaction: { status: "completed", usage: { total_input_tokens: 10, total_output_tokens: 5, ...extra } } }]],
  ["Ollama", Ollama, [{ done: true, message: { content: "" }, prompt_eval_count: 10, eval_count: 5, ...extra, eval_duration: 123 }]],
];

describe("all provider usage reaches the normalized envelope", () => {
  for (const [name, Provider, frames] of cases) {
    test(`${name} normalizes tier and preserves bounded cost and unknown nested fields`, () => {
      const connection = new (providerComplete(Provider))(undefined, { context: {}, tools: () => [] });
      const state = {};
      const terminal = frames.flatMap((frame) => connection.msg2events(frame, state)).at(-1);
      expect(terminal.type).toBe("done");
      const usage = Context.usageFinalize(terminal.usage, [], { content: [] });
      expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider", cost: extra.cost, serviceTier: "standard", details: { token_details: details } });
      expect(usage.details.token_details).not.toBe(details);
      expect(usage.service_tier).toBeUndefined();
    });
  }
});

test("token estimation retains provider cost and extra fields on a partial report", () => {
  const usage = Context.usageFinalize({ inputTokens: 10, ...extra }, [USER("hello")], { content: [{ type: "text", text: "hi" }] });
  expect(usage.source).toBe("estimate");
  expect(usage).toMatchObject({ cost: extra.cost, serviceTier: extra.service_tier, details: { token_details: details } });
  expect(usage.outputTokens).toBeGreaterThan(0);
  expect(Context.usageFinalize({ cost: NaN }, [], {}).cost).toBeUndefined();
});

test("Agent adds each IO round's cost but snapshots unknown metrics across tools and later runs", async () => {
  const env = await testEnv();
  env.toolAdd("fake-tool", () => "ok", { description: "fake", inputSchema: {} });
  const io = scriptedIO([
    [...TOOLCALL(0, "c1", "fake-tool", {}), { type: "done", usage: { inputTokens: 10, outputTokens: 5, ...extra } }],
    [...TEXT(0, "done"), { type: "done", usage: { inputTokens: 20, outputTokens: 10, ...extra } }],
    [...TEXT(0, "again"), { type: "done", usage: { inputTokens: 30, outputTokens: 15, ...extra, service_tier: "priority" } }],
  ]);
  const agent = await Agent.create({ env, model: "fake/m", context: [USER("go")], createIO: () => io });
  await agent.run();
  expect(agent.usage.cost).toBeCloseTo(0.025);
  expect(agent.usage.details.token_details).toEqual(details);
  agent.context.append(USER("again"));
  await agent.run();
  expect(agent.usage.cost).toBeCloseTo(0.0375);
  expect(agent.usage.details.token_details).toEqual(details);
  expect(agent.usage.serviceTier).toBe("priority");
  const snapshot = agent.usage;
  snapshot.details.token_details.reasoning_tokens = 99;
  expect(agent.usage.details.token_details.reasoning_tokens).toBe(3);
  expect(details.reasoning_tokens).toBe(3);
  await agent.close();
});

test("Agent counts billed failed IO attempts before retrying", async () => {
  const env = await testEnv({ retry: { attempts: 2, base: 1, max: 1 } });
  const io = scriptedIO([
    [{ type: "error", kind: "network", error: "retry", usage: { inputTokens: 10, outputTokens: 1, cost: 0.01 } }],
    [...TEXT(0, "ok"), { type: "done", usage: { inputTokens: 20, outputTokens: 2, cost: 0.02 } }],
  ]);
  const agent = await Agent.create({ env, model: "fake/m", context: [USER("go")], createIO: () => io });
  await agent.run();
  expect(io.writes).toHaveLength(2);
  expect(agent.usage.cost).toBeCloseTo(0.03);
  expect(agent.usage.inputTokens).toBe(30);
  await agent.close();
});

test("Context plan reports preserve nested provider metadata without sharing mutable data", () => {
  const context = new Context({ messages: [] });
  const report = { label: "Pro", details: { renewal_time: "tomorrow", enabled: false, missing: null, credits: [1, 2] }, quotas: { rolling_window: { used: 3, custom_details: { bonus_tokens: 5 }, enabled: false } } };
  context.planUsage = report;
  expect(context.planUsage).toEqual(report);
  report.details.credits.push(3);
  const snapshot = context.planUsage;
  snapshot.quotas.rolling_window.custom_details.bonus_tokens = 99;
  expect(context.planUsage.details.credits).toEqual([1, 2]);
  expect(context.planUsage.quotas.rolling_window.custom_details.bonus_tokens).toBe(5);
});

test("account-usage details omit normalized sources and wallet internals", async () => {
  const originalFetch = globalThis.fetch;
  const body = { plan_type: "Pro", provider_flag: false, unknown_metadata: { bonus_tokens: 50 }, rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } }, usage: { limit: "100", used: "5" }, data: { available_balance: 12 }, booster_wallet: { balance: "3" } };
  globalThis.fetch = async () => Response.json(body);
  try {
    for (const [Provider, url] of [[OpenAI, "https://chatgpt.com/backend-api/codex"], [Kimi, "https://api.kimi.com/coding/v1"], [Kimi, "https://api.moonshot.ai/v1"]]) {
      const context = new Context({ messages: [] });
      const io = { context, settings: { auth: { token: "fake" } } };
      const connection = new (providerComplete(Provider))(url, io);
      await connection.reportPlanUsage(new Headers(), io);
      const text = JSON.stringify(context.planUsage.details);
      expect(text).toContain('"provider_flag":false');
      expect(text).toContain('"bonus_tokens":50');
      expect(text).not.toContain("booster_wallet");
      if (Provider === OpenAI) expect(text).not.toContain("primary_window");
      else if (url.includes("coding")) expect(text).not.toContain('"usage":');
      else expect(text).not.toContain("available_balance");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("plan reports retain all supplied rate-limit headers but no unrelated headers", () => {
  for (const Provider of [OpenAI, Anthropic, Claude, Kimi]) {
    const context = new Context({ messages: [] });
    const io = { context, tools: () => [] };
    const connection = new (providerComplete(Provider))("https://example.test/v1", io);
    const name = [Anthropic, Claude].includes(Provider) ? "anthropic-ratelimit-custom_field" : "x-ratelimit-custom_field";
    connection.reportPlanUsage(new Headers({ [name]: "future data", "set-cookie": "secret", "content-type": "text/event-stream" }), io);
    expect(context.planUsage.details).toEqual({ [name]: "future data" });
  }
});

test("provider data cannot mutate prototypes when accumulated", async () => {
  const env = await testEnv();
  const io = scriptedIO([[...TEXT(0, "ok"), { type: "done", usage: JSON.parse('{"inputTokens":1,"outputTokens":1,"cost":0.5,"__proto__":{"polluted":true},"token_details":{"constructor":3,"reasoning_tokens":2}}') }]]);
  const agent = await Agent.create({ env, model: "fake/m", context: [USER("go")], createIO: () => io });
  await agent.run();
  expect(agent.usage.cost).toBe(0.5);
  expect(Object.hasOwn(agent.usage, "__proto__")).toBe(false);
  expect(Object.hasOwn(agent.usage.details.token_details, "constructor")).toBe(false);
  expect({}.polluted).toBeUndefined();
  await agent.close();
});
