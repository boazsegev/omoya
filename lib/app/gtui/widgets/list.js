/**
 * lib/gtui/widgets/list.js — a scrollable, selectable list Node: the
 * base widgets/dropdown.js (a later phase) builds a popup menu on.
 * The windowing math (keep the selected row on screen, centered when
 * possible) mirrors tui-helpers/menu.js's layoutMenu — same idea,
 * reimplemented here rather than imported: layoutMenu is 1-based
 * screen-row math tied to formatMenu's whole-frame text output,
 * gtui's is a 0-based Node windowing its OWN rect. Part of the
 * retained, unwired widget island (see lib/gtui/msg.js).
 */

import { displayWidth } from "../width.js";
import { clip } from "../clip.js";
import { REVERSE } from "../cell.js";

/** The visible window [start, end) keeping `index` on screen, centered
 *  when the list outgrows `rows` (never past either edge). */
export function listWindow(count, index, rows) {
  if (rows <= 0) return { start: 0, end: 0 };
  if (count <= rows) return { start: 0, end: count };
  let start = Math.max(0, index - Math.floor(rows / 2));
  start = Math.min(start, count - rows);
  return { start, end: start + rows };
}

function resolveMsg(onSelect, item, index) {
  if (onSelect === undefined || onSelect === null) return null;
  return typeof onSelect === "function" ? onSelect(item, index) : onSelect;
}

/**
 * @param {Object} options
 * @param {Array<string|{label: string}>} options.items
 * @param {number} [options.index] - the selected row
 * @param {{fg?, bg?, attrs?}} [options.style]
 * @param {(item, index: number) => Object|Object} [options.onSelect]
 * @returns {{measure: Function, draw: Function, activate: Function, window: Function}}
 */
export function list({ items, index = 0, style = {}, onSelect } = {}) {
  const label = (item) => (typeof item === "string" ? item : String(item?.label ?? ""));
  return {
    measure(availW, availH) {
      if (availW <= 0 || availH <= 0) return { w: 0, h: 0 };
      const w = Math.min(availW, Math.max(0, ...items.map((it) => displayWidth(label(it)))));
      return { w, h: Math.min(availH, items.length) };
    },
    draw(buffer, rect) {
      if (rect.w <= 0 || rect.h <= 0) return;
      const { start, end } = listWindow(items.length, index, rect.h);
      for (let i = start; i < end; i++) {
        const row = rect.y + (i - start);
        const selected = i === index;
        const rowStyle = selected ? { ...style, attrs: (style.attrs ?? 0) | REVERSE } : style;
        buffer.text(rect.x, row, clip(label(items[i]), rect.w), rowStyle);
      }
    },
    /** The Msg selecting the CURRENT index produces (or null). */
    activate: () => resolveMsg(onSelect, items[index], index),
    /** The visible window at a given row count — exposed for hit-testing (a later phase's click/wheel routing). */
    window: (rows) => listWindow(items.length, index, rows),
  };
}
