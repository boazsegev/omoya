/**
 * lib/app/tui/input-controller.js — the draft input box's MODEL-OWNED
 * state: value/caret/selection (mirrored from GTUI's `input` control —
 * see lib/app/gtui/controls.js's controlled-input contract: the control
 * computes edits from the LAST rendered value/caret/selection, so the
 * app must hold and re-supply them) plus completions, which are pure
 * tui-app policy (completion.js's computeCompletions) that GTUI's
 * `input` node only ever displays.
 *
 * Tab/Shift+Tab/Down/Up/Enter double as completion-list navigation ONLY
 * while completions are showing — the app declares them via GTUI's
 * `bindings(model)` so those keys bypass the input control entirely and
 * move, accept, or dismiss the completion list instead.
 */

import Context from "../../context.js";
const { MessageType } = Context;
import { computeCompletions } from "./completion.js";

/**
 * Create a blank draft state while preserving a copy of submitted history.
 *
 * @param {Array<string>} [history=[]] Previously submitted values, in order.
 * @returns {object} A fresh input state with an empty value, no selection or completions, and history browsing reset.
 * @throws {TypeError} If `history` is not iterable.
 */
function draftState(history = []) {
  return {
    value: "", caret: 0, selection: null,
    completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0,
    history: [...history], historyIndex: null, historyDraft: "",
  };
}

/**
 * Create the initial blank input state, optionally seeded with submitted history.
 *
 * @param {Array<string>} [history=[]] Previously submitted values, in order.
 * @returns {object} A fresh input state; the supplied history is copied.
 * @throws {TypeError} If `history` is not iterable.
 */
export function initialInput(history = []) {
  return draftState(history);
}

/**
 * Extract non-empty user-turn text as initial command/message history.
 * Content block text is concatenated per message; non-user messages and empty messages are omitted.
 *
 * @param {Array<object>} [context=[]] Conversation messages to inspect.
 * @returns {Array<string>} User message text in context order.
 * @throws {TypeError} If `context` is not an array or does not support the required array operations.
 */
export function historyFromContext(context = []) {
  return context
    .filter((message) => message?.type === MessageType.User)
    .map((message) => (message.content ?? []).map((block) => block?.text ?? "").join(""))
    .filter(Boolean);
}

const NO_COMPLETIONS = Object.freeze({ completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 });

/**
 * Compute the completion-list fields appropriate for the current draft.
 * Automatic completion is limited to slash commands and declared arguments; explicit
 * completion may also use other sources. A source function is invoked only when eligible.
 *
 * @param {object} input Draft state containing `value` and `caret`.
 * @param {object|Function} sources Completion data, or a thunk receiving `{ line, caret, explicit }` and returning that data.
 * @param {boolean} [explicit=false] Whether completion was explicitly requested (for example, by Tab).
 * @returns {object} Completion fields: `completions`, `completionStart`, `completionEnd`, and `completionIndex`.
 * @throws {Error} Any error thrown by the source thunk or completion computation is propagated.
 */
function completionState(input, sources, explicit = false) {
  if (input.value === "") return NO_COMPLETIONS;
  // Source thunks may enumerate persisted catalogues. Ordinary prose must
  // reject automatic completion before invoking any source at all.
  if (!explicit && typeof sources === "function" && !input.value.startsWith("/")) return NO_COMPLETIONS;
  const current = typeof sources === "function" ? sources({ line: input.value, caret: input.caret, explicit }) : sources;
  if (!current) return NO_COMPLETIONS;

  if (!explicit) {
    // Match the legacy input contract: typing opens only slash-command
    // choices and declared argument lists. General filesystem completion
    // is intentionally opt-in via Tab; doing a synchronous readdir after
    // every ordinary keystroke made large/cloud folders stall the UI.
    const before = input.value.slice(0, input.caret);
    const lineStart = before.lastIndexOf("\n") + 1;
    if (lineStart !== 0) return NO_COMPLETIONS;
    const lineEnd = input.value.indexOf("\n");
    const line = input.value.slice(0, lineEnd < 0 ? input.value.length : lineEnd);
    const lineBefore = line.slice(0, input.caret);
    const wordStart = Math.max(lineBefore.lastIndexOf(" "), lineBefore.lastIndexOf("\t")) + 1;
    const firstToken = line.trim().split(/\s+/)[0];
    const firstWord = wordStart === 0;
    const knownArgument = !firstWord && Object.prototype.hasOwnProperty.call(current.argCandidates ?? {}, firstToken);
    if (!(firstWord && lineBefore.startsWith("/")) && !knownArgument) return NO_COMPLETIONS;
  }

  const { start, end, candidates } = computeCompletions(input.value, input.caret, current);
  // A fully typed candidate is complete, not an open chooser. Otherwise
  // Enter merely re-accepts identical text and commands need a surprising
  // second Enter before they submit.
  const exact = candidates.includes(input.value.slice(start, end));
  return { completions: exact ? [] : candidates, completionStart: exact ? 0 : start, completionEnd: exact ? 0 : end, completionIndex: 0 };
}

