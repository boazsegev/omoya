// test/gtui-widget-text.test.js — proof for lib/gtui/widgets/text.js:
// DEAD CODE (see AI-GTUI.md) — measure/draw, wrapping via
// tui-helpers/width.js's wrapWords (reused, not reimplemented).
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { text } from "../lib/gtui/widgets/text.js";
import { BOLD } from "../lib/gtui/cell.js";

const rowText = (buf, y) => buf.row(y).map((c) => c.text ?? " ").join("").replace(/\s+$/, "");

describe("text: measure", () => {
  test("a short string measures its own width, one row", () => {
    expect(text("hi").measure(10, 5)).toEqual({ w: 2, h: 1 });
  });
  test("a string wider than availW wraps and measures the wrapped shape", () => {
    const m = text("the quick brown fox").measure(9, 5);
    expect(m.h).toBeGreaterThan(1);
    expect(m.w).toBeLessThanOrEqual(9);
  });
  test("zero available space measures zero", () => {
    expect(text("hi").measure(0, 5)).toEqual({ w: 0, h: 0 });
    expect(text("hi").measure(5, 0)).toEqual({ w: 0, h: 0 });
  });
  test("height is capped at availH even when more lines would wrap", () => {
    const m = text("one two three four five six seven eight").measure(4, 2);
    expect(m.h).toBe(2);
  });
});

describe("text: draw", () => {
  test("draws each wrapped line starting at the rect's origin", () => {
    const buf = createBuffer(10, 3);
    text("the quick fox").draw(buf, { x: 1, y: 0, w: 6, h: 3 });
    const lines = [0, 1, 2].map((y) => rowText(buf, y).trimStart());
    expect(lines.join("\n")).toContain("the");
    expect(lines.some((l) => l.includes("quick"))).toBe(true);
    expect(lines.some((l) => l.includes("fox"))).toBe(true);
  });

  test("draw clips to rect.h — extra wrapped lines never spill past it", () => {
    const buf = createBuffer(10, 2);
    text("one two three four five").draw(buf, { x: 0, y: 0, w: 4, h: 1 });
    expect(rowText(buf, 1)).toBe(""); // row 1 (outside the 1-row rect) untouched
  });

  test("style carries onto every drawn cell", () => {
    const buf = createBuffer(5, 1);
    text("hi", { fg: 208, attrs: BOLD }).draw(buf, { x: 0, y: 0, w: 5, h: 1 });
    expect(buf.row(0)[0]).toMatchObject({ text: "h", fg: 208, attrs: BOLD });
  });

  test("a degenerate rect (0 width or height) draws nothing, never throws", () => {
    const buf = createBuffer(3, 3);
    expect(() => text("hi").draw(buf, { x: 0, y: 0, w: 0, h: 3 })).not.toThrow();
    expect(() => text("hi").draw(buf, { x: 0, y: 0, w: 3, h: 0 })).not.toThrow();
  });
});
