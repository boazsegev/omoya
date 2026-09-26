/**
 * lib/gtui/render.js — a Buffer diff turned into ANSI bytes.
 * Changed runs receive one absolute cursor position; SGR and OSC 8 spans
 * are coalesced within each run.
 */

import { sgr, equalCell } from "./cell.js";
import { CURSOR_SHOW, CURSOR_HIDE } from "./term.js";

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const OSC8_CLOSE = `${ESC}]8;;${ESC}\\`;
const osc8Open = (url) => `${ESC}]8;;${url}${ESC}\\`;

function sameStyle(a, fg, bg, attrs) {
  return a !== null && a.fg === fg && a.bg === bg && a.attrs === attrs;
}

function samePoint(a, b) {
  return (a === null) === (b === null) && (a === null || (a.x === b.x && a.y === b.y));
}

/**
 * Render only changed cells. The scan deliberately reads the two flat grids
 * directly: `buffer.diff()` is useful as a public buffer diagnostic, but it
 * creates a run object and cells array for every changed span solely for this
 * hot rendering path to immediately consume.
 */
export function renderDiff(buffer, prev = null, { cursorBytes = CURSOR_SHOW } = {}) {
  const out = [];
  const width = buffer.w;
  const height = buffer.h;
  // A resize is a full repaint. Besides being terminal-correct this avoids
  // comparing cells at mismatched flat-grid strides (or past a short grid).
  const previous = prev?.w === width && prev?.h === height ? prev.cells : null;
  let changed = false;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      const first = row + x;
      if (previous && equalCell(buffer.cells[first], previous[first])) { x++; continue; }
      const start = x++;
      while (x < width && (!previous || !equalCell(buffer.cells[row + x], previous[row + x]))) x++;
      out.push(`${ESC}[${y + 1};${start + 1}H`);
      let active = null;
      let styled = false;
      let activeUrl = null;
      for (let column = start; column < x; column++) {
        const c = buffer.cells[row + column];
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
      changed = true;
    }
  }
  const cursor = buffer.cursor;
  const prevCursor = prev?.cursor ?? null;
  if (changed || !samePoint(cursor, prevCursor)) {
    out.push(cursor ? `${ESC}[${cursor.y + 1};${cursor.x + 1}H${cursorBytes}` : CURSOR_HIDE);
  }
  return out.join("");
}
