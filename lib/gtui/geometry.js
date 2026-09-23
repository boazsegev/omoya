/**
 * lib/gtui/geometry.js — pure rectangle math for gtui layout: Rect,
 * inset(), center(), splitRows()/splitCols(). Only lib/gtui/widgets/
 * (the retained, unwired widget island — see lib/gtui/msg.js) imports
 * this today.
 *
 * 0-based, gtui-internal (unlike tui-helpers/overlay-frame.js, which
 * stays 1-based at the screen-CUP boundary for tuiold's CURRENT
 * pre-gtui overlays — this module doesn't depend on it, or vice
 * versa; the two coexist, overlay-frame.js is the arrival home for
 * tuiold's overlays as they migrate onto gtui in a later phase).
 */

/** @param {number} x @param {number} y @param {number} w @param {number} h */
export function rect(x, y, w, h) {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Shrink a Rect by the given margins (never past empty).
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {{top?:number,right?:number,bottom?:number,left?:number}} [margins]
 */
export function inset(r, { top = 0, right = 0, bottom = 0, left = 0 } = {}) {
  return rect(r.x + left, r.y + top, r.w - left - right, r.h - top - bottom);
}

/**
 * A `w`×`h` box centered within `r` (rounds down; ties favor the
 * top-left, matching CSS/most layout engines' convention).
 */
export function center(r, w, h) {
  const cw = Math.min(w, r.w);
  const ch = Math.min(h, r.h);
  return rect(r.x + Math.floor((r.w - cw) / 2), r.y + Math.floor((r.h - ch) / 2), cw, ch);
}

/**
 * Split `r` into stacked rows of the given heights, top to bottom;
 * a negative or omitted height (`null`) takes the REMAINDER after
 * every other height is subtracted (at most one such entry is
 * meaningful — a second null-height row gets 0). Rows that would spill
 * past `r`'s bottom are clipped to 0 height, never negative.
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {(number|null)[]} heights
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function splitRows(r, heights) {
  const fixed = heights.reduce((sum, h) => sum + (typeof h === "number" ? h : 0), 0);
  const remainder = Math.max(0, r.h - fixed);
  let usedRemainder = false;
  let y = r.y;
  const out = [];
  for (const h of heights) {
    let rowH;
    if (typeof h === "number") rowH = h;
    else { rowH = usedRemainder ? 0 : remainder; usedRemainder = true; }
    const clipped = Math.max(0, Math.min(rowH, r.y + r.h - y));
    out.push(rect(r.x, y, r.w, clipped));
    y += rowH;
  }
  return out;
}

/** Split `r` into side-by-side columns — the column twin of splitRows. */
export function splitCols(r, widths) {
  const fixed = widths.reduce((sum, w) => sum + (typeof w === "number" ? w : 0), 0);
  const remainder = Math.max(0, r.w - fixed);
  let usedRemainder = false;
  let x = r.x;
  const out = [];
  for (const w of widths) {
    let colW;
    if (typeof w === "number") colW = w;
    else { colW = usedRemainder ? 0 : remainder; usedRemainder = true; }
    const clipped = Math.max(0, Math.min(colW, r.x + r.w - x));
    out.push(rect(x, r.y, clipped, r.h));
    x += colW;
  }
  return out;
}
