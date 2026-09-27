import { displayWidth, graphemes, graphemeWidth, wrapWordsOffsets } from "./width.js";
import { reorderBidiTokens } from "./bidi.js";
import { ALT, CTRL, META, SHIFT, createKeybindings, keyInfo, matchesBinding } from "./keymap.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isWord = (character) => /[\p{L}\p{N}_]/u.test(character ?? "");
const PASTE_COLLAPSE_THRESHOLD = 2048;
const PAGE_OVERLAP_ROWS = 5;
const COMPLETION_ROWS = 6;
const INPUT_HISTORY_LIMIT = 20;
const MULTI_CLICK_MS = 500;
const CLICK_DRAG_THRESHOLD = 1;

function movedBeyondClickThreshold(drag, point) {
  if (Number.isInteger(point.index)) return Math.abs(point.index - drag.index) > CLICK_DRAG_THRESHOLD;
  if (!Number.isFinite(drag.origin?.x) || !Number.isFinite(drag.origin?.y) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return true;
  return Math.abs(point.x - drag.origin.x) > CLICK_DRAG_THRESHOLD || Math.abs(point.y - drag.origin.y) > CLICK_DRAG_THRESHOLD;
}

function orderedSelection(selection) {
  if (!selection || selection.anchor === selection.caret) return null;
  return selection.anchor < selection.caret
    ? { start: selection.anchor, end: selection.caret }
    : { start: selection.caret, end: selection.anchor };
}

function replaceRange(value, selection, caret, inserted) {
  const range = orderedSelection(selection) ?? { start: caret, end: caret };
  return { value: value.slice(0, range.start) + inserted + value.slice(range.end), caret: range.start + inserted.length, selection: null };
}

function collapsePaste(node, state, text) {
  const value = String(node.value ?? "");
  const caret = clamp(Number.isInteger(node.caret) ? node.caret : value.length, 0, value.length);
  let placeholder;
  do {
    const lines = text.split("\n").length;
    placeholder = `[Pasted ${lines} line${lines === 1 ? "" : "s"} #${++state.pasteCounter}]`;
  } while (value.includes(placeholder));
  state.pastes.set(placeholder, text);
  return replaceRange(value, node.selection ?? null, caret, placeholder);
}

function expandPastes(value, pastes) {
  let expanded = value;
  for (const [placeholder, text] of pastes) expanded = expanded.split(placeholder).join(text);
  return expanded;
}

function previousGrapheme(value, caret) {
  let previous = 0;
  let offset = 0;
  for (const part of graphemes(value)) {
    offset += part.length;
    if (offset >= caret) return previous;
    previous = offset;
  }
  return previous;
}

function nextGrapheme(value, caret) {
  let offset = 0;
  for (const part of graphemes(value)) {
    offset += part.length;
    if (offset > caret) return offset;
  }
  return value.length;
}

function wordLeft(value, caret) {
  let next = caret;
  while (next > 0 && !isWord(value[next - 1])) next--;
  while (next > 0 && isWord(value[next - 1])) next--;
  return next;
}

function wordRight(value, caret) {
  let next = caret;
  // Match terminal/editor Option+Right semantics: cross separators first,
  // then advance through the following word to its end. At a position inside
  // a word this naturally advances to that word's end.
  while (next < value.length && !isWord(value[next])) next++;
  while (next < value.length && isWord(value[next])) next++;
  return next;
}

function wordEnd(value, caret) {
  let next = caret;
  while (next < value.length && isWord(value[next])) next++;
  return next;
}

function clickSelection(value, caret, count) {
  if (count >= 3) return { anchor: lineBoundary(value, caret, false), caret: lineBoundary(value, caret, true) };
  if (count !== 2 || value.length === 0) return null;
  const index = Math.min(caret, value.length - 1);
  const word = isWord(value[index]);
  let start = index;
  let end = index + 1;
  while (start > 0 && isWord(value[start - 1]) === word && value[start - 1] !== "\n") start--;
  while (end < value.length && isWord(value[end]) === word && value[end] !== "\n") end++;
  return { anchor: start, caret: end };
}

function lineBoundary(value, caret, end) {
  if (end) {
    const newline = value.indexOf("\n", caret);
    return newline < 0 ? value.length : newline;
  }
  return value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
}

function vertical(value, caret, direction, width) {
  const rows = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    const parts = line === "" ? [{ text: "", start: 0, end: 0 }] : wrapWordsOffsets(line, Math.max(1, width));
    for (const part of parts) rows.push({ start: offset + part.start, end: offset + part.end, text: part.text });
    offset += line.length + 1;
  }
  let row = rows.findIndex(({ start, end }) => caret >= start && caret <= end);
  if (row < 0) row = rows.length - 1;
  const target = row + direction;
  if (target < 0 || target >= rows.length) return null;
  const column = displayWidth(value.slice(rows[row].start, caret));
  let used = 0;
  let index = rows[target].start;
  for (const grapheme of graphemes(rows[target].text)) {
    const size = graphemeWidth(grapheme) || 1;
    if (used + size > column) break;
    used += size;
    index += grapheme.length;
  }
  return index;
}

function extendSelection(selection, oldCaret, caret) {
  const anchor = selection?.anchor ?? oldCaret;
  return anchor === caret ? null : { anchor, caret };
}

/** Word-break characters for the menu label wrap (whitespace plus the
 *  usual punctuation a label can break after). */
const MENU_WRAP_CHARS = /[\s\u2010-\u2015\/\\.,;:()&&[\]{}'"'‘’“”]/;

/** Soft-wrap a menu label to the box width at word boundaries; the
 *  continuation rows indent under the text start (past the selector
 *  and any marker), never under the glyphs. */
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

/** Declarative shared text-editing semantics for EVERY GTUI input control:
 *  the generic/common keybindings for moving between words, lines, and
 *  paragraphs, selecting them, and deleting by grapheme/word/line — every
 *  input is a small TEXT EDITOR, so an active SELECTION behaves like one:
 *  typing/paste/Enter replaces it, Backspace/Delete remove it, and any
 *  plain (non-Shift) move drops it — a DIRECTIONAL move (Left/Right,
 *  word, vertical) collapses to the selection's edge on the side the
 *  key walks toward, an ABSOLUTE move (Home/End, Ctrl+A/E, Cmd+Up/Down)
 *  goes to the position it names; the caret never lands inside the
 *  selection it just dropped. Each
 *  entry matches a message through keymap.js's matchesBinding — the same
 *  normalized-key matching an app's bindings(model) arrays use — so the
 *  effective dispatch order stays: the app's user keybinding maps first,
 *  then this GTUI map for the input's state, then nothing (terminal
 *  default behavior). Readline/Emacs aliases (Ctrl+A/E/K/U, Alt+B/F/D) and
 *  the macOS kitty-protocol Cmd+arrow conventions sit next to the plain
 *  arrows because every input is a small text editor.
 *
 *  Entry contract: run(context) returns an edit {value, caret, selection}
 *  (or {submit, value}); returning the sentinel BUBBLE declines the key so
 *  later entries — and finally the application — see it. */
const BUBBLE = Symbol("GTUI.controls.editing.bubble");
/** The collapse target a plain (non-Shift) move lands on when a
 *  selection is active. A move is either DIRECTIONAL (Left/Right,
 *  word, vertical: walks toward a side — collapses to the selection's
 *  OWN edge on that side) or ABSOLUTE (Home/End, Ctrl+A/E, Cmd+Up/Down:
 *  names a position — goes THERE, deselecting). Either way the caret
 *  never lands INSIDE the selection it just dropped. */
