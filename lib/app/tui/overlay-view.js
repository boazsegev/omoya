/** AI overlay views composed from GTUI's shared menu/scroll viewport controls. */

import { view } from "../gtui/gtui.js";
import { transcriptItems } from "./transcript.js";
import { questionView } from "./questionnaire-view.js";
import { VIEWER_FILTERS } from "./overlay-controller.js";
import { markdownRows } from "./markdown-view.js";

export const MENU_ID = "overlay-menu";
export const VIEWER_ID = "overlay-viewer";

/**
 * Split a menu label at its first `|` or `(` into a trimmed label and optional note.
 * @param {*} value Value coerced with `String(value ?? "")`; defaults to an empty string when nullish.
 * @returns {{label: string, note?: string}} Trimmed label, with a note only when non-empty.
 * @throws {Error} Propagates errors from a value's string conversion.
 */
export function splitMenuLabel(value) {
  const text = String(value ?? "");
  const pipe = text.indexOf("|");
  const paren = text.indexOf("(");
  const split = pipe < 0 ? paren : paren < 0 ? pipe : Math.min(pipe, paren);
  if (split < 0) return { label: text.trim() };
  const label = text.slice(0, split).trim();
  const note = text.slice(split + (text[split] === "|" ? 1 : 0)).trim();
  return note ? { label, note } : { label };
}

const MARKDOWN_SAMPLE = "# Heading\n**Bold**, _italic_, `inline code`, and a [link](https://example.com)\n1. Ordered item\n- List item\n> Quoted context\n```js\nconst themed = true;\n```";

/**
 * Build a column showing themed message and Markdown examples for a menu preview.
 * @param {string} name Theme name displayed in the preview heading.
 * @returns {*} GTUI column view node.
 * @throws {Error} Propagates errors from Markdown row generation or GTUI view construction.
 */
function themePreview(name) {
  const markdown = markdownRows(MARKDOWN_SAMPLE).map(/** Convert one Markdown row to a styled text node. @param {{role: string, content: string}} row Markdown row. @returns {*} GTUI text node. */({ role, content }) => view.text({ role, content }));
  return view.column({}, [
    view.text({ role: "menu.header" }, ` ${name} preview `),
    view.text({ role: "message.system" }, "System › concise guidance"),
    view.text({ role: "message.user" }, "User › Can you summarize this?"),
    view.text({ role: "message.text" }, "Assistant › Certainly — here is the result."),
    view.text({ role: "message.thinking" }, "Thinking › reviewing context…"),
    view.text({ role: "tool.call" }, "Tool call › read settings"),
    view.text({ role: "tool.result" }, "Tool result ✓ completed"),
    view.text({ role: "tool.display" }, "Tool display › rendered output"),
    view.text({ role: "tool.error" }, "Tool error ✕ failed"),
    ...markdown,
  ]);
}

/**
 * Build a clipped footer text node for an agent-description overlay layer.
 * @param {string} description Description shown in the node.
 * @returns {*} GTUI text view node.
 * @throws {Error} Propagates errors from GTUI view construction.
 */
function agentDescriptionPreview(description) {
  return view.text({ role: "menu.footer", overflow: "clip-end" }, description);
}

/**
 * Build the menu node for the active overlay stack level, including a theme preview when requested.
 * @param {object} overlay Overlay state; expects a non-empty `stack` whose final level has `title` and `items`.
 * @returns {*} GTUI menu or column view node.
 * @throws {Error} Propagates errors from malformed overlay data or GTUI view construction.
 */
function menuView(overlay) {
  const level = overlay.stack.at(-1);
  const stateKey = overlay.stack.map(/** Return a level title for the state key. @param {{title: string}} level Stack level. @returns {string} The title. */({ title }) => title).join(" › ");
  const items = level.items.map(/** Split each item label and preserve its explicit note. @param {object} item Menu item. @returns {object} Copied item with parsed label and note. @throws {Error} Propagates errors converting the item label to a string. */(item) => {
    const parts = splitMenuLabel(item.label);
    return { ...item, ...parts, note: item.note ?? parts.note };
  });
  const menu = view.menu({ id: MENU_ID, stateKey, focus: true, title: level.title, items });
  return level.preview?.type === "theme" ? view.column({}, [menu, themePreview(level.preview.name)]) : menu;
}