/**
 * Open explicit completion choices, including command, declared-argument, and filesystem-path choices.
 *
 * @param {object} input Current draft state.
 * @param {object|Function} sources Completion data or a source thunk receiving `{ line, caret, explicit }`.
 * @returns {object} A new draft state with its completion fields recalculated.
 * @throws {Error} Any error from the source thunk or completion computation is propagated.
 */
export function openCompletions(input, sources) {
  return { ...input, ...completionState(input, sources, true) };
}

/**
 * Apply a GTUI `input.change` event, including text edits, caret/selection updates, and clicked completion replacement.
 * Recomputes automatic completions and resets history browsing only when the value changes.
 *
 * @param {object} input Current draft state.
 * @param {object} message Change payload; optional `value`, integer `caret`, `selection`, and string `completion` fields are used when present.
 * @param {object|Function} sources Completion data or a source thunk receiving `{ line, caret, explicit }`.
 * @returns {object} The updated draft state.
 * @throws {Error} Any error from the source thunk or completion computation is propagated.
 */
export function applyChange(input, message, sources) {
  let value = message.value ?? input.value;
  let caret = Number.isInteger(message.caret) ? message.caret : input.caret;
  if (typeof message.completion === "string") {
    const before = value.slice(0, input.completionStart);
    const after = value.slice(input.completionEnd);
    value = `${before}${message.completion}${after}`;
    caret = before.length + message.completion.length;
  }
  const edited = value !== input.value;
  const next = {
    ...input, value, caret, selection: message.selection ?? null,
    ...(edited ? { historyIndex: null, historyDraft: "" } : {}),
  };
  return { ...next, ...completionState(next, sources) };
}

/**
 * Move the highlighted completion forward or backward, wrapping and previewing the candidate in the draft.
 * `completionEnd` tracks the preview so a later cycle replaces it instead of appending.
 *
 * @param {object} input Draft state with completion candidates and replacement bounds.
 * @param {number} direction Signed cycle step (normally `1` or `-1`).
 * @returns {object} The updated state, or the original state unchanged when there are no candidates.
 */
export function cycleCompletions(input, direction) {
  const count = input.completions.length;
  if (count === 0) return input;
  const completionIndex = ((input.completionIndex + direction) % count + count) % count;
  const candidate = input.completions[completionIndex];
  const before = input.value.slice(0, input.completionStart);
  const after = input.value.slice(input.completionEnd);
  const value = `${before}${candidate}${after}`;
  const caret = before.length + candidate.length;
  return { ...input, value, caret, selection: null, completionIndex, completionEnd: caret };
}

/**
 * Accept the highlighted completion and close the chooser; no trailing space is added.
 * If the highlighted candidate is absent, delegates to dismissal without changing draft text.
 *
 * @param {object} input Draft state with completion candidates and replacement bounds.
 * @returns {object} The updated state with completions cleared and the accepted text/caret, or the dismissed state when no candidate is selected.
 */
export function acceptCompletion(input) {
  const candidate = input.completions[input.completionIndex];
  if (candidate === undefined) return dismissCompletions(input);
  const value = input.value.slice(0, input.completionStart) + candidate + input.value.slice(input.completionEnd);
  const caret = input.completionStart + candidate.length;
  return { ...input, value, caret, selection: null, completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 };
}

/**
 * Dismiss completion choices while preserving the draft text and caret.
 *
 * @param {object} input Current draft state.
 * @returns {object} A new state with completion fields cleared.
 */
export function dismissCompletions(input) {
  return { ...input, completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 };
}

/**
 * Return selected draft text in logical value order, regardless of selection direction.
 *
 * @param {object} input Draft state with `value` and an optional `{ anchor, caret }` selection.
 * @returns {string} Selected substring, or an empty string when there is no non-empty selection.
 */
export function selectedText(input) {
  const selection = input.selection;
  if (!selection || selection.anchor === selection.caret) return "";
  const start = Math.min(selection.anchor, selection.caret);
  const end = Math.max(selection.anchor, selection.caret);
  return input.value.slice(start, end);
}

