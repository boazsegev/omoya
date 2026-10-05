// Shared control geometry, selection, paste, and clipped-cell rendering.
import { graphemes, graphemeWidth } from "../width.js";
/**
 * Clamp a numeric value to the inclusive bounds.
 * @param {number} value - Value to constrain.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The bounded value.
 */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
/**
 * Test whether a character is a Unicode letter, number, or underscore.
 * @param {string} character - Character to test; nullish values are treated as empty.
 * @returns {boolean} Whether the character is a word character.
 */
export const isWord = (character) => /[\p{L}\p{N}_]/u.test(character ?? "");
export const PASTE_COLLAPSE_THRESHOLD = 2048;
export const PAGE_OVERLAP_ROWS = 5;
export const INPUT_HISTORY_LIMIT = 20;
export const MULTI_CLICK_MS = 500;
const CLICK_DRAG_THRESHOLD = 1;

/**
 * Determine whether a pointer report moved far enough to count as a drag.
 * @param {object} drag - Drag state containing an origin and optional source index.
 * @param {object} point - Pointer report with optional index and coordinates.
 * @returns {boolean} Whether movement exceeds the click threshold; invalid coordinates count as movement.
 */
export function movedBeyondClickThreshold(drag, point) {
  if (Number.isInteger(point.index)) return Math.abs(point.index - drag.index) > CLICK_DRAG_THRESHOLD;
  if (!Number.isFinite(drag.origin?.x) || !Number.isFinite(drag.origin?.y) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return true;
  return Math.abs(point.x - drag.origin.x) > CLICK_DRAG_THRESHOLD || Math.abs(point.y - drag.origin.y) > CLICK_DRAG_THRESHOLD;
}

/**
 * Normalize a nonempty anchor/caret selection into ascending offsets.
 * @param {?object} selection - Selection with numeric anchor and caret offsets.
 * @returns {?{start:number,end:number}} Ordered range, or null for no range.
 */
export function orderedSelection(selection) {
  if (!selection || selection.anchor === selection.caret) return null;
  return selection.anchor < selection.caret
    ? { start: selection.anchor, end: selection.caret }
    : { start: selection.caret, end: selection.anchor };
}

/**
 * Replace the active selection, or the caret position when none is active.
 * @param {string} value - Original input value.
 * @param {?object} selection - Optional anchor/caret selection.
 * @param {number} caret - Insertion offset used without a selection.
 * @param {string} inserted - Text to insert.
 * @returns {{value:string,caret:number,selection:null}} Updated value and caret with selection cleared.
 */
export function replaceRange(value, selection, caret, inserted) {
  const range = orderedSelection(selection) ?? { start: caret, end: caret };
  return { value: value.slice(0, range.start) + inserted + value.slice(range.end), caret: range.start + inserted.length, selection: null };
}

/**
 * Store a large paste and replace it with a collision-free visible placeholder.
 * @param {object} node - Input node whose value, caret, and selection define the edit range.
 * @param {object} state - Input state; increments pasteCounter and stores text in pastes.
 * @param {string} text - Pasted text.
 * @returns {{value:string,caret:number,selection:null}} Placeholder edit; mutates paste state.
 */
export function collapsePaste(node, state, text) {
  const value = String(node.value ?? "");
  const caret = clamp(Number.isInteger(node.caret) ? node.caret : value.length, 0, value.length);
  let placeholder;
  do {
    const lines = text.split("\n").length;
    placeholder = `[Pasted ${lines} line${lines === 1 ? "" : "s"} #${++state.pasteCounter}]`;
  } while (value.includes(placeholder));
  state.pastes.set(placeholder, text);
  return replaceRange(value, node.selection ?? null, caret, placeholder);
}

/**
 * Expand every stored paste placeholder in a value.
 * @param {string} value - Value possibly containing placeholders.
 * @param {Map<string,string>} pastes - Placeholder-to-original-text map.
 * @returns {string} Value with placeholders expanded.
 */
export function expandPastes(value, pastes) {
  let expanded = value;
  for (const [placeholder, text] of pastes) expanded = expanded.split(placeholder).join(text);
  return expanded;
}

/**
 * Compute the selection produced by a double- or triple-click.
 * @param {string} value - Input text.
 * @param {number} caret - Click offset.
 * @param {number} count - Consecutive click count.
 * @returns {?{anchor:number,caret:number}} Word or line selection, or null for a single click/empty value.
 */
export function clickSelection(value, caret, count) {
  if (count >= 3) return { anchor: lineBoundary(value, caret, false), caret: lineBoundary(value, caret, true) };
  if (count !== 2 || value.length === 0) return null;
  const index = Math.min(caret, value.length - 1);
  const word = isWord(value[index]);
  let start = index;
  let end = index + 1;
  while (start > 0 && isWord(value[start - 1]) === word && value[start - 1] !== "\n") start--;
  while (end < value.length && isWord(value[end]) === word && value[end] !== "\n") end++;
  return { anchor: start, caret: end };
}

/**
 * Find the current line start or end.
 * @param {string} value - Multiline text.
 * @param {number} caret - Current UTF-16 offset.
 * @param {boolean} end - True for line end; false for line start.
 * @returns {number} Line boundary offset.
 */
export function lineBoundary(value, caret, end) {
  if (end) {
    const newline = value.indexOf("\n", caret);
    return newline < 0 ? value.length : newline;
  }
  return value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
}

/**
 * Draw one clipped menu-style line, optionally filling the remaining cells.
 * @param {object} canvas - Canvas exposing put().
 * @param {object} box - Destination rectangle.
 * @param {number} row - Row offset inside box.
 * @param {*} text - Text rendered as graphemes.
 * @param {string} role - Cell style role.
 * @param {boolean} [fill=false] - Whether to fill remaining columns with spaces.
 * @param {object} [meta={}] - Additional cell metadata.
 * @returns {void} Writes cells to canvas.
 */
export function drawMenuLine(canvas, box, row, text, role, fill = false, meta = {}) {
  let x = box.x;
  for (const grapheme of graphemes(String(text ?? ""))) {
    const width = graphemeWidth(grapheme) || 1;
    if (x + width > box.x + box.w) break;
    const used = canvas.put(x, box.y + row, grapheme, { ...meta, role, cellWidth: width });
    if (used === 0) break;
    x += used;
  }
  if (fill) while (x < box.x + box.w) x += canvas.put(x, box.y + row, " ", { role });
}

/**
 * Test whether a point lies within a half-open rectangle.
 * @param {object} point - Point with x and y.
 * @param {object} box - Rectangle with x, y, w, and h.
 * @returns {boolean} True when point is inside.
 */
export function pointInside(point, box) {
  return point.x >= box.x && point.x < box.x + box.w && point.y >= box.y && point.y < box.y + box.h;
}

