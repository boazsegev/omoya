/**
 * Overlay model state. Menus own a back-navigable item stack; the block
 * viewer owns only semantic block/message indexes and a row offset. GTUI
 * owns viewport geometry, wrapping, scrolling, and terminal input.
 */

const HOP_MESSAGES = 10;
const clamp = (value, max) => Math.max(0, Math.min(max, value));

/** @param {string} title @param {Array} items @returns {object} a fresh single-level menu overlay */
export function openMenu(title, items) {
  return { type: "menu", stack: [{ title, items }] };
}

/** Descend into a sub-menu (a selected item that lists more items). A
 *  direct entry point such as `/endpoint-login` may arrive with no menu
 *  open (or while another overlay is being dismissed). Only a real menu
 *  owns a stack; replace every other overlay with a fresh menu. */
export function pushMenu(overlay, title, items) {
  return overlay?.type === "menu" && Array.isArray(overlay.stack)
    ? { ...overlay, stack: [...overlay.stack, { title, items }] }
    : openMenu(title, items);
}

/** Explicit back navigation; Escape is handled separately as full dismissal. */
export function popMenu(overlay) {
  return overlay.stack.length <= 1 ? null : { ...overlay, stack: overlay.stack.slice(0, -1) };
}

/** @returns {Array} the currently displayed level's items */
export function currentMenuItems(overlay) {
  return overlay.stack.at(-1).items;
}

/** Attach highlighted-item preview data to the active menu level. */
export function previewMenu(overlay, preview) {
  const stack = [...overlay.stack];
  stack[stack.length - 1] = { ...stack.at(-1), preview: preview ?? null };
  return { ...overlay, stack };
}

export const VIEWER_FILTERS = Object.freeze(["system", "user", "thinking", "assistant", "tool"]);

/** Open on the newest block, matching the transcript's end anchor. */
export function openViewer(blocks = []) {
  return { type: "viewer", index: Math.max(0, blocks.length - 1), sourceIndex: blocks.at(-1)?.sourceIndex ?? Math.max(0, blocks.length - 1), offset: 0, filters: [], search: "" };
}

/** Apply message categories and a case-insensitive text pattern without losing source indexes. */
export function filterViewerBlocks(blocks, overlay = {}) {
  overlay ??= {};
  const selected = new Set(overlay.filters ?? []);
  const pattern = String(overlay.search ?? "").toLowerCase();
  return blocks.map((block, sourceIndex) => ({ ...block, sourceIndex })).filter((block) =>
    (selected.size === 0 || selected.has(block.category ?? block.type))
    && (pattern === "" || String(block.text ?? "").toLowerCase().includes(pattern)));
}

/** Preserve the same source block, or select the nearest surviving predecessor. */
export function reconcileViewer(overlay, blocks) {
  const sourceIndex = overlay.sourceIndex ?? blocks[overlay.index]?.sourceIndex ?? 0;
  let index = blocks.findIndex((block) => block.sourceIndex === sourceIndex);
  if (index < 0) {
    index = blocks.findLastIndex((block) => block.sourceIndex < sourceIndex);
    if (index < 0) index = 0;
  }
  return { ...overlay, index, sourceIndex: blocks[index]?.sourceIndex ?? sourceIndex, offset: 0 };
}

/** Move one semantic block and reset that block's row scroll. */
export function moveViewer(overlay, blocks, direction) {
  const index = clamp(overlay.index + direction, Math.max(0, blocks.length - 1));
  return { ...overlay, index, sourceIndex: blocks[index]?.sourceIndex ?? overlay.sourceIndex, offset: 0 };
}

/** Hop by logical messages while keeping a tool call/result's sub-blocks together. */
export function hopViewer(overlay, blocks, direction, count = HOP_MESSAGES) {
  if (blocks.length === 0) return { ...overlay, index: 0, offset: 0 };
  const groups = [];
  const messageGroup = (block, index) => Number.isInteger(block?.message)
    ? `message:${block.message}` : (block?.group ?? `block:${index}`);
  for (let index = 0; index < blocks.length; index++) {
    const group = messageGroup(blocks[index], index);
    if (groups.at(-1)?.group !== group) groups.push({ group, index });
  }
  const currentIndex = clamp(overlay.index, blocks.length - 1);
  const current = messageGroup(blocks[currentIndex], currentIndex);
  const groupIndex = Math.max(0, groups.findIndex(({ group }) => group === current));
  const destination = groups[clamp(groupIndex + direction * count, groups.length - 1)]?.index ?? currentIndex;
  return { ...overlay, index: destination, sourceIndex: blocks[destination]?.sourceIndex ?? overlay.sourceIndex, offset: 0 };
}
