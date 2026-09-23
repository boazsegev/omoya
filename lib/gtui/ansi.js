/**
 * lib/gtui/ansi.js — writeAnsiRow(): draws an SGR-styled STRING (the
 * kind tui-helpers/messages.js's row renderers already produce — the
 * SAME transcript rows tui2 and tui-old paint) into a gtui Buffer,
 * decoding the embedded `\x1b[...m` codes into structured Cell
 * styles (lib/gtui/cell.js). Reuses tui-helpers/width.js's tokenize()
 * for the actual SGR/grapheme split — never a second parser.
 *
 * NOTE: an app emitting SGR strings for the runtime to parse back is
 * a named anti-pattern (README §9) from the rejected bridged app;
 * this module is unused since that app's eviction (AI-TUI
 * MIGRATION.md Phase 01 step 1) and is a candidate for removal or
 * replacement by the rich-text/span rendering in Phase 02.
 */

import { tokenize } from "./width.js";
import { BOLD, DIM, UNDERLINE, REVERSE, STRIKE } from "./cell.js";

const ATTR_ON = { 1: BOLD, 2: DIM, 4: UNDERLINE, 7: REVERSE, 9: STRIKE };
const ATTR_OFF = { 21: BOLD, 22: BOLD | DIM, 24: UNDERLINE, 27: REVERSE, 29: STRIKE };

/**
 * Fold one `\x1b[...m` SGR sequence onto a running style. Understands
 * reset (0), the attrs this Cell model tracks (bold/dim/underline/
 * reverse/strike, and their "off" counterparts), default fg/bg (39/49),
 * and 256-color fg/bg (`38;5;N` / `48;5;N`) — the only forms
 * tui-helpers' renderers (messages.js, view-rows.js, status.js) emit.
 * Anything else (24-bit color, unsupported codes) is ignored, not
 * thrown on — a style this Cell model can't represent just doesn't
 * change from whatever was active before it.
 * @param {{fg: number|null, bg: number|null, attrs: number}} style
 * @param {string} sgr - e.g. "\x1b[1;38;5;208m"
 * @returns {{fg: number|null, bg: number|null, attrs: number}}
 */
export function foldSgr(style, sgr) {
  const nums = sgr.slice(2, -1).split(";").filter((s) => s !== "").map(Number);
  let { fg, bg, attrs } = style;
  if (nums.length === 0) nums.push(0); // a bare "\x1b[m" is a reset, same as "\x1b[0m"
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (n === 0) { fg = null; bg = null; attrs = 0; }
    else if (ATTR_ON[n] !== undefined) attrs |= ATTR_ON[n];
    else if (ATTR_OFF[n] !== undefined) attrs &= ~ATTR_OFF[n];
    else if (n === 39) fg = null;
    else if (n === 49) bg = null;
    else if (n === 38 && nums[i + 1] === 5) { fg = nums[i + 2]; i += 2; }
    else if (n === 48 && nums[i + 1] === 5) { bg = nums[i + 2]; i += 2; }
  }
  return { fg, bg, attrs };
}

/**
 * Write an SGR-styled line into `buffer` starting at (x, y), decoding
 * its embedded SGR codes into Cell styles as it goes; `baseStyle`
 * (e.g. a hyperlink `url`) applies to every cell, UNDER whatever the
 * line's own SGR sets for fg/bg/attrs.
 * @param {ReturnType<typeof import("./buffer.js").createBuffer>} buffer
 * @param {number} x @param {number} y
 * @param {string} line - plain or `\x1b[...m`-styled text, one row
 * @param {{fg?: number|null, bg?: number|null, attrs?: number, url?: string|null}} [baseStyle]
 * @returns {number} columns actually written
 */
export function writeAnsiRow(buffer, x, y, line, baseStyle = {}) {
  let col = x;
  let style = { fg: baseStyle.fg ?? null, bg: baseStyle.bg ?? null, attrs: baseStyle.attrs ?? 0 };
  const url = baseStyle.url ?? null;
  for (const token of tokenize(line)) {
    if (token.sgr) { style = foldSgr(style, token.sgr); continue; }
    buffer.set(col, y, token.g, { ...style, url });
    col += token.w;
  }
  return col - x;
}
