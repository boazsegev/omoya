/**
 * lib/gtui/buffer.js — a fixed W×H grid of Cells (lib/gtui/cell.js):
 * the gtui rendering surface every widget draws into (the cell-grid
 * model — see lib/gtui/cell.js).
 */

import { graphemes, graphemeWidth } from "./width.js";
import { blank, equalCell } from "./cell.js";
import { renderBidi } from "./bidi.js";

/**
 * @param {number} w @param {number} h
 * @returns {{w: number, h: number, cells: Array, set: Function,
 *   text: Function, fill: Function, blit: Function, diff: Function,
 *   row: Function, reset: Function, copyFrom: Function}}
 */
export function createBuffer(w, h) {
  const width = Math.max(0, Math.floor(w));
  const height = Math.max(0, Math.floor(h));
  const cells = Array.from({ length: width * height }, () => blank());
  const at = (x, y) => y * width + x;
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  let cursor = null; // {x, y} — where the REAL terminal cursor lands this frame, or null (hidden)

  /** Write one grapheme cluster at (x, y); a wide cluster also claims
   *  its continuation cell (the whole cluster is dropped when it would
   *  run past the row — never enters the terminal's pending-wrap state).
   *  `columns` skips re-measuring when the caller already knows the width. */
  // Cells are rewritten in place: a reused screen buffer allocates nothing
  // per frame. (Callers never retain cell objects across writes; copyFrom
  // copies field by field.)
  const assign = (index, text, { fg = null, bg = null, attrs = 0, url = null } = {}) => {
    const target = cells[index];
    target.text = text; target.fg = fg; target.bg = bg; target.attrs = attrs; target.url = url;
  };
  const set = (x, y, text, style = {}, columns = graphemeWidth(text) || 1) => {
    if (!inBounds(x, y)) return;
    const w2 = columns;
    if (w2 === 2 && !inBounds(x + 1, y)) return;
    assign(at(x, y), text, style);
    if (w2 === 2) assign(at(x + 1, y), null);
  };

  /** Blank every cell and hide the cursor, in place (frame reuse). */
  const reset = () => {
    for (let index = 0; index < cells.length; index++) assign(index, " ");
    cursor = null;
  };

  /** Copy another same-size buffer's cells and cursor, in place. */
  const copyFrom = (other) => {
    for (let index = 0; index < cells.length; index++) {
      const source = other.cells[index];
      const target = cells[index];
      target.text = source.text; target.fg = source.fg; target.bg = source.bg; target.attrs = source.attrs; target.url = source.url;
    }
    cursor = other.cursor ? { ...other.cursor } : null;
  };

  /** Write display-order output from (x, y), advancing per grapheme
   *  width; clips at the row edge. Bidi transformation is here, at the
   *  rendering boundary, so the caller retains the original logical text
   *  for copy/paste and future input handling. */
  const text = (x, y, str, style = {}) => {
    let col = x;
    for (const g of graphemes(renderBidi(str))) {
      if (col >= width) break;
      set(col, y, g, style);
      col += graphemeWidth(g) || 1;
    }
    return col - x; // columns actually written
  };

  /** Fill a rectangle with one repeated cell (default: blank). */
  const fill = (rect, fillCell = blank()) => {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w);
    const y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells[at(x, y)] = { ...fillCell };
  };

  /** Composite another Buffer into this one at an offset (a child
   *  widget's own off-screen surface, blitted into its parent's Rect). */
  const blit = (x0, y0, other) => {
    for (let y = 0; y < other.h; y++) {
      for (let x = 0; x < other.w; x++) {
        const c = other.cells[y * other.w + x];
        if (inBounds(x0 + x, y0 + y)) cells[at(x0 + x, y0 + y)] = { ...c };
      }
    }
  };

  /** One row's cells (a copy), left to right. */
  const row = (y) => cells.slice(at(0, y), at(0, y) + width);

  /**
   * Diff against a previous Buffer of the SAME size: per row, the
   * runs of cells that changed — `{y, x, cells}` (a contiguous run
   * starting at column x). Continuation sentinels never start a run
   * (they carry no glyph of their own) but do extend one already open.
   * @param {ReturnType<typeof createBuffer>|null} prev
   * @returns {Array<{y: number, x: number, cells: Array}>}
   */
  const diff = (prev) => {
    const runs = [];
    for (let y = 0; y < height; y++) {
      let open = null; // {x, cells}
      for (let x = 0; x < width; x++) {
        const c = cells[at(x, y)];
        const p = prev ? prev.cells[prev.at(x, y)] : null;
        const changed = !p || !equalCell(c, p);
        if (changed) {
          if (open === null) open = { x, cells: [] };
          open.cells.push(c);
        } else if (open !== null) {
          runs.push({ y, ...open });
          open = null;
        }
      }
      if (open !== null) runs.push({ y, ...open });
    }
    return runs;
  };

  /** Place the REAL terminal cursor at (x, y) this frame (a widget's
   *  draw() calls this — e.g. an input line marking where typing
   *  lands); render.js reads it after diffing. */
  const setCursor = (x, y) => { cursor = { x, y }; };
  /** No cursor this frame (the default — render.js hides it). */
  const hideCursor = () => { cursor = null; };

  return {
    w: width, h: height, cells, at, set, text, fill, blit, diff, row, reset, copyFrom,
    setCursor, hideCursor, get cursor() { return cursor; },
  };
}
