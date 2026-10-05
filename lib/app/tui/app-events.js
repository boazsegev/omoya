/** app-events: GTUI message reducer and transient notice handling. */
import { effect } from "../gtui/gtui.js";
import Context from "../../context.js";
const { assemblerCreate, messageHasError } = Context;
import { initialInput, applyChange, insertText, submitOrContinue, cycleCompletions } from "./input-controller.js";
import { computeCompletions } from "./completion.js";
import { attachmentPaste } from "./attachment-draft.js";
import { QUESTION_MENU_ID, QUESTION_INPUT_ID } from "./questionnaire-view.js";
import { MENU_ID, VIEWER_ID } from "./overlay-view.js";
import { TRANSCRIPT_SCROLL_ID } from "./transcript-navigation.js";
import { currentQuestion, selectedLabels, answerWithText, answerWithLabels, toggleLabel, abandonQuestions, createQuestionnaire } from "./questionnaire.js";
import { previewMenu, reconcileViewer, openMenu } from "./overlay-controller.js";
import { resolveTheme } from "./theme-data.js";
import { resolveMenuAction } from "./menu-actions.js";
import { masterMenuOptions } from "./menu-sources.js";
import { buildMenuItems } from "./contracts.js";

const MAX_KEPT_NOTICES = 20;
/** Every notice is transient: it expires from the visible stack after
 *  this delay (errors expire like copy/endpoint notices — the failure
 *  has to be SEEN, not archived forever). */
const NOTICE_TTL_MS = 8_000;
/** Message types a human actually drives — the only ones that dismiss
 *  the "press ^C again to exit" arm state (see update()'s top guard).
 *  Everything else (agent.turn.event/settled, app.log, resize, task
 *  failures, …) must not silently disarm it. */
const USER_DRIVEN_MESSAGE_TYPES = new Set(["key", "input.change", "input.submit", "agent.submit", "menu.select", "menu.cancel", "paste", "pointer"]);
let nextNoticeId = 0;

/** The app's initial model: an idle turn, empty notice/tool streams, no
 *  question or overlay, focus on the input, and the draft seeded from
 *  prior history.
 * @param {string[]} [history=[]] - previously submitted lines for ↑/↓ recall
 * @returns {object} the initial app model
 */
export function initialModel(history = []) {
  return {
    turnRunning: false, pendingCount: 0, live: null, liveOrigin: null, liveContextLength: null, notices: [], question: null,
    toolStream: [], closedInput: false,
    input: initialInput(history), transcriptOffset: 0, overlay: null, exitNotice: false, completionGeneration: 0, completionRequest: 0,
    focus: "input", toolbarKey: null,
  };
}

/** Parity with lib/tui-helpers/repl-turns.js's onError: a cancelled turn
 *  keeps its partial response and says so; a failed response is already
 *  in context (its message's error renders in the transcript); any other
 *  error (a guard stop, no model) is reported as-is. Never fires for
 *  "done" — that content is already in context.
 * @param {object} event - a terminal turn event ({type, kind?, message?, error?})
 * @returns {?{text: string, kind: string}} a notice for the stack, or null
 *   when the event needs none (non-error, or an errored message renders itself)
 */
function noticeFor(event) {
  if (event.type !== "error") return null;
  if (event.kind === "cancelled") return { text: "cancelled — the partial response is kept", kind: "notice" };
  // a failed response is kept as its message: the transcript shows its error
  if (messageHasError(event.message)) return null;
  return { text: event.error ?? "unknown error", kind: "error" };
}

/** The notice for a failed GTUI task: labels the failure from the task's
 *  stable key ("agent.command" -> command, "agent.turn" -> turn, else task).
 * @param {object} message - the task.failed message ({key, error?})
 * @returns {{text: string, kind: string}} an error-kind notice
 */
function taskFailureNotice(message) {
  const detail = message.error?.message ?? message.error ?? "unknown error";
  const label = message.key === "agent.command" ? "command" : message.key === "agent.turn" ? "turn" : "task";
  return { text: `${label} failed: ${detail}`, kind: "error" };
}

/** Push a notice onto the visible stack: an identical still-visible text is
 *  REPLACED (its expiry restarts from the latest occurrence), and the stack
 *  is trimmed to MAX_KEPT_NOTICES.
 * @param {object} model - the app model (its model.notices stack is read)
 * @param {?object} notice - the notice to add; null/undefined returns the stack unchanged
 * @returns {Array<object>} the next stack; each new entry gains a unique id
 */
