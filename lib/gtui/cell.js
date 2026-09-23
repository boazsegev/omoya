/**
 * lib/gtui/cell.js — one screen cell of a gtui Buffer (lib/gtui/buffer.js),
 * the cell-grid model: every drawable is a W×H grid of these cells.
 *
 * A Cell holds one GRAPHEME CLUSTER (never a raw code point — reuse
 * tui-helpers/width.js's grapheme math, never reinvent it) plus its
 * style. A wide (2-column) cluster occupies two array slots in a
 * Buffer: the cluster's own cell, then a CONTINUATION sentinel cell
 * (text: null) the diff/render step skips — exactly how a real
 * terminal's wide-char cell pair behaves.
 */

/** Style bit flags (attrs). */
export const BOLD = 1 << 0;
export const DIM = 1 << 1;
export const UNDERLINE = 1 << 2;
export const REVERSE = 1 << 3;
export const STRIKE = 1 << 4;
export const ITALIC = 1 << 5;

/**
 * @param {string|null} text - one grapheme cluster, "" for a blank
 *   cell, or null for a wide-cluster CONTINUATION sentinel
 * @param {{fg?: number|null, bg?: number|null, attrs?: number, url?: string|null}} [style]
 *   `url` is an OSC 8 hyperlink target (lib/gtui/widgets/link.js) — a
 *   run of cells sharing the same non-null url renders as ONE
 *   hyperlink span (render.js coalesces it exactly like SGR).
 * @returns {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}}
 */
export function cell(text = "", { fg = null, bg = null, attrs = 0, url = null } = {}) {
  return { text, fg, bg, attrs, url };
}

/** A blank (space) cell, the Buffer's fill default. */
export function blank() {
  return cell(" ");
}

/** A continuation sentinel: the second slot of a wide grapheme. */
export function continuation() {
  return cell(null);
}

/** True when two cells render identically (same glyph, style, AND link target). */
export function equalCell(a, b) {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs && a.url === b.url;
}

/** The SGR escape sequence for a cell's style (fg/bg/attrs), or "" for the default style. */
export function sgr(style) {
  const codes = [];
  if (style.attrs & BOLD) codes.push("1");
  if (style.attrs & DIM) codes.push("2");
  if (style.attrs & UNDERLINE) codes.push("4");
  if (style.attrs & REVERSE) codes.push("7");
  if (style.attrs & STRIKE) codes.push("9");
  if (style.attrs & ITALIC) codes.push("3");
  const colorCode = (value, background) => {
    if (typeof value === "number") return `${background ? 48 : 38};5;${value}`;
    const text = String(value ?? "");
    if (text.length !== 7 || text[0] !== "#") return null;
    const parts = [text.slice(1, 3), text.slice(3, 5), text.slice(5, 7)];
    if (parts.some((part) => !Number.isFinite(parseInt(part, 16)))) return null;
    return `${background ? 48 : 38};2;${parts.map((part) => parseInt(part, 16)).join(";")}`;
  };
  const foreground = colorCode(style.fg, false);
  const background = colorCode(style.bg, true);
  if (foreground) codes.push(foreground);
  if (background) codes.push(background);
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}
