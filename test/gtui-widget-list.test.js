// test/gtui-widget-list.test.js — proof for lib/gtui/widgets/list.js:
// DEAD CODE (see AI-GTUI.md) — measure/draw, the selected-row reverse
// video, the scroll window (listWindow), and activate()'s Msg.
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { list, listWindow } from "../lib/gtui/widgets/list.js";
import { REVERSE } from "../lib/gtui/cell.js";

const rowText = (buf, y) => buf.row(y).map((c) => c.text ?? "").join("").trimEnd();

describe("listWindow", () => {
  test("everything fits: the whole list, no scrolling", () => {
    expect(listWindow(3, 1, 10)).toEqual({ start: 0, end: 3 });
  });
  test("centers the index when the list outgrows the visible rows", () => {
    expect(listWindow(20, 10, 5)).toEqual({ start: 8, end: 13 });
  });
  test("never scrolls past either edge", () => {
    expect(listWindow(20, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(listWindow(20, 19, 5)).toEqual({ start: 15, end: 20 });
  });
  test("zero visible rows: an empty window", () => {
    expect(listWindow(5, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("list: measure", () => {
  test("width is the longest item's display width, height the item count (capped)", () => {
    const l = list({ items: ["a", "longer item"] });
    expect(l.measure(20, 20)).toEqual({ w: 11, h: 2 });
    expect(l.measure(20, 1)).toEqual({ w: 11, h: 1 }); // height capped
  });
  test("accepts {label} objects, not just strings", () => {
    const l = list({ items: [{ label: "one" }, { label: "two-longer" }] });
    expect(l.measure(20, 20).w).toBe(10);
  });
});

describe("list: draw", () => {
  test("draws each visible item; the selected row is reverse video", () => {
    const buf = createBuffer(10, 3);
    list({ items: ["a", "b", "c"], index: 1 }).draw(buf, { x: 0, y: 0, w: 10, h: 3 });
    expect(rowText(buf, 0)).toBe("a");
    expect(rowText(buf, 1)).toBe("b");
    expect(buf.row(1)[0].attrs & REVERSE).toBeTruthy();
    expect(buf.row(0)[0].attrs & REVERSE).toBeFalsy();
  });

  test("a scrolled list draws only its visible window, starting at the rect's top", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    const buf = createBuffer(10, 3);
    list({ items, index: 9 }).draw(buf, { x: 0, y: 0, w: 10, h: 3 });
    // index 9's window is {start:7,end:10} — row 0 shows item7
    expect(rowText(buf, 0)).toBe("item7");
    expect(rowText(buf, 2)).toBe("item9");
  });
});

describe("list: activate", () => {
  test("resolves onSelect with the CURRENT (item, index)", () => {
    const l = list({ items: ["a", "b"], index: 1, onSelect: (item, index) => ({ type: "pick", item, index }) });
    expect(l.activate()).toEqual({ type: "pick", item: "b", index: 1 });
  });
  test("a plain Msg onSelect (no function) returns as-is; no onSelect: null", () => {
    expect(list({ items: ["a"], onSelect: { type: "fixed" } }).activate()).toEqual({ type: "fixed" });
    expect(list({ items: ["a"] }).activate()).toBeNull();
  });
});