function collapseTarget(selection, caret, targetCaret, side) {
  const range = orderedSelection(selection);
  if (!range) return targetCaret;
  if (side === "start") return range.start;
  if (side === "end") return range.end;
  return targetCaret;
}

const move = (keys, target, side = null) => ({
  keys,
  run({ value, caret, selection, shift, width }) {
    const targetCaret = target({ value, caret, width });
    // An unhandled boundary (vertical movement past the first/last visual
    // row) bubbles so app policy — history browsing, scroll paging — can run.
    if (targetCaret === null) return BUBBLE;
    const nextCaret = shift ? targetCaret : collapseTarget(selection, caret, targetCaret, side);
    return { value, caret: nextCaret, selection: shift ? extendSelection(selection, caret, nextCaret) : null };
  },
});
/** Plain Left/Right with an active selection collapse to its sides — the
 *  universal editor gesture — instead of stepping one grapheme from the
 *  caret (which would land INSIDE the selection). The selection's origin
 *  is the caret, so the collapse side follows anchor/caret, matching what
 *  the mouse and Shift-moves produce. */
const collapse = (keys, side) => ({
  keys,
  run({ value, caret, selection }) {
    const range = orderedSelection(selection);
    if (range) return { value, caret: side === "start" ? range.start : range.end, selection: null };
    const nextCaret = side === "start" ? previousGrapheme(value, caret) : nextGrapheme(value, caret);
    return { value, caret: nextCaret, selection: null };
  },
});
const remove = (keys, range) => ({
  keys,
  run({ value, caret, selection }) {
    if (orderedSelection(selection)) return replaceRange(value, selection, caret, "");
    const result = range({ value, caret });
    if (result === BUBBLE) return BUBBLE;
    const { start = caret, end = caret } = result;
    return { value: value.slice(0, start) + value.slice(end), caret: start, selection: null };
  },
});
const EDITING_KEYS = [
  // Character (grapheme) movement; plain arrows collapse a selection.
  move(["left"], ({ value, caret }) => previousGrapheme(value, caret), "start"),
  move(["right"], ({ value, caret }) => nextGrapheme(value, caret), "end"),
  move(["shift+left"], ({ value, caret }) => previousGrapheme(value, caret)),
  move(["shift+right"], ({ value, caret }) => nextGrapheme(value, caret)),
  // Word movement (+ Shift selects); Alt+B/F are the common ESC-b/f encodings.
  move(["alt+left", "alt+b"], ({ value, caret }) => wordLeft(value, caret), "start"),
  move(["alt+right", "alt+f"], ({ value, caret }) => wordRight(value, caret), "end"),
  move(["alt+shift+left", "alt+shift+b"], ({ value, caret }) => wordLeft(value, caret)),
  move(["alt+shift+right", "alt+shift+f"], ({ value, caret }) => wordRight(value, caret)),
  // Line (paragraph) boundaries: Home/End, readline Ctrl+A/E, Ctrl+arrows,
  // and macOS Cmd+Left/Right on kitty-protocol terminals.
  move(["home", "ctrl+left", "meta+left"], ({ value, caret }) => lineBoundary(value, caret, false)),
  move(["end", "ctrl+right", "meta+right"], ({ value, caret }) => lineBoundary(value, caret, true)),
  move(["shift+home", "ctrl+shift+left", "meta+shift+left"], ({ value, caret }) => lineBoundary(value, caret, false)),
  move(["shift+end", "ctrl+shift+right", "meta+shift+right"], ({ value, caret }) => lineBoundary(value, caret, true)),
  // Vertical movement over visual (wrapped) rows; bubbles at the boundary.
  move(["up"], ({ value, caret, width }) => vertical(value, caret, -1, width), "start"),
  move(["down"], ({ value, caret, width }) => vertical(value, caret, 1, width), "end"),
  move(["shift+up"], ({ value, caret, width }) => vertical(value, caret, -1, width) ?? caret),
  move(["shift+down"], ({ value, caret, width }) => vertical(value, caret, 1, width) ?? caret),
  // Whole-input boundaries: macOS Cmd+Up/Down.
  move(["meta+up"], () => 0),
  move(["meta+down"], ({ value }) => value.length),
  move(["meta+shift+up"], () => 0),
  move(["meta+shift+down"], ({ value }) => value.length),
  // Deletion: grapheme, word (Alt), forward word (Alt+D / readline),
  // line (Ctrl+Backspace / Ctrl+W), kill line to end/start (Ctrl+K/U).
  remove(["backspace"], ({ value, caret }) => ({ start: previousGrapheme(value, caret) })),
  remove(["shift+backspace"], ({ value, caret }) => ({ start: previousGrapheme(value, caret) })),
  remove(["delete"], ({ value, caret }) => ({ end: nextGrapheme(value, caret) })),
  remove(["ctrl+d"], ({ value, caret }) => value === "" ? BUBBLE : { end: nextGrapheme(value, caret) }),
  remove(["alt+backspace"], ({ value, caret }) => ({ start: wordLeft(value, caret) })),
  remove(["alt+delete"], ({ value, caret }) => ({ end: wordRight(value, caret) })),
  remove(["alt+d"], ({ value, caret }) => ({ end: wordEnd(value, caret) })),
  remove(["ctrl+backspace", "ctrl+w"], ({ value, caret }) => ({ start: lineBoundary(value, caret, false), end: lineBoundary(value, caret, true) })),
  remove(["ctrl+k"], ({ value, caret }) => ({ end: lineBoundary(value, caret, true) })),
  remove(["ctrl+u"], ({ value, caret }) => ({ start: lineBoundary(value, caret, false) })),
  // Readline line-boundary moves, matching the Home/End entries but
  // declared AFTER the readline deletions above so a bare Ctrl+A/E
  // moves while the selection-editing semantics still hold: a plain
  // (non-Shift) move collapses an active selection to its named edge,
  // never leaving the caret inside it.
  move(["ctrl+a"], ({ value, caret }) => lineBoundary(value, caret, false)),
  move(["ctrl+e"], ({ value, caret }) => lineBoundary(value, caret, true)),
  move(["ctrl+shift+a"], ({ value, caret }) => lineBoundary(value, caret, false)),
  move(["ctrl+shift+e"], ({ value, caret }) => lineBoundary(value, caret, true)),
  // Enter submits; Shift/Alt+Enter insert a soft line break.
  { keys: ["enter"], run: ({ value }) => ({ submit: true, value }) },
  { keys: ["shift+enter", "alt+enter"], run: ({ value, caret, selection }) => replaceRange(value, selection, caret, "\n") },
];
const compileEditingMap = (name, entries) => Object.freeze(entries.map((entry) => Object.freeze({
  keys: entry.keys, context: createKeybindings(name, entry.keys), run: entry.run,
})));
// Unselected input bindings. This is immutable declarative input policy,
// rather than per-screen shortcuts, so every input control gets identical
// editor behavior.
const EDITING_MAP = compileEditingMap("GTUI.editing", EDITING_KEYS);
// Selected input has its own immutable key map and takes precedence. Its
// handlers deliberately share the elementary edit operations above: those
// operations replace/delete/collapse the selected range, whereas the normal
// map moves or deletes adjacent text. Keeping the dispatch maps distinct
// makes the selected-state contract explicit without duplicating mechanics.
const SELECTED_EDITING_MAP = compileEditingMap("GTUI.editing.selected", EDITING_KEYS);

function editingContext(node) {
  const value = String(node.value ?? "");
  const caret = clamp(Number.isInteger(node.caret) ? node.caret : value.length, 0, value.length);
  const selection = node.selection ?? null;
  return { value, caret, selection };
}

