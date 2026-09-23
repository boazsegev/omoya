// test/gtui-render.test.js — proof for lib/gtui/render.js: DEAD CODE
// (see AI-GTUI.md) — a Buffer's diff turned into ANSI bytes: one CUP
// per changed run, coalesced SGR, wide-grapheme continuation cells
// skipped, and the real terminal cursor placed/hidden per
// buffer.cursor.
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { renderDiff } from "../lib/gtui/render.js";
import { BOLD } from "../lib/gtui/cell.js";

const CURSOR_HIDE = "\x1b[?25l"; // every content-changing paint re-asserts cursor state — hidden by default

describe("renderDiff", () => {
  test("null prev: the whole (non-blank) content prints from one CUP, opening with a bare reset (no color/attrs codes) when unstyled", () => {
    const buf = createBuffer(5, 1);
    buf.text(0, 0, "hi");
    // row diffs as ONE run incl. trailing blanks; the run OPENS with a
    // reset regardless of style (a run may land anywhere on screen —
    // it never trusts leftover SGR state from an unrelated prior write);
    // content changed, so the frame ALSO re-asserts cursor state (hidden,
    // since buffer.cursor was never set)
    expect(renderDiff(buf, null)).toBe(`\x1b[1;1H\x1b[0mhi   ${CURSOR_HIDE}`);
  });

  test("no changes against an identical prev, cursor unmoved (both hidden): empty output", () => {
    const a = createBuffer(3, 1);
    a.text(0, 0, "abc");
    const b = createBuffer(3, 1);
    b.text(0, 0, "abc");
    expect(renderDiff(a, b)).toBe("");
  });

  test("a single changed cell mid-row: one CUP at that column, just that glyph", () => {
    const before = createBuffer(5, 1);
    before.text(0, 0, "abcde");
    const after = createBuffer(5, 1);
    after.text(0, 0, "abcde");
    after.set(2, 0, "X");
    expect(renderDiff(after, before)).toBe(`\x1b[1;3H\x1b[0mX${CURSOR_HIDE}`);
  });

  test("two separate changed spans on one row: two CUPs, each its own run", () => {
    const before = createBuffer(6, 1);
    before.text(0, 0, "aaaaaa");
    const after = createBuffer(6, 1);
    after.text(0, 0, "aaaaaa");
    after.set(0, 0, "X");
    after.set(4, 0, "Y");
    expect(renderDiff(after, before)).toBe(`\x1b[1;1H\x1b[0mX\x1b[1;5H\x1b[0mY${CURSOR_HIDE}`);
  });

  test("a changed run on row 2 gets a 1-based CUP matching its row", () => {
    const before = createBuffer(3, 3);
    const after = createBuffer(3, 3);
    after.set(1, 2, "z");
    expect(renderDiff(after, before)).toBe(`\x1b[3;2H\x1b[0mz${CURSOR_HIDE}`);
  });

  test("a styled cell opens SGR before it, and the run resets AS SOON AS it returns to the default style", () => {
    const buf = createBuffer(3, 1);
    buf.set(0, 0, "x", { fg: 208, attrs: BOLD });
    // "x" is styled; the two trailing blanks are plain — the reset lands
    // right after "x" (a style-change boundary), not deferred to the run's end
    expect(renderDiff(buf, null)).toBe(`\x1b[1;1H\x1b[0m\x1b[1;38;5;208mx\x1b[0m  ${CURSOR_HIDE}`);
  });

  test("a style change WITHIN a run emits SGR only where it actually changes (coalesced)", () => {
    const buf = createBuffer(4, 1);
    buf.set(0, 0, "a", { fg: 1 });
    buf.set(1, 0, "b", { fg: 1 }); // same style as "a": no new SGR
    buf.set(2, 0, "c", { fg: 2 }); // different: opens new SGR
    const out = renderDiff(buf, null);
    // exactly two SGR opens within the run (one per style, not one per cell)
    expect(out.match(/\x1b\[0m\x1b\[38;5;\d+m/g)).toHaveLength(2);
    expect(out).toContain("ab"); // "a" and "b" share the SAME open, printed back to back
  });

  test("a wide grapheme's continuation cell writes no glyph (the terminal already advanced two columns)", () => {
    const buf = createBuffer(4, 1);
    buf.set(0, 0, "日"); // width 2 — claims a continuation cell at column 1
    buf.set(2, 0, "x");
    expect(renderDiff(buf, null)).toBe(`\x1b[1;1H\x1b[0m日x ${CURSOR_HIDE}`);
  });

  test("a run of cells sharing one url coalesces into ONE OSC 8 hyperlink span, closed where the url ends", () => {
    const buf = createBuffer(4, 1);
    buf.text(0, 0, "go", { url: "https://x" });
    const out = renderDiff(buf, null);
    // one open, one close — never per-cell
    expect(out.match(/\x1b\]8;;https:\/\/x\x1b\\/g)).toHaveLength(1);
    expect(out.match(/\x1b\]8;;\x1b\\/g)).toHaveLength(1);
    expect(out).toBe(`\x1b[1;1H\x1b]8;;https://x\x1b\\\x1b[0mgo\x1b]8;;\x1b\\  ${CURSOR_HIDE}`);
  });

  test("the link closes exactly where the url changes, even mid-run", () => {
    const buf = createBuffer(4, 1);
    buf.set(0, 0, "a", { url: "https://x" });
    buf.set(1, 0, "b"); // no link, same (default) style as "a" — no new SGR needed
    const out = renderDiff(buf, null);
    expect(out).toBe(`\x1b[1;1H\x1b]8;;https://x\x1b\\\x1b[0ma\x1b]8;;\x1b\\b  ${CURSOR_HIDE}`);
  });
});

describe("renderDiff: cursor", () => {
  test("a shown cursor places it (1-based CUP) and enables it, after any content bytes", () => {
    const buf = createBuffer(5, 1);
    buf.text(0, 0, "hi");
    buf.setCursor(2, 0);
    expect(renderDiff(buf, null)).toBe("\x1b[1;1H\x1b[0mhi   \x1b[1;3H\x1b[?25h");
  });

  test("the cursor moving alone (no cell changed) still repaints — just the cursor bytes", () => {
    const before = createBuffer(5, 1);
    before.text(0, 0, "hi");
    before.setCursor(0, 0);
    const after = createBuffer(5, 1);
    after.text(0, 0, "hi");
    after.setCursor(3, 0);
    expect(renderDiff(after, before)).toBe("\x1b[1;4H\x1b[?25h");
  });

  test("cursor unmoved AND no content change: still empty output", () => {
    const before = createBuffer(5, 1);
    before.text(0, 0, "hi");
    before.setCursor(1, 0);
    const after = createBuffer(5, 1);
    after.text(0, 0, "hi");
    after.setCursor(1, 0);
    expect(renderDiff(after, before)).toBe("");
  });

  test("hiding a previously-shown cursor emits the hide sequence", () => {
    const before = createBuffer(3, 1);
    before.setCursor(0, 0);
    const after = createBuffer(3, 1); // hideCursor() is the default — never called setCursor
    expect(renderDiff(after, before)).toBe("\x1b[?25l");
  });

  test("a different-size previous buffer safely forces a full repaint", () => {
    const previous = createBuffer(2, 1);
    const next = createBuffer(3, 2);
    previous.text(0, 0, "xx");
    next.text(0, 0, "abc");
    next.text(0, 1, "def");
    const esc = String.fromCharCode(27);
    expect(renderDiff(next, previous)).toBe(`${esc}[1;1H${esc}[0mabc${esc}[2;1H${esc}[0mdef${esc}[?25l`);
  });
});
