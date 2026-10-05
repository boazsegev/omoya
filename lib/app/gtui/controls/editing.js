// Text-editor keybindings and edit operations for controlled inputs.
import { displayWidth, graphemes, graphemeWidth, wrapWordsOffsets } from "../width.js";
import { SHIFT, createKeybindings, keyInfo, matchesBinding } from "../keymap.js";
import { clamp, isWord, orderedSelection, replaceRange, lineBoundary } from "./helpers.js";
/**
 * Find the UTF-16 offset immediately before the grapheme at a caret.
 * @param {string} value - Text to inspect.
 * @param {number} caret - Current UTF-16 caret offset.
 * @returns {number} Previous grapheme boundary, or zero.
 */
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

/**
 * Find the UTF-16 offset immediately after the grapheme at a caret.
 * @param {string} value - Text to inspect.
 * @param {number} caret - Current UTF-16 caret offset.
 * @returns {number} Next grapheme boundary, or the value length.
 */
function nextGrapheme(value, caret) {
  let offset = 0;
  for (const part of graphemes(value)) {
    offset += part.length;
    if (offset > caret) return offset;
  }
  return value.length;
}

/**
 * Move left across separators and then the preceding word.
 * @param {string} value - Text to inspect.
 * @param {number} caret - Starting UTF-16 offset.
 * @returns {number} Offset at the preceding word boundary.
 */
export function wordLeft(value, caret) {
  let next = caret;
  while (next > 0 && !isWord(value[next - 1])) next--;
  while (next > 0 && isWord(value[next - 1])) next--;
  return next;
}

/**
 * Move right across separators and the following word.
 * @param {string} value - Text to inspect.
 * @param {number} caret - Starting UTF-16 offset.
 * @returns {number} Offset at the following word boundary.
 */
function wordRight(value, caret) {
  let next = caret;
  // Match terminal/editor Option+Right semantics: cross separators first,
  // then advance through the following word to its end. At a position inside
  // a word this naturally advances to that word's end.
  while (next < value.length && !isWord(value[next])) next++;
  while (next < value.length && isWord(value[next])) next++;
  return next;
}

/**
 * Find the end of the word at or after an offset.
 * @param {string} value - Text to inspect.
 * @param {number} caret - Starting UTF-16 offset.
 * @returns {number} Offset after consecutive word characters.
 */
export function wordEnd(value, caret) {
  let next = caret;
  while (next < value.length && isWord(value[next])) next++;
  return next;
}

/**
 * Move a caret between wrapped visual rows while preserving display column.
 * @param {string} value - Multiline input value.
 * @param {number} caret - Current UTF-16 offset.
 * @param {number} direction - Row direction, normally -1 or 1.
 * @param {number} width - Available display width.
 * @returns {?number} Target offset, or null beyond the first/last row.
 */
