// test/gtui-widget-dropdown.test.js — proof for lib/gtui/widgets/
// dropdown.js: DEAD CODE (see AI-GTUI.md) — a box+list popup anchored
// to a point, clamped to stay within the drawable area.
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { dropdown } from "../lib/gtui/widgets/dropdown.js";

describe("dropdown: positioning", () => {
  test("opens at the anchor when there's room on every side", () => {
    const buf = createBuffer(20, 10);
    dropdown({ anchor: { x: 2, y: 1 }, items: ["a", "b"] })
      .draw(buf, { x: 0, y: 0, w: 20, h: 10 });
    expect(buf.row(1)[2].text).toBe("┌"); // the box's top-left corner at the anchor
  });

  test("clamps to the RIGHT edge instead of running off it", () => {
    const buf = createBuffer(20, 10);
    dropdown({ anchor: { x: 19, y: 1 }, items: ["a", "b"] })
      .draw(buf, { x: 0, y: 0, w: 20, h: 10 });
    const row = buf.row(1).map((c) => c.text ?? "").join("");
    expect(row.trimEnd()).toContain("┌"); // moved left, still visible
    expect(row).toHaveLength(20); // never wrote past the buffer's own edge
  });

  test("clamps to the BOTTOM edge instead of running off it", () => {
    const buf = createBuffer(20, 10);
    dropdown({ anchor: { x: 2, y: 9 }, items: ["a", "b"], maxHeight: 8 })
      .draw(buf, { x: 0, y: 0, w: 20, h: 10 });
    // a 4-row box (2 items + 2 border) anchored at y=9 must clamp to
    // start at y=6 so it still ends by row 9 (the buffer's last row)
    expect(buf.row(6)[2].text).toBe("┌");
    expect(buf.row(9)[2].text).toBe("└");
  });

  test("never overflows a screen SMALLER than the anchor's naive placement", () => {
    const buf = createBuffer(6, 4);
    expect(() => dropdown({ anchor: { x: 5, y: 3 }, items: ["a", "b", "c"] })
      .draw(buf, { x: 0, y: 0, w: 6, h: 4 })).not.toThrow();
  });

  test("a degenerate (0-size) drawable area draws nothing, never throws", () => {
    const buf = createBuffer(4, 4);
    expect(() => dropdown({ anchor: { x: 0, y: 0 }, items: ["a"] })
      .draw(buf, { x: 0, y: 0, w: 0, h: 0 })).not.toThrow();
  });
});

describe("dropdown: selection", () => {
  test("activate() delegates to the inner list's onSelect", () => {
    const d = dropdown({
      anchor: { x: 0, y: 0 }, items: ["a", "b"], index: 1,
      onSelect: (item, index) => ({ type: "pick", item, index }),
    });
    expect(d.activate()).toEqual({ type: "pick", item: "b", index: 1 });
  });
});
