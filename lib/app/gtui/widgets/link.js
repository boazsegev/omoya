/**
 * lib/gtui/widgets/link.js — a one-line OSC 8 hyperlink Node (Cmd+click
 * opens `url` in the terminal, same as tui/linkify.js's transcript
 * links — the escape FORMAT is duplicated as a literal since
 * lib/gtui/* never imports lib/tui/*). Part of the retained, unwired
 * widget island (see lib/gtui/msg.js).
 */

import { displayWidth } from "../width.js";
import { clip } from "../clip.js";

/**
 * @param {Object} options
 * @param {string} options.label - the visible text
 * @param {string} options.url
 * @param {{fg?, bg?, attrs?}} [options.style]
 * @returns {{measure: Function, draw: Function}}
 */
export function link({ label, url, style = {} } = {}) {
  const drawStyle = { ...style, url };
  return {
    measure(availW, availH) {
      if (availW <= 0 || availH <= 0) return { w: 0, h: 0 };
      return { w: Math.min(availW, displayWidth(label)), h: Math.min(availH, 1) };
    },
    draw(buffer, rect) {
      if (rect.w <= 0 || rect.h <= 0) return;
      buffer.text(rect.x, rect.y, clip(label, rect.w), drawStyle);
    },
  };
}
