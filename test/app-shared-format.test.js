// test/app-shared-format.test.js — the presentation text App.TUI and App.Web
// share (lib/app/shared/format.js, served to the SPA at /format.js).
import { expect, test } from "bun:test";
import { formatAmount, formatDuration, parseArgs, quotaUsedTotal, toolSummary } from "../lib/app/shared/format.js";

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
