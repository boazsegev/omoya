import { expect, test } from "bun:test";
import Context from "../lib/context.js";
import { providerComplete } from "../lib/io/provider.js";
import Anthropic from "../providers/anthropic.js";
import OpenAI from "../providers/openai.js";
import Kimi from "../providers/kimi.js";

function connection(Provider, url) {
  const context = new Context({ messages: [] });
  const io = { context, settings: { auth: { token: "fake" } }, tools: () => [] };
  return { context, io, provider: new (providerComplete(Provider))(url, io) };
}

test("Anthropic exposes input/output quota dimensions without duplicating represented headers", () => {
  const { context, io, provider } = connection(Anthropic, "https://api.anthropic.com/v1");
  provider.reportPlanUsage(new Headers({ "anthropic-ratelimit-input-tokens-limit": "1000", "anthropic-ratelimit-input-tokens-remaining": "750", "anthropic-ratelimit-input-tokens-reset": "2026-10-15T20:00:00Z", "anthropic-ratelimit-output-tokens-limit": "200", "anthropic-ratelimit-output-tokens-remaining": "190", "anthropic-ratelimit-custom": "future" }), io);
  expect(context.planUsage.quotas.inputTokens).toEqual({ total: 1000, remaining: 750, reset: "2026-10-15T20:00:00Z" });
  expect(context.planUsage.quotas.outputTokens).toEqual({ total: 200, remaining: 190 });
  expect(context.planUsage.details).toEqual({ "anthropic-ratelimit-custom": "future" });
});

test("Kimi explicit counts beat ratios and wallet identities never enter plan details", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ usage: { limit: "100", used: "8", remaining: "92", reset_time: "2026-10-17T17:00:00Z" }, limits: [{ window: { duration: 300, time_unit: "TIME_UNIT_MINUTE" }, detail: { limit: 100, remaining: 100, reset_time: "2026-10-15T17:00:00Z" } }], usages: { limit_5h: { used_ratio: 0.1234, reset_time: "later" }, limit_7d: { used_ratio: 0.0803 } }, booster_wallet: { user_id: "private", balance: { amount: 6000000000, unit: "UNIT_CURRENCY" }, monthly_charge_limit_enabled: true, monthly_charge_limit: { currency: "USD", price_in_cents: 4000 }, monthly_used: { currency: "USD", price_in_cents: 125 } }, provider_flag: false });
  try {
    const { context, io, provider } = connection(Kimi, "https://api.kimi.com/coding/v1");
    await provider.reportPlanUsage(new Headers(), io);
    expect(context.planUsage.quotas["5h"]).toMatchObject({ total: 100, used: 0, remaining: 100, windowSeconds: 18000 });
    expect(context.planUsage.quotas["7d"]).toMatchObject({ total: 100, used: 8, remaining: 92, windowSeconds: 604800 });
    expect(context.planUsage.quotas.boosterMonthlySpend).toEqual({ total: 40, used: 1.25, remaining: 38.75, unit: "usd" });
    expect(JSON.stringify(context.planUsage)).not.toContain("private");
    expect(JSON.stringify(context.planUsage)).not.toContain("6000000000");
    expect(context.planUsage.details).toEqual({ provider_flag: false });
  } finally { globalThis.fetch = original; }
});

test("Kimi ratio-only quotas preserve precision and accept published window units", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ usages: { limit_5h: { used_ratio: 0.0803, reset_time: "2026-10-15T17:00:00Z" } }, limits: [{ window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: 200, used: 50 } }] });
  try {
    const { context, io, provider } = connection(Kimi, "https://api.kimi.com/coding/v1");
    await provider.reportPlanUsage(new Headers(), io);
    expect(context.planUsage.quotas["5h"].used).toBeCloseTo(8.03);
    expect(context.planUsage.quotas["5h"].unit).toBe("percent");
    expect(context.planUsage.quotas["1d"]).toMatchObject({ total: 200, used: 50, remaining: 150, windowSeconds: 86400 });
  } finally { globalThis.fetch = original; }
});

test("OpenAI account quotas preserve fractional percentages and omit represented raw windows", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ plan_type: "Pro", rate_limit: { primary_window: { used_percent: 8.03, limit_window_seconds: 18000, reset_at: 1792083600 } }, provider_flag: false });
  try {
    const { context, io, provider } = connection(OpenAI, "https://chatgpt.com/backend-api/codex");
    await provider.reportPlanUsage(new Headers(), io);
    expect(context.planUsage.quotas["5h"]).toMatchObject({ used: 8.03, total: 100, unit: "percent", reset: "2026-10-15T17:00:00.000Z" });
    expect(context.planUsage.details).toEqual({ provider_flag: false });
  } finally { globalThis.fetch = original; }
});
