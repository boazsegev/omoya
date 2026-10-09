import { expect, test } from "bun:test";
import Context from "../lib/context.js";
import OpenAI from "../providers/openai.js";
import { providerComplete } from "../lib/io/provider.js";

test("quota snapshots reject prototype keys and bound header-created windows", () => {
  const context = new Context({ messages: [] });
  const details = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`anthropic-ratelimit-unified-${n + 1}h-status`, "allowed"]));
  context.planUsage = JSON.parse(JSON.stringify({ details, quotas: JSON.parse('{"__proto__":{"polluted":true},"constructor":{},"prototype":{}}'), overage: false }));
  expect(Object.keys(context.planUsage.quotas)).toHaveLength(32);
  expect(Object.keys(context.planUsage.details)).toHaveLength(28);
  expect(context.planUsage.overage).toBe(false);
  expect({}.polluted).toBeUndefined();
  const first = context.planUsage;
  context.planUsage = first;
  expect(context.planUsage).toEqual(first);
});

test("bounded normalized quotas are stable when copied back into Context", () => {
  const context = new Context({ messages: [] });
  context.planUsage = { quotas: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`${index + 1}h`, { total: 100, used: 10, remaining: 90, status: "allowed", allowed: true, limitReached: false }])) };
  const snapshot = context.planUsage;
  context.planUsage = snapshot;
  expect(context.planUsage).toEqual(snapshot);
});

test("OpenAI malformed additional scopes cannot discard a valid account report", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ plan_type: "Plus", rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 3600 } }, additional_rate_limits: [null, false, "unknown"], model_usage: { available: false } });
  try {
    const context = new Context({ messages: [] });
    const io = { context, settings: { auth: { token: "fake" } } };
    const provider = new (providerComplete(OpenAI))("https://chatgpt.com/backend-api/codex", io);
    await provider.reportPlanUsage(new Headers(), io);
    expect(context.planUsage.quotas["1h"].used).toBe(1);
    expect(context.planUsage.details.additional_rate_limits).toEqual([null, false, "unknown"]);
  } finally { globalThis.fetch = original; }
});

test("quota percentages fill missing usage against an explicit count total without replacing counts", () => {
  const context = new Context({ messages: [] });
  context.planUsage = { quotas: { count: { limit: 200, used_ratio: 0.25 }, explicit: { total: 200, remaining: 20, used_ratio: 0.1 }, percent: { total: 100, unit: "percent", used_percent: 6.25 } } };
  expect(context.planUsage.quotas.count).toEqual({ total: 200, used: 50, remaining: 150 });
  expect(context.planUsage.quotas.explicit).toEqual({ total: 200, remaining: 20 });
  expect(context.planUsage.quotas.percent).toEqual({ total: 100, used: 6.25, remaining: 93.75, unit: "percent" });
});
