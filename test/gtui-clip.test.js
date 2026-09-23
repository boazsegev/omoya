// test/gtui-clip.test.js — proof for lib/gtui/clip.js (ported from
// lib/tui-helpers/layout.js's clip(), AI-TUI MIGRATION.md Phase 01
// step 2): fits a plain line into a width, ending a cut with an
// ellipsis, never splitting a grapheme cluster.
import { describe, expect, test } from "bun:test";
import { clip } from "../lib/gtui/clip.js";

describe("clip", () => {
  test("text that already fits passes through unchanged", () => {
    expect(clip("hello world", 20)).toBe("hello world");
  });

  test("a cut ends with an ellipsis, one column short of the width", () => {
    expect(clip("hello world", 6)).toBe("hello…");
  });

  test("never splits a wide grapheme cluster", () => {
    const family = "👨‍👩‍👧"; // ZWJ sequence, one 2-column cluster
    expect(clip(`ab${family}cd`, 3)).toBe("ab…"); // the cluster doesn't fit in the last column
  });

  test("width is clamped to at least 1", () => {
    expect(clip("hello", 0)).toBe("…");
  });
});
