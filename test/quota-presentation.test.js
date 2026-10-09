import { expect, test } from "bun:test";
import { usageDetailLines } from "../lib/app/shared/format.js";

const display = (plan, usage = {}) => usageDetailLines(usage, plan).join("\n");

test("Kimi and Anthropic period rows show window length in their labels without redundant seconds", () => {
  const text = display({ label: "prolite", quotas: {
    "5h": { used: 12, total: 100, windowSeconds: 18000, reset: "6m0s" },
    "7d": { remaining: 45, windowSeconds: 604800 },
    "4h": { used: 20, total: 100, windowSeconds: 14400, status: "blocked", allowed: false, limitReached: true },
    "1d": { remaining: 0, windowSeconds: 86400 },
  } });
  expect(text).toContain("Plan: prolite");
  for (const period of ["5h", "7d", "4h", "1d"]) expect(text).toMatch(new RegExp(`^${period}:`, "m"));
  expect(text).toContain("5h: 12/100 used · reset 6m0s");
  expect(text).not.toContain("window seconds");
  expect(text).not.toContain("prolite ·");
  expect(text).toContain("blocked");
  expect(text).toContain("allowed: false");
  expect(text).toContain("limit reached: true");
});

test("semantic window duration, reset, unknown quota metadata and reported status all remain visible once", () => {
  const text = display({ quotas: { rolling_window: {
    used: 0, total: 30, windowSeconds: 3660, reset: "15m0s", status: "rejected",
    allowed: false, limitReached: true, arbitrary_value: null, note: "<script>x</script>",
  } } });
  expect(text).toContain("rolling window (1h1m window):");
  expect(text).toContain("reset 15m0s");
  expect(text).not.toContain("window seconds:");
  expect(text.match(/rejected/g)).toHaveLength(1);
  expect(text.match(/allowed: false/g)).toHaveLength(1);
  expect(text.match(/limit reached: true/g)).toHaveLength(1);
  expect(text).toContain("arbitrary value: null");
  expect(text).toContain("note: <script>x</script>");
});

test("OpenAI plan metadata and grouped provider/plan details retain structured leaves", () => {
  const text = display({ label: "Plus", status: "blocked", allowed: false, limitReached: true,
    reset: "1h30m", representativeClaim: "weekly", fallbackPercentage: 0,
    overage: { used: 0, total: 25, remaining: 25, unit: "usd", status: "enabled", extra_note: null },
    details: { payment: { pending: false, attempts: 0, comment: null } },
    quotas: { weekly: { remaining: 0 } },
  }, { details: { billing: { reason: "<script>hello</script>", retry: false, count: 0, hint: null } }, provider_flag: false });
  expect(text).toContain("Plan: Plus");
  expect(text).toContain("Plan status: blocked");
  expect(text).toContain("Plan allowed: false");
  expect(text).toContain("Plan limit reached: true");
  expect(text).toContain("Plan reset: reset 1h30m");
  expect(text).toContain("Overage:");
  expect(text).toContain("$0.00/$25.00 used");
  expect(text).toContain("extra note: null");
  expect(text).toContain("representative claim: weekly");
  expect(text).toContain("fallback percentage: 0");
  expect(text).toContain("provider flag: false");
  expect(text).toContain("Provider details:");
  expect(text).toContain("billing · reason: <script>hello</script>");
  expect(text).toContain("billing · retry: false");
  expect(text).toContain("billing · count: 0");
  expect(text).toContain("billing · hint: null");
  expect(text).toContain("Plan details:");
  expect(text).toContain("payment · pending: false");
  expect(text).toContain("payment · attempts: 0");
  expect(text).toContain("payment · comment: null");
  expect(text).not.toContain("details ·");
  expect(text).not.toContain("Provider ·");
});

test("large repeated and cyclic extension data remains bounded as plain text", () => {
  const shared = { text: "<b>".repeat(300), zero: 0, flag: false, missing: null };
  shared.cycle = shared;
  const quotas = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`rolling_${index}`, { ...shared, windowSeconds: 3600 }]));
  const lines = usageDetailLines({ details: { shared } }, { label: "A".repeat(2000), quotas, details: { shared } });
  expect(Array.isArray(lines)).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(100);
  expect(lines.every((line) => typeof line === "string" && line.length <= 1024)).toBe(true);
  expect(lines.join("\n").length).toBeLessThanOrEqual(19050);
  expect(lines.join("\n")).toContain("<b>");
  expect(lines.join("\n")).not.toContain("[object Object]");
});

test("malformed quota and extension imports do not throw or hide other rows", () => {
  const text = display({ quotas: { malformed: null, other: { remaining: 0, status: "rejected" } }, details: null });
  expect(text).toContain("malformed:");
  expect(text).toContain("other:");
  expect(text).toContain("0 left");
  expect(text).toContain("rejected");
});
