// test/gtui-width.test.js — proof for lib/gtui/width.js (ported from
// lib/tui-helpers/width.js, AI-TUI MIGRATION.md Phase 01 step 2):
// display width counts GRAPHEME CLUSTERS (a ZWJ emoji family, a
// skin-tone emoji, a flag pair are ONE 2-column cell), tabs expand,
// controls/zero-width count nothing; wrapWords/wrapByWidth never
// split a cluster.
import { describe, expect, test } from "bun:test";
import { displayWidth, graphemes, graphemeWidth, wrapRowsGraphemes, wrapWords, wrapWordsOffsets, wrapByWidth } from "../lib/gtui/width.js";

describe("displayWidth: grapheme clusters", () => {
  test("ascii, wide CJK, tabs, controls", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("a\tb")).toBe(9);
    expect(displayWidth("\x1b\x07")).toBe(0);
  });

  test("multi-code-point emoji are ONE two-column cell", () => {
    const family = "👨‍👩‍👧"; // ZWJ sequence
    const thumbs = "👍🏽"; // skin-tone modifier
    const flag = "🇯🇵"; // regional-indicator pair
    const heart = "❤️"; // VS16-forced emoji presentation
    for (const g of [family, thumbs, flag, heart]) {
      expect(graphemes(g)).toHaveLength(1);
      expect(displayWidth(g)).toBe(2);
    }
    expect(displayWidth(`x${family}y`)).toBe(4);
    expect(graphemeWidth("é")).toBe(1); // combining accent
  });
});

describe("wrapping never splits a cluster", () => {
  test("wrapByWidth keeps an emoji family whole across the cut", () => {
    const family = "👨‍👩‍👧";
    const rows = wrapByWidth(`abc${family}def`, 4);
    expect(rows.join("")).toBe(`abc${family}def`);
    expect(rows.every((r) => !r.includes("‍") || r.includes(family))).toBe(true);
    expect(rows[0]).toBe("abc"); // the 2-col cluster did not fit after "abc" (3+2 > 4)
  });

  test("wrapWords measures words by cluster width", () => {
    const rows = wrapWords("hi 👨‍👩‍👧 there", 6);
    expect(rows).toEqual(["hi 👨‍👩‍👧", "there"]);
  });
});

describe("wrapWords (the one wrap function)", () => {
  test("rows break at word boundaries, never mid-word", () => {
    expect(wrapWords("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });
  test("a word longer than the width hard-breaks (unavoidable mid-word)", () => {
    expect(wrapWords("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });
  test("a boundary space is consumed by the break", () => {
    expect(wrapWords("aaaa bbbb", 4)).toEqual(["aaaa", "bbbb"]);
  });
  test("genuine trailing spaces on the line's TRUE end survive wrapping (a cursor must be able to reach them)", () => {
    expect(wrapWords("aaaa bbbb  ", 4)).toEqual(["aaaa", "bbbb", " "]);
  });
  test("short lines pass through untouched (empty included)", () => {
    expect(wrapWords("", 10)).toEqual([""]);
    expect(wrapWords("short", 10)).toEqual(["short"]);
  });
  test("ANSI styles are zero-width and CARRY across the break", () => {
    const rows = wrapWords("\x1b[2mone two three\x1b[0m", 7);
    expect(rows[0]).toBe("\x1b[2mone two\x1b[0m");
    expect(rows[1].startsWith("\x1b[2m")).toBe(true);
    expect(rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["one two", "three"]);
  });
});

describe("wrapRowsGraphemes", () => {
  test("mirrors plain word boundaries while retaining display-width graphemes", () => {
    expect(wrapRowsGraphemes("hi 👨‍👩‍👧 there", 6)).toEqual([
      { graphemes: ["h", "i", " ", "👨‍👩‍👧"], width: 5 },
      { graphemes: ["t", "h", "e", "r", "e"], width: 5 },
    ]);
  });
});

describe("wrapWordsOffsets (word-wrap + exact reverse offsets — cursor math)", () => {
  test("offsets reconstruct the original line: each row is line.slice(start, end)", () => {
    const line = "the quick brown fox jumps";
    const rows = wrapWordsOffsets(line, 10);
    expect(rows.map((r) => r.text)).toEqual(wrapWords(line, 10));
    for (const r of rows) expect(line.slice(r.start, r.end)).toBe(r.text);
  });

  test("a boundary space is consumed: the next row's start is one past the previous row's end", () => {
    const rows = wrapWordsOffsets("aaaa bbbb", 4);
    expect(rows).toEqual([{ text: "aaaa", start: 0, end: 4 }, { text: "bbbb", start: 5, end: 9 }]);
  });

  test("a hard mid-word break has NO gap: the next row starts exactly at the previous row's end", () => {
    const rows = wrapWordsOffsets("abcdefghijkl", 5);
    expect(rows).toEqual([
      { text: "abcde", start: 0, end: 5 },
      { text: "fghij", start: 5, end: 10 },
      { text: "kl", start: 10, end: 12 },
    ]);
  });

  test("an empty line still reports one zero-width row", () => {
    expect(wrapWordsOffsets("", 10)).toEqual([{ text: "", start: 0, end: 0 }]);
  });

  test("a short line is one row spanning the whole line", () => {
    expect(wrapWordsOffsets("short", 10)).toEqual([{ text: "short", start: 0, end: 5 }]);
  });

  test("a repeated word resolves to its ACTUAL later occurrence, not the first", () => {
    const rows = wrapWordsOffsets("the cat and the mat", 8); // "the" appears twice
    expect(rows.map((r) => r.text)).toEqual(["the cat", "and the", "mat"]);
    expect(rows[1].start).toBe(8); // the SECOND "and the", not index 0
    expect(rows[2].start).toBe(16);
  });

  test("trailing spaces on a wrapped line's true end are covered by a row (the cursor can reach every index)", () => {
    const line = "aaaa bbbb  "; // two genuine trailing spaces, not a wrap boundary
    const rows = wrapWordsOffsets(line, 4);
    expect(rows).toEqual([
      { text: "aaaa", start: 0, end: 4 },
      { text: "bbbb", start: 5, end: 9 },
      { text: " ", start: 10, end: 11 },
    ]);
    expect(rows.at(-1).end).toBe(line.length); // every buffer index up to and including the end maps to a row
  });
});
