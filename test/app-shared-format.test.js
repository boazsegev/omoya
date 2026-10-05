// test/app-shared-format.test.js — the presentation text App.TUI and App.Web
// share (lib/app/shared/format.js, served to the SPA at /format.js).
import { expect, test } from "bun:test";
import { formatAmount, formatDuration, parseArgs, quotaUsedTotal, resetAtMs, resetCountdown, resetDurationMs, resetText, settingChips, toolSummary } from "../lib/app/shared/format.js";

test("toolSummary: a preferred subject key wins over a JSON dump, from objects or JSON text", () => {
  expect(toolSummary({ path: "README.md", startLine: 1 })).toBe("README.md");
  expect(toolSummary('{"timeout": 5, "command": "bun  test\\n ./x"}')).toBe("bun test ./x");
  expect(toolSummary({ options: { deep: ["first string"] } })).toBe("first string");
  expect(toolSummary({})).toBe("");
  expect(toolSummary("plain text args")).toBe("plain text args");
});

test("toolSummary: clips to the requested width with an ellipsis", () => {
  expect(toolSummary({ command: "x".repeat(20) }, 10)).toBe(`${"x".repeat(9)}…`);
});

test("parseArgs: JSON objects parse; anything else passes through", () => {
  expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
  expect(parseArgs("{broken")).toBe("{broken");
  expect(parseArgs("text")).toBe("text");
});

test("formatDuration: ms, seconds, then minutes", () => {
  expect(formatDuration(0.2)).toBe("1ms");
  expect(formatDuration(12)).toBe("12ms");
  expect(formatDuration(4200)).toBe("4.2s");
  expect(formatDuration(95000)).toBe("1m35s");
});

test("quotaUsedTotal and formatAmount", () => {
  expect(quotaUsedTotal({ total: 100, remaining: 40 })).toEqual({ used: 60, total: 100 });
  expect(quotaUsedTotal({ remaining: 40 })).toBeNull();
  expect(formatAmount(1.5, "usd")).toBe("$1.50");
  expect(formatAmount(2048, undefined, (n) => `${n / 1024}K`)).toBe("2K");
});

test("resetDurationMs: Go-style durations parse to milliseconds, nothing else does", () => {
  expect(resetDurationMs("120ms")).toBe(120);
  expect(resetDurationMs("6m0s")).toBe(360000);
  expect(resetDurationMs("1h30m")).toBe(5400000);
  expect(resetDurationMs("2m59.56s")).toBeCloseTo(179560, 0);
  expect(resetDurationMs("7.66s")).toBeCloseTo(7660, 0);
  expect(resetDurationMs("6m0x")).toBeNull(); // trailing garbage: not a duration
  expect(resetDurationMs("60")).toBeNull(); // no unit: a bare number, not a duration
  expect(resetDurationMs("")).toBeNull();
  expect(resetDurationMs(undefined)).toBeNull();
});

test("resetCountdown/resetText: future timestamps count down, past timestamps say NOTHING, duration-shaped resets show verbatim", () => {
  const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  expect(resetCountdown(future)).toMatch(/^resets in 1h5\dm|^resets in 2h/);
  expect(resetCountdown(past)).toBeNull(); // "resets now" is noise, not information
  expect(resetCountdown("6m0s")).toBeNull(); // duration-shaped, not a timestamp
  expect(resetCountdown(undefined)).toBeNull();
  expect(resetText(future)).toBe(resetCountdown(future));
  expect(resetText(past)).toBeNull(); // omitted entirely — never "resets now", never the raw past timestamp
  expect(resetText("6m0s")).toBe("reset 6m0s");
  expect(resetText(undefined)).toBeNull();
  expect(resetText("")).toBeNull();
  expect(resetText("60")).toBe("reset 60"); // a bare relative delay, NOT a year (Date.parse would read 0060 AD) nor an epoch
});

test("resetAtMs: ISO passes through, epoch seconds and epoch milliseconds normalize, small numbers stay non-timestamps", () => {
  const iso = "2026-09-19T21:00:00Z";
  const ms = Date.parse(iso);
  expect(resetAtMs(iso)).toBe(ms);
  expect(resetAtMs(String(Math.floor(ms / 1000)))).toBe(Math.floor(ms / 1000) * 1000); // epoch SECONDS (Anthropic's unpublished unified-*-reset shape)
  expect(resetAtMs(String(ms))).toBe(ms); // epoch MILLISECONDS (the 13-digit variant)
  expect(resetAtMs(` ${ms} `)).toBe(ms); // header whitespace is tolerated
  expect(resetAtMs("1774933200")).toBe(1774933200000); // a real captured value
  expect(resetAtMs("60")).toBeNull(); // a RELATIVE delay (IETF RateLimit-Reset convention), not an epoch
  expect(resetAtMs("17999")).toBeNull(); // even window-sized: too small to be any epoch
  expect(resetAtMs("99999999999")).toBeNull(); // between the units: neither plausible s nor ms
  expect(resetAtMs("6m0s")).toBeNull(); // duration-shaped, not a timestamp
  expect(resetAtMs("")).toBeNull();
  expect(resetAtMs(undefined)).toBeNull();
  expect(resetAtMs(1774933200)).toBeNull(); // non-strings are not quota reset values
});