// A text edit coalesces when the old value can be split into a constant
// prefix/postfix around precisely one newly inserted non-whitespace grapheme.
// This deliberately does not coalesce whitespace, deletions, replacements, or
// multi-grapheme input: each is a meaningful undo boundary.
function isSingleWordInsertion(before, after) {
  if (after.length <= before.length) return false;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  const postfixLength = before.length - prefix;
  if (!after.endsWith(before.slice(prefix))) return false;
  const inserted = after.slice(prefix, after.length - postfixLength);
  return graphemes(inserted).length === 1 && !/\s/u.test(inserted);
}

function inputEdit(node, message, width) {
  const context = editingContext(node);
  const { value, caret, selection } = context;
  if (message.type === "paste") return replaceRange(value, selection, caret, String(message.text ?? ""));
  if (message.type !== "key") return null;
  if (typeof message.text === "string" && message.text !== "") return replaceRange(value, selection, caret, message.text);

  const info = keyInfo(message);
  if (!info) return null;
  const shift = Boolean(info.modifiers & SHIFT);
  // A selected range is a distinct editor state. Consult its binding map
  // first; if it declines a boundary key, the ordinary input policy (and
  // then application bindings) retains its normal chance to handle it.
  const maps = orderedSelection(selection) ? [SELECTED_EDITING_MAP, EDITING_MAP] : [EDITING_MAP];
  for (const map of maps) for (const entry of map) {
    if (!matchesBinding(entry.context, message)) continue;
    // A BUBBLE result declines the key for THIS entry only; a later entry
    // may still claim it, and otherwise the key reaches the application
    // (terminal default behavior).
    const edit = entry.run({ ...context, shift, width });
    if (edit === BUBBLE || edit === undefined) continue;
    return edit;
  }
  return null;
}

