/**
 * lib/gtui/render.js — a Buffer diff turned into ANSI bytes.
 * Every changed row is repainted whole: one absolute cursor position at
 * column one, its cells through the last visible one (SGR and OSC 8 spans
 * coalesced), then an erase-to-end-of-line. The terminal's own glyph
 * advance places every cell, so a row can never keep stale glyphs, even
 * when a terminal disagrees with us about a glyph's width.
 */

import { sgr, equalCell } from "./cell.js";
import { CURSOR_SHOW, CURSOR_HIDE } from "./term.js";

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const ERASE_LINE = `${ESC}[K`;
const OSC8_CLOSE = `${ESC}]8;;${ESC}\\`;
const osc8Open = (url) => `${ESC}]8;;${url}${ESC}\\`;

function sameStyle(a, fg, bg, attrs) {
  return a !== null && a.fg === fg && a.bg === bg && a.attrs === attrs;
}

/** A cell an erase-to-end-of-line (default background) reproduces exactly. */
function erasable(c) {
  return c.text === " " && c.bg === null && c.attrs === 0 && c.url === null;
}

function samePoint(a, b) {
  return (a === null) === (b === null) && (a === null || (a.x === b.x && a.y === b.y));
}

function rowChanged(cells, previous, row, width) {
  if (!previous) return true;
  for (let x = row; x < row + width; x++) if (!equalCell(cells[x], previous[x])) return true;
  return false;
}

/**
 * Render changed rows. The scan deliberately reads the two flat grids
 * directly: `buffer.diff()` is useful as a public buffer diagnostic, but it
 * creates a run object and cells array for every changed span solely for this
 * hot rendering path to immediately consume.
 */
export function renderDiff(buffer, prev = null, { cursorBytes = CURSOR_SHOW } = {}) {
  const out = [];
  const { w: width, h: height, cells } = buffer;
  // A resize is a full repaint. Besides being terminal-correct this avoids
  // comparing cells at mismatched flat-grid strides (or past a short grid).
  const previous = prev?.w === width && prev?.h === height ? prev.cells : null;
  let changed = false;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    if (!rowChanged(cells, previous, row, width)) continue;
    let end = width;
    while (end > 0 && erasable(cells[row + end - 1])) end--;
    out.push(`${ESC}[${y + 1};1H`);
    let active = null;
    let styled = false;
    let activeUrl = null;
    for (let x = row; x < row + end; x++) {
      const c = cells[x];
      if (c.text === null) continue; // a wide-glyph continuation
      if (c.url !== activeUrl) {
        if (activeUrl !== null) out.push(OSC8_CLOSE);
        if (c.url !== null) out.push(osc8Open(c.url));
        activeUrl = c.url;
      }
      if (!sameStyle(active, c.fg, c.bg, c.attrs)) {
        const style = { fg: c.fg, bg: c.bg, attrs: c.attrs };
        const codes = sgr(style);
        out.push(RESET, codes);
        active = style;
        styled = codes !== "";
      }
      out.push(c.text);
    }
    if (styled) out.push(RESET);
    if (activeUrl !== null) out.push(OSC8_CLOSE);
    // A row painted through its final column is complete; an EL there would
    // erase the glyph just written (the cursor sits on it, wrap pending).
    if (end < width) out.push(ERASE_LINE);
    changed = true;
  }
  const cursor = buffer.cursor;
  const prevCursor = prev?.cursor ?? null;
  if (changed || !samePoint(cursor, prevCursor)) {
    out.push(cursor ? `${ESC}[${cursor.y + 1};${cursor.x + 1}H${cursorBytes}` : CURSOR_HIDE);
  }
  return out.join("");
}
