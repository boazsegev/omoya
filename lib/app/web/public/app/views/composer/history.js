/** history.js — Per-agent composer drafts, visual-row-aware resize, and sent-message recall. */
import { state } from "../../state.js";
import { composerRefs } from "./refs.js";
import { agentKey } from "../../logic/agents.js";

import { autofitComposer } from "../../logic/composer-scroll.js";

import { historyEntries, historyRecall, onEdgeRow, editHistoryDraft } from "../../logic/history.js";
/**
 * Get (creating if needed) the per-agent composer draft.
 * @returns {{text: string, attachments: Array, submitted: string[], historyIndex: number|null, historyDraft: string|null}}
 */
function composerDraft() {
  const id = agentKey(state.agent);
  if (!id) return { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null };
  if (!state.composerByAgent.has(id)) state.composerByAgent.set(id, { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null });
  return state.composerByAgent.get(id);
}

/**
 * Snapshot the current textarea text and attachments into the viewed agent's draft.
 * @returns {void}
 */
function saveComposerDraft() {
  if (!state.agent?.id || !composerRefs.textareaEl) return;
  const draft = composerDraft();
  draft.text = composerRefs.textareaEl.value;
  draft.attachments = [...state.draftAttachments];
}

/**
 * Restore the viewed agent's saved attachments into `draftAttachments`.
 * @returns {void}
 */
function loadComposerDraft() {
  const draft = composerDraft();
  state.draftAttachments = [...draft.attachments];
}

/**
 * Measure the visual row tops of the text start, `index`, and the text end using
 * a hidden mirror element with the textarea's wrapping geometry; zero-width
 * markers share an offsetTop exactly when they share a row. U+2060 (word joiner)
 * adds no break opportunity, so the mirror wraps like the textarea.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} index - caret offset to measure.
 * @returns {{start: number, caret: number, end: number}} pixel tops of the three markers.
 */
function caretRowTops(textarea, index) {
  const value = textarea.value;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "letterSpacing", "wordSpacing", "lineHeight", "tabSize", "textTransform", "textIndent", "paddingLeft", "paddingRight", "direction"]) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", boxSizing: "border-box", border: "0", paddingTop: "0", paddingBottom: "0", width: `${textarea.clientWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak });
  const mark = () => { const span = document.createElement("span"); span.textContent = "\u2060"; return span; };
  const start = mark(), caret = mark(), end = mark();
  mirror.append(start, value.slice(0, index), caret, value.slice(index), end);
  document.body.append(mirror);
  const tops = { start: start.offsetTop, caret: caret.offsetTop, end: end.offsetTop };
  mirror.remove();
  return tops;
}

/**
 * Composer-visible message history: user messages from the authoritative context,
 * plus locally remembered submits not yet present there (deduplicated by text count,
 * so recalling a sent message never yields a duplicate).
 * @returns {string[]} oldest-first history entries.
 */
function messageHistory() {
  return historyEntries(state.blocks, composerDraft().submitted);
}

/**
 * Composer height follows content, capped at twelve rows. Preserve the user's
 * reading position as the dock grows; only the first typed input jumps to latest.
 * @param {boolean} [firstWrite=false] - input transitioned from empty to nonempty.
 * @returns {void}
 */
function autofit(firstWrite = false) {
  autofitComposer(composerRefs.textareaEl, document.querySelector(".transcript-scroll"), firstWrite);
}

/**
 * Typing always exits history browsing and the edited text becomes the working
 * draft (parity with the TUI's input-controller edit actions, which reset
 * historyIndex/historyDraft on any edit).
 * @returns {void}
 */
function noteComposerInput() {
  const draft = composerDraft();
  editHistoryDraft(draft, composerRefs.textareaEl.value);
}

/**
 * True when the caret at `index` sits on the first (direction < 0) or last
 * (direction > 0) VISUAL row of the textarea, soft wraps included: the caret
 * shares its row top with the text's start (Up) or end (Down).
 * @param {HTMLTextAreaElement} textarea
 * @param {number} index - caret offset to test.
 * @param {number} direction - negative for first row (Up), positive for last row (Down).
 * @returns {boolean}
 */
function caretOnEdgeRow(textarea, index, direction) {
  return onEdgeRow(textarea.value, index, direction, caretRowTops(textarea, index));
}

/**
 * Arrow-key recall of previously sent messages into the composer. Recall takes
 * over only on the first visual row for Up and the last for Down — like the
 * TUI's visual-edge trigger — so normal caret movement between rows is kept.
 * @param {number} direction - -1 for older (Up), +1 for newer (Down).
 * @returns {boolean} true when recall consumed the key (caller should preventDefault).
 */
function recallHistory(direction) {
  if (!composerRefs.textareaEl) return false;
  const textarea = composerRefs.textareaEl;
  const entries = messageHistory();
  const draft = composerDraft();
  if (!entries.length || (direction > 0 && draft.historyIndex === null)) return false;
  const caret = direction < 0 ? (textarea.selectionStart ?? 0) : (textarea.selectionEnd ?? textarea.value.length);
  const result = historyRecall({ value: textarea.value, caret, direction, entries, draft, tops: caretRowTops(textarea, caret) });
  if (!result) return false;
  if (direction < 0 && draft.historyIndex === 0) return true;
  draft.historyIndex = result.index;
  draft.historyDraft = result.historyDraft;
  textarea.value = result.value;
  if (result.index !== null || direction > 0) { autofit(); const list = document.querySelector("#autocomplete"); if (list) list.hidden = true; state.acItems = []; state.acIndex = -1; composerRefs.textareaEl?.setAttribute("aria-expanded", "false"); }
  return true;
}

/**
 * Tool name + a short human summary of its arguments (format.js).
 * @param {object} [call] - `{ name?, arguments?|args? }` tool call shape.
 * @returns {{name: string, summary: string}}
 */

export { composerDraft, saveComposerDraft, loadComposerDraft, caretRowTops, messageHistory, autofit, noteComposerInput, caretOnEdgeRow, recallHistory };
