// test/gtui-buffer.test.js — proof for lib/gtui/buffer.js: DEAD CODE
// (see AI-GTUI.md) — set/text/fill/blit, wide-grapheme continuation
// cells, and diff()'s per-row changed runs.
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { blank, cell } from "../lib/gtui/cell.js";

describe("createBuffer: set/text", () => {
  test("set() writes one grapheme; text() advances left to right by width", () => {
    const buf = createBuffer(5, 2);
    buf.set(0, 0, "x", { fg: 1 });
    expect(buf.row(0)[0]).toEqual(cell("x", { fg: 1 }));
    const written = buf.text(0, 1, "abc");
    expect(written).toBe(3);
    expect(buf.row(1).slice(0, 3).map((c) => c.text)).toEqual(["a", "b", "c"]);
  });

  test("a wide (2-col) grapheme claims a continuation sentinel cell", () => {
    const buf = createBuffer(4, 1);
    buf.set(0, 0, "日"); // CJK, width 2
    expect(buf.row(0)[0].text).toBe("日");
    expect(buf.row(0)[1].text).toBeNull(); // continuation, no glyph
  });

  test("a wide grapheme at the last column is dropped, never wraps on its own", () => {
    const buf = createBuffer(3, 1);
    buf.set(2, 0, "日"); // no room for the continuation cell
    expect(buf.row(0)[2].text).toBe(" ");
    // no out-of-bounds write, no exception — the buffer stays 3 wide
    expect(buf.row(0)).toHaveLength(3);
  });

  test("text() clips at the row edge without wrapping", () => {
    const buf = createBuffer(3, 1);
    const written = buf.text(0, 0, "hello");
    expect(written).toBe(3);
    expect(buf.row(0).map((c) => c.text)).toEqual(["h", "e", "l"]);
  });

  test("out-of-bounds set() is a no-op, never throws", () => {
    const buf = createBuffer(2, 2);
    expect(() => buf.set(-1, 0, "x")).not.toThrow();
    expect(() => buf.set(5, 0, "x")).not.toThrow();
    expect(() => buf.set(0, 9, "x")).not.toThrow();
  });
});

describe("createBuffer: fill/blit", () => {
  test("fill() paints a rectangle, clipped to the buffer", () => {
    const buf = createBuffer(4, 4);
    buf.fill({ x: 1, y: 1, w: 10, h: 10 }, cell("#"));
    expect(buf.row(0).map((c) => c.text)).toEqual([" ", " ", " ", " "]);
    expect(buf.row(1).map((c) => c.text)).toEqual([" ", "#", "#", "#"]);
    expect(buf.row(3).map((c) => c.text)).toEqual([" ", "#", "#", "#"]);
  });

  test("blit() composites a child buffer at an offset", () => {
    const parent = createBuffer(4, 2);
    const child = createBuffer(2, 1);
    child.text(0, 0, "hi");
    parent.blit(1, 1, child);
    expect(parent.row(0).map((c) => c.text)).toEqual([" ", " ", " ", " "]);
    expect(parent.row(1).map((c) => c.text)).toEqual([" ", "h", "i", " "]);
  });

  test("blit() clips a child that overhangs the parent's edge", () => {
    const parent = createBuffer(2, 1);
    const child = createBuffer(3, 1);
    child.text(0, 0, "abc");
    expect(() => parent.blit(0, 0, child)).not.toThrow();
    expect(parent.row(0).map((c) => c.text)).toEqual(["a", "b"]);
  });
});

describe("createBuffer: diff", () => {
  test("an unchanged buffer against itself yields no runs", () => {
    const buf = createBuffer(5, 2);
    buf.text(0, 0, "hello");
    const same = createBuffer(5, 2);
    same.text(0, 0, "hello");
    expect(buf.diff(same)).toEqual([]);
  });

  test("null prev diffs the whole buffer as one run per non-blank row start", () => {
    const buf = createBuffer(3, 1);
    buf.text(0, 0, "hi");
    const runs = buf.diff(null);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ y: 0, x: 0 });
    expect(runs[0].cells.map((c) => c.text)).toEqual(["h", "i", " "]);
  });

  test("a single changed cell mid-row yields one narrow run, not the whole row", () => {
    const before = createBuffer(6, 1);
    before.text(0, 0, "abcdef");
    const after = createBuffer(6, 1);
    after.text(0, 0, "abcdef");
    after.set(3, 0, "X");
    const runs = after.diff(before);
    expect(runs).toEqual([{ y: 0, x: 3, cells: [cell("X")] }]);
  });

  test("two separate changed spans on one row yield two runs", () => {
    const before = createBuffer(8, 1);
    before.text(0, 0, "aaaaaaaa");
    const after = createBuffer(8, 1);
    after.text(0, 0, "aaaaaaaa");
    after.set(1, 0, "X");
    after.set(6, 0, "Y");
    const runs = after.diff(before);
    expect(runs).toHaveLength(2);
    expect(runs[0].x).toBe(1);
    expect(runs[1].x).toBe(6);
  });

  test("a changed run spans multiple rows independently", () => {
    const before = createBuffer(3, 2);
    const after = createBuffer(3, 2);
    after.set(0, 1, "z");
    const runs = after.diff(before);
    expect(runs).toEqual([{ y: 1, x: 0, cells: [cell("z")] }]);
  });
});

describe("createBuffer: cursor", () => {
  test("hidden by default", () => {
    expect(createBuffer(3, 3).cursor).toBeNull();
  });
  test("setCursor() places it; hideCursor() clears it again", () => {
    const buf = createBuffer(5, 5);
    buf.setCursor(2, 3);
    expect(buf.cursor).toEqual({ x: 2, y: 3 });
    buf.hideCursor();
    expect(buf.cursor).toBeNull();
  });
});
