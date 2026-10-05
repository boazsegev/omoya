// Toolbar button sizing, layout, rendering, and target registration.
import { displayWidth } from "../width.js";
import { drawMenuLine } from "./helpers.js";
/**
 * A toolbar button's identity: its `id`, else its `action` — stable while
 * its label or pressed state changes, so roving focus stays on it.
 */
const buttonKey = (button) => String(button.id ?? button.action ?? "");
/**
 * Format a toolbar button label with optional icon and surrounding spaces.
 * @param {object} button - Toolbar button.
 * @returns {string} Display text.
 */
const buttonText = (button) => ` ${button.icon ? `${button.icon} ` : ""}${button.content ?? ""} `;
/**
 * Get the toolbar gap, flooring finite values and defaulting to one.
 * @param {object} node - Toolbar node.
 * @returns {number} Nonnegative gap in columns.
 */
export const toolbarGap = (node) => Math.max(0, Number.isFinite(node.gap) ? Math.floor(node.gap) : 1);

/**
 * Extract button children with identity, display text, and measured width.
 * @param {object} node - Toolbar node.
 * @returns {object[]} Button layout descriptors retaining source child indices.
 */
export function toolbarButtons(node) {
  return (node.children ?? []).filter((child) => child?.type === "button").map((button, index) => {
    const text = buttonText(button);
    return { button, index, key: buttonKey(button), text, w: displayWidth(text) };
  });
}

/**
 * The buttons that fit `width`, laid out left to right. Buttons drop WHOLE,
 * lowest `priority` first (ties drop the later one), like row children —
 * a half-drawn button would be a click target with an unreadable label.
 */
function toolbarLayout(node, width) {
  const gap = toolbarGap(node);
  const kept = toolbarButtons(node);
  const used = () => kept.reduce((sum, item) => sum + item.w, 0) + gap * Math.max(0, kept.length - 1);
  const drops = [...kept].sort((a, b) => (Number(a.button.priority ?? 0) - Number(b.button.priority ?? 0)) || (b.index - a.index));
  for (const item of drops) {
    if (used() <= width || kept.length <= 1) break;
    kept.splice(kept.indexOf(item), 1);
  }
  let x = 0;
  return kept.map((item) => {
    const placed = { ...item, x };
    x += item.w + gap;
    return placed;
  });
}

/**
 * Render toolbar buttons, maintain roving-focus state, and register actions.
 * @param {object} canvas - Render canvas.
 * @param {object} node - Toolbar node.
 * @param {object} box - Toolbar rectangle.
 * @param {object} state - Mutable roving-focus state.
 * @param {Function} register - Receives action targets.
 * @returns {void} Mutates canvas, state, and registrations.
 */
export function drawToolbar(canvas, node, box, state, register) {
  const items = toolbarLayout(node, box.w);
  // `align: "end"` keeps the buttons against the box's right edge when
  // dropped buttons leave spare columns (a status line reads right-aligned).
  const used = items.length === 0 ? 0 : items.at(-1).x + items.at(-1).w;
  const offset = node.align === "end" ? Math.max(0, box.w - used) : 0;
  // Roving focus remembers a button by key; when that button is gone (or
  // dropped for width) focus rests on the first visible one.
  const current = items.find((item) => item.key === state.key) ?? items[0] ?? null;
  state.key = current?.key ?? null;
  state.items = items;
  items.forEach((item, index) => {
    const { button } = item;
    const role = [
      "button",
      button.pressed === true ? "button.on" : null,
      typeof button.tone === "string" && button.tone !== "" ? `button.${button.tone}` : null,
      node.focus === true && item === current ? "button.focus" : null,
    ].filter(Boolean).join(" ");
    const itemBox = { x: box.x + offset + item.x, y: box.y, w: Math.min(item.w, box.w - offset - item.x), h: 1 };
    drawMenuLine(canvas, itemBox, 0, item.text, role, false, { hover: `${node.id ?? "toolbar"}:${item.key}` });
    if (button.action) register({ kind: "action", target: button.id ?? node.id, action: button.action, index, box: itemBox });
  });
}

