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
 * Create a cell record containing one grapheme, its colors, attribute flags, and link target.
 * @param {string|null} [text=""] One grapheme cluster, an empty string for a blank cell, or null for a wide-cluster continuation sentinel.
 * @param {{fg?: number|null, bg?: number|null, attrs?: number, url?: string|null}} [style={}] Style values; `fg` and `bg` default to null, `attrs` to 0, and `url` to null. `url` is an OSC 8 hyperlink target; adjacent cells with the same non-null URL may render as one hyperlink span.
 * @returns {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}} A new cell object with the resolved values.
 * @throws {TypeError} If `style` is null, because its properties are destructured.
 */
export function cell(text = "", { fg = null, bg = null, attrs = 0, url = null } = {}) {
  return { text, fg, bg, attrs, url };
}

/**
 * Create a blank cell whose text is one space and whose style uses the defaults from {@link cell}.
 * @returns {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}} A new blank cell object.
 */
export function blank() {
  return cell(" ");
}

/**
 * Create a continuation sentinel for the second slot occupied by a wide grapheme.
 * @returns {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}} A new cell object with `text` set to null and default style values.
 */
export function continuation() {
  return cell(null);
}

/**
 * Compare two cells by text, foreground, background, attributes, and hyperlink target.
 * @param {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}} a First cell.
 * @param {{text: string|null, fg: number|null, bg: number|null, attrs: number, url: string|null}} b Second cell.
 * @returns {boolean} True if every compared field is strictly equal; otherwise false.
 * @throws {TypeError} If either argument is null or undefined, property access fails.
 */
export function equalCell(a, b) {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs && a.url === b.url;
}

/**
 * Build the SGR escape sequence for a style's attributes and colors; unsupported color values are ignored.
 * @param {{fg?: number|string|null, bg?: number|string|null, attrs?: number}} style Style object; numeric colors are 256-color indices, and valid `#RRGGBB` strings are truecolor values.
 * @returns {string} An SGR sequence, or an empty string when no supported style codes are present.
 * @throws {TypeError} If style is null or undefined, if `attrs` is a Symbol or BigInt and is used with a numeric bitwise flag, or if a color value's string conversion throws.
 */
export function sgr(style) {
  const codes = [];
  if (style.attrs & BOLD) codes.push("1");
  if (style.attrs & DIM) codes.push("2");
  if (style.attrs & UNDERLINE) codes.push("4");
  if (style.attrs & REVERSE) codes.push("7");
  if (style.attrs & STRIKE) codes.push("9");
  if (style.attrs & ITALIC) codes.push("3");
  /**
   * Convert one color value to its SGR parameter, or reject it as unsupported.
   * @param {number|string|null|undefined} value Color index or `#RRGGBB` string.
   * @param {boolean} background Whether to encode a background rather than foreground color.
   * @returns {string|null} SGR color parameters, or null for an invalid or absent color.
   * @throws {TypeError} If converting a non-number color value to a string throws.
   */
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
