// Controlled input rendering, wrapping, caret mapping, and completions.
import { displayWidth, graphemes, graphemeWidth, wrapWordsOffsets } from "../width.js";
import { reorderBidiTokens } from "../bidi.js";
import { clamp, orderedSelection, drawMenuLine } from "./helpers.js";
export const COMPLETION_ROWS = 6;

/**
 * Lay out an input value into wrapped rows using its margins and width.
 * @param {object} node - Input node; margin defaults to 2 and is clamped.
 * @param {number} width - Outer control width.
 * @returns {{margin:number,textWidth:number,rows:object[]}} Geometry and source-offset row records.
 */
export function inputRows(node, width) {
  // Text starts after the left margin and must also stop before the right
  // margin. This geometry is the single input layout source for wrapping,
  // caret movement, natural height, and pointer mapping.
  const margin = clamp(Number(node.margin ?? 2), 0, Math.floor(width / 2));
  const textWidth = Math.max(1, width - margin * 2);
  const value = String(node.value ?? "");
  const rows = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    const parts = line === "" ? [{ text: "", start: 0, end: 0 }] : wrapWordsOffsets(line, textWidth);
    for (const part of parts) rows.push({ text: part.text, start: offset + part.start, end: offset + part.end });
    offset += line.length + 1;
  }
  return { margin, textWidth, rows };
}

/**
 * Convert a logical input row into display-ordered bidi grapheme tokens.
 * @param {object} row - Row with text and source start offset.
 * @returns {object[]} Reordered tokens with text and source offsets.
 */
export function visualInputRow(row) {
  let index = row.start;
  const logical = graphemes(row.text).map((text) => {
    const token = { text, start: index, end: index + text.length };
    index += text.length;
    return token;
  });
  return reorderBidiTokens(logical);
}

/**
 * Map a logical caret offset to its visual display column within a row.
 * @param {object} row - Wrapped input row.
 * @param {number} caret - Logical UTF-16 offset.
 * @returns {number} Display column.
 */
function inputCaretColumn(row, caret) {
  const visual = visualInputRow(row);
  let column = 0;
  const positions = new Map();
  for (let index = 0; index < visual.length; index++) {
    const token = visual[index];
    const width = graphemeWidth(token.text) || 1;
    const previous = visual[index - 1];
    const next = visual[index + 1];
    const reversed = (previous && previous.start > token.start) || (next && token.start > next.start);
    if (reversed) {
      if (!positions.has(token.start)) positions.set(token.start, column + width);
      positions.set(token.end, column);
    } else {
      if (!positions.has(token.start)) positions.set(token.start, column);
      positions.set(token.end, column + width);
    }
    column += width;
  }
  return positions.get(caret) ?? displayWidth(row.text.slice(0, Math.max(0, caret - row.start)));
}

/**
 * A bounded completion menu. The selected item remains visible while
 * the candidate list scrolls; one overflow row reports hidden choices.
 */
export function completionWindow(items, selected, available, maximum = COMPLETION_ROWS) {
  const list = items ?? [];
  const room = Math.max(0, available);
  if (list.length === 0 || room === 0) return [];
  const limit = Math.max(1, Number(maximum) || COMPLETION_ROWS);
  let count = Math.min(list.length, limit, room);
  let showOverflow = list.length > count && room > 1;
  if (showOverflow && count === room) count--;
  const index = clamp(Number.isInteger(selected) ? selected : 0, 0, list.length - 1);
  const start = clamp(index - 2, 0, Math.max(0, list.length - count));
  const rows = list.slice(start, start + count).map((item, offset) => ({
    kind: "item", item, index: start + offset, selected: start + offset === index,
  }));
  showOverflow = list.length > count;
  if (showOverflow && rows.length < room) {
    rows.push({ kind: "more", before: start, after: Math.max(0, list.length - start - count) });
  }
  return rows;
}

/**
 * Render an input control, register pointer targets, and update caret/layout state.
 * @param {object} canvas - Render canvas with put() and caret storage.
 * @param {object} node - Input node and presentation settings.
 * @param {object} box - Control rectangle.
 * @param {Function} register - Receives interactive target descriptors.
 * @param {object} state - Mutable per-input viewport and paste state.
 * @returns {void} Mutates canvas, state, and target registrations.
 */
