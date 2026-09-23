/**
 * lib/gtui/widgets/box.js — a bordered/titled container Node nesting
 * ONE child. Part of the retained, unwired widget island (see
 * lib/gtui/msg.js for the shared contract).
 */

import { inset } from "../geometry.js";
import { clip } from "../clip.js";

const LINE = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

/**
 * @param {Object} [options]
 * @param {string} [options.title]
 * @param {boolean} [options.border]
 * @param {{fg?, bg?, attrs?}} [options.style] - the border/title's style
 * @param {{measure: Function, draw: Function}|null} [options.child]
 * @returns {{measure: Function, draw: Function}}
 */
export function box({ title = "", border = true, style = {}, child = null } = {}) {
  const pad = border ? 1 : 0;
  return {
    measure(availW, availH) {
      const innerW = Math.max(0, availW - pad * 2);
      const innerH = Math.max(0, availH - pad * 2);
      const inner = child ? child.measure(innerW, innerH) : { w: 0, h: 0 };
      return { w: Math.min(availW, inner.w + pad * 2), h: Math.min(availH, inner.h + pad * 2) };
    },
    draw(buffer, rect) {
      if (rect.w <= 0 || rect.h <= 0) return;
      if (border && rect.w >= 2 && rect.h >= 2) drawBorder(buffer, rect, title, style);
      if (!child) return;
      const innerRect = inset(rect, { top: pad, right: pad, bottom: pad, left: pad });
      if (innerRect.w > 0 && innerRect.h > 0) child.draw(buffer, innerRect);
    },
  };
}

function drawBorder(buffer, rect, title, style) {
  const { x, y, w, h } = rect;
  buffer.set(x, y, LINE.tl, style);
  buffer.set(x + w - 1, y, LINE.tr, style);
  buffer.set(x, y + h - 1, LINE.bl, style);
  buffer.set(x + w - 1, y + h - 1, LINE.br, style);
  for (let i = 1; i < w - 1; i++) {
    buffer.set(x + i, y, LINE.h, style);
    buffer.set(x + i, y + h - 1, LINE.h, style);
  }
  for (let i = 1; i < h - 1; i++) {
    buffer.set(x, y + i, LINE.v, style);
    buffer.set(x + w - 1, y + i, LINE.v, style);
  }
  if (title !== "" && w > 4) {
    buffer.text(x + 2, y, clip(` ${title} `, w - 4), style);
  }
}
