import { expect, test } from "bun:test";
import Context from "../lib/context.js";
import { providerComplete } from "../lib/io/provider.js";
import OpenAI from "../providers/openai.js";
import { usageDetailLines } from "../lib/app/shared/format.js";

test("shared usage maps aliases once and gives explicit reasoning and cache details priority", () => {
  const usage = Context.usageFinalize({ inputTokens: 100, outputTokens: 20, total_tokens: 999, cached_tokens: 1, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 7, thinking_tokens: 9 }, service_tier: "standard", inference_geo: "global" });
  expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7, serviceTier: "standard", inferenceGeo: "global" });
  expect(usage.input_tokens_details).toBeUndefined();
  expect(usage.details).toBeUndefined();
  expect(Context.usageNormalize(usage)).toEqual(usage);
  const estimate = Context.usageFinalize({ cost: 0.1 }, [], {});
  expect(Context.usageFinalize(estimate, [], {})).toEqual(estimate);
  expect(Context.usageNormalize({ cacheReadTokens: 0, cached_tokens: 99, reasoningTokens: 0, thinking_tokens: 99 })).toEqual({ cacheReadTokens: 0, reasoningTokens: 0 });
  expect(Context.usageNormalize({ cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 } })).toEqual({ cacheWriteTokens: 12, cacheWrite5mTokens: 5, cacheWrite1hTokens: 7 });
});

test("provider OpenAI never emits attribution usage", () => {
  const connection = new (providerComplete(OpenAI))(undefined, { context: {}, tools: () => [] });
  const attribution = {};
  Object.defineProperty(attribution, "items", { enumerable: true, get() { throw new Error("attribution must not be traversed"); } });
  const report = { input_tokens: 1, output_tokens: 2 };
  Object.defineProperty(report, "attribution", { enumerable: true, get() { throw new Error("attribution must not be read"); } });
  const terminal = connection.msg2events({ type: "response.completed", response: { usage: report, service_tier: "priority", inference_geo: "us" } }, {}).at(-1);
  expect(Context.usageNormalize({ inputTokens: 1, outputTokens: 2, attribution }).attribution).toBeUndefined();
  expect(terminal.usage.attribution).toBeUndefined();
  expect(terminal.usage.serviceTier).toBe("priority");
});

test("shared lifetime accounting sums only counters and replaces latest provider metadata", () => {
  const first = Context.usageAdd({ inputTokens: 0, outputTokens: 0, cost: 0 }, { inputTokens: 10, outputTokens: 5, cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 3 }, service_tier: "standard", inference_geo: "global", latency: 7 });
  const total = Context.usageAdd(first, { inputTokens: 20, outputTokens: 10, completion_tokens_details: { reasoning_tokens: 2 }, latency: 9 });
  expect(total).toMatchObject({ inputTokens: 30, outputTokens: 15, totalTokens: 45, cacheWriteTokens: 4, reasoningTokens: 5, details: { latency: 9 } });
  expect(total.serviceTier).toBeUndefined();
  expect(total.inferenceGeo).toBeUndefined();
  expect(total.output_tokens_details).toBeUndefined();
  expect(first.serviceTier).toBe("standard");
  expect(first.details.latency).toBe(7);
});

test("usage details are bounded before snapshots and display", () => {
  const fields = { inputTokens: 1, outputTokens: 2, rows: Array.from({ length: 10000 }, (_, index) => ({ index, value: "x".repeat(10000) })) };
  const usage = Context.usageFinalize(fields);
  expect(JSON.stringify(usage).length).toBeLessThan(40000);
  const cycle = {}; cycle.self = cycle;
  const context = new Context({ messages: [] });
  context.planUsage = { details: { fields, cycle }, quotas: {} };
  expect(JSON.stringify(context.planUsage).length).toBeLessThan(40000);
  const lines = usageDetailLines({ ...fields, context: { used: 1, total: 10 } });
  expect(lines.length).toBeLessThanOrEqual(100);
  expect(lines.join("\n").length).toBeLessThan(20000);
});

test("display renders canonical subsets once without raw alias duplicates", () => {
  const text = usageDetailLines({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7, serviceTier: "standard", inferenceGeo: "global" }).join("\n");
  expect(text).toContain("Session: 100 in · 20 out");
  expect(text).toContain("Cache: 30 read · 5 written (input subset)");
  expect(text).toContain("Reasoning: 7 tokens (output subset)");
  expect(text).toContain("Service tier: standard");
  expect(text).toContain("Inference geography: global");
  expect(text).not.toContain("cache read tokens:");
});