/**
 * Format the title for a transcript block viewer, including block/message position when available.
 * @param {object|null|undefined} block Block metadata; a falsy value produces the empty-view title.
 * @param {number} index Zero-based block index.
 * @param {number} total Total number of blocks.
 * @returns {string} Formatted viewer title.
 */
export function viewerTitle(block, index, total) {
  if (!block) return " Block View [0/0] ";
  const label = block.label && block.label !== block.type ? ` — ${block.label}` : "";
  const numbered = Number.isInteger(block.messageNumber) && Number.isInteger(block.messagePart)
    ? `${block.messageNumber}.${block.messagePart}${block.section ? ` ${block.section}` : ""}`
    : null;
  const where = block.virtual ? " · virtual system block" : numbered ? ` · ${numbered}` : Number.isInteger(block.message) ? ` · message ${block.message + 1}` : "";
  return ` ${String(block.type).toUpperCase()} [${index + 1}/${total}]${label}${where} `;
}

/**
 * Build the scrollable transcript-block viewer node, or its empty-context message.
 * @param {object} overlay Viewer state; reads `index` and `offset`.
 * @param {Array<object>} blocks Transcript blocks to display.
 * @returns {*} GTUI scroll view node.
 * @throws {Error} Propagates errors from transcript rendering or GTUI view construction.
 */
function viewerView(overlay, blocks) {
  const index = Math.max(0, Math.min(overlay.index ?? 0, Math.max(0, blocks.length - 1)));
  const block = blocks[index];
  const body = block
    ? transcriptItems([block], 0, { previews: false }).at(0)?.node
    : view.text({ role: "menu.footer" }, "(no context blocks)");
  return view.scroll({
    id: VIEWER_ID,
    offset: overlay.offset,
    focus: true,
    title: viewerTitle(block, index, blocks.length),
    footer: " ← → blocks · Alt+←/→ 10 messages · ↑ ↓ / Space B / wheel scroll · F filter/search · C copy · Esc close ",
  }, [body]);
}

/**
 * Build the multi-select question view used to choose message filters and a search pattern.
 * @param {object} overlay Filter overlay state passed through to the questionnaire view.
 * @returns {*} Questionnaire/GTUI view node.
 * @throws {Error} Propagates errors from questionnaire view construction.
 */
function viewerFilterView(overlay) {
  const options = [
    ...VIEWER_FILTERS.map(/** Create a display option for a filter. @param {string} label Filter name. @returns {{label: string, description: string}} Filter option. */(label) => ({ label, description: `show ${label} messages` })),
    { label: "Clear filters", description: "show every message type and clear search" },
  ];
  return questionView({ question: "Choose message types and/or enter a search pattern.", header: "Block View filters", details: "No selected types means all message types.", multiSelect: true, options }, overlay.draft, overlay.focus, overlay.filters, null, overlay.caret, overlay.selection);
}

/**
 * Render an overlay as a full-fill modal, selecting its menu, block viewer, or filter content.
 * The modal owns the viewport in both terminal modes.
 * @param {object} overlay Overlay state; `type` selects the view and menu/description state as applicable.
 * @param {Array<object>} blocks Transcript blocks consumed by the block viewer; unused for menus and filters.
 * @returns {*} GTUI overlay view node.
 * @throws {Error} Propagates errors from the selected child view or GTUI view construction.
 */
export function overlayView(overlay, blocks) {
  if (overlay.type === "viewer-filter") return viewerFilterView(overlay);
  const body = overlay.type === "menu" ? menuView(overlay) : viewerView(overlay, blocks);
  const preview = overlay.type === "menu" ? overlay.stack.at(-1)?.preview : null;
  const layers = preview?.type === "agent-description"
    ? [{ position: "top-right", node: agentDescriptionPreview(preview.description) }]
    : [];
  return view.overlay({ fill: true, layers }, [body]);
}
