/**
 * lib/gtui/widgets/checkbox.js — a one-line `[x] label` toggle Node.
 * Part of the retained, unwired widget island (see lib/gtui/msg.js).
 * Same activatable shape as button.js (see its header for the
 * activate() contract).
 */

import { displayWidth } from "../width.js";
import { clip } from "../clip.js";
import { REVERSE } from "../cell.js";

function resolveMsg(onToggle) {
  if (onToggle === undefined || onToggle === null) return null;
  return typeof onToggle === "function" ? onToggle() : onToggle;
}

/**
 * @param {Object} options
 * @param {string} options.label
 * @param {boolean} [options.checked]
 * @param {boolean} [options.focused]
 * @param {{fg?, bg?, attrs?}} [options.style]
 * @param {Object|Function} [options.onToggle] - a Msg, or `() => Msg`
 * @returns {{measure: Function, draw: Function, activate: Function}}
 */
export function checkbox({ label, checked = false, focused = false, style = {}, onToggle } = {}) {
  const rendered = `[${checked ? "x" : " "}] ${label}`;
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
    activate: () => resolveMsg(onToggle),
  };
}