export function drawInput(canvas, node, box, register, state) {
  const topRole = node.active ? "input.border.active.top" : "input.border";
  const bottomRole = node.active ? "input.border.active.bottom" : "input.border";
  for (let x = 0; x < Math.max(0, box.w - 1); x++) canvas.put(box.x + x, box.y, "─", { role: topRole });

  const layout = inputRows(node, box.w);
  const caret = clamp(Number.isInteger(node.caret) ? node.caret : String(node.value ?? "").length, 0, String(node.value ?? "").length);
  const selection = orderedSelection(node.selection);
  const cursorRow = Math.max(0, layout.rows.findIndex(({ start, end }) => caret >= start && caret <= end));
  // Preserve one editable row and both borders first. Completion choices
  // consume only the remaining rows and never paint through the status
  // node below this control.
  const completionRows = completionWindow(node.completions, node.completionIndex, Math.max(0, box.h - 3), node.maxCompletionRows);
  // A squeezed box keeps the input compact: the borders hug the visible
  // rows, never leaving an empty gap that reads as stray line noise.
  const textRoom = Math.max(1, box.h - 2 - completionRows.length);
  const maxRows = Math.max(1, Math.min(Number(node.maxRows ?? 8), layout.rows.length, textRoom, box.h - 2));
  const maxStart = Math.max(0, layout.rows.length - maxRows);
  // Keep the caret in view after edits, but let wheel gestures browse the
  // draft independently until the caret or value changes again.
  if (state.inputValue !== node.value || state.inputCaret !== caret || state.inputRows !== maxRows) {
    state.inputStart = clamp(cursorRow - maxRows + 1, 0, maxStart);
  }
  state.inputValue = node.value;
  state.inputCaret = caret;
  state.inputRows = maxRows;
  state.inputStart = clamp(state.inputStart ?? 0, 0, maxStart);
  const windowStart = state.inputStart;
  layout.rows.slice(windowStart, windowStart + maxRows).forEach((row, visibleRow) => {
    let x = box.x + layout.margin;
    const tokens = visualInputRow(row);
    for (const token of tokens) {
      const role = selection && token.start >= selection.start && token.start < selection.end ? "input.selection" : "input.text";
      x += canvas.put(x, box.y + 1 + visibleRow, token.text, { role, inputIndex: token.start });
    }
    register({ kind: "input", target: node.id, box: { x: box.x, y: box.y + 1 + visibleRow, w: box.w, h: 1 }, row, tokens, margin: layout.margin });
  });
  // `placeholder`: muted hint text on an EMPTY input's first row, under the
  // caret. Presentation only — it is never part of the value or its indexes.
  if (String(node.value ?? "") === "" && typeof node.placeholder === "string" && node.placeholder !== "") {
    let x = box.x + layout.margin;
    for (const glyph of graphemes(node.placeholder)) {
      if (x + graphemeWidth(glyph) > box.x + box.w - 1) break;
      x += canvas.put(x, box.y + 1, glyph, { role: "muted" });
    }
  }
  const current = layout.rows[cursorRow] ?? { start: 0, text: "" };
  const caretColumn = layout.margin + inputCaretColumn(current, caret);
  // Cursor presentation is an input concern, while the host owns the
  // terminal protocol. Default to a line cursor with a 450 ms blinking
  // half-period; `cursor` may override `{shape, blinkMs}`.
  const requestedCursor = node.cursor && typeof node.cursor === "object" ? node.cursor : {};
  if (cursorRow >= windowStart && cursorRow < windowStart + maxRows) canvas.caret = {
    id: node.id ?? null, index: caret, row: box.y + 1 + cursorRow - windowStart, column: box.x + caretColumn,
    cursor: { shape: requestedCursor.shape ?? "line", blinkMs: requestedCursor.blinkMs ?? 450 },
  };

  const bottom = box.y + 1 + maxRows;
  for (let x = 0; x < Math.max(0, box.w - 1); x++) canvas.put(box.x + x, bottom, "─", { role: bottomRole });
  const completionTop = bottom + 1;
  completionRows.forEach((row, visibleIndex) => {
    const line = completionTop + visibleIndex;
    if (row.kind === "more") {
      const before = row.before > 0 ? `${row.before} above` : "";
      const after = row.after > 0 ? `${row.after} below` : "";
      drawMenuLine(canvas, { x: box.x, y: line, w: box.w, h: 1 }, 0, `  … ${[before, after].filter(Boolean).join(" · ")}`, "completion.text");
      return;
    }
    const value = typeof row.item === "string" ? row.item : String(row.item.label ?? row.item.value ?? "");
    drawMenuLine(canvas, { x: box.x, y: line, w: box.w, h: 1 }, 0, `  ${value}`, row.selected ? "completion.selected" : "completion.text", row.selected);
    register({ kind: "completion", target: node.id, item: row.item, index: row.index, box: { x: box.x, y: line, w: box.w, h: 1 } });
  });
}

