/**
 * lib/gtui/widgets/text.js — a static/wrapped text Node. Part of the
 * retained, unwired widget island (see lib/gtui/msg.js).
 *
 * A Node is `{measure(availW, availH) -> {w, h}, draw(buffer, rect)}`
 * — no class base, a plain factory closure like every other
 * createX() in this codebase.
 */

import { wrapWords, displayWidth } from "../width.js";

/**
 * @param {string} str
 * @param {{fg?: number|null, bg?: number|null, attrs?: number, url?: string|null}} [style]
 * @returns {{measure: Function, draw: Function}}
 */
export function text(str, style = {}) {
  const content = String(str);
  const wrapCache = new Map(); // width -> wrapped lines (measure/draw often share a width)
  const wrapped = (w) => {
    if (!wrapCache.has(w)) wrapCache.set(w, wrapWords(content, Math.max(1, w)));
    return wrapCache.get(w);
  };
  return {
    measure(availW, availH) {
      if (availW <= 0 || availH <= 0) return { w: 0, h: 0 };
      const lines = wrapped(availW);
      const w = Math.min(availW, Math.max(0, ...lines.map((l) => displayWidth(l))));
      return { w, h: Math.min(availH, lines.length) };
    },
    draw(buffer, rect) {
      if (rect.w <= 0 || rect.h <= 0) return;
      const lines = wrapped(rect.w);
      for (let i = 0; i < Math.min(lines.length, rect.h); i++) {
        buffer.text(rect.x, rect.y + i, lines[i], style);
      }
    },
  };
}
