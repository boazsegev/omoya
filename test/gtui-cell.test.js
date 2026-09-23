// test/gtui-cell.test.js — proof for lib/gtui/cell.js: DEAD CODE (see
// AI-GTUI.md) — a plain cell value, its equality, and its SGR encoding.
import { describe, expect, test } from "bun:test";
import { cell, blank, continuation, equalCell, sgr, BOLD, DIM, ITALIC, REVERSE } from "../lib/gtui/cell.js";

describe("cell()", () => {
  test("defaults to no style and no link", () => {
    expect(cell("x")).toEqual({ text: "x", fg: null, bg: null, attrs: 0, url: null });
  });
  test("blank() is a space cell; continuation() carries no glyph", () => {
    expect(blank()).toEqual({ text: " ", fg: null, bg: null, attrs: 0, url: null });
    expect(continuation().text).toBeNull();
  });
});

describe("equalCell", () => {
  test("same glyph, style, and link target: equal", () => {
    expect(equalCell(cell("a", { fg: 1 }), cell("a", { fg: 1 }))).toBe(true);
  });
  test("different glyph, fg, bg, attrs, or url: not equal", () => {
    expect(equalCell(cell("a"), cell("b"))).toBe(false);
    expect(equalCell(cell("a", { fg: 1 }), cell("a", { fg: 2 }))).toBe(false);
    expect(equalCell(cell("a", { bg: 1 }), cell("a", { bg: 2 }))).toBe(false);
    expect(equalCell(cell("a", { attrs: BOLD }), cell("a", { attrs: DIM }))).toBe(false);
    expect(equalCell(cell("a", { url: "https://x" }), cell("a", { url: null }))).toBe(false);
  });
});

describe("sgr", () => {
  test("no style: empty string", () => {
    expect(sgr({ fg: null, bg: null, attrs: 0 })).toBe("");
  });
  test("attrs, fg, and bg combine into one escape", () => {
    expect(sgr({ fg: 208, bg: null, attrs: BOLD | REVERSE })).toBe("\x1b[1;7;38;5;208m");
    expect(sgr({ fg: null, bg: 22, attrs: 0 })).toBe("\x1b[48;5;22m");
    expect(sgr({ fg: null, bg: null, attrs: ITALIC })).toBe("\x1b[3m");
  });
});
