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

/** Portable cursor shape via DECSCUSR. `shape` is `line`, `underline`,
 * or `block`, translated to the numeric preferences 32, 50, and 100.
 * Numeric 1-100 preferences are also accepted. `blink` picks the terminal's
 * steady/blinking variant (the host controls an exact millisecond half-period
 * by toggling visibility itself). */
/** SGR mouse reporting (button, drag, and motion). */
export const ENABLE_MOUSE = String.fromCharCode(27) + "[?1000h" + String.fromCharCode(27) + "[?1002h" + String.fromCharCode(27) + "[?1006h";
export const DISABLE_MOUSE = String.fromCharCode(27) + "[?1006l" + String.fromCharCode(27) + "[?1002l" + String.fromCharCode(27) + "[?1000l";

export function cursorStyle(shape = "line", blink = true) {
  const namedValue = { line: 32, underline: 50, block: 100 }[shape];
  const value = namedValue ?? Number(shape);
  const base = Number.isFinite(value)
    ? (value < 34 ? 5 : value < 67 ? 3 : 1)
    : 5;
  // DECSCUSR: odd values blink, even values are steady.
  return String.fromCharCode(27) + "[" + (blink !== false ? base : base + 1) + " q";
}

/** Set an xterm-compatible cursor color; null restores the terminal default. */
export function cursorColor(value) {
  if (value === null || value === undefined) return "\x1b]112\x07";
  if (typeof value === "number") return ""; // palette indices have no portable OSC 12 representation
  return `\x1b]12;${value}\x07`;
}

/** Set an xterm-compatible terminal canvas color; null restores its default.
 * This affects only the alternate screen: inline mode must not recolor the
 * user's scrollback or shell. Palette indices have no portable OSC 11 form. */
export function backgroundColor(value) {
  if (value === null || value === undefined) return "\x1b]111\x07";
  if (typeof value === "number") return "";
  return `\x1b]11;${value}\x07`;
}

/** Restore the terminal's configured cursor shape. */
export function cursorStyleReset() {
  return "\x1b[0 q";
}

/** Hide the hardware cursor while an overlay owns interaction. */
export function overlayCursorHidden() {
  return "\x1b[?25l";
}

function oscText(value, limit = 512) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * The window/tab title escape (OSC 0 — honored by every xterm-compatible
 * terminal; others just ignore the bytes, an OSC sequence is consumed
 * silently, never a visible artifact).
 * @param {string} title
 * @returns {string}
 */
export function titleBytes(title) {
  return `\x1b]0;${oscText(title)}\x07`;
}

/** Host-level desktop notification (OSC 9). Unsupported terminals ignore it;
 * the BEL terminator still provides a minimal alert without painting text into
 * an owned screen. Control bytes are stripped so content cannot break the OSC. */
export function notificationBytes(text) {
  return `\x1b]9;${oscText(text)}\x07`;
}
