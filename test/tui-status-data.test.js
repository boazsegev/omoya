// test/tui-status-data.test.js — lib/app/tui/status-data.js's plain-data
// projections: the turn readout line and the plan/quota formatters. No GTUI,
// no Agent — these are pure functions over shaped input.
import { expect, test } from "bun:test";
import { turnReadoutParts, formatQuotaText } from "../lib/app/tui/status-data.js";
import { modelParts, sortedQuotaEntries } from "../lib/app/shared/format.js";

test("modelParts: splits the first slash only and leaves missing selection empty", () => {
  expect(modelParts("endpoint/team/model")).toEqual({ endpoint: "endpoint", model: "team/model" });
  expect(modelParts(undefined)).toEqual({});
});

test("statusData: model setting chips display native model id, without changing qualified Agent.model", async () => {
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const agent = { model: "endpoint/team/model", context: { save: false } };
  const [endpoint, model] = statusData({ agent }).chips;
  expect(endpoint.label).toBe("endpoint");
  expect(model.label).toBe("team/model");
  expect(agent.model).toBe("endpoint/team/model");
});

function agentStub({ contextUsage = null, planUsage = null } = {}) {
  return { contextUsage, planUsage };
}

test("turnReadoutParts: context only — no in/out, no plan segment (no quotas, no line, no noise)", () => {
  const { before, after } = turnReadoutParts(agentStub({}));
  expect(before).toBe("~0 tokens");
  expect(after).toBe("");
  expect(before).not.toContain("in=");
  expect(before).not.toContain("plan:");
});

test("turnReadoutParts: counters go before the gauge, the percent and plan (`<name> <used>/<total> (<pct>%)`, no bare \"plan:\" prefix) after it", () => {
  const { before, after } = turnReadoutParts(agentStub({
    contextUsage: { used: 100, total: 1000, approximate: false },
    planUsage: { quotas: { requests: { total: 500, remaining: 470 } } },
  }));
  expect(before).toBe("100/1000");
  expect(after).toBe("10.0% · requests 30/500 (6.0%)");
});

test("turnReadoutParts: multiple quotas join with the same separator, unsized ones (a balance) included", () => {
  const { before, after } = turnReadoutParts(agentStub({
    planUsage: { quotas: {
      requests: { total: 500, remaining: 470 },
      tokens: { total: 100000, used: 25000 },
      unsized: { remaining: 12 }, // no total — can't size a percentage
    } },
  }));
  expect(before).toBe("~0 tokens · requests 30/500 (6.0%) · tokens 24.4K/97.7K (25.0%) · unsized 12 left");
  expect(after).toBe(""); // no window size — no gauge, no percent
});

