/**
 * lib/gtui/widgets/button.js — a one-line, click/Enter-activatable
 * control Node. Part of the retained, unwired widget island (see
 * lib/gtui/msg.js).
 *
 * Beyond the plain measure/draw Node contract, an activatable widget
 * also exposes `activate()`, returning the Msg its activation
 * produces (or null for none) — the future input adapter (a later
 * phase) calls it when a click or Enter lands on the FOCUSED control;
 * this module only defines what activating one produces, never how a
 * click/keypress gets routed there.
 */

import { displayWidth } from "../width.js";
import { clip } from "../clip.js";
import { REVERSE } from "../cell.js";

/** `onActivate` may be a Msg itself, or a function returning one. */
function resolveMsg(onActivate) {
  if (onActivate === undefined || onActivate === null) return null;
  return typeof onActivate === "function" ? onActivate() : onActivate;
}

/**
 * @param {Object} options
 * @param {string} options.label
 * @param {boolean} [options.focused]
 * @param {{fg?, bg?, attrs?}} [options.style]
 * @param {Object|Function} [options.onActivate] - a Msg, or `() => Msg`
 * @returns {{measure: Function, draw: Function, activate: Function}}
 */
export function button({ label, focused = false, style = {}, onActivate } = {}) {
  const rendered = `[ ${label} ]`;
  const drawStyle = focused ? { ...style, attrs: (style.attrs ?? 0) | REVERSE } : style;
  return {
    measure(availW, availH) {
      if (availW <= 0 || availH <= 0) return { w: 0, h: 0 };
      return { w: Math.min(availW, displayWidth(rendered)), h: Math.min(availH, 1) };
    },
    draw(buffer, rect) {
      if (rect.w <= 0 || rect.h <= 0) return;
      buffer.text(rect.x, rect.y, clip(rendered, rect.w), drawStyle);
    },
    activate: () => resolveMsg(onActivate),
  };
}
