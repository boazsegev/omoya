// test/base-duration.test.js — proof for lib/util.js durations: millisecond
// numerals and unit-string durations ("500ms", "20s", "5m", "1.5h").
import { describe, expect, test } from "bun:test";
import { durationParse, durationTry } from "../lib/util.js";

describe("durationParse", () => {
  test("numbers pass through as milliseconds", () => {
    expect(durationParse(120000)).toBe(120000);
    expect(durationParse(1048575)).toBe(1048575);
  });

  test("unit strings: ms, s, m, h (case-insensitive, decimals allowed)", () => {
    expect(durationParse("500ms")).toBe(500);
    expect(durationParse("20s")).toBe(20_000);
    expect(durationParse("5m")).toBe(300_000);
    expect(durationParse("1h")).toBe(3_600_000);
    expect(durationParse("1.5h")).toBe(5_400_000);
    expect(durationParse("2M")).toBe(120_000);
    expect(durationParse(" 45s ")).toBe(45_000);
  });

  test("a bare numeric string is milliseconds", () => {
    expect(durationParse("120000")).toBe(120000);
  });

  test("undefined/null pass through; invalid and non-positive values throw", () => {
    expect(durationParse(undefined)).toBeUndefined();
    expect(durationParse(null)).toBeUndefined();
    expect(() => durationParse("bogus")).toThrow(/invalid duration/);
    expect(() => durationParse("10x")).toThrow(/invalid duration/);
    expect(() => durationParse(0)).toThrow(/positive/);
    expect(() => durationParse(-5)).toThrow(/positive/);
    expect(() => durationParse("0s")).toThrow(/positive/);
  });

  test("durationTry never throws", () => {
    expect(durationTry("bogus")).toBeUndefined();
    expect(durationTry(-1)).toBeUndefined();
    expect(durationTry("30s")).toBe(30_000);
  });
});