export function vertical(value, caret, direction, width) {
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

/**
 * Extend an existing selection to a caret, or start one from the old caret.
 * @param {?object} selection - Existing selection, if any.
 * @param {number} oldCaret - Previous caret used as the new anchor when needed.
 * @param {number} caret - New caret offset.
 * @returns {?{anchor:number,caret:number}} Updated selection, or null if collapsed.
 */
function extendSelection(selection, oldCaret, caret) {
  const anchor = selection?.anchor ?? oldCaret;
  return anchor === caret ? null : { anchor, caret };
}

/**
 * Declarative shared text-editing semantics for EVERY GTUI input control:
 * the generic/common keybindings for moving between words, lines, and
 * paragraphs, selecting them, and deleting by grapheme/word/line — every
 * input is a small TEXT EDITOR, so an active SELECTION behaves like one:
 * typing/paste/Enter replaces it, Backspace/Delete remove it, and any
 * plain (non-Shift) move drops it — a DIRECTIONAL move (Left/Right,
 * word, vertical) collapses to the selection's edge on the side the
 * key walks toward, an ABSOLUTE move (Home/End, Ctrl+A/E, Cmd+Up/Down)
 * goes to the position it names; the caret never lands inside the
 * selection it just dropped. Each
 * entry matches a message through keymap.js's matchesBinding — the same
 * normalized-key matching an app's bindings(model) arrays use — so the
 * effective dispatch order stays: the app's user keybinding maps first,
 * then this GTUI map for the input's state, then nothing (terminal
 * default behavior). Readline/Emacs aliases (Ctrl+A/E/K/U, Alt+B/F/D) and
 * the macOS kitty-protocol Cmd+arrow conventions sit next to the plain
 * arrows because every input is a small text editor.
 * Entry contract: run(context) returns an edit {value, caret, selection}
 * (or {submit, value}); returning the sentinel BUBBLE declines the key so
 * later entries — and finally the application — see it.
 */
export const BUBBLE = Symbol("GTUI.controls.editing.bubble");
/**
 * The collapse target a plain (non-Shift) move lands on when a
 * selection is active. A move is either DIRECTIONAL (Left/Right,
 * word, vertical: walks toward a side — collapses to the selection's
 * OWN edge on that side) or ABSOLUTE (Home/End, Ctrl+A/E, Cmd+Up/Down:
 * names a position — goes THERE, deselecting). Either way the caret
 * never lands INSIDE the selection it just dropped.
 */
function collapseTarget(selection, caret, targetCaret, side) {
  const range = orderedSelection(selection);
  if (!range) return targetCaret;
  if (side === "start") return range.start;
  if (side === "end") return range.end;
  return targetCaret;
}

/**
 * Create a keybinding entry that moves the caret and optionally extends selection.
 * @param {string[]} keys - Normalized key names for this binding.
 * @param {Function} target - Computes destination from value, caret, and width.
 * @param {?string} [side=null] - Selection collapse edge for plain directional movement.
 * @returns {{keys:string[],run:Function}} Binding entry; its run returns an edit or BUBBLE.
 */
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
/**
 * Plain Left/Right with an active selection collapse to its sides — the
 * universal editor gesture — instead of stepping one grapheme from the
 * caret (which would land INSIDE the selection). The selection's origin
 * is the caret, so the collapse side follows anchor/caret, matching what
 * the mouse and Shift-moves produce.
 */
const collapse = (keys, side) => ({
  keys,
  run({ value, caret, selection }) {
    const range = orderedSelection(selection);
    if (range) return { value, caret: side === "start" ? range.start : range.end, selection: null };
    const nextCaret = side === "start" ? previousGrapheme(value, caret) : nextGrapheme(value, caret);
    return { value, caret: nextCaret, selection: null };
  },
});
/**
 * Create a keybinding entry that removes a selected range or computed range.
 * @param {string[]} keys - Key names for this binding.
 * @param {Function} range - Computes deletion bounds or returns BUBBLE.
 * @returns {{keys:string[],run:Function}} Binding entry returning an edit or BUBBLE.
 */
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
/**
 * Compile immutable keybinding entries for a named editing context.
 * @param {string} name - Keybinding context name.
 * @param {object[]} entries - Entries containing keys and run handlers.
 * @returns {object[]} Frozen entries with compiled contexts.
 */
const compileEditingMap = (name, entries) => Object.freeze(entries.map((entry) => Object.freeze({
  keys: entry.keys, context: createKeybindings(name, entry.keys), run: entry.run,
})));
// Unselected input bindings. This is immutable declarative input policy,
// rather than per-screen shortcuts, so every input control gets identical
// editor behavior.
export const EDITING_MAP = compileEditingMap("GTUI.editing", EDITING_KEYS);
// Selected input has its own immutable key map and takes precedence. Its
// handlers deliberately share the elementary edit operations above: those
// operations replace/delete/collapse the selected range, whereas the normal
// map moves or deletes adjacent text. Keeping the dispatch maps distinct
// makes the selected-state contract explicit without duplicating mechanics.
export const SELECTED_EDITING_MAP = compileEditingMap("GTUI.editing.selected", EDITING_KEYS);

/**
 * Read a normalized value, clamped caret, and selection from an input node.
 * @param {object} node - Input node.
 * @returns {{value:string,caret:number,selection:?object}} Editing context.
 */
export function editingContext(node) {
  const value = String(node.value ?? "");
  const caret = clamp(Number.isInteger(node.caret) ? node.caret : value.length, 0, value.length);
  const selection = node.selection ?? null;
  return { value, caret, selection };
}

// A text edit coalesces when the old value can be split into a constant
// prefix/postfix around precisely one newly inserted non-whitespace grapheme.
// This deliberately does not coalesce whitespace, deletions, replacements, or
// multi-grapheme input: each is a meaningful undo boundary.
/**
 * Check whether an edit inserts exactly one non-whitespace grapheme.
 * @param {string} before - Previous value.
 * @param {string} after - Candidate updated value.
 * @returns {boolean} Whether the change qualifies for undo coalescing.
 */
export function isSingleWordInsertion(before, after) {
  if (after.length <= before.length) return false;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  const postfixLength = before.length - prefix;
  if (!after.endsWith(before.slice(prefix))) return false;
  const inserted = after.slice(prefix, after.length - postfixLength);
  return graphemes(inserted).length === 1 && !/\s/u.test(inserted);
}

/**
 * Apply paste/text/key editing semantics to an input message.
 * @param {object} node - Controlled input node.
 * @param {object} message - Paste or key message.
 * @param {number} width - Text width for visual movement.
 * @returns {?object} Edit/submit result, or null when unhandled; does not emit events.
 */
export function inputEdit(node, message, width) {
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