/**
 * Prepend drained pending-message text to the draft for editing and refresh completions.
 * Messages are separated by blank lines; an empty drained list leaves the state untouched.
 *
 * @param {object} input Current draft state.
 * @param {Array<object>} drained Drained messages, each optionally containing content blocks with text.
 * @param {object|Function} sources Completion data or a source thunk receiving `{ line, caret, explicit }`.
 * @returns {object} The updated draft state, or the original state if `drained` is empty.
 * @throws {Error} Any error from the source thunk or completion computation is propagated when messages are recalled.
 */
export function recallDrained(input, drained, sources) {
  if (drained.length === 0) return input;
  const text = drained.map((message) => (message.content ?? []).map((block) => block.text ?? "").join("")).join("\n\n");
  const value = input.value === "" ? text : `${text}\n\n${input.value}`;
  const next = { ...input, value, caret: value.length, selection: null, historyIndex: null, historyDraft: "" };
  return { ...next, ...completionState(next, sources) };
}

/**
 * Browse submitted history after Up/Down reaches a visual boundary, restoring the saved draft after the newest entry.
 * Recomputes automatic completions when history changes the displayed value.
 *
 * @param {object} input Draft state containing history and history-browsing fields.
 * @param {number} direction Negative moves toward older entries; non-negative moves toward newer entries.
 * @param {object|Function} sources Completion data or a source thunk receiving `{ line, caret, explicit }`.
 * @returns {object} The updated state, or the original state when history is empty or navigation cannot proceed.
 * @throws {Error} Any error from the source thunk or completion computation is propagated when navigation changes the value.
 */
export function navigateHistory(input, direction, sources) {
  const history = input.history ?? [];
  if (history.length === 0) return input;
  let index = input.historyIndex;
  let draft = input.historyDraft ?? "";
  if (direction < 0) {
    if (index === null) { draft = input.value; index = history.length - 1; }
    else if (index > 0) index--;
  } else {
    if (index === null) return input;
    if (index < history.length - 1) index++;
    else index = null;
  }
  const value = index === null ? draft : history[index];
  const next = { ...input, value, caret: value.length, selection: null, historyIndex: index, historyDraft: index === null ? "" : draft };
  return { ...next, ...completionState(next, sources) };
}

/**
 * Continue a multiline draft ending in a backslash, or submit its logical value and reset the draft.
 * A continued draft removes the final backslash and appends a newline; a submitted non-blank value is added to history.
 *
 * @param {object} input Current draft state.
 * @param {object|Function} sources Completion data or a source thunk receiving `{ line, caret, explicit }`; used only for continuation.
 * @param {string} [logicalValue=input.value] Value to submit, allowing callers to supply a logical rather than displayed value.
 * @returns {{continued: true, input: object}|{continued: false, value: string, input: object}} Continuation state or submitted value with a fresh input state.
 * @throws {Error} Any error from the source thunk or completion computation is propagated when continuing.
 */
export function submitOrContinue(input, sources, logicalValue = input.value) {
  const submitted = String(logicalValue ?? input.value);
  if (submitted.endsWith("\\")) {
    const value = `${submitted.slice(0, -1)}\n`;
    const next = { ...input, value, caret: value.length, selection: null, historyIndex: null, historyDraft: "" };
    return { continued: true, input: { ...next, ...completionState(next, sources) } };
  }
  const history = [...(input.history ?? [])];
  if (submitted.trim() !== "") history.push(submitted);
  return { continued: false, value: submitted, input: draftState(history) };
}

/**
 * Clear the draft and browsing/completion state while retaining its submitted history.
 *
 * @param {object} [input=initialInput()] State whose history should be retained.
 * @returns {object} A fresh blank draft state with a copy of the existing history.
 * @throws {TypeError} If the retained history is not iterable.
 */
export function clearInput(input = initialInput()) {
  return draftState(input.history ?? []);
}

/**
 * Insert menu-provided text at the caret without replacing the rest of the draft.
 * Clears selection but leaves completion fields unchanged for the caller to manage.
 *
 * @param {object} input Current draft state with a string value and caret offset.
 * @param {string} text Text to insert.
 * @returns {object} Updated draft state with the caret after the inserted text and no selection.
 */
export function insertText(input, text) {
  const value = input.value.slice(0, input.caret) + text + input.value.slice(input.caret);
  return { ...input, value, caret: input.caret + text.length, selection: null };
}
