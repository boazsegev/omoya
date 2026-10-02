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
/**
 * Build an OSC 8 hyperlink-opening sequence.
 * @param {string} url - Hyperlink target to embed in the sequence.
 * @returns {string} The terminal escape sequence that opens the hyperlink.
 * @throws {TypeError} If interpolation of the supplied target fails.
 */
const osc8Open = (url) => `${ESC}]8;;${url}${ESC}\\`;

/**
 * Test whether a cached style matches the requested style values.
 * @param {?{fg: *, bg: *, attrs: *}} a - Cached style, or `null` if none is active.
 * @param {*} fg - Foreground value to compare.
 * @param {*} bg - Background value to compare.
 * @param {*} attrs - Attribute value to compare.
 * @returns {boolean} Whether `a` is non-null and all three values match.
 */
function sameStyle(a, fg, bg, attrs) {
  return a !== null && a.fg === fg && a.bg === bg && a.attrs === attrs;
}

/**
 * Check whether erasing to end of line reproduces a cell exactly.
 * @param {{text: *, bg: *, attrs: *, url: *}} c - Cell to inspect.
 * @returns {boolean} Whether the cell is a plain default-background space with no attributes or hyperlink.
 */
function erasable(c) {
  return c.text === " " && c.bg === null && c.attrs === 0 && c.url === null;
}

/**
 * Compare nullable cursor points by coordinates.
 * @param {?{x: number, y: number}} a - First point, or `null`.
 * @param {?{x: number, y: number}} b - Second point, or `null`.
 * @returns {boolean} Whether both points are null or have equal `x` and `y` coordinates.
 */
function samePoint(a, b) {
  return (a === null) === (b === null) && (a === null || (a.x === b.x && a.y === b.y));
}

/**
 * Determine whether the specified row differs between two flat cell grids.
 * @param {Array<*>} cells - Current flat cell grid.
 * @param {?Array<*>} previous - Previous flat cell grid, or `null` when a full repaint is needed.
 * @param {number} row - Flat-grid index of the row's first cell.
 * @param {number} width - Number of cells in the row.
 * @returns {boolean} Whether any corresponding cell differs, or `true` when no previous grid is available.
 */
function rowChanged(cells, previous, row, width) {
  if (!previous) return true;
  for (let x = row; x < row + width; x++) if (!equalCell(cells[x], previous[x])) return true;
  return false;
}

/**
 * Render changed rows from a buffer as terminal escape sequences.
 * The scan deliberately reads the two flat grids directly: `buffer.diff()` is
 * useful as a public buffer diagnostic, but it creates a run object and cells
 * array for every changed span solely for this hot rendering path to consume.
 * A missing or differently sized previous buffer causes a full repaint; row
 * output resets styling and hyperlinks, erases any remaining line, and
 * appends cursor positioning/visibility bytes when the screen or cursor changed.
 * This function performs no terminal I/O and does not mutate either buffer.
 * @param {{w: number, h: number, cells: Array<*>, cursor: ?{x: number, y: number}}} buffer - Current buffer grid and cursor state.
 * @param {?{w: number, h: number, cells: Array<*>, cursor?: ?{x: number, y: number}}} [prev=null] - Previous buffer; omitted or `null` means no previous grid or cursor.
 * @param {Object} [options={}] - Rendering options.
 * @param {string} [options.cursorBytes=CURSOR_SHOW] - Escape bytes appended after positioning the current cursor; `CURSOR_HIDE` is emitted when there is no cursor.
 * @returns {string} Concatenated ANSI/OSC bytes to render the changed rows and cursor state, or an empty string when nothing changed.
 * @throws {TypeError} If the buffer, its cell data, or rendering options do not satisfy the expected shape.
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
