// test/tui-status-data.test.js — lib/tui-app/status-data.js's plain-data
// projections: the turn readout line and the plan/quota formatters. No GTUI,
// no Agent — these are pure functions over shaped input.
import { expect, test } from "bun:test";
import { turnReadoutText, formatQuotaText, sortedQuotaEntries } from "../lib/tui-app/status-data.js";

function agentStub({ contextUsage = null, planUsage = null } = {}) {
  return { contextUsage, planUsage };
}

test("turnReadoutText: context only — no in/out, no plan segment (no quotas, no line, no noise)", () => {
  const text = turnReadoutText(agentStub({}));
  expect(text).toBe("context: ~0 tokens");
  expect(text).not.toContain("in=");
  expect(text).not.toContain("plan:");
});

test("turnReadoutText: a sizeable quota appends `plan: <name> <pct>%` right after the context percentage", () => {
  const text = turnReadoutText(agentStub({
    contextUsage: { used: 100, total: 1000, approximate: false },
    planUsage: { quotas: { requests: { total: 500, remaining: 470 } } },
  }));
  expect(text).toBe("context: 100/1000 (10.0%) · plan: requests 6.0%");
});

test("turnReadoutText: multiple quotas join with the same separator, unsizeable ones dropped", () => {
  const text = turnReadoutText(agentStub({
    planUsage: { quotas: {
      requests: { total: 500, remaining: 470 },
      tokens: { total: 100000, used: 25000 },
      unsized: { remaining: 12 }, // no total — can't size a percentage
    } },
  }));
  expect(text).toBe("context: ~0 tokens · plan: requests 6.0% · tokens 25.0%");
});

test("turnReadoutText: a subscription-session window (5h/7d, {total:100, used, remaining}) reads like any other quota", () => {
  const text = turnReadoutText(agentStub({
    contextUsage: { used: 8339, total: 200000, approximate: false },
    planUsage: { quotas: { "5h": { total: 100, used: 2, remaining: 98 }, "7d": { total: 100, used: 42, remaining: 58 } } },
  }));
  expect(text).toBe("context: 8.1K/195.3K (4.2%) · plan: 5h 2.0% · 7d 42.0%");
});

test("formatQuotaText: used/total percentage and remaining-only formatting (unchanged)", () => {
  expect(formatQuotaText("weekly", { total: 131100, used: 4000 })).toBe("weekly 3.9K/128.0K (3.1%)");
  expect(formatQuotaText("requests", { remaining: 49 })).toBe("requests 49 left");
});

test("formatQuotaText: a parseable ISO reset renders as a countdown, not the raw timestamp", () => {
  const reset = new Date(Date.now() + 2 * 3600 * 1000 + 5 * 60 * 1000).toISOString(); // ~2h5m out
  const text = formatQuotaText("requests", { total: 50, remaining: 49, reset });
  expect(text).toMatch(/^requests 1\/50 \(2\.0%\) · resets in 2h\d{1,2}m$/);
});

test("formatQuotaText: a reset at/before now renders \"resets now\"", () => {
  const reset = new Date(Date.now() - 1000).toISOString();
  expect(formatQuotaText("requests", { total: 50, remaining: 50, reset })).toBe("requests 0/50 (0.0%) · resets now");
});

test("formatQuotaText: a non-parseable (duration-shaped) reset is shown verbatim — never misread as a date", () => {
  expect(formatQuotaText("requests", { total: 50, remaining: 49, reset: "20ms" }))
    .toBe("requests 1/50 (2.0%) · reset 20ms");
});

test("formatQuotaText: windowSeconds alone (no reset) adds nothing to the text — it only ever sizes the countdown, never stands in for one", () => {
  expect(formatQuotaText("5h", { total: 100, used: 2, remaining: 98, windowSeconds: 18000 }))
    .toBe("5h 2/100 (2.0%)");
});

test("formatQuotaText: a currency-unit quota (a prepaid balance) formats as money, not a token count", () => {
  expect(formatQuotaText("balance", { remaining: 49.58894, unit: "usd" })).toBe("balance $49.59 left");
  expect(formatQuotaText("balance", { remaining: 120.5, unit: "cny" })).toBe("balance ¥120.50 left");
});

test("sortedQuotaEntries: a soon reset wins over a later one, which wins over a mere window size, which wins over neither", () => {
  const quotas = {
    bigWindow: { windowSeconds: 604800 }, // 7d, no reset
    bare: {}, // neither reset nor window
    later: { reset: new Date(Date.now() + 3 * 3600_000).toISOString() }, // ~3h out
    smallWindow: { windowSeconds: 18000 }, // 5h, no reset
    soon: { reset: new Date(Date.now() + 5 * 60_000).toISOString() }, // ~5m out
  };
  expect(sortedQuotaEntries(quotas).map(([name]) => name))
    .toEqual(["soon", "later", "smallWindow", "bigWindow", "bare"]);
});

test("sortedQuotaEntries: ties within a tier keep their original/insertion order (stable)", () => {
  const quotas = { b: {}, a: {}, c: {} };
  expect(sortedQuotaEntries(quotas).map(([name]) => name)).toEqual(["b", "a", "c"]);
});

test("turnReadoutText: the compact plan line orders quotas by importance too (smallest window first, here — neither has a reset)", () => {
  const text = turnReadoutText(agentStub({
    planUsage: { quotas: {
      "7d": { total: 100, used: 10, remaining: 90, windowSeconds: 604800 },
      "5h": { total: 100, used: 20, remaining: 80, windowSeconds: 18000 },
    } },
  }));
  expect(text).toBe("context: ~0 tokens · plan: 5h 20.0% · 7d 10.0%");
});
