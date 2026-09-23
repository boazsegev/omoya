// test/gtui-theme-detect.test.js — proof for lib/gtui/theme-detect.js
// (ported from lib/tui-helpers/theme.js, AI-TUI MIGRATION.md Phase 01
// step 2): best-effort dark/light detection from COLORFGBG, and the
// subtle-background palette index it implies.
import { describe, expect, test } from "bun:test";
import { themeDark, subtleBg } from "../lib/gtui/theme-detect.js";

describe("themeDark", () => {
  test("a dark-half background index (0-6) reads as dark", () => {
    expect(themeDark({ COLORFGBG: "15;0" })).toBe(true);
    expect(themeDark({ COLORFGBG: "15;6" })).toBe(true);
  });

  test("a light-half background index (7-15) reads as light", () => {
    expect(themeDark({ COLORFGBG: "0;7" })).toBe(false);
    expect(themeDark({ COLORFGBG: "0;15" })).toBe(false);
  });

  test("a trailing extra field is ignored", () => {
    expect(themeDark({ COLORFGBG: "15;0;default" })).toBe(true);
  });

  test("absent, empty, or unparseable is unknown (null)", () => {
    expect(themeDark({})).toBeNull();
    expect(themeDark({ COLORFGBG: "" })).toBeNull();
    expect(themeDark({ COLORFGBG: "not-a-number" })).toBeNull();
    expect(themeDark({ COLORFGBG: "15" })).toBeNull(); // no bg field
    expect(themeDark({ COLORFGBG: "15;99" })).toBeNull(); // out of range
  });
});

describe("subtleBg", () => {
  test("dark -> bright black (100), light -> bright white (107)", () => {
    expect(subtleBg(true)).toBe("100");
    expect(subtleBg(false)).toBe("107");
  });

  test("unknown theme -> no background", () => {
    expect(subtleBg(null)).toBeNull();
    expect(subtleBg(undefined)).toBeNull();
  });

  test("re-detects from process.env when called with no argument", () => {
    expect([null, "100", "107"]).toContain(subtleBg());
  });
});
