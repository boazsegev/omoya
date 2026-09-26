/**
 * lib/gtui/widgets/dropdown.js — a popup list (box.js + list.js)
 * anchored to a screen point, clamped to stay fully within the
 * drawable area (never runs off the right/bottom edge) — the
 * drill-down menu widget. Part of the retained, unwired widget island
 * (see lib/gtui/msg.js).
 *
 * Unlike every other widget here, `draw(buffer, screenRect)`'s rect
 * is the whole DRAWABLE AREA the popup may occupy (typically the
 * buffer's own bounds, passed straight through from a Program's
 * view()) — the popup positions ITSELF near `anchor` inside it,
 * rather than filling whatever rect a parent layout handed it.
 */

import { box } from "./box.js";
import { list } from "./list.js";
import { rect as makeRect } from "../geometry.js";

/**
 * @param {Object} options
 * @param {{x: number, y: number}} options.anchor - the point the
 *   popup opens FROM (its top-left, before any edge clamping)
 * @param {Array<string|{label: string}>} options.items
 * @param {number} [options.index]
 * @param {string} [options.title]
 * @param {{fg?, bg?, attrs?}} [options.style]
 * @param {number} [options.maxHeight] - visible rows before scrolling
 * @param {(item, index: number) => Object|Object} [options.onSelect]
 * @returns {{measure: Function, draw: Function, activate: Function}}
 */
export function dropdown({ anchor, items, index = 0, title = "", style = {}, maxHeight = 8, onSelect } = {}) {
  const body = list({ items, index, style, onSelect });
  const framed = box({ title, style, child: body });
  return {
    measure: (availW, availH) => framed.measure(availW, availH),
    draw(buffer, screenRect) {
      if (screenRect.w <= 0 || screenRect.h <= 0) return;
      const contentH = Math.min(maxHeight, items.length) + 2; // +2 for the box border
      const natural = framed.measure(screenRect.w, contentH);
      const w = Math.min(natural.w, screenRect.w);
      const h = Math.min(natural.h, screenRect.h);
      const maxX = screenRect.x + screenRect.w - w;
      const maxY = screenRect.y + screenRect.h - h;
      const x = Math.max(screenRect.x, Math.min(anchor.x, maxX));
      const y = Math.max(screenRect.y, Math.min(anchor.y, maxY));
      framed.draw(buffer, makeRect(x, y, w, h));
    },
    activate: () => body.activate(),
  };
}
