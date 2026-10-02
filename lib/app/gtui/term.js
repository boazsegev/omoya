/**
 * lib/gtui/term.js — terminal output controls: cursor shape/visibility,
 * synchronized-output framing, and the window/tab title (generic
 * terminal primitives, ported from lib/tui-helpers/term.js and
 * lib/tui-helpers/terminal-title.js — both now retired). Every export here PRODUCES escape
 * bytes; nothing writes to a stream itself — hosts own IO and call
 * these when composing a frame, matching the rest of gtui's injected-
 * write convention. The title STRING (ai's `@<parent>/<folder>`
 * naming) is a tui-app/façade concern, not this primitive — this
 * module only knows how to frame whatever title string it's given.
 */

/** Begin/end a synchronized-output frame (CSI ?2026): the terminal
 *  buffers the writes between these and paints them atomically,
 *  avoiding visible tearing on a fast repaint. */
export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/** Show/hide the hardware cursor. */
export const CURSOR_SHOW = "\x1b[?25h";
export const CURSOR_HIDE = "\x1b[?25l";

/** Enable SGR mouse reporting for button, drag, and motion events. */
export const ENABLE_MOUSE = String.fromCharCode(27) + "[?1000h" + String.fromCharCode(27) + "[?1002h" + String.fromCharCode(27) + "[?1006h";
/** Disable SGR mouse reporting for button, drag, and motion events. */
export const DISABLE_MOUSE = String.fromCharCode(27) + "[?1006l" + String.fromCharCode(27) + "[?1002l" + String.fromCharCode(27) + "[?1000l";

/**
 * Build a DECSCUSR escape sequence for the requested cursor shape and blink state.
 * Named shapes are `line`, `underline`, and `block`; other shapes are converted
 * to numbers and mapped to the terminal's line, underline, or block preference
 * by numeric thresholds. Only `blink === false` selects a steady cursor; the
 * host can control an exact blink period by toggling cursor visibility itself.
 * This function only returns bytes and does not write to a terminal.
 * @param {string|number} [shape="line"] Named or numeric shape preference.
 * @param {boolean} [blink=true] Whether to request blinking.
 * @returns {string} The DECSCUSR escape sequence.
 * @throws {*} If coercing `shape` to a property key or number throws.
 */
export function cursorStyle(shape = "line", blink = true) {
  const namedValue = { line: 32, underline: 50, block: 100 }[shape];
  const value = namedValue ?? Number(shape);
  const base = Number.isFinite(value)
    ? (value < 34 ? 5 : value < 67 ? 3 : 1)
    : 5;
  // DECSCUSR: odd values blink, even values are steady.
  return String.fromCharCode(27) + "[" + (blink !== false ? base : base + 1) + " q";
}

/**
 * Build an xterm-compatible OSC 12 cursor-color sequence.
 * `null` or `undefined` restores the terminal default, a number produces no
 * sequence because palette indices have no portable OSC 12 representation,
 * and other values are interpolated as the color specification without validation.
 * This function returns bytes; it does not write to a terminal.
 * @param {*} [value] Color specification; omission behaves like `undefined`.
 * @returns {string} The OSC sequence, or an empty string for a numeric value.
 * @throws {*} If converting a supplied color value to a string throws.
 */
export function cursorColor(value) {
  if (value === null || value === undefined) return "\x1b]112\x07";
  if (typeof value === "number") return ""; // palette indices have no portable OSC 12 representation
  return `\x1b]12;${value}\x07`;
}

/**
 * Build an xterm-compatible OSC 11 terminal-canvas-color sequence.
 * `null` or `undefined` restores the terminal default, a number produces no
 * sequence because palette indices have no portable OSC 11 representation,
 * and other values are interpolated as the color specification without validation.
 * The caller should use this only for an alternate screen: recoloring in inline
 * mode would affect the user's scrollback or shell. This function returns bytes
 * and does not write to a terminal.
 * @param {*} [value] Color specification; omission behaves like `undefined`.
 * @returns {string} The OSC sequence, or an empty string for a numeric value.
 * @throws {*} If converting a supplied color value to a string throws.
 */
export function backgroundColor(value) {
  if (value === null || value === undefined) return "\x1b]111\x07";
  if (typeof value === "number") return "";
  return `\x1b]11;${value}\x07`;
}

/**
 * Build the DECSCUSR reset sequence that restores the terminal's configured cursor shape.
 * This function returns bytes and does not write to a terminal.
 * @returns {string} The cursor-shape reset escape sequence.
 */
export function cursorStyleReset() {
  return "\x1b[0 q";
}

/**
 * Build the escape sequence that hides the hardware cursor while an overlay owns interaction.
 * This function returns bytes and does not write to a terminal.
 * @returns {string} The cursor-hide escape sequence.
 */
export function overlayCursorHidden() {
  return "\x1b[?25l";
}

/**
 * Convert text for use in an OSC payload by replacing controls with spaces,
 * collapsing whitespace, trimming, and truncating to the requested slice bound.
 * This helper performs no IO; a conversion failure from `value` is propagated.
 * @param {*} value Value converted with `String(value ?? "")`.
 * @param {number} [limit=512] `slice` end bound applied after normalization.
 * @returns {string} The normalized, control-free text.
 * @throws {*} If converting `value` to a string throws or `limit` is invalid for `slice`.
 */
function oscText(value, limit = 512) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * Build the OSC 0 window/tab-title escape sequence. The title is normalized by
 * `oscText` (control bytes replaced with spaces, whitespace collapsed, trimmed,
 * then limited to 512 UTF-16 code units); unsupported terminals can ignore the bytes.
 * This function returns bytes and does not write to a terminal.
 * @param {*} [title] Title value; omission is treated as an empty string.
 * @returns {string} The OSC 0 title escape sequence.
 * @throws {*} If converting `title` to a string throws.
 */
export function titleBytes(title) {
  return `\x1b]0;${oscText(title)}\x07`;
}

/**
 * Build an OSC 9 host-level desktop-notification sequence. Notification text
 * is normalized by `oscText` (control bytes replaced with spaces, whitespace
 * collapsed, trimmed, then limited to 512 UTF-16 code units); unsupported terminals may ignore it.
 * This function returns bytes and does not write to a terminal.
 * @param {*} [text] Notification value; omission is treated as an empty string.
 * @returns {string} The OSC 9 notification escape sequence.
 * @throws {*} If converting `text` to a string throws.
 */
export function notificationBytes(text) {
  return `\x1b]9;${oscText(text)}\x07`;
}
