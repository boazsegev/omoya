/**
 * lib/gtui/clip.js — fit a plain line into a width (generic terminal
 * primitive, ported from the retired lib/tui-helpers/layout.js's
 * clip()). The legacy CAPS constant (footer row caps) is ai-specific
 * layout policy, not a generic primitive, and stayed behind with it.
 */

import { displayWidth, graphemes, graphemeWidth } from "./width.js";

/**
 * Fit a PLAIN (unstyled) line into `width` display columns, ending a
 * cut with an ellipsis.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function clip(text, width) {
  const w = Math.max(1, width);
  if (displayWidth(text) <= w) return text;
  let out = "";
  let col = 0;
  for (const g of graphemes(text)) {
    const gw = g === "\t" ? 1 : graphemeWidth(g);
    if (col + gw > w - 1) break;
    out += g;
    col += gw;
  }
  return `${out}…`;
}
