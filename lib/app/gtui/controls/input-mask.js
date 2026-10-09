// Shared masked-input policy. Never return source text as presentation data.
import { graphemes, graphemeWidth } from "../width.js";

/**
 * Resolve an input's mask to a safe, one-cell glyph.
 * @param {object} node Input node; true uses a bullet, a non-empty string requests its first grapheme.
 * @returns {string} Mask glyph, or an empty string for an ordinary input. Invalid/wide/control glyphs use a bullet.
 * Does not mutate or retain the input.
 */
export function inputMask(node) {
  if (node.mask !== true && !(typeof node.mask === "string" && node.mask !== "")) return "";
  const glyph = typeof node.mask === "string" ? graphemes(node.mask)[0] : "•";
  return glyph && graphemeWidth(glyph) === 1 && !/[\p{C}\p{Z}]/u.test(glyph) ? glyph : "•";
}

/**
 * Move vertically through masked rows without using the secret's display widths.
 * @param {string} value Actual value; each codepoint occupies one mask cell, including newlines.
 * @param {number} caret UTF-16 source offset.
 * @param {number} direction Row step, normally -1 or 1.
 * @param {number} width Mask cells per wrapped row.
 * @returns {number|null} Source offset in the target row, or null beyond the input.
 * Does not mutate or retain the value.
 */
export function maskedVertical(value, caret, direction, width) {
  const offsets = [0];
  for (const point of value) offsets.push(offsets.at(-1) + point.length);
  const columns = Math.max(1, Math.floor(width));
  const position = Math.max(0, offsets.findLastIndex((offset) => offset <= caret));
  // A caret at a soft-wrap boundary belongs to the preceding row, just as
  // ordinary inputRows' inclusive source ranges do.
  const row = position > 0 ? Math.floor((position - 1) / columns) : 0;
  const lastRow = Math.max(0, Math.ceil((offsets.length - 1) / columns) - 1);
  const target = row + direction;
  if (target < 0 || target > lastRow) return null;
  const column = position - row * columns;
  return offsets[Math.min(target * columns + column, offsets.length - 1)];
}
