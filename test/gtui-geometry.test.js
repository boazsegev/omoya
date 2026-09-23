// test/gtui-geometry.test.js — proof for lib/gtui/geometry.js: DEAD
// CODE (see AI-GTUI.md) — pure Rect math (rect, inset, center,
// splitRows/splitCols).
import { describe, expect, test } from "bun:test";
import { rect, inset, center, splitRows, splitCols } from "../lib/gtui/geometry.js";

describe("rect", () => {
  test("clamps negative width/height to 0", () => {
    expect(rect(1, 2, -5, -1)).toEqual({ x: 1, y: 2, w: 0, h: 0 });
  });
});

describe("inset", () => {
  test("shrinks by each margin independently", () => {
    expect(inset(rect(0, 0, 10, 10), { top: 1, right: 2, bottom: 3, left: 4 }))
      .toEqual({ x: 4, y: 1, w: 4, h: 6 });
  });
  test("omitted margins default to 0", () => {
    expect(inset(rect(0, 0, 10, 10), { left: 1 })).toEqual({ x: 1, y: 0, w: 9, h: 10 });
  });
  test("never goes negative", () => {
    expect(inset(rect(0, 0, 4, 4), { left: 10 })).toEqual({ x: 10, y: 0, w: 0, h: 4 });
  });
});

describe("center", () => {
  test("centers a smaller box, rounding ties toward top-left", () => {
    expect(center(rect(0, 0, 10, 10), 4, 4)).toEqual({ x: 3, y: 3, w: 4, h: 4 });
    expect(center(rect(0, 0, 11, 11), 4, 4)).toEqual({ x: 3, y: 3, w: 4, h: 4 }); // odd remainder floors
  });
  test("clamps a box larger than the container to the container's size", () => {
    expect(center(rect(0, 0, 5, 5), 20, 20)).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });
  test("respects the container's own origin offset", () => {
    expect(center(rect(10, 20, 10, 10), 4, 4)).toEqual({ x: 13, y: 23, w: 4, h: 4 });
  });
});

describe("splitRows", () => {
  test("fixed heights stack top to bottom", () => {
    expect(splitRows(rect(0, 0, 10, 10), [2, 3])).toEqual([
      { x: 0, y: 0, w: 10, h: 2 },
      { x: 0, y: 2, w: 10, h: 3 },
    ]);
  });
  test("a null height takes the remainder after fixed heights", () => {
    expect(splitRows(rect(0, 0, 10, 10), [2, null, 3])).toEqual([
      { x: 0, y: 0, w: 10, h: 2 },
      { x: 0, y: 2, w: 10, h: 5 },
      { x: 0, y: 7, w: 10, h: 3 },
    ]);
  });
  test("a second null height gets nothing (only one remainder row is meaningful)", () => {
    const rows = splitRows(rect(0, 0, 10, 10), [null, null]);
    expect(rows[0].h).toBe(10);
    expect(rows[1].h).toBe(0);
  });
  test("rows spilling past the container clip to 0, never negative", () => {
    const rows = splitRows(rect(0, 0, 10, 4), [3, 3, 3]);
    expect(rows.map((r) => r.h)).toEqual([3, 1, 0]);
  });
});

describe("splitCols", () => {
  test("fixed widths sit side by side; a null width takes the remainder", () => {
    expect(splitCols(rect(0, 0, 10, 5), [3, null])).toEqual([
      { x: 0, y: 0, w: 3, h: 5 },
      { x: 3, y: 0, w: 7, h: 5 },
    ]);
  });
});
