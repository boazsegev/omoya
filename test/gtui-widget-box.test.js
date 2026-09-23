// test/gtui-widget-box.test.js — proof for lib/gtui/widgets/box.js:
// DEAD CODE (see AI-GTUI.md) — border/title drawing, inset child nesting.
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { box } from "../lib/gtui/widgets/box.js";
import { text } from "../lib/gtui/widgets/text.js";

const rowText = (buf, y) => buf.row(y).map((c) => c.text ?? "").join("");

describe("box: measure", () => {
  test("with a border, adds 2 to the child's measured size on each axis", () => {
    const b = box({ child: text("hi") });
    expect(b.measure(20, 20)).toEqual({ w: 4, h: 3 }); // "hi" is 2x1 + 1 pad each side
  });
  test("without a border, passes the child's size through untouched", () => {
    const b = box({ border: false, child: text("hi") });
    expect(b.measure(20, 20)).toEqual({ w: 2, h: 1 });
  });
  test("with no child, measures just the border's own footprint", () => {
    expect(box({}).measure(20, 20)).toEqual({ w: 2, h: 2 });
  });
});

describe("box: draw", () => {
  test("draws a full border (corners, edges) around the rect", () => {
    const buf = createBuffer(6, 4);
    box({}).draw(buf, { x: 0, y: 0, w: 6, h: 4 });
    expect(rowText(buf, 0)).toBe("┌────┐");
    expect(rowText(buf, 3)).toBe("└────┘");
    expect(rowText(buf, 1)[0]).toBe("│");
    expect(rowText(buf, 1)[5]).toBe("│");
  });

  test("nests a child inset by the border on every side", () => {
    const buf = createBuffer(8, 4);
    box({ child: text("hi") }).draw(buf, { x: 0, y: 0, w: 8, h: 4 });
    expect(buf.row(1)[1].text).toBe("h"); // inset (1,1) from the (0,0) rect
    expect(buf.row(1)[2].text).toBe("i");
  });

  test("a title renders on the top border, clipped to fit", () => {
    const buf = createBuffer(10, 3);
    box({ title: "Menu" }).draw(buf, { x: 0, y: 0, w: 10, h: 3 });
    expect(rowText(buf, 0)).toContain("Menu");
  });

  test("no border: the child draws over the WHOLE rect, no inset", () => {
    const buf = createBuffer(4, 1);
    box({ border: false, child: text("hi") }).draw(buf, { x: 0, y: 0, w: 4, h: 1 });
    expect(buf.row(0)[0].text).toBe("h");
  });

  test("a rect too small for a border (w or h < 2) draws no border, never throws", () => {
    const buf = createBuffer(3, 3);
    expect(() => box({ child: text("x") }).draw(buf, { x: 0, y: 0, w: 1, h: 1 })).not.toThrow();
    expect(buf.row(0)[0].text).not.toBe("┌"); // border skipped, not garbled
  });

  test("a degenerate (0-size) rect draws nothing, never throws", () => {
    const buf = createBuffer(3, 3);
    expect(() => box({ child: text("x") }).draw(buf, { x: 0, y: 0, w: 0, h: 0 })).not.toThrow();
  });
});
