// Menu filtering, item layout, viewport frames, and rendering.
import { displayWidth, graphemes, graphemeWidth } from "../width.js";
import { clamp, drawMenuLine } from "./helpers.js";
/**
 * Word-break characters for the menu label wrap (whitespace plus the
 * usual punctuation a label can break after).
 */
const MENU_WRAP_CHARS = /[\s\u2010-\u2015\/\\.,;:()&&[\]{}'"'‘’“”]/;

/**
 * Soft-wrap a menu label to the box width at word boundaries; the
 * continuation rows indent under the text start (past the selector
 * and any marker), never under the glyphs.
 */
function wrapMenuLabel(text, width, indent) {
  const source = String(text ?? "");
  if (width <= 0) return [""];
  const lines = [];
  let rest = source;
  let first = true;
  while (rest !== "") {
    const limit = first ? width : Math.max(1, width - indent);
    if (displayWidth(rest) <= limit) { lines.push((first ? "" : " ".repeat(indent)) + rest); break; }
    let used = 0;
    let cut = 0;
    let lastBreak = -1;
    for (const g of graphemes(rest)) {
      const w = graphemeWidth(g) || 1;
      if (used + w > limit) break;
      used += w;
      cut += g.length;
      if (MENU_WRAP_CHARS.test(g)) lastBreak = cut;
    }
    if (lastBreak > 0) cut = lastBreak;
    if (cut === 0) { // no grapheme fits (degenerate narrow box): force one
      const g = graphemes(rest)[0] ?? "";
      cut = g.length || rest.length;
    }
    lines.push((first ? "" : " ".repeat(indent)) + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    first = false;
  }
  return lines;
}

/**
 * Return menu items matching the current query, unless filtering is disabled.
 * @param {object} state - Menu state containing query.
 * @param {object} node - Menu node and item list.
 * @returns {object[]} Matching menu items; headers/info are excluded during filtering.
 */
export function filteredMenu(state, node) {
  const items = node.items ?? [];
  if (node.filter === false) return items;
  const query = state.query ?? String(node.query ?? "");
  return query === "" ? items : items.filter((item) => {
    if (item.kind === "header" || item.kind === "info") return false;
    return [item.label, item.note, item.hint, item.description, item.decription]
      .some((value) => String(value ?? "").toLowerCase().includes(query.toLowerCase()));
  });
}

/**
 * Determine whether a menu item can be selected.
 * @param {?object} item - Candidate menu item.
 * @returns {boolean} False for missing, header, info, or explicitly disabled items.
 */
export function selectable(item) {
  return item && item.kind !== "header" && item.kind !== "info" && item.disabled !== true;
}

/**
 * Advance the menu index in a direction, skipping unselectable items.
 * @param {object} state - Mutable menu state whose index is updated.
 * @param {object[]} list - Menu items.
 * @param {number} direction - Usually -1 or 1; wraps around the list.
 * @returns {void} Mutates state only when list is nonempty.
 */
export function moveMenuSelection(state, list, direction) {
  if (list.length === 0) return;
  for (let count = 0; count < list.length; count++) {
    state.index = ((Number.isInteger(state.index) ? state.index : 0) + direction + list.length) % list.length;
    if (selectable(list[state.index])) break;
  }
}

/**
 * Rows one menu item occupies: a description adds a row, and a label
 * that outgrows the width SOFT-WRAPS (continuation indented under the
 * text start).
 */
export function menuItemRows(item, boxW) {
  const description = item?.description ?? item?.decription;
  let rows = description ? 2 : 1;
  if (boxW > 0 && item && item.kind !== "header" && item.kind !== "info") {
    const label = `   ${item.label ?? ""}`; // the " ❯ " selector width
    const indent = 3 + leadingMarkerWidth(String(item.label ?? ""));
    rows += wrapMenuLabel(label, boxW, indent).length - 1;
  }
  return rows;
}

/**
 * The leading "[ ] "/"( ) "-style marker's display width (0 when the
 * label starts with text).
 */
function leadingMarkerWidth(label) {
  const m = /^(\S+ )/.exec(label);
  return m && /^[([{][^([{]{0,4}[)\]}] $/.test(m[1]) ? displayWidth(m[1]) : 0;
}

/**
 * Draw title/footer rows and return the inner viewport.
 * @param {object} canvas - Render canvas.
 * @param {object} box - Outer rectangle.
 * @param {{title:string,footer:string}} param2 - Frame labels.
 * @returns {object} Content viewport rectangle.
 */
export function drawViewportFrame(canvas, box, { title, footer }) {
  drawMenuLine(canvas, box, 0, title, "menu.title", true);
  drawMenuLine(canvas, box, box.h - 1, footer, "menu.footer", true);
  return { x: box.x, y: box.y + 2, w: box.w, h: Math.max(1, box.h - 3) };
}

/**
 * Render a menu, update filtering/selection state, and register selectable targets.
 * @param {object} canvas - Render canvas.
 * @param {object} node - Menu node.
 * @param {object} box - Menu rectangle.
 * @param {object} state - Mutable menu query and selection state.
 * @param {Function} register - Receives item targets.
 * @returns {void} Mutates canvas, state, and registrations.
 */
export function drawMenu(canvas, node, box, state, register) {
  const menuToken = node.stateKey ?? node.title ?? "Menu";
  if (state.menuToken !== menuToken) {
    state.menuToken = menuToken;
    state.query = String(node.query ?? "");
    state.index = Number.isInteger(node.initialIndex) ? node.initialIndex : null;
  }
  const list = filteredMenu(state, node);
  state.index = clamp(Number.isInteger(state.index) ? state.index : list.findIndex(selectable), 0, Math.max(0, list.length - 1));
  const name = node.title ?? "Menu";
  const filtering = node.filter !== false;
  const title = filtering && state.query ? ` ${name} — filter: ${state.query} ` : ` ${name} `;
  const action = node.submitOnEnter ? "Enter submit" : "Enter select";
  const footer = filtering
    ? (state.query
      ? ` ↑ ↓ navigate · ${action} · Backspace edit · Esc close`
      : ` ↑ ↓ navigate · ${action} · type to filter · click/wheel work too · q / esc close`)
    : ` ↑ ↓ navigate · ${node.selectOnSpace ? "Space toggle · " : ""}${action} · Esc close`;
  const body = drawViewportFrame(canvas, box, { title, footer });
  const itemHeight = (item) => menuItemRows(item, box.w);
  const selectedRow = list.slice(0, state.index).reduce((rows, item) => rows + itemHeight(item), 0);
  const totalRows = list.reduce((rows, item) => rows + itemHeight(item), 0);
  const startRow = clamp(selectedRow - Math.floor(body.h / 2), 0, Math.max(0, totalRows - body.h));
  const noteColumn = 3 + list.reduce((width, item) => Math.max(width, displayWidth(String(item.label ?? ""))), 0) + 3;
  let logicalRow = 0;

  list.forEach((item, index) => {
    const height = itemHeight(item);
    const visibleRow = logicalRow - startRow;
    logicalRow += height;
    if (visibleRow + height <= 0 || visibleRow >= body.h) return;
    const row = body.y - box.y + visibleRow;
    const note = item.note ?? item.hint;
    const selected = index === state.index && selectable(item);
    const itemLabel = String(item.label ?? "");
    if (item.kind === "header") {
      const header = ` ${item.label ?? ""} `;
      const rule = "─".repeat(Math.max(0, box.w - displayWidth(header)));
      drawMenuLine(canvas, box, row, header + rule, "menu.header");
    } else {
      const role = item.kind === "info" ? "menu.footer" : selected ? `${item.role ?? "menu.text"} menu.selected` : item.role ?? "menu.text";
      // The label soft-WRAPS at the box width (a menu row never clips
      // mid-text); continuation rows indent under the text start, past
      // the selector and any leading "[ ] "/"( ) " marker. A note/hint
      // stays on the FIRST row, right-aligned after the widest label.
      const markerIndent = 3 + leadingMarkerWidth(itemLabel);
      const wrapped = wrapMenuLabel(`${selected ? " ❯ " : "   "}${itemLabel}`, box.w, markerIndent);
      const gap = note == null || note === "" ? "" : `${" ".repeat(Math.max(3, noteColumn - 3 - displayWidth(itemLabel)))}${note}`;
      wrapped.forEach((line, offset) => {
        if (visibleRow + offset >= 0 && visibleRow + offset < body.h) {
          drawMenuLine(canvas, box, row + offset, offset === 0 ? `${line}${gap}` : line, role, selected && offset === 0);
        }
      });
      const description = item.description ?? item.decription;
      if (description && visibleRow + wrapped.length >= 0 && visibleRow + wrapped.length < body.h) {
        drawMenuLine(canvas, box, row + wrapped.length, `     ${description}`, "menu.footer", selected);
      }
    }
    register({ kind: "menu.item", target: node.id, item, index, box: { x: box.x, y: box.y + row, w: box.w, h: height } });
  });

  if (list.length === 0) drawMenuLine(canvas, box, body.y - box.y, "   (no matches — Backspace edits the filter, Esc closes)", "menu.footer");
}

