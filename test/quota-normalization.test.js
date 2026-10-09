import { expect, test } from "bun:test";
import Context from "../lib/context.js";
import Anthropic from "../providers/anthropic.js";
import OpenAI from "../providers/openai.js";
import Kimi from "../providers/kimi.js";
import { providerComplete } from "../lib/io/provider.js";

function connection(Provider, url) {
  const context = new Context({ messages: [] });
  const io = { context, settings: { auth: { token: "fake" } }, tools: () => [] };
  return { context, io, provider: new (providerComplete(Provider))(url, io) };
}

test("Context normalizes quota aliases without losing unknown fields or mutating reports", () => {
  const context = new Context({ messages: [] });
  const report = { label: "prolite", quotas: { "4h": { window_seconds: "14400", used_percent: 6.25, reset_at: 1792356600, limit_reached: false, custom: { enabled: false } }, "1d": { windowSeconds: 86400, window_seconds: 1, used: 0, used_percent: 90, total: 100, unit: "percent" } } };
  context.planUsage = report;
  expect(context.planUsage.quotas["4h"]).toEqual({ windowSeconds: 14400, total: 100, used: 6.25, remaining: 93.75, unit: "percent", reset: "2026-10-18T20:50:00.000Z", limitReached: false, custom: { enabled: false } });
  expect(context.planUsage.quotas["1d"]).toEqual({ windowSeconds: 86400, used: 0, total: 100, unit: "percent" });
  expect(report.quotas["4h"].window_seconds).toBe("14400");
  const snapshot = context.planUsage;
  context.planUsage = snapshot;
  expect(context.planUsage).toEqual(snapshot);
  snapshot.quotas["4h"].custom.enabled = true;
  expect(context.planUsage.quotas["4h"].custom.enabled).toBe(false);
});

test("Anthropic unified metadata becomes canonical window and account state without raw duplicates", () => {
  const { context, io, provider } = connection(Anthropic, "https://api.anthropic.com/v1");
  provider.reportPlanUsage(new Headers({
    "anthropic-ratelimit-unified-4h-utilization": "0.125",
    "anthropic-ratelimit-unified-4h-reset": "1792356600",
    "anthropic-ratelimit-unified-4h-status": "allowed",
    "anthropic-ratelimit-unified-1d-status": "rejected",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-reset": "1792356600",
    "anthropic-ratelimit-unified-representative-claim": "four_hour",
    "anthropic-ratelimit-unified-fallback-percentage": "0.5",
    "anthropic-ratelimit-unified-overage-status": "allowed",
    "anthropic-ratelimit-unified-overage-utilization": "0.0",
    "anthropic-ratelimit-unified-overage-reset": "1793491200",
    "anthropic-ratelimit-unified-future-signal": "unknown",
  }), io);
  const plan = context.planUsage;
  expect(plan.quotas["4h"]).toMatchObject({ used: 12.5, total: 100, unit: "percent", windowSeconds: 14400, status: "allowed" });
  expect(plan.quotas["1d"]).toEqual({ windowSeconds: 86400, status: "rejected" });
  expect(plan.status).toBe("allowed");
  expect(plan.reset).toBe("2026-10-18T20:50:00.000Z");
  expect(plan.representativeClaim).toBe("four_hour");
  expect(plan.fallbackPercentage).toBe(0.5);
  expect(plan.overage).toMatchObject({ total: 100, used: 0, remaining: 100, unit: "percent", status: "allowed" });
  expect(plan.quotas.overage).toBeUndefined();
  expect(plan.details).toEqual({ "anthropic-ratelimit-unified-future-signal": "unknown" });
});

test("malformed quota fields are not coerced to zero and unknown detail snapshots remain bounded", () => {
  const context = new Context({ messages: [] });
  const cycle = {}; cycle.self = cycle;
  context.planUsage = { quotas: { bad: { window_seconds: false, total: null, used_percent: "", remaining: -1, reset_at: true, allowed: false }, ok: { used: 0, window_seconds: 0 } }, details: { cycle, missing: null, enabled: false } };
  expect(context.planUsage.quotas.bad).toEqual({ allowed: false });
  expect(context.planUsage.quotas.ok).toEqual({ used: 0 });
  expect(context.planUsage.details).toEqual({ cycle: {}, missing: null, enabled: false });
  context.planUsage = { quotas: {}, details: { "anthropic-ratelimit-unified-5h-utilization": "bad", "anthropic-ratelimit-unified-5h-status": "", unrelated: "kept" } };
  expect(context.planUsage.details).toMatchObject({ "anthropic-ratelimit-unified-5h-utilization": "bad", unrelated: "kept" });
});

test("OpenAI promotes independent known quota scopes and preserves unconsumed window extensions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    plan_type: "prolite", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 6.25, limit_window_seconds: 604800, future_flag: false } },
    code_review_rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 86400 } },
    additional_rate_limits: [{ limit_name: "research", rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 14400 } }, future: "keep" }],
    model_usage: { example: { available: true, available_at: null } }, credits: { balance: 0, has_credits: false },
  });
  try {
    const { context, io, provider } = connection(OpenAI, "https://chatgpt.com/backend-api/codex");
    await provider.reportPlanUsage(new Headers(), io);
    const plan = context.planUsage;
    expect(plan.label).toBe("prolite");
    expect(plan.allowed).toBe(true);
    expect(plan.limitReached).toBe(false);
    expect(plan.quotas["7d"]).toMatchObject({ used: 6.25, windowSeconds: 604800, future_flag: false });
    expect(plan.quotas["codeReview · 1d"]).toMatchObject({ used: 100, allowed: false, limitReached: true });
    expect(plan.quotas["research · 4h"]).toMatchObject({ used: 20 });
    expect(plan.details.model_usage.example).toEqual({ available: true, available_at: null });
    expect(plan.details.credits).toEqual({ balance: 0, has_credits: false });
    expect(JSON.stringify(plan.details)).not.toContain("used_percent");
    expect(JSON.stringify(plan.details)).toContain("keep");
  } finally { globalThis.fetch = original; }
});

test("Kimi recognizes future ratio window names and explicit window seconds", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ usage: { limit: 200, used: 10, window_seconds: 14400 }, usages: { limit_4h: { used_ratio: 0.125 }, limit_1d: { used_ratio: 0, window_seconds: 86400 }, future: { strange: false } } });
  try {
    const { context, io, provider } = connection(Kimi, "https://api.kimi.com/coding/v1");
    await provider.reportPlanUsage(new Headers(), io);
    expect(context.planUsage.quotas["4h"]).toMatchObject({ total: 200, used: 10, windowSeconds: 14400 });
    expect(context.planUsage.quotas["1d"]).toMatchObject({ total: 100, used: 0, windowSeconds: 86400 });
    expect(context.planUsage.quotas["7d"]).toBeUndefined();
    expect(context.planUsage.details.usages.future).toEqual({ strange: false });
  } finally { globalThis.fetch = original; }
});