export function appendNotice(model, notice) {
  if (!notice) return model.notices;
  // A notice with the same text as one still on screen REPLACES it: the
  // stack shows one fresh line ("copied selection to the clipboard" may
  // fire many times in a row — twenty identical rows are noise), and
  // its expiry timer restarts from the latest occurrence.
  const kept = notice.text === undefined ? model.notices : model.notices.filter((entry) => entry.text !== notice.text);
  const notices = [...kept, { id: nextNoticeId++, ...notice }];
  if (notices.length > MAX_KEPT_NOTICES) notices.splice(0, notices.length - MAX_KEPT_NOTICES);
  return notices;
}

/** The expiry effect for a fresh notice stack's latest entry (every
 *  kind, see NOTICE_TTL_MS); empty stacks schedule nothing. A stale
 *  timer expiring an already-replaced id is harmless:
 *  app.notice.expire filters by id.
 * @param {Array<object>} notices - the fresh notice stack
 * @returns {Array<object>} zero or one effects: effect.after(NOTICE_TTL_MS)
 *   expiring the latest entry; [] for an empty stack
 */
export function noticeExpiryEffect(notices) {
  const latest = notices.at(-1);
  return latest ? [effect.after(NOTICE_TTL_MS, { type: "app.notice.expire", id: latest.id })] : [];
}

/** One assistant turn's live preview: a fresh assembler per provider request.
 *  Agent emits terminal events only after persisting the authoritative final
 *  message, so neither terminal can leave a streamed preview in the view.
 * @param {object} model - the app model; model.live holds the current assembler
 * @param {object} event - a turn event (start opens a fresh assembler; done/error closes it)
 * @returns {?object} the assembler to keep streaming into, or null on a terminal event
 */
function nextLive(model, event) {
  if (event.type === "done" || event.type === "error") return null;
  const live = event.type === "start" ? assemblerCreate() : model.live;
  live?.consume(event);
  return live;
}

