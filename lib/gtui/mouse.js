/**
 * lib/gtui/mouse.js — SGR mouse reporting (generic terminal primitive,
 * ported from the retired lib/tui-helpers/mouse.js).
 *
 * Mode: button events only (CSI ?1000 — presses, releases, wheel; no
 * motion) in the SGR encoding (CSI ?1006: `ESC [ < b ; x ; y M|m`,
 * unambiguous, no 223-column limit). Terminals that lack the modes
 * ignore the enables.
 */

/** Enable SGR button events and passive pointer motion. ?1003 includes
 * unpressed movement, which interactive text needs for hover feedback; drag
 * selection remains a normal button-held motion report. */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
/** Disable mouse reporting (reverse order of the enable). */
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

/**
 * xterm's "alternate scroll mode" (CSI ?1007) makes a terminal
 * TRANSLATE wheel events into arrow-key sequences on the alternate
 * screen whenever it decides mouse tracking isn't active — an
 * incomplete/quirky SGR implementation can trip this even while mouse
 * reporting WAS enabled, and the arrow keys it sends land as history
 * navigation, not a transcript scroll. Disabled for the session's
 * duration whenever the mouse is used at all (restored on teardown —
 * most terminals default it ON outside alt-screen apps).
 */
export const DISABLE_ALT_SCROLL = "\x1b[?1007l";
export const ENABLE_ALT_SCROLL = "\x1b[?1007h";

/** One SGR mouse report anywhere in a byte string. */
export const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Decode one SGR mouse report into a mouse event.
 * @param {number} b - the button/modifier code
 * @param {number} x - 1-based column
 * @param {number} y - 1-based row
 * @param {"M"|"m"} final - M = press (or wheel), m = release
 * @returns {{type: "mouse", button: number|null, x: number, y: number,
 *   press: boolean, release: boolean, wheel: "up"|"down"|null,
 *   drag: boolean, move: boolean, shift: boolean, meta: boolean, ctrl: boolean}}
 */
export function decodeMouse(b, x, y, final) {
  const wheel = (b & 64) !== 0 ? ((b & 1) !== 0 ? "down" : "up") : null;
  const button = wheel ? null : b & 3;
  const drag = (b & 32) !== 0;
  // xterm encodes unpressed motion as the motion bit plus button 3.
  const move = drag && button === 3;
  return {
    type: "mouse",
    button,
    x, y,
    press: final === "M" && !wheel && !move,
    release: final === "m",
    wheel,
    drag,
    move,
    shift: (b & 4) !== 0,
    meta: (b & 8) !== 0,
    ctrl: (b & 16) !== 0,
  };
}

/** @param {*} ev @returns {boolean} is this a mouse event (vs a key name) */
export function isMouseEvent(ev) {
  return ev !== null && typeof ev === "object" && ev.type === "mouse";
}
