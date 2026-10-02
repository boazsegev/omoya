/**
 * Overlay model state. Menus own a back-navigable item stack; the block
 * viewer owns only semantic block/message indexes and a row offset. GTUI
 * owns viewport geometry, wrapping, scrolling, and terminal input.
 */

const HOP_MESSAGES = 10;
/** Clamp a numeric index to the inclusive range from zero through max.
 * @param {number} value - The value to clamp.
 * @param {number} max - The upper bound; expected to be nonnegative.
 * @returns {number} The clamped value. Does not mutate state or throw intentionally.
 */
const clamp = (value, max) => Math.max(0, Math.min(max, value));

/** Create a fresh single-level menu overlay.
 * @param {string} title - The displayed menu title.
 * @param {Array} items - The menu entries.
 * @returns {object} A menu overlay with one stack level. Does not mutate inputs.
 */
export function openMenu(title, items) {
  return { type: "menu", stack: [{ title, items }] };
}

/** Descend into a sub-menu (a selected item that lists more items). A
 *  direct entry point such as `/endpoint-login` may arrive with no menu
 *  open (or while another overlay is being dismissed). Only a real menu
 *  owns a stack; replace every other overlay with a fresh menu.
 * @param {object|null|undefined} overlay - Current overlay, if any.
 * @param {string} title - The sub-menu title.
 * @param {Array} items - The sub-menu entries.
 * @returns {object} A copied overlay with the new level appended, or a fresh menu.
 * Does not mutate inputs; malformed/non-menu overlays are replaced.
 */
export function pushMenu(overlay, title, items) {
  return overlay?.type === "menu" && Array.isArray(overlay.stack)
    ? { ...overlay, stack: [...overlay.stack, { title, items }] }
    : openMenu(title, items);
}

/** Explicitly navigate back one menu level; Escape is handled separately as full dismissal.
 * @param {object} overlay - A menu overlay with a stack.
 * @returns {object|null} A copied overlay with its last level removed, or null when at the root.
 * Reads `overlay.stack`; callers must provide a valid menu overlay.
 */
export function popMenu(overlay) {
  return overlay.stack.length <= 1 ? null : { ...overlay, stack: overlay.stack.slice(0, -1) };
}

/** Return the items in the currently displayed menu level.
 * @param {object} overlay - A menu overlay with a non-empty stack.
 * @returns {Array} The active level's items.
 * Reads `overlay.stack`; callers must provide a valid menu overlay.
 */
export function currentMenuItems(overlay) {
  return overlay.stack.at(-1).items;
}

/** Attach highlighted-item preview data to the active menu level.
 * @param {object} overlay - A menu overlay with a non-empty stack.
 * @param {*} preview - Preview data; nullish values clear the preview to null.
 * @returns {object} A copied overlay and stack with the active level's preview set.
 * Does not mutate inputs; expects a valid menu overlay.
 */
export function previewMenu(overlay, preview) {
  const stack = [...overlay.stack];
  stack[stack.length - 1] = { ...stack.at(-1), preview: preview ?? null };
  return { ...overlay, stack };
}

export const VIEWER_FILTERS = Object.freeze(["system", "user", "thinking", "assistant", "tool"]);

/** Open on the newest block, matching the transcript's end anchor.
 * @param {Array} [blocks=[]] - Blocks in source order.
 * @returns {object} A viewer overlay initialized at the newest block (or index zero when empty), with zero offset and cleared filters/search.
 * Does not mutate the input.
 */
export function openViewer(blocks = []) {
  return { type: "viewer", index: Math.max(0, blocks.length - 1), sourceIndex: blocks.at(-1)?.sourceIndex ?? Math.max(0, blocks.length - 1), offset: 0, filters: [], search: "" };
}

/** Apply message categories and a case-insensitive text pattern without losing source indexes.
 * @param {Array} blocks - Blocks to filter.
 * @param {object} [overlay={}] - Filter state; `filters` defaults to an empty list and `search` to an empty string. Null is treated as empty state.
 * @returns {Array} Matching copied blocks, each annotated with its original source index.
 * Does not mutate inputs; stringifies block text and search values.
 */
export function filterViewerBlocks(blocks, overlay = {}) {
  overlay ??= {};
  const selected = new Set(overlay.filters ?? []);
  const pattern = String(overlay.search ?? "").toLowerCase();
  return blocks.map((block, sourceIndex) => ({ ...block, sourceIndex })).filter((block) =>
    (selected.size === 0 || selected.has(block.category ?? block.type))
    && (pattern === "" || String(block.text ?? "").toLowerCase().includes(pattern)));
}

/** Preserve the same source block, or select the nearest surviving predecessor.
 * @param {object} overlay - Viewer state; `sourceIndex` is preferred, falling back to the indexed block's source index and then zero.
 * @param {Array} blocks - Current filtered blocks.
 * @returns {object} A copied overlay with reconciled `index`/`sourceIndex` and reset offset.
 * Does not mutate inputs; selects index zero if no matching predecessor exists.
 */
export function reconcileViewer(overlay, blocks) {
  const sourceIndex = overlay.sourceIndex ?? blocks[overlay.index]?.sourceIndex ?? 0;
  let index = blocks.findIndex((block) => block.sourceIndex === sourceIndex);
  if (index < 0) {
    index = blocks.findLastIndex((block) => block.sourceIndex < sourceIndex);
    if (index < 0) index = 0;
  }
  return { ...overlay, index, sourceIndex: blocks[index]?.sourceIndex ?? sourceIndex, offset: 0 };
}

/** Move by a signed number of semantic blocks and reset row scroll.
 * @param {object} overlay - Viewer state containing the current index.
 * @param {Array} blocks - Available blocks.
 * @param {number} direction - Signed movement amount (typically -1 or 1).
 * @returns {object} A copied overlay with bounded index, updated source index when available, and zero offset.
 * Does not mutate inputs.
 */
export function moveViewer(overlay, blocks, direction) {
  const index = clamp(overlay.index + direction, Math.max(0, blocks.length - 1));
  return { ...overlay, index, sourceIndex: blocks[index]?.sourceIndex ?? overlay.sourceIndex, offset: 0 };
}

/** Hop by logical messages while keeping a tool call/result's sub-blocks together.
 * @param {object} overlay - Viewer state containing the current index.
 * @param {Array} blocks - Available blocks, in order.
 * @param {number} direction - Signed hop direction.
 * @param {number} [count=HOP_MESSAGES] - Number of logical message groups to hop.
 * @returns {object} A copied overlay positioned at the destination group's first block with zero offset; for empty input, index is zero.
 * Does not mutate inputs. Groups contiguous equal message identifiers together, falling back to group or block identity.
 */
export function hopViewer(overlay, blocks, direction, count = HOP_MESSAGES) {
  if (blocks.length === 0) return { ...overlay, index: 0, offset: 0 };
  const groups = [];
  /** Resolve a block's logical message grouping key.
   * @param {object} block - Block whose grouping metadata is inspected.
   * @param {number} index - Block position, used as the final fallback.
   * @returns {string} A key based on integer message id, explicit group, or block index.
   * Does not mutate state.
   */
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
