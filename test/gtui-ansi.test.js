// test/gtui-ansi.test.js — proof for lib/gtui/ansi.js: DEAD CODE
// through AI-GTUI.md Phase 8, LIVE in Phase 9 — writeAnsiRow() decodes
// an SGR-styled string (the exact shape tui-helpers/messages.js's row
// renderers already produce) into gtui Cells via width.js's tokenize().
import { describe, expect, test } from "bun:test";
import { createBuffer } from "../lib/gtui/buffer.js";
import { writeAnsiRow, foldSgr } from "../lib/gtui/ansi.js";
import { BOLD, DIM, REVERSE } from "../lib/gtui/cell.js";

describe("foldSgr", () => {
  const DEFAULT = { fg: null, bg: null, attrs: 0 };

  test("reset (0, or bare \\x1b[m) clears everything", () => {
    expect(foldSgr({ fg: 1, bg: 2, attrs: BOLD }, "\x1b[0m")).toEqual(DEFAULT);
    expect(foldSgr({ fg: 1, bg: 2, attrs: BOLD }, "\x1b[m")).toEqual(DEFAULT);
  });

  test("attrs turn on and combine across separate sequences", () => {
    let style = foldSgr(DEFAULT, "\x1b[1m");
    style = foldSgr(style, "\x1b[7m");
    expect(style.attrs).toBe(BOLD | REVERSE);
  });

  test("22 clears BOTH bold and dim (standard SGR 'normal intensity')", () => {
    const style = foldSgr({ ...DEFAULT, attrs: BOLD | DIM }, "\x1b[22m");
    expect(style.attrs).toBe(0);
  });

  test("256-color fg/bg (38;5;N / 48;5;N)", () => {
    expect(foldSgr(DEFAULT, "\x1b[38;5;208m").fg).toBe(208);
    expect(foldSgr(DEFAULT, "\x1b[48;5;22m").bg).toBe(22);
  });

  test("39/49 reset fg/bg to default without touching attrs", () => {
    const style = foldSgr({ fg: 1, bg: 2, attrs: BOLD }, "\x1b[39;49m");
    expect(style).toEqual({ fg: null, bg: null, attrs: BOLD });
  });

  test("combined codes in one sequence apply in order", () => {
    expect(foldSgr(DEFAULT, "\x1b[1;38;5;208m")).toEqual({ fg: 208, bg: null, attrs: BOLD });
  });

  test("an unrecognized code is ignored, never throws", () => {
    expect(() => foldSgr(DEFAULT, "\x1b[38;2;255;0;0m")).not.toThrow(); // 24-bit color, unsupported
  });
});

describe("writeAnsiRow", () => {
  test("plain (unstyled) text writes verbatim", () => {
    const buf = createBuffer(10, 1);
    const written = writeAnsiRow(buf, 0, 0, "hi");
    expect(written).toBe(2);
    expect(buf.row(0).slice(0, 2).map((c) => c.text)).toEqual(["h", "i"]);
  });

  test("an SGR-styled span applies its style to the cells it covers, and stops applying after a reset", () => {
    const buf = createBuffer(10, 1);
    writeAnsiRow(buf, 0, 0, "\x1b[1;38;5;208mhot\x1b[0mcold");
    expect(buf.row(0)[0]).toMatchObject({ text: "h", fg: 208, attrs: BOLD });
    expect(buf.row(0)[3]).toMatchObject({ text: "c", fg: null, attrs: 0 });
  });

  test("writes starting at the given (x, y), not always the row origin", () => {
    const buf = createBuffer(10, 3);
    writeAnsiRow(buf, 3, 1, "yo");
    expect(buf.row(1)[3].text).toBe("y");
    expect(buf.row(1)[2].text).toBe(" "); // untouched
    expect(buf.row(0).every((c) => c.text === " ")).toBe(true); // other rows untouched
  });

  test("baseStyle (e.g. a hyperlink url) applies under the line's own SGR", () => {
    const buf = createBuffer(10, 1);
    writeAnsiRow(buf, 0, 0, "\x1b[1mhi", { url: "https://x" });
    expect(buf.row(0)[0]).toMatchObject({ text: "h", attrs: BOLD, url: "https://x" });
  });

  test("a wide grapheme mid-styled-line still claims its continuation cell", () => {
    const buf = createBuffer(10, 1);
    writeAnsiRow(buf, 0, 0, "\x1b[2m日\x1b[0mx");
    expect(buf.row(0)[0].text).toBe("日");
    expect(buf.row(0)[1].text).toBeNull(); // continuation
    expect(buf.row(0)[2].text).toBe("x");
  });
});
