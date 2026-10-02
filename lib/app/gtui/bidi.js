/**
 * lib/gtui/bidi.js — the bidi-text detection HOOK: `detectBidi(text)`
 * flags Hebrew/Arabic runs and reorders them for visual output. This
 * library-level rendering step preserves the caller's logical string,
 * so widgets and future copy support retain true source order. It is
 * deliberately not a complete UAX#9 implementation: strong RTL runs
 * are reversed pragmatically, while LTR runs and their order remain
 * unchanged.
 */

import { graphemes } from "./width.js";

// Hebrew, Arabic, and their presentation-form blocks — strong RTL.
const RTL_RANGES = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0750, 0x077f], // Arabic Supplement
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
];

/**
 * Test whether a Unicode code point falls in one of the heuristic strong-RTL ranges.
 * @param {number} codePoint Unicode code point to test.
 * @returns {boolean} Whether it is classified as RTL.
 */
function isRTL(codePoint) {
  return RTL_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

const NEUTRAL = /[\s\p{P}\p{S}]/u; // whitespace, punctuation, symbols

/**
 * Classify a character as strong RTL, neutral, or strong LTR for this heuristic. Digits and CJK count as LTR; punctuation, symbols, and whitespace are neutral and may be absorbed into an adjacent RTL run.
 * @param {string} ch Character to classify; its first code point is used.
 * @returns {"R"|"N"|"L"} `R` for RTL, `N` for whitespace/punctuation/symbols, otherwise `L`.
 * @throws {TypeError} If `ch` is nullish or otherwise lacks `codePointAt`.
 */
function classify(ch) {
  if (isRTL(ch.codePointAt(0))) return "R";
  if (NEUTRAL.test(ch)) return "N";
  return "L";
}

/**
 * Detect RTL runs in `text`: a maximal span of RTL code points plus
 * any NEUTRALS directly between/after them (trimmed back to the last
 * RTL character — a run never ends mid-whitespace). Leading neutrals
 * before the first RTL character of a run are NOT absorbed backward
 * (kept simple, matching this heuristic's non-UAX#9 scope).
 * @param {*} text Value converted to a string before detection.
 * @returns {{hasRTL: boolean, runs: Array<{start: number, end: number, dir: "rtl"}>}}
 *   `start`/`end` are code-point indices (Array.from(text) offsets),
 *   `end` exclusive.
 */
export function detectBidi(text) {
  const chars = Array.from(String(text));
  const classes = chars.map(classify);
  const runs = [];
  let i = 0;
  while (i < chars.length) {
    if (classes[i] !== "R") { i++; continue; }
    const start = i;
    let end = i + 1;
    while (end < chars.length && classes[end] !== "L") end++;
    while (end > start + 1 && classes[end - 1] === "N") end--;
    runs.push({ start, end, dir: "rtl" });
    i = end;
  }
  return { hasRTL: runs.length > 0, runs };
}

/**
 * Return a visual-order array without modifying the input. Each detected RTL run is reversed. When items are graphemes, combining marks remain with their preceding logical character. This limited rendering heuristic is not a complete UAX#9 implementation and is not intended for input editing.
 * @param {Iterable<*>} items Input items, consumed into a new array; the input is not mutated.
 * @param {(item: *) => string} [textOf=(item) => String(item)] Function providing the text used to classify each item.
 * @returns {Array<*>} New array with detected RTL runs reversed; not a string.
 * @throws {TypeError} If `items` is not iterable or `textOf`/an item text cannot be classified.
 */
export function visualOrder(items, textOf = (item) => String(item)) {
  const values = [...items];
  const classes = values.map((item) => classify(textOf(item)));
  let index = 0;
  while (index < values.length) {
    if (classes[index] !== "R") { index++; continue; }
    const start = index;
    let end = index + 1;
    while (end < values.length && classes[end] !== "L") end++;
    while (end > start + 1 && classes[end - 1] === "N") end--;
    values.splice(start, end - start, ...values.slice(start, end).reverse());
    classes.splice(start, end - start, ...classes.slice(start, end).reverse());
    index = end;
  }
  return values;
}

/**
 * Return token items in visual order, classifying each token by its `text` property.
 * @param {Iterable<{text: string}>} tokens Token sequence; copied, not mutated.
 * @returns {Array<{text: string}>} New array with detected RTL token runs reversed.
 * @throws {TypeError} If `tokens` is not iterable or a token's `text` cannot be classified.
 */
export function reorderBidiTokens(tokens) {
  return visualOrder(tokens, (token) => token.text);
}

/**
 * Render text in heuristic visual order by reversing RTL grapheme runs.
 * @param {*} text Value converted to a string before grapheme segmentation.
 * @returns {string} Rendered string; the input value is not modified.
 * @throws {TypeError} If grapheme segmentation fails for the converted input.
 */
export function renderBidi(text) {
  return visualOrder(graphemes(String(text))).join("");
}
