/**
 * lib/tui-app/input-controller.js — the draft input box's MODEL-OWNED
 * state: value/caret/selection (mirrored from GTUI's `input` control —
 * see lib/gtui/controls.js's controlled-input contract: the control
 * computes edits from the LAST rendered value/caret/selection, so the
 * app must hold and re-supply them) plus completions, which are pure
 * tui-app policy (lib/tui-app/completion.js's computeCompletions) that
 * GTUI's `input` node only ever displays.
 *
 * Tab/Shift+Tab/Down/Up/Enter double as completion-list navigation ONLY while
 * completions are showing — the app declares them via GTUI's
 * `bindings(model)` so those keys bypass the input control entirely
 * (matching the capability matrix: "Enter; Shift+Enter; Tab/Down —
 * submit/soft break/completion — tui-app policy").
 */

import Context from "../context.js";
const { MessageType } = Context;
import { computeCompletions } from "./completion.js";

function draftState(history = []) {
  return {
    value: "", caret: 0, selection: null,
    completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0,
    history: [...history], historyIndex: null, historyDraft: "",
  };
}

export function initialInput(history = []) {
  return draftState(history);
}

/** Initial command/message history comes only from user turns. */
export function historyFromContext(context = []) {
  return context
    .filter((message) => message?.type === MessageType.User)
    .map((message) => (message.content ?? []).map((block) => block?.text ?? "").join(""))
    .filter(Boolean);
}

const NO_COMPLETIONS = Object.freeze({ completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 });

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

/** Explicit Tab completion: commands, declared arguments, or filesystem paths. */
export function openCompletions(input, sources) {
  return { ...input, ...completionState(input, sources, true) };
}

/** `input.change` (typing, movement, selection, or a clicked completion). */
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

/** Tab/Down/Up while completions are open: move the highlight, wrapping,
 * and preview that immutable candidate in the draft.  completionEnd tracks
 * the inserted preview so the next cycle replaces it rather than appending. */
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

/** Enter while completions are open: accept the highlighted candidate and
 *  stop cycling (parity with lib/tui-helpers/editor.js's acceptCompletion —
 *  the cycle just ends; no trailing space is added). */
export function acceptCompletion(input) {
  const candidate = input.completions[input.completionIndex];
  if (candidate === undefined) return dismissCompletions(input);
  const value = input.value.slice(0, input.completionStart) + candidate + input.value.slice(input.completionEnd);
  const caret = input.completionStart + candidate.length;
  return { ...input, value, caret, selection: null, completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 };
}

/** Escape while completions are open: dismiss the list, keep the typed text. */
export function dismissCompletions(input) {
  return { ...input, completions: [], completionStart: 0, completionEnd: 0, completionIndex: 0 };
}

/** Logical-order text selected in the controlled draft, independent of display order. */
export function selectedText(input) {
  const selection = input.selection;
  if (!selection || selection.anchor === selection.caret) return "";
  const start = Math.min(selection.anchor, selection.caret);
  const end = Math.max(selection.anchor, selection.caret);
  return input.value.slice(start, end);
}

/** Alt+Shift+Up: recall drained pending messages (Agent.drainPending()) into the box for editing — parity with lib/tui-helpers/repl-turns.js's queued-message notice ("Alt+↑ recalls them"). */
export function recallDrained(input, drained, sources) {
  if (drained.length === 0) return input;
  const text = drained.map((message) => (message.content ?? []).map((block) => block.text ?? "").join("")).join("\n\n");
  const value = input.value === "" ? text : `${text}\n\n${input.value}`;
  const next = { ...input, value, caret: value.length, selection: null, historyIndex: null, historyDraft: "" };
  return { ...next, ...completionState(next, sources) };
}

/** Up/Down after GTUI reaches a visual boundary: browse submitted history. */
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

/** Enter either continues a trailing-backslash draft or returns a submitted value and reset state. */
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

/** Clear the draft without discarding its history. */
export function clearInput(input = initialInput()) {
  return draftState(input.history ?? []);
}

/** A menu's "insert" action (e.g. a command/prompt row, Alt+↑ recall's
 *  sibling): insert at the caret — parity with lib/tui-helpers/repl-
 *  overlays.js's applyMenuEffect ("insert" -> editor.insert(text)),
 *  never a wholesale replace. */
export function insertText(input, text) {
  const value = input.value.slice(0, input.caret) + text + input.value.slice(input.caret);
  return { ...input, value, caret: input.caret + text.length, selection: null };
}
