// test/base-duration.test.js — proof for lib/duration.js: millisecond
// numerals and unit-string durations ("500ms", "20s", "5m", "1.5h").
import { describe, expect, test } from "bun:test";
import { parseDuration, tryDuration } from "../lib/env.js";

describe("parseDuration", () => {
  test("numbers pass through as milliseconds", () => {
    expect(parseDuration(120000)).toBe(120000);
    expect(parseDuration(1048575)).toBe(1048575);
  });

  test("unit strings: ms, s, m, h (case-insensitive, decimals allowed)", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("20s")).toBe(20_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("2M")).toBe(120_000);
    expect(parseDuration(" 45s ")).toBe(45_000);
  });

  test("a bare numeric string is milliseconds", () => {
    expect(parseDuration("120000")).toBe(120000);
  });

  test("undefined/null pass through; invalid and non-positive values throw", () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(null)).toBeUndefined();
    expect(() => parseDuration("bogus")).toThrow(/invalid duration/);
    expect(() => parseDuration("10x")).toThrow(/invalid duration/);
    expect(() => parseDuration(0)).toThrow(/positive/);
    expect(() => parseDuration(-5)).toThrow(/positive/);
    expect(() => parseDuration("0s")).toThrow(/positive/);
  });

  test("tryDuration never throws", () => {
    expect(tryDuration("bogus")).toBeUndefined();
    expect(tryDuration(-1)).toBeUndefined();
    expect(tryDuration("30s")).toBe(30_000);
  });
});