export function createUpdateCore({ key, slot, activeTurns, claimTurn, adapter, submit, closedAgents, reseatingAgents, catalogMatches, completionSources, viewed, cwd, env, applyMenuResolution, getTheme, blocksFor, updateQuestion, combo, notify, liveByOrigin, noteTime, thinkingKey, dropToolSanitizer, toolStreamFor, toolStreams, toolSanitizerFor, TOOL_STREAM_LIMIT, refreshCompletionCatalogEffect, copyWaiters, nextCopySequence, requestQuit }) {
  /** The GTUI update: exit-notice disarm first, then one case per message
   *  type — app lifecycle, copy/selection, completion answers, turn and
   *  tool events, task failures, question lifecycle, menus and scrolling.
   * @param {object} model - the app model
   * @param {object} message - the dispatched message ({type, ...})
   * @returns {{model: object, effects: Array<object>}} the next state
   */
  function updateCore(model, message) {
    // Any user-driven action but a repeated ctrl+c dismisses the "press
    // ^C again to exit" notice — parity with input-keys.js's "any other
    // key dismisses the exit notice", narrowed to messages a HUMAN
    // actually drives (see USER_DRIVEN_MESSAGE_TYPES): a background
    // A background turn event must never disarm a notice the user is still
    // deciding on. The prompt is transient footer state, never a
    // committed transcript item (inline scrollback cannot retract one).
    if (model.exitNotice && USER_DRIVEN_MESSAGE_TYPES.has(message.type) && !(message.type === "key" && message.key === "ctrl+c")) {
      model = { ...model, exitNotice: false };
    }
    switch (message.type) {
      case "app.quit":
        return requestQuit(model);
      case "app.notice.expire":
        return { model: { ...model, notices: model.notices.filter((notice) => notice.id !== message.id) }, effects: [] };
      case "app.copy.request":
        return { model, effects: [effect.copy(message.text, message.id)] };
      case "copy.done": {
        const waiter = copyWaiters.get(message.id);
        if (waiter) {
          copyWaiters.delete(message.id);
          waiter(message.ok === true);
          return { model, effects: [] };
        }
        const copyId = String(message.id);
        const subject = copyId.startsWith("input-copy:") || copyId.startsWith("transcript-copy:") ? "selection" : "block";
        const text = message.ok ? `copied ${subject} to the clipboard` : "clipboard unavailable (OSC 52 and system tools failed)";
        const notified = notify(model, { text, kind: message.ok ? "notice" : "error" });
        return { model: { ...model, notices: notified.notices }, effects: notified.effects };
      }
      case "selection.copy":
        return message.text
          ? { model, effects: [effect.copy(message.text, `transcript-copy:${nextCopySequence()}`)] }
          : { model, effects: [] };
      case "link.open":
        return { model, effects: typeof message.url === "string" ? [effect.open(message.url)] : [] };
      case "action.select":
        return key(model, message);
      case "toolbar.change":
        return { model: { ...model, toolbarKey: message.key ?? null }, effects: [] };
      case "selection.change":
        // GTUI owns the mouse selection highlight; the app only primes its
        // resolved text so the keyboard Copy key — the same key that copies
        // an input's Shift-selection — copies it (selection.copy is GTUI's
        // own immediate gesture; both land on the same copy.done notice).
        return { model: { ...model, transcriptSelection: message.text ?? null }, effects: [] };
      case "app.fillInput":
        return { model: { ...model, input: insertText(model.input, message.text) }, effects: [] };
      case "app.continue": {
        const origin = slot.current();
        if (activeTurns.has(origin)) return { model, effects: [] };
        claimTurn(origin);
        return { model: { ...model, turnRunning: true }, effects: [adapter.turnEffect()] };
      }
      case "app.compact": {
        // /context-compact — a real effect, never the router's "not
        // available" fallback: the same per-agent turn claim as
        // app.continue, then ONE guarded-off summarization run whose
        // events stream like any turn (see adapter.compactEffect).
        const origin = slot.current();
        if (activeTurns.has(origin)) return { model, effects: [] };
        claimTurn(origin);
        return { model: { ...model, turnRunning: true }, effects: [adapter.compactEffect(message.focus)] };
      }
      case "agent.submit":
        return submit(model, message.text);
      case "agent.close.marked":
        closedAgents.add(message.origin);
        if (message.origin !== slot.current() || reseatingAgents.has(message.origin)) return { model, effects: [] };
        return { model: { ...model, closedInput: true }, effects: [] };
      case "agent.interrupt":
        return activeTurns.has(slot.current()) ? { model, effects: [adapter.interruptEffect()] } : { model, effects: [] };
      case "viewer.tools.ready":
        if (message.request !== model.toolCatalog?.request || !catalogMatches(model.toolCatalog)) return { model, effects: [] };
        return { model: { ...model, toolCatalog: { ...model.toolCatalog, text: message.text } }, effects: [] };
      case "completion.catalog.ready":
        // The thunk has updated its cache. Do not alter the draft, popup, or
        // overlay: a late catalogue must never steal focus or selection.
        return { model, effects: [effect.refresh()] };
      case "context.windows.ready":
        return { model, effects: [effect.refresh()] };
      case "completion.path.ready": {
        const request = message.request;
        // A lookup belongs only to the exact draft/cursor/current session that requested it.
        if (model.overlay || model.question || slot.current() !== request.agent || model.completionGeneration !== request.generation || request.nonce !== model.completionRequest || model.input.value !== request.value || model.input.caret !== request.caret || model.input.completions.length > 0) return { model, effects: [] };
        const found = computeCompletions(request.value, request.caret, { listDir: () => message.entries });
        const exact = found.candidates.includes(request.value.slice(found.start, found.end));
        const opened = { ...model.input, completions: exact ? [] : found.candidates, completionStart: exact ? 0 : found.start, completionEnd: exact ? 0 : found.end, completionIndex: 0 };
        // This is the delayed half of an explicit Tab, so it follows the
        // synchronous path and immediately previews its first candidate.
        const input = opened.completions.length > 0 ? cycleCompletions(opened, request.direction ?? 0) : opened;
        return { model: { ...model, input }, effects: [] };
      }
      case "input.change":
        // Any input caret/selection gesture (keyboard or mouse) retires a
        // primed transcript mouse selection — one primed selection at a time.
        model = model.transcriptSelection ? { ...model, transcriptSelection: null } : model;
        if (message.id === QUESTION_INPUT_ID && model.overlay?.type === "viewer-filter") return { model: { ...model, overlay: { ...model.overlay, focus: "input", draft: message.value ?? "", caret: message.caret, selection: message.selection ?? null } }, effects: [] };
        if (message.id === QUESTION_INPUT_ID) {
          const state = model.question.state;
          const selections = [...(state.selections ?? [])];
          if (currentQuestion(state).multiSelect !== true && (message.value ?? "") !== "") selections[state.index] = [];
          return { model: { ...model, question: { ...model.question, focus: "input", menuTarget: null,
            state: { ...state, selections }, draft: message.value ?? "", caret: message.caret, selection: message.selection ?? null } }, effects: [adapter.resetTimeoutEffect()] };
        }
        return { model: { ...model, input: applyChange(model.input, message, completionSources), completionGeneration: model.completionGeneration + 1 }, effects: [] };
      case "input.submit":
        // In ask-style flows Enter edits/selects; it never commits. Typed
        // answers are committed only through the explicit Submit menu row.
        if (message.id === QUESTION_INPUT_ID && model.overlay?.type === "viewer-filter") return { model, effects: [] };
        if (message.id === QUESTION_INPUT_ID) return { model: { ...model, question: { ...model.question, focus: "menu", menuTarget: "submit", menuToken: `${currentQuestion(model.question.state).header}:submit`, caret: 0, selection: null } }, effects: [adapter.resetTimeoutEffect()] };
        {
          const outcome = submitOrContinue(model.input, completionSources, message.value);
          if (outcome.continued) return { model: { ...model, input: outcome.input }, effects: [] };
          return submit(model, outcome.value, outcome.input);
        }
      case "key":
        return key(model, message);
      case "paste":
        // Only an unfocused input lets a paste reach the app (the toolbar
        // declines it): return to the input with the pasted text, as typing does.
        if (model.focus !== "toolbar" || model.overlay || model.question) return { model, effects: [] };
        return { model: { ...model, focus: "input", input: insertText(model.input, attachmentPaste(String(message.text ?? ""), { cwd: env?.cwd ?? cwd })) }, effects: [] };
      case "menu.change": {
        // The question menu OWNS its highlight: the option under the
        // cursor carries its description/preview in the view (its
        // extra information shows only while highlighted), so every
        // highlight move is model state.
        if (message.id === QUESTION_MENU_ID && model.question) {
          const label = message.item?.value?.type === "question.toggle" ? message.item.value.label : null;
          return label === (model.question.highlight ?? null) ? { model, effects: [] }
            : { model: { ...model, question: { ...model.question, highlight: label } }, effects: [] };
        }
        if (message.id !== MENU_ID || model.overlay?.type !== "menu") return { model, effects: [] };
        const preview = message.item?.preview;
        const tokens = preview?.type === "theme" ? resolveTheme({ tui: { theme: preview.name, themes: env?.settings?.tui?.themes ?? {} } }) : getTheme();
        return { model: { ...model, overlay: previewMenu(model.overlay, preview) }, effects: [effect.theme(tokens)] };
      }
      case "menu.select":
        if (message.id === QUESTION_MENU_ID && model.overlay?.type === "viewer-filter") {
          const value = message.item.value;
          if (value?.type === "question.custom") return { model: { ...model, overlay: { ...model.overlay, focus: "input" } }, effects: [] };
          if (value?.type === "question.submit") {
            const viewer = { ...model.overlay.viewer, filters: model.overlay.filters, search: model.overlay.draft };
            return { model: { ...model, overlay: reconcileViewer(viewer, blocksFor({ ...model, overlay: viewer })) }, effects: [] };
          }
          const label = value?.label ?? value;
          const filters = label === "Clear filters" ? [] : model.overlay.filters.includes(label)
            ? model.overlay.filters.filter((item) => item !== label) : [...model.overlay.filters, label];
          return { model: { ...model, overlay: { ...model.overlay, filters, ...(label === "Clear filters" ? { draft: "" } : {}) } }, effects: [] };
        }
        if (message.id === QUESTION_MENU_ID && model.question) {
          const value = message.item.value;
          if (value?.type === "question.read") return { model: { ...model, question: { ...model.question, reading: true } }, effects: [] };
          // Selection only changes draft state. Answers are committed solely
          // by menu/input submit (Enter), never by Space, click, or another
          // selection key.
          if (value?.type === "question.custom") return { model: { ...model, question: { ...model.question, focus: "input", menuTarget: null } }, effects: [] };
          if (value?.type === "question.submit") {
            const draft = model.question.draft ?? "";
            return draft !== ""
              ? updateQuestion(model, answerWithText(model.question.state, draft))
              : updateQuestion(model, answerWithLabels(model.question.state, selectedLabels(model.question.state)));
          }
          const label = value?.type === "question.toggle" ? value.label : value;
          const question = currentQuestion(model.question.state);
          const selections = [...(model.question.state.selections ?? [])];
          if (question.multiSelect === true) return { model: { ...model, question: { ...model.question, menuTarget: null, state: toggleLabel(model.question.state, label) } }, effects: [adapter.resetTimeoutEffect()] };
          // Single-select Enter: the answer is recorded AND the menu
          // highlight moves to the Submit row for confirmation — the
          // same jump the custom-input's Enter performs. Committing
          // still takes the explicit Submit row (or the input Enter),
          // never this selection alone. The LATCHED menuToken
          // (question.menuToken → the view's menu stateKey) re-applies
          // that Submit highlight on every render until the next
          // highlight move — a per-render stateKey would hand GTUI a
          // fresh menu each frame, swallowing Enter.
          selections[model.question.state.index] = [label];
          const header = currentQuestion(model.question.state).header;
          return { model: { ...model, question: { ...model.question, menuTarget: "submit", menuToken: `${header}:submit`, highlight: null, draft: "", state: { ...model.question.state, selections } } }, effects: [adapter.resetTimeoutEffect()] };
        }
        if (!model.overlay || !message.item?.value) return { model, effects: [] };
        return applyMenuResolution(model, resolveMenuAction(message.item.value, env));
      case "menu.submit":
        if (message.id === QUESTION_MENU_ID && model.overlay?.type === "viewer-filter") {
          const viewer = { ...model.overlay.viewer, filters: model.overlay.filters, search: model.overlay.draft };
          return { model: { ...model, overlay: reconcileViewer(viewer, blocksFor({ ...model, overlay: viewer })) }, effects: [] };
        }
        if (message.id === QUESTION_MENU_ID && model.question) {
          const value = message.item?.value;
          const fallback = value?.type === "question.toggle" ? value.label : value;
          const labels = selectedLabels(model.question.state);
          const selected = labels.length > 0 ? labels : [fallback].filter((item) => typeof item === "string");
          return updateQuestion(model, answerWithLabels(model.question.state, selected));
        }
        return { model, effects: [] };
      case "menu.cancel":
        if (message.id === QUESTION_MENU_ID && model.overlay?.type === "viewer-filter") return { model: { ...model, overlay: model.overlay.viewer }, effects: [] };
        if (message.id === QUESTION_MENU_ID && model.question) return updateQuestion(model, abandonQuestions(model.question.state));
        // Escape/Ctrl+C closes the complete modal from every menu depth.
        // Explicit "← back" rows still use resolveMenuAction("pop").
        return model.overlay ? { model: { ...model, overlay: null }, effects: [effect.theme(getTheme())] } : { model, effects: [] };
      case "scroll.change":
        if (message.id === TRANSCRIPT_SCROLL_ID) return { model: { ...model, transcriptOffset: Math.max(0, message.offset ?? 0) }, effects: [] };
        if (message.id === VIEWER_ID && model.overlay?.type === "viewer") {
          return { model: { ...model, overlay: { ...model.overlay, offset: Math.max(0, message.offset ?? 0) } }, effects: [] };
        }
        return { model, effects: [] };
      case "app.overlay.openMaster":
        return { model: { ...model, overlay: openMenu("Menu", buildMenuItems(masterMenuOptions(viewed, env, combo(), { catalog: completionSources.catalog?.() }))), completionGeneration: model.completionGeneration + 1 }, effects: [] };
      case "app.overlay.openLogin":
        return applyMenuResolution({ ...model, completionGeneration: model.completionGeneration + 1 }, resolveMenuAction({ type: "login" }, env));
      case "app.log": {
        const notified = notify(model, { text: message.text, kind: "notice" }, { replace: true });
        return { model: { ...model, notices: notified.notices }, effects: notified.effects };
      }
      case "app.oauth.log": {
        const notified = notify(model, { text: message.text, kind: message.kind ?? "notice" });
        return { model: { ...model, notices: notified.notices }, effects: notified.effects };
      }
      case "app.oauth.authUrl": {
        const notified = notify(model, { text: `authorize: ${message.url}`, kind: "notice" });
        return { model: { ...model, notices: notified.notices }, effects: [...notified.effects, effect.open(message.url)] };
      }
      case "agent.throttle.tick":
        return viewed.throttledUntil ? { model: { ...model }, effects: [] } : { model, effects: [] };
      case "agent.turn.event": {
        const origin = message.origin ?? slot.current();
        const saved = liveByOrigin.get(origin) ?? { live: null, contextLength: null };
        const live = nextLive({ ...model, live: saved.live }, message.event);
        const contextLength = message.event.type === "start" ? origin.context.length : live ? saved.contextLength : null;
        if (live) liveByOrigin.set(origin, { live, contextLength }); else liveByOrigin.delete(origin);
        const thinkingEdge = { thinking_start: "started", thinking_end: "ended" }[message.event.type];
        if (thinkingEdge && contextLength !== null) noteTime(thinkingKey(origin, contextLength, message.event.contentIndex ?? 0), thinkingEdge);
        if (origin !== slot.current()) return { model, effects: [] };
        const notified = notify(model, noticeFor(message.event));
        return { model: {
          ...model, live, liveOrigin: live ? origin : null, liveContextLength: contextLength,
          notices: notified.notices,
        }, effects: notified.effects };
      }
      case "agent.tool.event": {
        const origin = message.origin ?? slot.current();
        // Agent has appended the outcome before calling this hook. Remove only
        // that call's ephemeral stream now, so the persisted result replaces it
        // immediately at the call's transcript position rather than duplicating it.
        if (message.event?.type === "tool.execute" && message.event.call?.callId !== undefined) noteTime(`call:${message.event.call.callId}`, "started");
        if (message.event?.type === "tool.result") {
          const callId = message.event.result?.callId;
          if (callId !== undefined) noteTime(`call:${callId}`, "ended");
          dropToolSanitizer(origin, callId);
          const lines = toolStreamFor(origin);
          const remaining = lines.filter((entry) => entry.callId !== callId);
          if (remaining.length > 0) toolStreams.set(origin, remaining); else toolStreams.delete(origin);
          // a tool may have changed its live status (the catalog snapshot)
          if (origin === slot.current()) return { model: { ...model, toolStream: [...remaining] }, effects: [refreshCompletionCatalogEffect()] };
        }
        if (origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model }, effects: [] };
      }
      case "agent.tool.data": {
        const origin = message.origin ?? slot.current();
        const lines = toolStreamFor(origin);
        const sanitizer = toolSanitizerFor(origin, message.call?.callId);
        lines.push({ callId: message.call?.callId, tool: message.call?.name ?? "tool", text: sanitizer.push(String(message.chunk ?? "")) });
        if (lines.length > TOOL_STREAM_LIMIT) lines.splice(0, lines.length - TOOL_STREAM_LIMIT);
        if (origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model, toolStream: [...lines] }, effects: [] };
      }
      case "agent.queue.changed":
        if (message.origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model, pendingCount: message.pendingCount }, effects: [] };
      case "agent.turn.settled": {
        const origin = message.origin ?? slot.current(); // legacy adapter compatibility
        activeTurns.delete(origin);
        liveByOrigin.delete(origin);
        toolStreams.delete(origin);
        if (origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model, live: null, liveOrigin: null, liveContextLength: null, turnRunning: false, pendingCount: message.pendingCount, toolStream: [] }, effects: [] };
      }
      case "agent.turn.failed": {
        const origin = message.origin ?? slot.current();
        activeTurns.delete(origin);
        liveByOrigin.delete(origin);
        toolStreams.delete(origin);
        if (origin !== slot.current()) return { model, effects: [] };
        const failed = { ...model, live: null, liveOrigin: null, liveContextLength: null, turnRunning: false, pendingCount: origin.pending?.length ?? 0, toolStream: [] };
        const notified = notify(failed, { text: `turn failed: ${message.error?.message ?? message.error ?? "unknown error"}`, kind: "error" });
        return { model: { ...failed, notices: notified.notices }, effects: notified.effects };
      }
      case "task.failed": {
        // Compatibility for callers/tests using the pre-origin stable key.
        // Adapter-owned turns convert throws into agent.turn.failed above.
        if (message.key !== "agent.turn") {
          const notified = notify(model, taskFailureNotice(message));
          return { model: { ...model, notices: notified.notices }, effects: notified.effects };
        }
        const origin = slot.current();
        activeTurns.delete(origin);
        liveByOrigin.delete(origin);
        const failed = { ...model, turnRunning: false, pendingCount: viewed.pending?.length ?? model.pendingCount };
        const notified = notify(failed, taskFailureNotice(message));
        return { model: { ...failed, notices: notified.notices }, effects: notified.effects };
      }
      case "agent.question.opened":
        if (message.origin && message.origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model, question: { requestId: message.requestId, state: createQuestionnaire(message.questions), focus: "menu", draft: "", highlight: null, menuTarget: null, menuToken: undefined } }, effects: [] };
      case "agent.question.timed-out":
        if (message.origin && message.origin !== slot.current()) return { model, effects: [] };
        return { model: { ...model, question: null }, effects: [] };
      default:
        return { model, effects: [] };
    }
  }

  return updateCore;
}