test("turnReadoutParts: a subscription-session window (5h/7d, {total:100, used, remaining}) reads like any other quota", () => {
  const { before, after } = turnReadoutParts(agentStub({
    contextUsage: { used: 8339, total: 200000, approximate: false },
    planUsage: { quotas: { "5h": { total: 100, used: 2, remaining: 98 }, "7d": { total: 100, used: 42, remaining: 58 } } },
  }));
  expect(before).toBe("8.1K/195.3K");
  expect(after).toBe("4.2% · 5h 2/100 (2.0%) · 7d 42/100 (42.0%)");
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

test("formatQuotaText: a reset at/before now is omitted — \"resets now\" is noise, not information", () => {
  const reset = new Date(Date.now() - 1000).toISOString();
  expect(formatQuotaText("requests", { total: 50, remaining: 50, reset })).toBe("requests 0/50 (0.0%)");
});

test("formatQuotaText: a reset less than 4 seconds away is omitted too — it flashes by and just burns status-bar space", () => {
  const soon = new Date(Date.now() + 2 * 1000).toISOString();
  expect(formatQuotaText("requests", { total: 50, remaining: 49, reset: soon })).toBe("requests 1/50 (2.0%)");
  const later = new Date(Date.now() + 60 * 1000).toISOString(); // past the 4s floor: still shown
  expect(formatQuotaText("requests", { total: 50, remaining: 49, reset: later })).toMatch(/^requests 1\/50 \(2\.0%\) · resets in /);
});

test("formatQuotaText: a duration-shaped reset shows verbatim only past the floor — a sub-floor blip (120ms < 4s) is dropped", () => {
  expect(formatQuotaText("requests", { total: 50, remaining: 49, reset: "6m0s" }))
    .toBe("requests 1/50 (2.0%) · reset 6m0s"); // longer than the floor: kept
  expect(formatQuotaText("requests", { total: 50, remaining: 49, reset: "120ms" }))
    .toBe("requests 1/50 (2.0%)"); // a sub-second blip: dropped, checked on the ms value not the text
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

test("turnReadoutParts: the plan orders quotas by importance too (smallest window first, here — neither has a reset)", () => {
  const { before } = turnReadoutParts(agentStub({
    planUsage: { quotas: {
      "7d": { total: 100, used: 10, remaining: 90, windowSeconds: 604800 },
      "5h": { total: 100, used: 20, remaining: 80, windowSeconds: 18000 },
    } },
  }));
  expect(before).toBe("~0 tokens · 5h 20/100 (20.0%) · 7d 10/100 (10.0%)");
});

test("turnReadoutParts: the plan caps at 3 data points — the rest collapse into a `+N more` hint (importance order decides who shows)", () => {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const { before } = turnReadoutParts(agentStub({
    planUsage: { quotas: {
      requests: { total: 500, remaining: 470 },
      tokens: { total: 100000, remaining: 99000 },
      inputTokens: { total: 40000, remaining: 39000 },
      outputTokens: { total: 8000, remaining: 7000 },
      "5h": { total: 100, used: 20, remaining: 80, reset: soon }, // the soonest reset wins the first slot
    } },
  }));
  expect(before).toContain("5h 20/100 (20.0%)"); // importance-ranked first
  expect(before).toContain("+2 more"); // 5 quotas, 3 shown
  expect(before).not.toContain("outputTokens"); // the tail stays off the bar
});

test("statusView: the counters lead, the gauge follows, turning to the error color when nearly full; ● carries the state role", async () => {
  const { statusView } = await import("../lib/app/tui/status-view.js");
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const { layoutView } = await import("../lib/app/gtui/layout.js");
  const render = (used) => layoutView(statusView(statusData({ agent: agentStub({ contextUsage: { used, total: 1000 } }), cwd: "/w" })), { width: 100, height: 4 }).snapshot;
  const half = render(500);
  expect(half.lines.join("\n")).toContain("500/1000 ▰▰▰▰▱▱▱▱ 50.0%");
  expect(half.lines.join("\n")).toContain("● idle");
  expect(half.roles.some((span) => span.role === "accent")).toBe(true);
  expect(render(900).roles.some((span) => span.role === "error")).toBe(true);
});

test("statusData: hints follow the viewed agent — Esc interrupt and Enter queue while it works", async () => {
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const idle = statusData({ agent: { ...agentStub({}), busy: false } });
  const busy = statusData({ agent: { ...agentStub({}), busy: true } });
  expect(idle.hints).toContain("^X menu");
  expect(busy.hints).toBe("Esc interrupt · ⏎ queue · ^O block viewer");
  expect(busy.shortcutHints.find((hint) => hint.key === "⏎").action).toBeUndefined(); // informational, not clickable
});

test("statusView: shows the pending continuation countdown", async () => {
  const { statusView } = await import("../lib/app/tui/status-view.js");
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const { layoutView } = await import("../lib/app/gtui/layout.js");
  const agent = { ...agentStub(), throttledUntil: Date.now() + 8500 };
  const lines = layoutView(statusView(statusData({ agent, cwd: "/w" })), { width: 100, height: 6 }).snapshot.lines.join("\n");
  expect(lines).toContain("continuing in 9s");
});

test("statusView: the plan (label, usage, reset) shows once — in the readout beside the context, never on its own line, and never behind a bare \"plan:\" prefix (noise)", async () => {
  const { statusView } = await import("../lib/app/tui/status-view.js");
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const { layoutView } = await import("../lib/app/gtui/layout.js");
  const reset = new Date(Date.now() + 2 * 3600_000 + 30_000).toISOString();
  const agent = agentStub({ contextUsage: { used: 500, total: 1000 }, planUsage: { label: "Max", quotas: { "5h": { total: 100, used: 2, reset } } } });
  const lines = layoutView(statusView(statusData({ agent, cwd: "/w" })), { width: 160, height: 6 }).snapshot.lines.join("\n");
  expect(lines).toContain("500/1000 ▰▰▰▰▱▱▱▱ 50.0% · Max: 5h 2/100 (2.0%) · resets in 2h");
  expect(lines).not.toContain("plan");
  expect(lines.match(/Max/g)).toHaveLength(1);
});

test("statusData: global state — one working agent outranks another's stale disconnect", async () => {
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const down = { ioState: "disconnected", busy: false };
  const env = (...agents) => ({ agents: () => agents });
  expect(statusData({ agent: down, env: env(down, { ioState: "working", busy: true }) }).state).toBe("working");
  expect(statusData({ agent: down, env: env(down, { ioState: "idle", busy: false }) }).state).toBe("disconnected");
  expect(statusData({ env: env({ ioState: "idle", busy: false }) }).state).toBe("idle");
});