test("resetCountdown/resetText: epoch-valued resets (Anthropic's unpublished unified shape) render as countdowns, never verbatim numbers", () => {
  const at = Date.now() + 2 * 86400 * 1000 - 3600 * 1000; // ~1d23h out
  expect(resetText(String(Math.floor(at / 1000)))).toMatch(/^resets in 1d\d{1,2}h$/); // epoch SECONDS (sub-second truncation may round the hour down)
  expect(resetText(String(at))).toMatch(/^resets in 1d2[0-3]h$/); // epoch MILLISECONDS
  const past = String(Math.floor((Date.now() - 60_000) / 1000));
  expect(resetText(past)).toBeNull(); // past is past in epoch form too
});

test("resetCountdown/resetText: a countdown closer than minSeconds away is noise, omitted like a past timestamp", () => {
  const soon = new Date(Date.now() + 2 * 1000).toISOString();
  const later = new Date(Date.now() + 60 * 1000).toISOString();
  expect(resetCountdown(soon, 4)).toBeNull(); // "resets in 2s" burns status-bar space, skip it
  expect(resetCountdown(later, 4)).toMatch(/^resets in /); // farther than the floor: shown
  expect(resetText(soon, 4)).toBeNull(); // minSeconds applies to resetText too
  expect(resetText(later, 4)).toBe(resetCountdown(later, 4));
  expect(resetText("6m0s", 4)).toBe("reset 6m0s"); // a duration longer than the floor still shows verbatim
  expect(resetText("120ms", 4)).toBeNull(); // a sub-floor DURATION is noise too — checked on the ms value, not the text
  expect(resetText("3s", 4)).toBeNull(); // under the floor: dropped
  expect(resetText("4s", 4)).toBeNull(); // at the floor: dropped (<=)
  expect(resetText("5s", 4)).toBe("reset 5s"); // past the floor: kept
  expect(resetText("120ms")).toBe("reset 120ms"); // no floor (default 0): every duration shows
  const epochSoon = String(Math.floor((Date.now() + 2 * 1000) / 1000));
  expect(resetText(epochSoon, 4)).toBeNull(); // the floor applies to epoch values too
  expect(resetCountdown(soon)).toMatch(/^resets in /); // default floor is 0: only past timestamps are dropped
});

test("settingChips: endpoint, model, thinking, safe, logging — labels, emphasis, and toggle state both front ends show", () => {
  const byKey = (options) => Object.fromEntries(settingChips(options).map((chip) => [chip.key, chip]));
  const saved = byKey({ endpoint: "p", model: "m", thinking: "high", safe: true, sessionSave: true });
  expect(settingChips({}).map((chip) => chip.key)).toEqual(["endpoint", "model", "thinking", "safe", "logging"]);
  expect(saved.endpoint).toMatchObject({ icon: "◎", label: "p", title: "Endpoint: p", action: "switch endpoint", active: false });
  expect(saved.model).toMatchObject({ label: "m", title: "Model: p/m", action: "switch model", active: false });
  expect(saved.thinking).toMatchObject({ label: "Think: high", active: true });
  expect(saved.safe).toMatchObject({ icon: "🔒", label: "Read-only", active: true, warn: true, pressed: true, action: "allow writes" });
  expect(saved.logging).toMatchObject({ label: "Logging", active: false, warn: false, pressed: true, action: "pause logging" });
  const fresh = byKey({});
  expect(fresh.model).toMatchObject({ label: "Choose model", action: "choose a model" });
  expect(fresh.endpoint).toMatchObject({ label: "Choose endpoint", action: "choose an endpoint" });
  expect(fresh.thinking).toMatchObject({ label: "Think: auto", active: false });
  expect(fresh.safe).toMatchObject({ icon: "🔓", label: "Read/Write", pressed: false });
  expect(fresh.logging).toMatchObject({ label: "No-log", title: "Not logged: nothing is written to disk", warn: true, pressed: false, action: "log this conversation" });
});
