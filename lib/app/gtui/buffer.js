/**
 * lib/gtui/buffer.js — a fixed W×H grid of Cells (lib/gtui/cell.js):
 * the gtui rendering surface every widget draws into (the cell-grid
 * model — see lib/gtui/cell.js).
 */

import { graphemes, graphemeWidth } from "./width.js";
import { blank, equalCell } from "./cell.js";
import { renderBidi } from "./bidi.js";

/**
 * Create a fixed-size cell-grid rendering buffer.
 * @param {number} w Requested width in columns; floored and clamped to zero.
 * @param {number} h Requested height in rows; floored and clamped to zero.
 * @returns {{w: number, h: number, cells: Array, set: Function, text: Function, fill: Function, blit: Function, diff: Function, row: Function, reset: Function, copyFrom: Function, at: Function, setCursor: Function, hideCursor: Function, cursor: (Object|null)}} Buffer API; `cells` and cursor are mutable state.
 */
export function createBuffer(w, h) {
  const width = Math.max(0, Math.floor(w));
  const height = Math.max(0, Math.floor(h));
  const cells = Array.from({ length: width * height }, () => blank());
  /** Convert grid coordinates to a linear cell index.
   * @param {number} x Column.
   * @param {number} y Row.
   * @returns {number} Linear index; coordinates are not bounds-checked.
   */
  const at = (x, y) => y * width + x;
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  let cursor = null; // {x, y} — where the REAL terminal cursor lands this frame, or null (hidden)

  /** Write one grapheme cluster at (x, y), claiming a continuation cell for width 2.
   * @param {number} index Linear cell index to update.
   * @param {string|null} text Grapheme to write; null marks a wide-glyph continuation.
   * @param {{fg?: *, bg?: *, attrs?: number, url?: string|null}} [style={}] Cell style; defaults are null foreground/background/URL and attrs 0.
   * @returns {void} Mutates the target cell.
   */
  // Cells are rewritten in place: a reused screen buffer allocates nothing
  // per frame. (Callers never retain cell objects across writes; copyFrom
  // copies field by field.)
  const assign = (index, text, { fg = null, bg = null, attrs = 0, url = null } = {}) => {
    const target = cells[index];
    target.text = text; target.fg = fg; target.bg = bg; target.attrs = attrs; target.url = url;
  };
  /** Write a grapheme at a grid position; a width-2 grapheme is dropped if it crosses the row edge.
   * @param {number} x Column.
   * @param {number} y Row.
   * @param {string} text Grapheme cluster.
   * @param {Object} [style={}] Cell style passed to the internal cell assignment.
   * @param {number} [columns=graphemeWidth(text)||1] Display width, allowing callers to skip measurement.
   * @returns {void} Does nothing when the position is out of bounds.
   */
  const set = (x, y, text, style = {}, columns = graphemeWidth(text) || 1) => {
    if (!inBounds(x, y)) return;
    const w2 = columns;
    if (w2 === 2 && !inBounds(x + 1, y)) return;
    assign(at(x, y), text, style);
    if (w2 === 2) assign(at(x + 1, y), null);
  };

  /** Blank every cell and hide the cursor, in place (frame reuse).
   * @returns {void} Mutates cells and cursor.
   */
  const reset = () => {
    for (let index = 0; index < cells.length; index++) assign(index, " ");
    cursor = null;
  };

  /** Copy another same-size buffer's cells and cursor, in place.
   * @param {ReturnType<typeof createBuffer>} other Source buffer; dimensions must match.
   * @returns {void} Copies cell fields and cursor state.
   */
  const copyFrom = (other) => {
    for (let index = 0; index < cells.length; index++) {
      const source = other.cells[index];
      const target = cells[index];
      target.text = source.text; target.fg = source.fg; target.bg = source.bg; target.attrs = source.attrs; target.url = source.url;
    }
    cursor = other.cursor ? { ...other.cursor } : null;
  };

  /** Write bidi-transformed display-order text from (x, y), advancing by grapheme width and clipping at the row edge.
   * @param {number} x Starting column.
   * @param {number} y Row.
   * @param {string} str Logical text to transform and write.
   * @param {Object} [style={}] Style applied to each grapheme.
   * @returns {number} Number of columns advanced (may include clipped graphemes' widths at the edge).
   */
  const text = (x, y, str, style = {}) => {
    let col = x;
    for (const g of graphemes(renderBidi(str))) {
      if (col >= width) break;
      set(col, y, g, style);
      col += graphemeWidth(g) || 1;
    }
    return col - x; // columns actually written
  };

  /** Fill the clipped portion of a rectangle with copies of one cell (default: blank).
   * @param {{x:number,y:number,w:number,h:number}} rect Rectangle to fill.
   * @param {Object} [fillCell=blank()] Cell value copied into each covered position.
   * @returns {void} Mutates cells.
   */
  const fill = (rect, fillCell = blank()) => {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w);
    const y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells[at(x, y)] = { ...fillCell };
  };

  /** Composite another buffer into this one at an offset, clipping to this buffer's bounds.
   * @param {number} x0 Destination column offset.
   * @param {number} y0 Destination row offset.
   * @param {ReturnType<typeof createBuffer>} other Source buffer.
   * @returns {void} Copies cells into the destination.
   */
  const blit = (x0, y0, other) => {
    for (let y = 0; y < other.h; y++) {
      for (let x = 0; x < other.w; x++) {
        const c = other.cells[y * other.w + x];
        if (inBounds(x0 + x, y0 + y)) cells[at(x0 + x, y0 + y)] = { ...c };
      }
    }
  };

  /** Return one row's cells from left to right.
   * @param {number} y Row index.
   * @returns {Array} Shallow copy of the row; out-of-range rows yield an empty or truncated slice.
   */
  const row = (y) => cells.slice(at(0, y), at(0, y) + width);

  /** Find contiguous changed-cell runs compared with a same-size previous buffer.
   * Continuation sentinels do not start runs but extend an open run.
   * @param {ReturnType<typeof createBuffer>|null} prev Previous buffer, or null to treat every cell as changed.
   * @returns {Array<{y: number, x: number, cells: Array}>} Changed runs by row.
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

  /** Set the real terminal cursor position for this frame.
   * @param {number} x Column.
   * @param {number} y Row.
   * @returns {void} Mutates cursor state; coordinates are not bounds-checked.
   */
  const setCursor = (x, y) => { cursor = { x, y }; };
  /** Hide the real terminal cursor for this frame.
   * @returns {void} Sets cursor state to null.
   */
  const hideCursor = () => { cursor = null; };

  return {
    w: width, h: height, cells, at, set, text, fill, blit, diff, row, reset, copyFrom,
    setCursor, hideCursor, get cursor() { return cursor; },
  };
}
