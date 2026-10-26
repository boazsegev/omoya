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

/** Keep a label on one row, clipping the tail when it outgrows the width. */
function clipEnd(text, width) {
  if (displayWidth(text) <= width) return text;
  const parts = graphemes(text);
  const result = [];
  let used = 0;
  for (const glyph of parts) {
    const size = graphemeWidth(glyph) || 1;
    if (used + size > width - 1) break;
    result.push(glyph);
    used += size;
  }
  return result.join("") + "…";
}

/** Keep a label on one row while preserving identifying prefixes and suffixes. */
function clipMiddle(text, width) {
  if (displayWidth(text) <= width) return text;
  const parts = graphemes(text);
  const take = (glyphs, limit) => {
    const result = [];
    let used = 0;
    for (const glyph of glyphs) {
      const size = graphemeWidth(glyph) || 1;
      if (used + size > limit) break;
      result.push(glyph);
      used += size;
    }
    return result;
  };
  const head = Math.ceil((width - 1) / 2);
  return take(parts, head).join("") + "…" + take(parts.toReversed(), width - head - 1).toReversed().join("");
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
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return items;
  return (node.searchItems ?? items).filter((item) => {
    if (item.kind === "header" || item.kind === "info") return false;
    if (item.alwaysVisible === true) return true;
    const fields = [item.label, item.note, item.hint, item.description, item.decription];
    return terms.every((term) => fields.some((value) => String(value ?? "").toLowerCase().includes(term)));
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
export function menuItemRows(item, boxW, { labelOverflow } = {}) {
  const description = item?.description ?? item?.decription;
  let rows = description ? 2 : 1;
  if (labelOverflow !== "clip-middle" && labelOverflow !== "clip-end" && boxW > 0 && item && item.kind !== "header" && item.kind !== "info") {
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
  const itemHeight = (item) => menuItemRows(item, box.w, node);
  const selectedRow = list.slice(0, state.index).reduce((rows, item) => rows + itemHeight(item), 0);
  const totalRows = list.reduce((rows, item) => rows + itemHeight(item), 0);
  const startRow = clamp(selectedRow - Math.floor(body.h / 2), 0, Math.max(0, totalRows - body.h));
  // The note column never exceeds the box; a note that cannot fit whole is
  // clipped with an ellipsis (dropped when even that leaves nothing readable).
  const noteColumn = Math.min(box.w, 3 + list.reduce((width, item) => Math.max(width, displayWidth(String(item.label ?? ""))), 0) + 3);
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
      const header = clipEnd(` ${item.label ?? ""} `, box.w);
      const rule = "─".repeat(Math.max(0, box.w - displayWidth(header)));
      drawMenuLine(canvas, box, row, header + rule, "menu.header");
    } else {
      const role = item.kind === "info" ? "menu.footer" : selected ? `${item.role ?? "menu.text"} menu.selected` : item.role ?? "menu.text";
      // The label soft-WRAPS at the box width (a menu row never clips
      // mid-text); continuation rows indent under the text start, past
      // the selector and any leading "[ ] "/"( ) " marker.
      const markerIndent = 3 + leadingMarkerWidth(itemLabel);
      const clip = node.labelOverflow === "clip-middle" ? clipMiddle : node.labelOverflow === "clip-end" ? clipEnd : null;
      const wrapped = clip
        ? [`${selected ? " ❯ " : "   "}${clip(itemLabel, Math.max(1, box.w - 3))}`]
        : wrapMenuLabel(`${selected ? " ❯ " : "   "}${itemLabel}`, box.w, markerIndent);
      // The note sits on the FIRST row, right-aligned after the widest label.
      // Placement measures the rendered first line (not the raw label, which
      // may wrap), so wrapped or clipped labels never push the note off-row.
      let suffix = "";
      if (note != null && note !== "") {
        const firstWidth = displayWidth(wrapped[0]);
        const column = Math.min(box.w, Math.max(firstWidth + 3, noteColumn));
        const available = box.w - column;
        if (available >= 4) suffix = `${" ".repeat(column - firstWidth)}${clipEnd(String(note), available)}`;
      }
      wrapped.forEach((line, offset) => {
        if (visibleRow + offset >= 0 && visibleRow + offset < body.h) {
          drawMenuLine(canvas, box, row + offset, offset === 0 ? `${line}${suffix}` : line, role, selected && offset === 0);
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