function inputRows(node, width) {
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

function visualInputRow(row) {
  let index = row.start;
  const logical = graphemes(row.text).map((text) => {
    const token = { text, start: index, end: index + text.length };
    index += text.length;
    return token;
  });
  return reorderBidiTokens(logical);
}

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

/** A bounded completion menu. The selected item remains visible while
 * the candidate list scrolls; one overflow row reports hidden choices. */
function completionWindow(items, selected, available, maximum = COMPLETION_ROWS) {
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

/** Natural size for controls, shared with the semantic layout engine. */
export function controlNaturalSize(node, width, height) {
  if (node.type === "input") {
    const textRows = Math.min(Number(node.maxRows ?? 8), inputRows(node, width).rows.length);
    const completionRows = completionWindow(node.completions, node.completionIndex, Infinity, node.maxCompletionRows).length;
    return { w: width, h: Math.min(height, Math.max(3, textRows + 2 + completionRows)) };
  }
  if (node.type === "menu") {
    const rows = (node.items ?? []).reduce((count, item) => count + menuItemRows(item, width), 0);
    return { w: width, h: Math.min(height, Math.max(5, rows + 4)) };
  }
  if (node.type === "toolbar") {
    const items = toolbarButtons(node);
    const natural = items.reduce((sum, item) => sum + item.w, 0) + toolbarGap(node) * Math.max(0, items.length - 1);
    return { w: Math.min(width, natural), h: Math.min(height, items.length > 0 ? 1 : 0) };
  }
  return null;
}

function drawInput(canvas, node, box, register, state) {
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

function filteredMenu(state, node) {
  const items = node.items ?? [];
  if (node.filter === false) return items;
  const query = state.query ?? String(node.query ?? "");
  return query === "" ? items : items.filter((item) => {
    if (item.kind === "header" || item.kind === "info") return false;
    return [item.label, item.note, item.hint, item.description, item.decription]
      .some((value) => String(value ?? "").toLowerCase().includes(query.toLowerCase()));
  });
}

function selectable(item) {
  return item && item.kind !== "header" && item.kind !== "info" && item.disabled !== true;
}

function moveMenuSelection(state, list, direction) {
  if (list.length === 0) return;
  for (let count = 0; count < list.length; count++) {
    state.index = ((Number.isInteger(state.index) ? state.index : 0) + direction + list.length) % list.length;
    if (selectable(list[state.index])) break;
  }
}

/** Rows one menu item occupies: a description adds a row, and a label
 *  that outgrows the width SOFT-WRAPS (continuation indented under the
 *  text start). */
function menuItemRows(item, boxW) {
  const description = item?.description ?? item?.decription;
  let rows = description ? 2 : 1;
  if (boxW > 0 && item && item.kind !== "header" && item.kind !== "info") {
    const label = `   ${item.label ?? ""}`; // the " ❯ " selector width
    const indent = 3 + leadingMarkerWidth(String(item.label ?? ""));
    rows += wrapMenuLabel(label, boxW, indent).length - 1;
  }
  return rows;
}

/** The leading "[ ] "/"( ) "-style marker's display width (0 when the
 *  label starts with text). */
function leadingMarkerWidth(label) {
  const m = /^(\S+ )/.exec(label);
  return m && /^[([{][^([{]{0,4}[)\]}] $/.test(m[1]) ? displayWidth(m[1]) : 0;
}

function drawMenuLine(canvas, box, row, text, role, fill = false, meta = {}) {
  let x = box.x;
  for (const grapheme of graphemes(String(text ?? ""))) {
    const width = graphemeWidth(grapheme) || 1;
    if (x + width > box.x + box.w) break;
    const used = canvas.put(x, box.y + row, grapheme, { ...meta, role, cellWidth: width });
    if (used === 0) break;
    x += used;
  }
  if (fill) while (x < box.x + box.w) x += canvas.put(x, box.y + row, " ", { role });
}

/** A toolbar button's identity: its `id`, else its `action` — stable while
 *  its label or pressed state changes, so roving focus stays on it. */
const buttonKey = (button) => String(button.id ?? button.action ?? "");
const buttonText = (button) => ` ${button.icon ? `${button.icon} ` : ""}${button.content ?? ""} `;
const toolbarGap = (node) => Math.max(0, Number.isFinite(node.gap) ? Math.floor(node.gap) : 1);

function toolbarButtons(node) {
  return (node.children ?? []).filter((child) => child?.type === "button").map((button, index) => {
    const text = buttonText(button);
    return { button, index, key: buttonKey(button), text, w: displayWidth(text) };
  });
}

/** The buttons that fit `width`, laid out left to right. Buttons drop WHOLE,
 *  lowest `priority` first (ties drop the later one), like row children —
 *  a half-drawn button would be a click target with an unreadable label. */
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

function drawToolbar(canvas, node, box, state, register) {
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

function drawViewportFrame(canvas, box, { title, footer }) {
  drawMenuLine(canvas, box, 0, title, "menu.title", true);
  drawMenuLine(canvas, box, box.h - 1, footer, "menu.footer", true);
  return { x: box.x, y: box.y + 2, w: box.w, h: Math.max(1, box.h - 3) };
}

function drawMenu(canvas, node, box, state, register) {
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

function pointInside(point, box) {
  return point.x >= box.x && point.x < box.x + box.w && point.y >= box.y && point.y < box.y + box.h;
}

/** Host-private controlled input/menu/scroll/overlay mechanics. */
export function createControls(emit, options = {}) {
  const nodes = new Map();
  const states = new Map();
  let targets = [];
  let focused = null;
  let overlay = null;
  let keyScroll = null;
  let drag = null;
  let textSelection = null;
  let sourceSelection = null;
  let previewCells = [];
  let hoveredCells = [];
  let lastClick = null;
  let lastCanvas = null;
  let sourceItems = [];
  const stateFor = (id) => {
    if (!states.has(id)) states.set(id, {
      query: "", index: null, scroll: 0, drag: null, pastes: new Map(), pasteCounter: 0,
      undo: [], redo: [],
    });
    return states.get(id);
  };
  const register = (target) => targets.push(target);
  const scrollBar = options.scrollBar?.show === false || !options.scrollBar ? null : {
    track: options.scrollBar.track ?? "│",
    thumb: options.scrollBar.thumb ?? "█",
  };

  function scrollBarGeometry(viewport, contentHeight) {
    if (!scrollBar || contentHeight <= viewport.h || viewport.h < 3 || viewport.w < 4) return null;
    // Text has a two-cell right margin by default. Paint the bar in its
    // outermost cell instead of shrinking the viewport and changing wraps.
    return { viewport, contentHeight, trackX: viewport.x + viewport.w - 1 };
  }

  function reserveScrollBar(node, viewport) {
    return viewport;
  }

  function drawScrollBar(canvas, node, { viewport, contentHeight, maxOffset, fromTop }) {
    const frame = viewport;
    const geometry = scrollBarGeometry(frame, contentHeight);
    const trackX = geometry?.trackX;
    if (!geometry) return;
    const thumbH = clamp(Math.round((frame.h ** 2) / contentHeight), 1, frame.h);
    const position = (frame.h - thumbH) * fromTop / Math.max(1, maxOffset);
    const direction = stateFor(node.id).scrollDirection ?? 0;
    const rounded = direction > 0 ? Math.ceil(position) : direction < 0 ? Math.floor(position) : Math.round(position);
    const thumbY = frame.y + rounded;
    for (let y = frame.y; y < frame.y + frame.h; y++) {
      canvas.put(trackX, y, y >= thumbY && y < thumbY + thumbH ? scrollBar.thumb : scrollBar.track, { role: y >= thumbY && y < thumbY + thumbH ? "scroll.thumb" : "scroll.track" });
    }
    register({ kind: "scrollbar", target: node.id, box: { x: trackX, y: frame.y, w: 1, h: frame.h }, maxOffset });
  }

  function drawControl(canvas, node, box) {
    // An id-less toolbar still draws; it just cannot hold focus or route clicks.
    if (node.type === "toolbar" && !node.id) return drawToolbar(canvas, node, box, {}, () => {});
    if (!node.id) return;
    nodes.set(node.id, { node, box });
    if (node.focus) focused = node.id;
    if (node.type === "toolbar") return drawToolbar(canvas, node, box, stateFor(node.id), register);
    if (node.action) {
      register({ kind: "action", target: node.id, action: node.action, box });
      return;
    }
    if (node.type === "input") {
      const state = stateFor(node.id);
      const value = String(node.value ?? "");
      for (const placeholder of state.pastes.keys()) if (!value.includes(placeholder)) state.pastes.delete(placeholder);
      // Whole-box WHEEL target: drawInput registers one caret target per
      // TEXT row, but border rows have no target. Route wheel movement
      // there to the input's viewport (or the transcript when it fits).
      // wheel-only (never a caret press: it carries
      // no text-row geometry), and registered FIRST so the per-row caret and
      // completion targets still win under resolvePoint's reverse-order search.
      register({ kind: "input", wheelOnly: true, target: node.id, box });
      return drawInput(canvas, node, box, register, state);
    }
    if (node.type === "menu") return drawMenu(canvas, node, box, stateFor(node.id), register);
    if (node.type === "scroll") {
      const state = stateFor(node.id);
      const external = Math.max(0, Number(node.offset ?? 0) || 0);
      state.externalChanged = state.externalScroll !== external;
      if (state.externalChanged) {
        state.externalScroll = external;
        state.scroll = external;
      }
      const viewport = node.title || node.footer
        ? drawViewportFrame(canvas, box, { title: node.title ?? "", footer: node.footer ?? "" })
        : box;
      // Key scrolling uses the actual content viewport, never the outer
      // title/footer frame. A non-focused transcript may opt into Page
      // Up/Down while the editor keeps normal typing and arrow ownership.
      nodes.set(node.id, { node, box: viewport });
      if (node.keyboard === true) keyScroll = node.id;
      register({ kind: "scroll", target: node.id, box: viewport });
      return viewport;
    }
  }

  function beginFrame() {
    nodes.clear();
    targets = [];
    focused = null;
    overlay = null;
    keyScroll = null;
  }

  function syncScroll(node, contentHeight, viewportHeight) {
    const state = stateFor(node.id);
    const maxOffset = Math.max(0, contentHeight - viewportHeight);
    // An end-anchored viewport at offset 0 follows new output. Once the
    // user scrolls away, grow the distance from the end by the same amount
    // as the content so the visible historical rows stay put while tokens stream.
    if (node.anchor === "end" && !state.externalChanged && state.scroll > 0 && Number.isFinite(state.maxOffset) && maxOffset > state.maxOffset) {
      state.scroll += maxOffset - state.maxOffset;
    }
    state.scroll = clamp(state.scroll, 0, maxOffset);
    state.maxOffset = maxOffset;
    state.externalChanged = false;
    return state.scroll;
  }

  function canvasPoint(canvas, point) {
    if (point?.logical === true) return point;
    const x = clamp(Math.floor(point.x), 0, Math.max(0, canvas.width - 1));
    const y = clamp(Math.floor(point.y), 0, Math.max(0, canvas.height - 1));
    const cell = canvas.cells[y]?.[x];
    return { x, y: Number.isFinite(cell?.selectionRow) ? cell.selectionRow : y, logical: true };
  }

  function selectionBounds(canvas) {
    if (!textSelection) return null;
    const anchor = canvasPoint(canvas, textSelection.anchor);
    const caret = canvasPoint(canvas, textSelection.caret);
    const ai = anchor.y * canvas.width + anchor.x;
    const ci = caret.y * canvas.width + caret.x;
    return ai <= ci ? { start: ai, end: ci } : { start: ci, end: ai };
  }

  function pointForSource(target, offset, fallback, preferEnd = false) {
    for (let y = 0; y < (lastCanvas?.height ?? 0); y++) for (let x = 0; x < (lastCanvas?.width ?? 0); x++) {
      const cell = lastCanvas.cells[y][x];
      if (cell?.selectionKey !== target || !cell.source) continue;
      if ((!preferEnd && cell.source.start <= offset && offset < cell.source.end) ||
          (preferEnd && cell.source.start < offset && offset <= cell.source.end)) return { x, y };
    }
    return fallback;
  }

  function sourceAnchor(canvas, point) {
    if (!canvas) return null;
    const x = clamp(Math.floor(point.x), 0, Math.max(0, canvas.width - 1));
    const y = clamp(Math.floor(point.y), 0, Math.max(0, canvas.height - 1));
    const row = canvas.cells[y] ?? [];
    let cell = row[x];
    if (!cell?.selectionKey || !cell.source || cell.text === null) {
      // Clamp into text on THIS row only; an empty row must not inherit
      // the source anchor of the preceding or following visible item.
      cell = null;
      for (let index = x <= 0 ? 0 : row.length - 1; index >= 0 && index < row.length; index += x <= 0 ? 1 : -1) {
        const candidate = row[index];
        if (candidate?.selectionKey && candidate.source && candidate.text !== null) { cell = candidate; break; }
      }
    }
    if (!cell) return null;
    return { key: cell.selectionKey, start: cell.source.start, end: cell.source.end };
  }

  function captureSourceSelection() {
    const anchor = drag?.sourceAnchor ?? textSelection?.sourceAnchor;
    const caret = drag?.sourceCaret ?? textSelection?.sourceCaret;
    if (!anchor || !caret) return null;
    const anchorIndex = sourceItems.findIndex(({ key }) => key === anchor.key);
    const caretIndex = sourceItems.findIndex(({ key }) => key === caret.key);
    if (anchorIndex < 0 || caretIndex < 0) return null;
    const forward = anchorIndex < caretIndex || (anchorIndex === caretIndex && anchor.start <= caret.start);
    const firstIndex = forward ? anchorIndex : caretIndex;
    const lastIndex = forward ? caretIndex : anchorIndex;
    const isSingleItem = firstIndex === lastIndex;
    const firstOffset = isSingleItem ? (forward ? anchor.start : caret.start) : 0;
    const lastOffset = isSingleItem ? (forward ? caret.end : anchor.end) : sourceItems[lastIndex].text.length;
    return new Map(sourceItems.slice(firstIndex, lastIndex + 1).map((item, index, items) => [item.key, {
      start: index === 0 ? firstOffset : 0,
      end: index === items.length - 1 ? lastOffset : item.text.length,
    }]));
  }

  function applySelection(canvas) {
    // During an active drag, preview directly from screen coordinates. Do not
    // resolve source ranges or selected content until release.
    if (drag?.kind === "text") {
      for (const cell of previewCells) cell.role = cell.selectionBaseRole;
      previewCells = [];
      const range = selectionBounds(canvas);
      if (!range) return;
      // Visit only visible rows intersecting the logical selection. The
      // selectionRow metadata translates viewport cells to content rows in
      // O(1), including a scrolled viewport; no source/text resolution occurs.
      for (let y = 0; y < canvas.height; y++) {
        const cells = canvas.cells[y];
        for (let x = 0; x < canvas.width; x++) {
          const cell = cells[x];
          if (!cell?.selectionKey || !cell?.source || cell.text === null) continue;
          const index = (Number.isFinite(cell.selectionRow) ? cell.selectionRow : y) * canvas.width + x;
          if (index < range.start || index > range.end) continue;
          cell.selectionBaseRole ??= cell.role;
          cell.role = `${cell.selectionBaseRole ?? "text"} selection`;
          previewCells.push(cell);
        }
      }
      return;
    }
    if (!sourceSelection) return;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const cell = canvas.cells[y][x];
        const range = cell?.selectionKey ? sourceSelection.get(cell.selectionKey) : null;
        if (!range || !cell?.source || cell.text === null || cell.source.end <= range.start || cell.source.start >= range.end) continue;
        cell.role = `${cell.role ?? "text"} selection`;
      }
    }
  }

  function selectedSourceText() {
    if (!sourceSelection) return "";
    return sourceItems.flatMap((item) => {
      const range = sourceSelection.get(item.key);
      return range ? [item.text.slice(range.start, range.end)] : [];
    }).join("\n");
  }

  function endFrame(root, canvas) {
    lastCanvas = canvas;
    sourceItems = [];
    const visit = (node, inOverlay = false) => {
      if (!node) return;
      if (node.type === "overlay") { overlay = node.id ?? true; inOverlay = true; }
      if (inOverlay && node.focus) focused = node.id;
      if (node.selectionKey) {
        const text = typeof node.sourceText === "string"
          ? node.sourceText
          : (node.children ?? []).map((child) => typeof child === "string" ? child : String(child?.text ?? "")).join("");
        sourceItems.push({ key: node.selectionKey, text });
      }
      for (const child of node.children ?? []) visit(child, inOverlay);
    };
    visit(root);
    const byKey = new Map(sourceItems.map((item) => [item.key, item]));
    // A text node can leave its source on rendered cells rather than its
    // view node. Fill those gaps in one visible-canvas pass, preserving view order.
    for (const row of canvas.cells) for (const cell of row) {
      if (!cell?.selectionKey) continue;
      let item = byKey.get(cell.selectionKey);
      if (!item) {
        item = { key: cell.selectionKey, text: "" };
        sourceItems.push(item);
        byKey.set(item.key, item);
      }
      if (item.text === "" && typeof cell.sourceText === "string") item.text = cell.sourceText;
    }
    // Control state belongs to a mounted node. Dropping it here makes a
    // closed/reopened menu start fresh instead of resurrecting an old
    // filter or selection; scroll controls get the same lifecycle.
    for (const id of states.keys()) if (!nodes.has(id)) states.delete(id);
  }

  function sendInput(node, edit) {
    if (edit.submit) emit({ type: "input.submit", id: node.id, value: edit.value });
    else emit({ type: "input.change", id: node.id, ...edit });
  }

  function restoreInput(node, state, direction) {
    const source = direction === "undo" ? state.undo : state.redo;
    if (source.length === 0) return true;
    const destination = direction === "undo" ? state.redo : state.undo;
    destination.push(editingContext(node));
    if (destination.length > INPUT_HISTORY_LIMIT) destination.shift();
    sendInput(node, source.pop());
    return true;
  }

  function recordInputChange(node, state, edit) {
    const previous = String(node.value ?? "");
    if (edit.value === previous) return;
    // Retain the initial state of a run, then let consecutive single
    // non-whitespace insertions share it. Undo restores the whole word while whitespace and
    // every other edit retain a separate boundary.
    if (state.undo.length === 0 || !isSingleWordInsertion(previous, edit.value)) {
      state.undo.push(editingContext(node));
      if (state.undo.length > INPUT_HISTORY_LIMIT) state.undo.shift();
    }
    state.redo.length = 0;
  }

  /** Roving focus inside a focused toolbar (one tab stop, arrows within):
   *  ←/→ and Tab/Shift+Tab wrap, Home/End jump, Enter/Space activate. Any
   *  other key bubbles to the app — leaving the toolbar is app policy. */
  function handleToolbar(node, state, message) {
    const items = state.items ?? [];
    if (message.type !== "key" || items.length === 0) return false;
    const index = Math.max(0, items.findIndex((item) => item.key === state.key));
    const step = { left: -1, "shift+tab": -1, right: 1, tab: 1 }[message.key];
    const next = step !== undefined ? (index + step + items.length) % items.length
      : message.key === "home" ? 0 : message.key === "end" ? items.length - 1 : null;
    if (next !== null) {
      state.key = items[next].key;
      emit({ type: "toolbar.change", id: node.id, key: state.key, action: items[next].button.action });
      return true;
    }
    if (message.key === "enter" || message.key === "space") {
      const { button } = items[index];
      if (button.action) emit({ type: "action.select", id: button.id ?? node.id, action: button.action });
      return true;
    }
    return false;
  }

  function handleMenu(node, state, message) {
    const list = filteredMenu(state, node);
    const filtering = node.filter !== false;
    // Escape is an unconditional modal exit. Backspace owns filter editing;
    // requiring a first Escape to clear a query made menus feel trapped and
    // diverged from every other overlay's one-key dismissal contract.
    if (message.type === "key" && (message.key === "escape" || message.key === "ctrl+c" || (message.key === "q" && (!filtering || state.query === "")))) { emit({ type: "menu.cancel", id: node.id }); return true; }
    if (message.type === "key" && message.key === "enter" && node.submitOnEnter === true) { emit({ type: "menu.submit", id: node.id, item: selectable(list[state.index]) ? list[state.index] : undefined }); return true; }
    if (message.type === "key" && message.key === "enter" && selectable(list[state.index])) { emit({ type: "menu.select", id: node.id, item: list[state.index], itemId: list[state.index].id }); return true; }
    if (message.type === "key" && message.key === "space" && node.selectOnSpace === true && selectable(list[state.index])) { emit({ type: "menu.select", id: node.id, item: list[state.index], itemId: list[state.index].id }); return true; }
    const changed = () => {
      const current = filteredMenu(state, node);
      emit({ type: "menu.change", id: node.id, item: selectable(current[state.index]) ? current[state.index] : undefined });
    };
    if (message.type === "key" && (message.key === "up" || message.key === "down")) { moveMenuSelection(state, list, message.key === "up" ? -1 : 1); changed(); return true; }
    if (filtering && message.type === "key" && message.key === "backspace") { state.query = [...state.query].slice(0, -1).join(""); state.index = null; changed(); return true; }
    if (filtering && message.type === "key" && typeof message.text === "string") { state.query += message.text; state.index = null; changed(); return true; }
    if (!filtering && node.bubbleText === true && message.type === "key" && typeof message.text === "string") return false;
    return overlay !== null;
  }

  function setScrollFromBar(target, y) {
    const entry = nodes.get(target.target);
    if (!entry) return false;
    const state = stateFor(entry.node.id);
    const row = clamp(Math.floor(y) - target.box.y, 0, target.box.h - 1);
    const fromTop = Math.round(row * target.maxOffset / Math.max(1, target.box.h - 1));
    const next = entry.node.anchor === "end" ? target.maxOffset - fromTop : fromTop;
    if (next !== state.scroll) {
      state.scroll = next;
      emit({ type: "scroll.change", id: entry.node.id, offset: next });
    }
    return true;
  }

  function handlePointer(message) {
    if (message.kind === "move") {
      for (const cell of hoveredCells) cell.role = cell.hoverBaseRole;
      hoveredCells = [];
      const cell = lastCanvas?.cells?.[Math.floor(message.y)]?.[Math.floor(message.x)];
      // A link or a toolbar button highlights as ONE unit: every cell
      // sharing its url / button key takes the matching hover layer.
      const field = typeof cell?.link === "string" && cell.link !== "" ? "link"
        : typeof cell?.hover === "string" && cell.hover !== "" ? "hover" : null;
      if (field) {
        const layer = field === "link" ? "link.hover" : "button.hover";
        for (const row of lastCanvas.cells) for (const candidate of row) {
          if (candidate?.[field] !== cell[field]) continue;
          candidate.hoverBaseRole ??= candidate.role;
          candidate.role = `${candidate.hoverBaseRole ?? "text"} ${layer}`;
          hoveredCells.push(candidate);
        }
      }
      return true;
    }
    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "scrollbar") {
      const handled = setScrollFromBar(drag.target, message.y);
      if (message.kind === "release") drag = null;
      return handled;
    }
    if (message.kind === "press" && message.button === 0 && message.control === "scrollbar") {
      const target = [...targets].reverse().find((candidate) => candidate.kind === "scrollbar" && candidate.target === message.target);
      if (!target) return false;
      drag = { kind: "scrollbar", target };
      return setScrollFromBar(target, message.y);
    }
    if (message.kind === "wheel") {
      // Overflowing inputs own wheel movement within their visible text
      // window. Short inputs fall back to the keyboard transcript; menus
      // and scroll containers under the pointer take precedence.
      const pointed = nodes.get(message.target ?? focused);
      if (pointed?.node.type === "input") {
        const state = stateFor(pointed.node.id);
        const layout = inputRows(pointed.node, pointed.box.w);
        const visible = state.inputRows ?? 1;
        const maxStart = Math.max(0, layout.rows.length - visible);
        if (maxStart > 0) {
          const delta = (message.direction === "up" ? -1 : 1) * (Number.isFinite(message.amount) ? Math.abs(message.amount) : 1);
          state.inputWheel = (state.inputWheel ?? 0) + delta;
          const rows = Math.trunc(state.inputWheel);
          state.inputWheel -= rows;
          const next = clamp((state.inputStart ?? 0) + rows, 0, maxStart);
          if (next !== state.inputStart) {
            state.inputStart = next;
            emit({ type: "input.scroll", id: pointed.node.id });
          }
          return true;
        }
      }
      const entry = pointed?.node.type === "menu" || pointed?.node.type === "scroll"
        ? pointed
        : nodes.get(keyScroll);
      if (!entry || (entry.node.type !== "menu" && entry.node.type !== "scroll")) return false;
      const state = stateFor(entry.node.id);
      if (entry.node.type === "menu") {
        const list = filteredMenu(state, entry.node);
        moveMenuSelection(state, list, message.direction === "up" ? -1 : 1);
        emit({ type: "menu.change", id: entry.node.id, item: selectable(list[state.index]) ? list[state.index] : undefined });
      } else {
        const towardStart = message.direction === "up";
        const physical = Number.isFinite(message.amount) ? Math.abs(message.amount) : 1;
        const signed = towardStart ? -physical : physical;
        const delta = entry.node.anchor === "end" ? -signed : signed;
        state.scrollAccumulator = (state.scrollAccumulator ?? 0) + delta;
        const rows = Math.trunc(state.scrollAccumulator);
        if (rows !== 0) {
          state.scrollAccumulator = 0;
          const next = clamp(state.scroll + rows, 0, state.maxOffset ?? Infinity);
          if (next !== state.scroll) {
            state.scrollDirection = Math.sign(entry.node.anchor === "end" ? -rows : rows);
            state.scroll = next;
            emit({ type: "scroll.change", id: entry.node.id, offset: state.scroll });
          }
        }
      }
      return true;
    }

    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "text") {
      const moved = !drag.multiClick || drag.moved || movedBeyondClickThreshold(drag, message);
      if (!moved) {
        if (message.kind === "release") drag = null;
        return true;
      }
      let endpoint = { x: message.x, y: message.y };
      if (drag.wordMode && Number.isInteger(message.index) && typeof message.sourceText === "string") {
        const word = clickSelection(message.sourceText, message.index, 2);
        if (word) endpoint = pointForSource(message.target, word.caret, endpoint, true);
      }
      // Convert the current screen endpoint immediately. Both endpoints then
      // live in scroll-content coordinates; later frames must never reinterpret
      // the original screen row against a newly scrolled canvas.
      const sourceCaret = sourceAnchor(lastCanvas, endpoint);
      textSelection = { ...textSelection, caret: canvasPoint(lastCanvas, endpoint), sourceCaret: sourceCaret ?? textSelection.sourceCaret };
      drag.sourceCaret = sourceCaret ?? drag.sourceCaret;
      const canvas = lastCanvas;
      const pointerY = clamp(Math.floor(message.y), 0, Math.max(0, (canvas?.height ?? 1) - 1));
      const scrollId = drag.scrollTarget ?? canvas?.cells?.[pointerY]?.find((cell) => cell?.selectionScroll)?.selectionScroll;
      const scroll = scrollId ? nodes.get(scrollId) : null;
      if (message.kind === "drag" && scroll) {
        const top = scroll.box.y;
        const bottom = scroll.box.y + scroll.box.h - 1;
        const previousY = Math.floor(drag.pointerY ?? message.y);
        const direction = pointerY < previousY ? -1 : pointerY > previousY ? 1 : 0;
        drag.pointerY = pointerY;
        // Entering the four-row zone merely arms it. Scroll only on a later
        // real mouse report moving another row outward. The physical first/
        // last terminal row is never an activation point.
        const inTopZone = pointerY > top && pointerY < top + 4;
        const inBottomZone = pointerY < bottom && pointerY > bottom - 4;
        const outward = (inTopZone && direction < 0) || (inBottomZone && direction > 0);
        const armed = drag.edgeZone === (inTopZone ? "top" : inBottomZone ? "bottom" : null);
        drag.edgeZone = inTopZone ? "top" : inBottomZone ? "bottom" : null;
        if (outward && armed) {
          const desired = inTopZone ? top + 4 : bottom - 4;
          const amount = Math.abs(desired - pointerY);
          const signed = inTopZone ? -amount : amount;
          const state = stateFor(scroll.node.id);
          const delta = scroll.node.anchor === "end" ? -signed : signed;
          const next = clamp(state.scroll + delta, 0, state.maxOffset ?? Infinity);
          if (next !== state.scroll) {
            const actual = scroll.node.anchor === "end" ? state.scroll - next : next - state.scroll;
            state.scroll = next;
            textSelection.caret = { ...textSelection.caret, y: textSelection.caret.y + actual, logical: true };
            emit({ type: "scroll.change", id: scroll.node.id, offset: state.scroll });
          }
        }
      }
      // Mouse motion can arrive hundreds of times per second. Preview only
      // after the endpoint has moved more than 0.75 of a terminal cell since
      // the last preview; this keeps feedback responsive without resolving
      // source text/ranges or repainting for every raw motion report.
      if (message.kind === "drag") {
        const previous = drag.previewAt ?? drag.origin;
        const nextCell = { x: Math.floor(message.x), y: Math.floor(message.y) };
        const previousCell = { x: Math.floor(previous.x), y: Math.floor(previous.y) };
        drag = { ...drag, moved };
        if (nextCell.x === previousCell.x && nextCell.y === previousCell.y) return true;
        drag.previewAt = { x: message.x, y: message.y };
        sourceSelection = null;
        emit({ type: "selection.preview" });
        return true;
      }
      sourceSelection = captureSourceSelection();
      drag = null;
      emit({ type: "selection.change", text: selectedSourceText() });
      return true;
    }
    if ((message.kind === "drag" || message.kind === "release") && drag?.kind === "input") {
      const entry = nodes.get(drag.target);
      if (!entry) { drag = null; return false; }
      // Terminals can report a drag/release at (or one cell beside) the
      // multi-click. Keep its word/line selection intact until a genuine
      // post-click movement starts; otherwise that trailing report shrinks
      // it to the pointer's index.
      const moved = !drag.multiClick || drag.moved || movedBeyondClickThreshold(drag, message);
      if (!moved) {
        if (message.kind === "release") drag = null;
        return true;
      }
      const value = String(entry.node.value ?? "");
      // A drag that leaves the input's glyphs reports no index; hold the
      // last resolved position instead of leaping to the value's end.
      const rawCaret = clamp(Number.isInteger(message.index) ? message.index : drag.caret ?? value.length, 0, value.length);
      // Pointer reports within the same terminal cell carry no new editor
      // information. Suppress the app update/layout entirely.
      if (message.kind === "drag" && rawCaret === drag.rawCaret) return true;
      let anchor = drag.anchor;
      let caret = rawCaret;
      if (drag.wordMode) {
        if (rawCaret >= drag.wordStart) { anchor = drag.wordStart; caret = wordEnd(value, rawCaret); }
        else { anchor = drag.wordEnd; caret = wordLeft(value, rawCaret); }
      }
      drag = { ...drag, rawCaret, caret, selection: { anchor, caret }, moved };
      if (message.kind === "drag") {
        // Preview input selection on the mounted canvas too; the controlled
        // value/caret update is committed once on release.
        for (const cell of previewCells) cell.role = cell.selectionBaseRole;
        previewCells = [];
        const ordered = orderedSelection(drag.selection);
        if (ordered) for (const row of lastCanvas?.cells ?? []) for (const cell of row) {
          if (!Number.isInteger(cell?.inputIndex) || cell.inputIndex < ordered.start || cell.inputIndex >= ordered.end) continue;
          cell.selectionBaseRole ??= cell.role;
          cell.role = "input.selection";
          previewCells.push(cell);
        }
        emit({ type: "selection.preview" });
        return true;
      }
      sendInput(entry.node, { value, caret, selection: drag.selection });
      drag = null;
      return true;
    }

    const target = message.target ? targets.find((candidate) => candidate.target === message.target
      && (message.control === undefined || candidate.kind === message.control)
      && (message.index === undefined || candidate.index === message.index)) : null;
    if (message.kind === "press" && target?.kind === "action") {
      emit({ type: "action.select", id: target.target, action: target.action });
      return true;
    }
    if (message.kind === "press" && target?.kind === "completion") {
      emit({ type: "input.change", id: target.target, completion: target.item, completionIndex: target.index });
      return true;
    }
    if (message.kind === "move" && target?.kind === "menu.item" && selectable(target.item)) {
      const entry = nodes.get(target.target);
      if (!entry) return false;
      const state = stateFor(entry.node.id);
      state.index = target.index;
      emit({ type: "menu.change", id: target.target, item: target.item });
      return true;
    }
    if (message.kind === "press" && target?.kind === "menu.item" && selectable(target.item)) {
      emit({ type: "menu.select", id: target.target, item: target.item, itemId: target.item.id });
      return true;
    }
    if (message.kind === "press" && message.control === "action" && message.button === 0 && typeof message.action === "string" && message.action !== "") {
      emit({ type: "action.select", action: message.action });
      return true;
    }
    if (message.kind === "press" && message.control === "link" && message.button === 0 && typeof message.link === "string" && message.link !== "") {
      emit({ type: "link.open", url: message.link });
      return true;
    }
    if (message.kind === "press" && message.control === "text" && message.button === 0) {
      const now = Date.now();
      const repeated = lastClick?.target === message.target && lastClick?.index === message.index && now - (lastClick?.at ?? 0) <= MULTI_CLICK_MS;
      const count = repeated ? Math.min(3, lastClick.count + 1) : 1;
      lastClick = { target: message.target, index: message.index, at: now, count };
      const source = String(message.sourceText ?? "");
      const selected = clickSelection(source, message.index ?? 0, count);
      const fallback = { x: message.x, y: message.y };
      const anchor = selected ? pointForSource(message.target, selected.anchor, fallback) : fallback;
      const caret = selected ? pointForSource(message.target, selected.caret, fallback, true) : fallback;
      const scrollTarget = lastCanvas?.cells?.[Math.floor(message.y)]?.[Math.floor(message.x)]?.selectionScroll
        ?? [...nodes.entries()].find(([, entry]) => entry.node.type === "scroll" && pointInside(message, entry.box))?.[0];
      const sourceAnchorPoint = sourceAnchor(lastCanvas, anchor);
      const sourceCaretPoint = sourceAnchor(lastCanvas, caret);
      drag = { kind: "text", multiClick: selected !== null, wordMode: count === 2, scrollTarget, origin: fallback,
        sourceAnchor: sourceAnchorPoint, sourceCaret: sourceCaretPoint };
      textSelection = { anchor: canvasPoint(lastCanvas, anchor), caret: canvasPoint(lastCanvas, caret),
        sourceAnchor: sourceAnchorPoint, sourceCaret: sourceCaretPoint };
      sourceSelection = captureSourceSelection();
      emit({ type: "selection.change", text: selectedSourceText() });
      return true;
    }
    if (message.kind === "press" && message.target && Number.isInteger(message.index)) {
      const entry = nodes.get(message.target);
      if (entry?.node.type === "input") {
        const value = String(entry.node.value ?? "");
        const caret = clamp(message.index, 0, value.length);
        const now = Date.now();
        const repeated = message.button === 0 && lastClick?.target === entry.node.id
          && lastClick.index === caret && now - lastClick.at <= MULTI_CLICK_MS;
        const count = repeated ? Math.min(3, lastClick.count + 1) : 1;
        lastClick = message.button === 0 ? { target: entry.node.id, index: caret, at: now, count } : null;
        const selection = clickSelection(value, caret, count);
        drag = message.button === 0 ? {
          kind: "input", target: entry.node.id, anchor: selection?.anchor ?? caret, caret: selection?.caret ?? caret,
          rawCaret: caret, index: caret, multiClick: selection !== null, wordMode: count === 2,
          wordStart: selection?.anchor ?? caret, wordEnd: selection?.caret ?? caret,
          origin: { x: message.x, y: message.y }, moved: false,
        } : null;
        // An input caret gesture owns selection now: a still-mounted mouse
        // text selection is dead, and clearing it repaints the highlight.
        if (textSelection) { textSelection = null; sourceSelection = null; emit({ type: "selection.change", text: "" }); }
        sendInput(entry.node, { value, caret: selection?.caret ?? caret, selection });
        return true;
      }
    }
    if (message.kind === "press" && textSelection) {
      textSelection = null;
      sourceSelection = null;
      drag = null;
      emit({ type: "selection.change", text: "" });
      return true;
    }
    return false;
  }

  function handleScroll(entry, message, fallback = false) {
    if (!entry || entry.node.type !== "scroll" || message.type !== "key") return false;
    const { node, box } = entry;
    const info = keyInfo(message);
    if (!info) return false;
    const page = Math.max(1, box.h - Math.min(PAGE_OVERLAP_ROWS, Math.max(0, box.h - 1)));
    const lineSteps = { up: -1, down: 1 };
    const pageSteps = { pageup: -page, pagedown: page, b: -page, space: page };
    let amount = null;
    // A focused input owns plain Up/Down (caret/history). As its scroll
    // fallback it accepts Page Up/Down and the modified vertical-scroll
    // keys it never claims: Alt+Up/Down (line) and Alt+Meta+Up/Down
    // (Alt wins over Meta). Meta+Up/Down stay the input's whole-value
    // caret jump, so this fallback never sees them.
    if (info.modifiers === 0) {
      if (fallback && (info.code === "up" || info.code === "down")) return false;
      amount = lineSteps[info.code] ?? pageSteps[info.code] ?? null;
    }
    else if (info.modifiers === ALT) amount = lineSteps[info.code] ?? null;
    else if (info.modifiers === (ALT | META)) amount = lineSteps[info.code] ?? null;
    if (amount === null) return false;
    const delta = node.anchor === "end" ? -amount : amount;
    const state = stateFor(node.id);
    state.scrollDirection = Math.sign(amount);
    state.scrollAccumulator = 0;
    // Content may have grown since the last layout (streaming); clamp only
    // at zero here and let syncScroll clamp to the fresh maxOffset.
    state.scroll = Math.max(0, state.scroll + delta);
    emit({ type: "scroll.change", id: node.id, offset: state.scroll });
    return true;
  }

  function handle(message) {
    if (message.type === "pointer") return handlePointer(message);
    // One primed selection, whatever the gesture: a mouse text selection
    // claims Copy only when it actually yields source text; otherwise the
    // focused input's own keyboard/mouse selection handles it below, so
    // the two never behave as separate selections.
    if (message.type === "key" && message.key === "copy" && textSelection) {
      const text = selectedSourceText();
      if (text !== "") {
        emit({ type: "selection.copy", text });
        return true;
      }
    }
    const entry = nodes.get(focused);
    if (!entry) return overlay !== null;
    const { node, box } = entry;
    if (node.type === "input") {
      const state = stateFor(node.id);
      if (message.type === "key" && ["ctrl+z", "meta+z"].includes(message.key)) return restoreInput(node, state, "undo");
      if (message.type === "key" && ["ctrl+shift+z", "meta+shift+z"].includes(message.key)) return restoreInput(node, state, "redo");
      const pasted = message.type === "paste"
        ? (typeof node.pasteTransform === "function" ? node.pasteTransform(String(message.text ?? "")) : String(message.text ?? ""))
        : null;
      const inputMessage = pasted === null ? message : { ...message, text: pasted };
      const edit = pasted !== null && pasted.length >= PASTE_COLLAPSE_THRESHOLD
        ? collapsePaste(node, state, pasted)
        : inputEdit(node, inputMessage, inputRows(node, box.w).textWidth);
      if (!edit) {
        // A DECLINED key the input opted to surface (node.bubbleKeys) —
        // e.g. the questionnaire's custom-answer input bubbling ↑/↓ at
        // its top/bottom row — reaches the app instead of dying at the
        // overlay boundary. Returning false lets the host forward it.
        if (message.type === "key" && Array.isArray(node.bubbleKeys) && node.bubbleKeys.includes(message.key)) return false;
        // Unmatched keys fall through to the keyboard-enabled transcript:
        // Page Up/Down plus the modified vertical-scroll keys the input
        // never claims (Alt/Meta+Up/Down — see handleScroll).
        return handleScroll(nodes.get(keyScroll), message, true) || overlay !== null;
      }
      if (edit.submit) {
        state.undo.length = 0;
        state.redo.length = 0;
        sendInput(node, { ...edit, value: expandPastes(edit.value, state.pastes) });
      } else {
        recordInputChange(node, state, edit);
        sendInput(node, edit);
      }
      return true;
    }
    if (node.type === "menu") return handleMenu(node, stateFor(node.id), message);
    if (node.type === "toolbar") return handleToolbar(node, stateFor(node.id), message) || overlay !== null;
    if (handleScroll(entry, message)) return true;
    return overlay !== null;
  }

  function dispose() {
    nodes.clear();
    states.clear();
    targets = [];
    focused = null;
    overlay = null;
    keyScroll = null;
    drag = null;
    textSelection = null;
    sourceSelection = null;
    previewCells = [];
    hoveredCells = [];
    lastCanvas = null;
  }

  return { beginFrame, drawControl, reserveScrollBar, drawScrollBar, syncScroll, endFrame, applySelection, handle, stateFor, dispose, resolvePoint(point, { wheel = false } = {}) {
    const cell = lastCanvas?.cells?.[point.y]?.[point.x];
    if (!wheel && typeof cell?.action === "string" && cell.action !== "") return { kind: "press", control: "action", action: cell.action };
    if (!wheel && typeof cell?.link === "string" && cell.link !== "") return { kind: "press", control: "link", link: cell.link };
    if (!wheel && cell?.selectionKey && cell?.source) {
      return {
        kind: "press", control: "text", target: cell.selectionKey,
        index: cell.source.start, sourceText: String(cell.sourceText ?? ""),
      };
    }
    const target = [...targets].reverse().find((candidate) => pointInside(point, candidate.box) && (wheel || !candidate.wheelOnly));
    if (!target) return null;
    if (wheel && target.kind === "scrollbar") return { kind: "press", control: "scroll", target: target.target };
    if (target.kind === "input") {
      if (target.wheelOnly) return { kind: "press", control: "input", target: target.target }; // wheel: resolve the input, never a caret index
      const column = Math.max(0, point.x - target.box.x - target.margin);
      const tokens = target.tokens ?? visualInputRow(target.row);
      let used = 0;
      let index = tokens[0]?.start ?? target.row.start;
      for (let at = 0; at < tokens.length; at++) {
        const token = tokens[at];
        const width = graphemeWidth(token.text) || 1;
        const previous = tokens[at - 1];
        const next = tokens[at + 1];
        const reversed = (previous && previous.start > token.start) || (next && token.start > next.start);
        if (used + width > column) { index = reversed ? token.end : token.start; break; }
        used += width;
        index = reversed ? token.start : token.end;
      }
      return { kind: "press", control: "input", target: target.target, index };
    }
    return { kind: "press", control: target.kind, target: target.target, index: target.index };
  } };
}

export const controlInternals = Object.freeze({ inputEdit, inputRows, orderedSelection, vertical, completionWindow, collapsePaste, expandPastes, PASTE_COLLAPSE_THRESHOLD, PAGE_OVERLAP_ROWS, COMPLETION_ROWS, EDITING_MAP, SELECTED_EDITING_MAP, BUBBLE });
