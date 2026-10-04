/**
 * lib/tui-app/app.js — the ai application on GTUI: a plain
 * {init, update, view, bindings} app (see lib/gtui/gtui.js's `run`
 * contract). Owns the agent-turn/question lifecycle
 * (createAgentAdapter), the transcript (contextBlocks -> GTUI feed
 * items, transcript.js), the draft input + status bar, and overlays
 * as model sub-states: the ^X/^P/^M menus and ^O block viewer
 * (overlay-controller.js), the questionnaire's real menu+input UI
 * (questionnaire-view.js), and session switching (agent-slot.js).
 * Slash commands (typed or menu-triggered) run through the SAME
 * already-tested router (commands.js) legacy used. Dispatched by
 * lib/tui.js through run.js in both inline and alternate-screen modes.
 */

import { view as v, effect } from "../gtui/gtui.js";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import Context from "../../context.js";
import Markdown from "../markdown/index.js";
const { sanitizeText, BashSanitizer } = Markdown;
const { assemblerCreate, messageHasError } = Context;
import Agent from "../../agent.js";
const { reseat } = Agent;
import CLI from "../../cli.js";
const { loginEndpoint, listEndpointModels } = CLI;
import { createAgentAdapter, msg } from "./agent-adapter.js";
import { createAgentSlot } from "./agent-slot.js";
import { createCommands } from "./commands.js";
import { NAMES } from "../../namespace.js";
import Env from "../../env.js";
import IO from "../../io.js";
import { contextBlocks } from "./context-blocks.js";
import { createTranscriptProjector, noticeItems } from "./transcript.js";
import { statusData } from "./status-data.js";
import { statusView } from "./status-view.js";
import { informationData } from "./information-data.js";
import { informationView } from "./information-view.js";
import {
  initialInput, historyFromContext, applyChange, openCompletions, cycleCompletions, acceptCompletion,
  dismissCompletions, recallDrained, navigateHistory, submitOrContinue,
  clearInput, insertText, selectedText,
} from "./input-controller.js";
import { appBindings, resolveKeymap } from "./bindings.js";
import {
  createQuestionnaire, currentQuestion, moveQuestion, selectedLabels, toggleLabel,
  answerWithLabels, answerWithText, abandonQuestions,
} from "./questionnaire.js";
import { questionView, QUESTION_MENU_ID, QUESTION_INPUT_ID } from "./questionnaire-view.js";
import { openMenu, pushMenu, popMenu, previewMenu, openViewer, moveViewer, hopViewer, filterViewerBlocks, reconcileViewer } from "./overlay-controller.js";
import { overlayView, MENU_ID, VIEWER_ID } from "./overlay-view.js";
import { TRANSCRIPT_SCROLL_ID } from "./transcript-navigation.js";
import { resolveMenuAction } from "./menu-actions.js";
import { masterMenuOptions, endpointMenuOptions, modelMenuOptions } from "./menu-sources.js";
import { buildMenuItems, buildEndpointItems, buildProviderItems, buildSpawnPermissionItems } from "./contracts.js";
import { resolveTheme, themePreviewRows } from "./theme-data.js";
import { createCompletionSources } from "./completion-sources.js";
import { welcomeView } from "./welcome-view.js";
import { computeCompletions } from "./completion.js";
import { queueView } from "./queue-view.js";
import { attachmentChips, attachmentPaste, hasAttachment } from "./attachment-draft.js";
import { formatBytes } from "../shared/format.js";
import { toolCatalogText } from "../shared/tool-catalog.js";

const MAX_KEPT_NOTICES = 20;
/** Every notice is transient: it expires from the visible stack after
 *  this delay (errors expire like copy/endpoint notices — the failure
 *  has to be SEEN, not archived forever). */
const NOTICE_TTL_MS = 8_000;
const EXIT_NOTICE_TEXT = "press ^C again to exit";
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
function initialModel(history = []) {
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
function appendNotice(model, notice) {
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
function noticeExpiryEffect(notices) {
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

/**
 * @param {object} agent - the Agent this app starts on ("main")
 * @param {object} [options]
 * @param {object} [options.env] - Env, for status/menu facts
 * @param {string} [options.cwd] - the process working folder
 * @param {object} [options.sources] - lib/tui-app/completion.js sources
 * @param {object} [options.completionIO] - completion filesystem hooks
 *   ({listDir}); defaults to real directory reads resolved under cwd
 * @param {(url: string) => void} [options.open] - browser opener handed to
 *   the OAuth flow; undefined uses the flow's system-browser default
 * @param {(line: string) => void} [options.log] - an external diagnostics
 *   mirror (piped `--input` runs: stdout IS the terminal byte stream,
 *   not human-parseable, so the caller may want every notice ALSO
 *   written somewhere plain — parity with the legacy engines' `log` option)
 * @returns {{init: Function, update: Function, view: Function, bindings: Function}}
 */
export function createApp(agent, { env, cwd = "", sources, completionIO, log, open, columns, rows } = {}) {
  const terminalWidth = () => typeof columns === "function" ? columns() : (columns ?? 80);
  const terminalHeight = () => typeof rows === "function" ? rows() : (rows ?? 24);
  const slot = createAgentSlot(agent);
  const viewed = slot.agent; // every read/call forwards to the CURRENT agent — a switch needs no other change
  const completionSources = sources ?? createCompletionSources(viewed, env);
  const listDir = completionIO?.listDir ?? (async (dir) => readdir(resolve(cwd || ".", dir), { withFileTypes: true }));
  /** Every notice that reaches the transcript ALSO reaches the external
   *  diagnostics mirror, when the caller gave one — the one place both
   *  command output (createCommands' own log hook, below) and turn
   *  errors (noticeFor()) funnel through.
   * @param {object} model - the app model; its notice stack is appended to
   * @param {?object} notice - the notice to mirror and stack; null skips both
   * @param {object} [options]
   * @param {boolean} [options.replace=false] - true clears the existing stack first
   * @returns {{notices: Array<object>, effects: Array<object>}} the next stack
   *   plus the expiry effect for its latest entry ([] when notice is null)
   */
  const notify = (model, notice, { replace = false } = {}) => {
    if (notice) log?.(typeof notice.text === "string" ? notice.text : JSON.stringify(notice.text));
    const base = replace ? { ...model, notices: [] } : model;
    const notices = appendNotice(base, notice);
    // Callers receive the expiry effect alongside the stack: notices
    // disappear on their own instead of accumulating forever (previously
    // only the app.log command-output path scheduled one).
    return { notices, effects: notice ? noticeExpiryEffect(notices) : [] };
  };
  // The opening is display-only; it is not a Context message.
  log?.(`${NAMES.Namespace} · ${viewed.model ?? "(none)"}`);
  const adapter = createAgentAdapter(viewed);
  /** A 1 Hz clock: sends agent.throttle.tick once a second until aborted, so
   *  a provider throttle countdown in the status bar keeps repainting.
   * @returns {object} a GTUI task effect keyed "agent.throttle-clock" */
  const throttleEffect = () => effect.task("agent.throttle-clock", async ({ send, signal }) => {
    while (!signal.aborted) {
      await new Promise((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 1000);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!signal.aborted) send({ type: "agent.throttle.tick" });
    }
  });
  // Running state and live previews belong to REAL agents, never the viewed
  // slot. A switch therefore neither cancels nor hides another session's work.
  const activeTurns = new Set();
  const closedAgents = new WeakSet();
  // Reseat closes the replaced Agent before moving the slot. Its close event
  // can dispatch during that narrow interval, when the old Agent still looks
  // current; it must not disable the fresh session's draft.
  const reseatingAgents = new WeakSet();
  const liveByOrigin = new WeakMap();
  /** Slot-switch hook: once the CLOSE_MARKED promise (the UI holds the
   *  agent until navigation) resolves, drop app-owned per-agent state.
   * @param {object} _next - the agent being switched to (unused)
   * @param {object} prev - the agent being switched away from */
  slot.onSwitch((_next, prev) => {
    // CLOSE_MARKED promised that the UI is the final holder until navigation.
    // Drop app-owned per-agent state as soon as that navigation occurs.
    if (closedAgents.has(prev)) {
      activeTurns.delete(prev);
      liveByOrigin.delete(prev);
      toolStreams.delete(prev);
    }
  });
  // Live tool OUTPUT per origin (a running bash command's streamed
  // lines): bounded to the tail, cleared when the turn settles —
  // display-only, never part of the context.
  const TOOL_STREAM_LIMIT = 200;
  const toolStreams = new WeakMap();
  // One streaming sanitizer PER TOOL CALL (origin × callId): the look-back
  // buffer that catches escape sequences split across chunks must never be
  // shared between concurrent calls. Untrusted chunks are sanitized at
  // this ingest boundary; the Agent's persisted result stays byte-exact.
  const toolSanitizers = new WeakMap();
  /** Get (or lazily create) the streaming sanitizer for one tool call.
   * @param {object} origin - the Agent that owns the call
   * @param {*} callId - the call identifier (defaults to "tool")
   * @returns {object} a BashSanitizer private to (origin, callId) */
  const toolSanitizerFor = (origin, callId) => {
    let byCall = toolSanitizers.get(origin);
    if (byCall === undefined) { byCall = new Map(); toolSanitizers.set(origin, byCall); }
    const key = String(callId ?? "tool");
    let sanitizer = byCall.get(key);
    if (sanitizer === undefined) { sanitizer = new BashSanitizer({ markdown: true }); byCall.set(key, sanitizer); }
    return sanitizer;
  };
  /** Drop a finished call's sanitizer (and the origin's map once empty).
   * @param {object} origin - the Agent that owned the call
   * @param {*} callId - the finished call's identifier */
  const dropToolSanitizer = (origin, callId) => {
    const byCall = toolSanitizers.get(origin);
    if (byCall === undefined) return;
    byCall.delete(String(callId ?? "tool"));
    if (byCall.size === 0) toolSanitizers.delete(origin);
  };
  // Start/end times (display-only, like the streams above): how long each
  // tool call ran ("call:<callId>") and each reasoning block streamed
  // ("thinking:<agent>:<message>:<content index>"). Bounded to the most
  // recent entries; a resumed session simply shows no durations.
  const TIMING_LIMIT = 512;
  const timings = new Map();
  const agentSerials = new WeakMap();
  let nextAgentSerial = 0;
  /** Timing key for a thinking block: "thinking:<agent serial>:<message>:<content>".
   * @param {object} origin - the Agent (assigned a stable serial on first use)
   * @param {number} messageIndex - index of the message in the context
   * @param {number} contentIndex - index of the content part within the message
   * @returns {string} the timings-map key */
  const thinkingKey = (origin, messageIndex, contentIndex) => {
    if (!agentSerials.has(origin)) agentSerials.set(origin, nextAgentSerial++);
    return `thinking:${agentSerials.get(origin)}:${messageIndex}:${contentIndex}`;
  };
  /** Stamp one edge (start/end) of a timed span, evicting the oldest entry
   *  beyond TIMING_LIMIT; an existing stamp is preserved via re-insertion.
   * @param {string} key - a timings key ("call:<callId>" or thinkingKey(...))
   * @param {string} field - "started" or "ended" */
  const noteTime = (key, field) => {
    const times = timings.get(key) ?? {};
    timings.delete(key);
    timings.set(key, { ...times, [field]: Date.now() });
    if (timings.size > TIMING_LIMIT) timings.delete(timings.keys().next().value);
  };
  /** Mark an Agent as running a turn: future submits queue instead of
   *  starting a second task. Idempotent (Set semantics).
   * @param {object} origin - the Agent whose turn is being claimed
   * @returns {Set} the active-turns set */
  const claimTurn = (origin) => activeTurns.add(origin);
  /** Elapsed milliseconds for a fully stamped span.
   * @param {string} key - a timings key
   * @returns {?number} ended - started, or undefined until both edges exist */
  const durationOf = (key) => {
    const times = timings.get(key);
    return times?.started !== undefined && times.ended !== undefined ? times.ended - times.started : undefined;
  };
  /** Get (or lazily create) an origin's live tool-output line buffer.
   * @param {object} origin - the Agent streaming tool output
   * @returns {Array<object>} its mutable line array */
  const toolStreamFor = (origin) => {
    let lines = toolStreams.get(origin);
    if (lines === undefined) { lines = []; toolStreams.set(origin, lines); }
    return lines;
  };
  /** Whether the CURRENTLY VIEWED agent has a claimed, unsettled turn.
   * @returns {boolean} */
  const viewedRunning = () => activeTurns.has(slot.current());
  /** Re-attach the viewed agent's saved live preview/running state to a
   *  model after a session switch (per-origin state outlives the view).
   * @param {object} model - the app model
   * @returns {object} a copy with turnRunning/pendingCount/live* refreshed */
  const attachViewedLive = (model) => {
    const origin = slot.current();
    const saved = liveByOrigin.get(origin);
    return { ...model, turnRunning: viewedRunning(), pendingCount: origin.pending?.length ?? 0,
      live: saved?.live ?? null, liveOrigin: saved ? origin : null,
      liveContextLength: saved?.contextLength ?? null };
  };
  let theme = resolveTheme(env?.settings ?? {});
  const keymap = resolveKeymap(env?.settings ?? {});
  const mapped = (action, key) => [].concat(keymap[action] ?? []).includes(key);
  const previewRows = themePreviewRows(theme);
  let projector = createTranscriptProjector({ previewRows });
  let projectedAgent = null;
  let projectedContext = null;
  let feedSerial = 0;
  let feedId = "transcript:0";
  /** Rebuild the transcript projector (and bump the feed id) when the
   *  viewed Agent or its Context instance changes; a no-op otherwise. */
  const refreshProjection = () => {
    const real = slot.current();
    if (real !== projectedAgent || real.context !== projectedContext) {
      projectedAgent = real;
      projectedContext = real.context;
      projector = createTranscriptProjector({ previewRows });
      feedId = `transcript:${++feedSerial}`;
    }
  };
  /** "provider/model" identity text, ALWAYS read live off the viewed
   *  agent — a session switch must never show a stale combo. */
  const combo = () => viewed.model ?? "(none)/(none)";
  /** All transcript blocks for the viewed session: context messages plus
   *  the live preview and tool stream, with known durations stamped on.
   * @param {object} model - the app model (live/toolStream are read)
   * @returns {Array<object>} blocks in transcript order */
  const allBlocksFor = (model) => {
    const live = model.live && model.liveOrigin === slot.current() && viewed.context.length <= (model.liveContextLength ?? Infinity)
      ? model.live.message() : null;
    // Tool output is an open, display-only transcript projection. It never
    // enters Context: the Agent appends the authoritative final result.
    const blocks = contextBlocks(viewed.context.messages(), live, model.toolStream);
    for (const block of blocks) {
      const key = block.type === "toolcall" && block.callId !== undefined ? `call:${block.callId}`
        : block.type === "thinking" ? thinkingKey(slot.current(), block.message, block.contentIndex) : null;
      const duration = key === null ? undefined : durationOf(key);
      if (duration !== undefined) block.duration = duration;
    }
    return blocks;
  };
  /** The viewer sub-state, unwrapping a viewer-filter overlay to its inner
   *  viewer so filtering keeps the underlying selection visible.
   * @param {object} model - the app model
   * @returns {?object} the viewer state, or null when no viewer is open */
  const viewerState = (model) => model.overlay?.type === "viewer-filter" ? model.overlay.viewer : model.overlay;
  /** The transcript blocks after the viewer's type/search filters.
   * @param {object} model - the app model
   * @returns {Array<object>} the filtered blocks */
  const blocksFor = (model) => filterViewerBlocks([toolCatalogBlock(model), ...allBlocksFor(model)], viewerState(model));
  let toolCatalogRequest = 0;
  const catalogMatches = (catalog) => catalog?.agent === slot.current() && catalog.selector === viewed.model && catalog.safe === viewed.safe;
  function toolCatalogBlock(model) {
    const text = catalogMatches(model.toolCatalog) ? model.toolCatalog.text : "Loading published tools…";
    return { type: "system", category: "system", label: "Tools", virtual: true, message: -1, group: "published-tools", open: false, text };
  }
  function refreshToolCatalog(model) {
    const agent = slot.current();
    const catalog = { agent, selector: agent.model, safe: agent.safe, request: ++toolCatalogRequest, text: "Loading published tools…" };
    const task = effect.task("viewer.tools", async ({ send, signal }) => {
      let text;
      try { text = toolCatalogText(await agent.tools ?? new Map()); }
      catch (error) { text = `Unable to load published tools: ${error?.message ?? error}`; }
      if (!signal.aborted) send({ type: "viewer.tools.ready", request: catalog.request, text });
    });
    return { model: { ...model, toolCatalog: catalog }, effects: [task] };
  }

  // The bridge a synchronous hook (commands.js's onMenu/onLogin, called
  // from deep inside an awaited command) uses to reach the CURRENT
  // task's `send` — the same pattern agent-adapter.js's question bridge
  // uses, for the same reason: dispatch always flows through the task
  // that's actively running, never a channel that outlives it.
  const sendRef = { current: null };
  /** Dispatch a message through the currently running task, if any.
   * @param {object} message - the app message to dispatch */
  const dispatchNow = (message) => sendRef.current?.(message);
  const copyWaiters = new Map();
  let copySequence = 0;
  /** Ask the app to copy text and await the clipboard outcome (commands.js
   *  /copy uses this).
   * @param {string} text - the text to copy
   * @returns {Promise<boolean>} resolves true on success; false immediately
   *   when no task can dispatch */
  const requestCopy = (text) => new Promise((resolve) => {
    const id = `command-copy:${++copySequence}`;
    if (!sendRef.current) return resolve(false);
    copyWaiters.set(id, resolve);
    dispatchNow({ type: "app.copy.request", id, text });
  });

  /** The ONE place "the app ends" means anything — /bye|/exit|/quit
   *  (onExit), a second idle-empty ^C, and ^D-on-empty all funnel here
   *  rather than each calling effect.quit() independently.
   * @param {object} model - the app model, returned unchanged
   * @returns {{model: object, effects: Array<object>}} the model plus effect.quit(0) */
  const requestQuit = (model) => ({ model, effects: [effect.quit(0)] });

  /** Create an independent, user-owned Agent and view it.
   * @param {object} options
   * @param {string} options.endpoint - endpoint name for the new session
   * @param {string} options.model - model name within the endpoint
   * Side effect: creates the Agent and switches the slot to it. */
  function addAgent({ endpoint, model }) {
    const current = slot.current();
    const fresh = current.env.agentCreate({
      model: `${endpoint}/${model}`,
      url: current.url,
      timeout: current.timeout,
      settings: current.settings,
      tools: current._toolSelection,
      safe: current.safe === true,
      contextId: randomUUID(),
      createIO: current._createIO,
      toolCall: current._toolCall,
    });
    (fresh.thinking = current.thinking);
    slot.switchTo(fresh);
  }

  /** Close an Agent and move the view before its asynchronous cleanup can strand it.
   * @param {object} agent - the Agent to close
   * @returns {boolean|string} false when the agent is missing/already closed;
   *   "quit" when the viewed agent closed with no replacement; true otherwise
   * Side effects: closes the agent and may switch the slot to another agent. */
  function closeAgent(agent) {
    if (!agent || agent.closed === true) return false;
    const current = slot.current();
    const agents = current.env?.agents?.() ?? env?.agents?.() ?? [];
    const index = agents.indexOf(agent);
    const replacement = agent === current && index >= 0
      ? agents.slice(index + 1).concat(agents.slice(0, index)).find((candidate) => candidate !== agent)
      : null;
    agent.close();
    if (replacement) slot.switchTo(replacement);
    return agent === current && !replacement ? "quit" : true;
  }

  /** Replace the viewed session with a fresh Agent.
   * @param {string} id - the new session id
   * @returns {object} the fresh session's Context
   * @throws {Error} when the viewed session's response is still running
   * Side effects: marks the old Agent as reseating, reseats, switches the slot. */
  function reseatNewSession(id) {
    const current = slot.current();
    if (current.busy) throw new Error("cannot replace a session while its response is running");
    reseatingAgents.add(current);
    const fresh = reseat(current, { id });
    slot.switchTo(fresh);
    return fresh.context;
  }

  const commands = createCommands({
    agent: viewed,
    copy: requestCopy,
    log: (text) => dispatchNow({ type: "app.log", text }),
    onMenu: () => dispatchNow({ type: "app.overlay.openMaster" }),
    onLogin: () => dispatchNow({ type: "app.overlay.openLogin" }),
    onExit: () => dispatchNow({ type: "app.quit" }),
    onFillInput: (text) => dispatchNow({ type: "app.fillInput", text }),
    onContinue: () => dispatchNow({ type: "app.continue" }),
    onCompact: (focus) => dispatchNow({ type: "app.compact", focus }),
    onReseat: (id) => reseatNewSession(id),
  });

  /** Runs one or more command lines IN ORDER, on the SAME task (a
   *  fresh task per line would collide on the "agent.command" key and
   *  cancel its predecessor mid-command — see GTUI's per-key task
   *  dedup).
   * @param {string[]} lines - the command lines, run sequentially
   * @returns {object} a task effect keyed "agent.command"; installs the
   *   question bridge and sendRef for the task's lifetime
   */
  function runCommandEffect(lines) {
    return effect.task("agent.command", async ({ send }) => {
      const origin = slot.current();
      const restoreQuestion = adapter.installQuestionBridge(send, origin);
      sendRef.current = send;
      try {
        for (const line of lines) await commands.handle(line);
      } finally {
        sendRef.current = null;
        restoreQuestion();
      }
    });
  }

  /** Browser sign-in for a chosen OAuth preset (the login picker's
   *  "(browser sign-in)" rows). Previously resolveMenuAction re-opened
   *  the preset picker — the same overlay Enter had just fired on — so
   *  the wizard flickered and reappeared without ever running a login.
   *  Here the real OAuth flow runs on its own task (kept OUT of the
   *  "agent.command" key so a late paste can't cancel it): the host
   *  opens the browser, progress lands as notices, /endpoint-oauth-paste
   *  stays available as the headless channel, and the resulting tokens
   *  log the endpoint in exactly like /endpoint-login does.
   * @param {object} preset - an OAuth preset ({name, label?, provider, url, oauth})
   * @returns {object} a task effect keyed "agent.oauth"; progress and
   *   failures surface as notices, never throw
   */
  function runOAuthLoginEffect(preset) {
    return effect.task("agent.oauth", async ({ send }) => {
      const logLine = (text, kind = "notice") => send({ type: "app.oauth.log", text, kind });
      try {
        logLine(`starting ${preset.label ?? preset.name} sign-in — the browser opens (headless? use /endpoint-oauth-paste)`);
        const tokens = await CLI.runOAuthFlow(preset.oauth, {
          onAuthUrl: (url) => send({ type: "app.oauth.authUrl", url }),
          onLog: (line) => logLine(line),
          open, // undefined: the flow's default system-browser opener
        });
        const result = await loginEndpoint(env, {
          name: preset.name, provider: preset.provider, url: preset.url,
          auth: CLI.tokensToAuth(tokens),
        });
        finishEndpointLogin(result);
        logLine(`endpoint saved: ${result.name} (${preset.provider} at ${preset.url}, package)`);
      } catch (error) {
        logLine(`sign-in failed: ${error?.message ?? error}`, "error");
      }
    });
  }

  /** Submit the draft: commands route to the router, whitespace-only text
   *  continues the turn silently, plain text enqueues and starts a turn.
   * @param {object} model - the app model
   * @param {string} text - the submitted text
   * @param {object} [input=clearInput(model.input)] - the input state to store (defaults cleared)
   * @returns {{model: object, effects: Array<object>}} the next state; a
   *   no-op when the input is closed or the session is close-marked
   */
  function submit(model, text, input = clearInput(model.input)) {
    if (model.closedInput || slot.current().closeMarked) return { model, effects: [] };
    // Whitespace-only input is a continue: the agent starts its turn
    // with the existing context and NO appended message — exactly what
    // /continue does (command-handlers.js's onContinue -> the
    // app.continue case below). The TUI stays silent: no message is
    // printed, no empty user turn lands in the transcript.
    if (text.trim() === "") {
      if (text === "") return { model: { ...model, input }, effects: [] };
      const origin = slot.current();
      if (activeTurns.has(origin)) return { model: { ...model, input }, effects: [] };
      claimTurn(origin);
      return { model: { ...model, turnRunning: true, input }, effects: [adapter.turnEffect()] };
    }
    if (text.startsWith("/")) return { model: { ...model, input, transcriptOffset: 0 }, effects: [runCommandEffect([text])] };
    const origin = slot.current();
    // Attachments must be assembled before a run is claimed. Agent.send()
    // starts idle delivery synchronously, so the ordinary queue+turn pair
    // races and can produce two turns.
    if (hasAttachment(text) && !activeTurns.has(origin)) {
      claimTurn(origin);
      return { model: { ...model, turnRunning: true, pendingCount: model.pendingCount + 1, input, transcriptOffset: 0 }, effects: [adapter.submitEffect(text)] };
    }
    const effects = [adapter.enqueueEffect(text)];
    // Claim before the task begins: a second submit in the same dispatch turn
    // is queue-only, while a switched session receives its own independent task.
    if (!activeTurns.has(origin)) { claimTurn(origin); effects.push(adapter.turnEffect()); }
    return { model: { ...model, turnRunning: true, pendingCount: model.pendingCount + 1, input, transcriptOffset: 0 }, effects };
  }

  /** Apply a questionnaire outcome: an incomplete one keeps the UI open
   *  (and resets the agent's answer timeout); a complete one resolves the
   *  pending question with its answers.
   * @param {object} model - the app model (model.question must be set)
   * @param {object} outcome - a questionnaire outcome ({complete, state?, answers?})
   * @returns {{model: object, effects: Array<object>}} the next state and
   *   either a timeout-reset or question-resolution effect
   */
  function updateQuestion(model, outcome) {
    const { requestId, focus, highlight } = model.question;
    if (!outcome.complete) {
      const draft = outcome.state.drafts[outcome.state.index] ?? "";
      return { model: { ...model, question: { requestId, state: outcome.state, focus, draft, highlight } }, effects: [adapter.resetTimeoutEffect()] };
    }
    return { model: { ...model, question: null }, effects: [adapter.resolveQuestionEffect(requestId, outcome.answers)] };
  }

  /** A finished endpoint login (direct form or OAuth) updates the viewed
   *  agent and the remembered combo — the same end state
   *  /endpoint-login's direct form lands in.
   * @param {object} result - the login result ({name, provider, url})
   * Side effect: selects the first known model, if available. */
  function finishEndpointLogin(result) {
    const current = slot.current();
    const model = listEndpointModels(current.env).find(({ name }) => name === result.name)?.models[0];
    if (model) (current.model = `${result.name}/${model}`);
  }

  /** A status-toolbar chip (status-view.js's CHIP_ACTIONS). Toggles run
   *  the same slash commands the ^X menu's items do, so they log the same
   *  notices; focus stays on the toolbar for the next toggle.
   * @param {object} model - the app model
   * @param {string} name - the chip name ("thinking" | "safe" | "logging")
   * @returns {{model: object, effects: Array<object>}} the next state
   */
  function statusAction(model, name) {
    switch (name) {
      case "thinking": {
        const current = viewed.thinking ?? "default";
        const items = ["default", ...IO.THINKING_LEVELS].map((value) => ({
          kind: "action", label: `${value}${current === value ? " (current)" : ""}`, value: { type: "thinking", value },
        }));
        return { model: { ...model, overlay: openMenu("Thinking", items) }, effects: [] };
      }
      case "safe": return applyMenuResolution(model, resolveMenuAction({ type: "safe", value: viewed.safe === true ? "off" : "on" }, env));
      // Logging is the store's one switch: turning it on writes the whole
      // conversation so far, whether or not it was ever logged before.
      case "logging": return applyMenuResolution(model, resolveMenuAction({ type: "session-save", value: !viewed.context.save }, env));
      default: return { model, effects: [] };
    }
  }

  /** Apply the outcome of a selected menu item (pop/push/run/switch/…).
   * @param {object} model - the app model
   * @param {object} resolved - resolveMenuAction's result ({kind, ...})
   * @returns {{model: object, effects: Array<object>}} the next state and
   *   any command/OAuth/quit/theme effects
   */
  function applyMenuResolution(model, resolved) {
    switch (resolved.kind) {
      case "pop": return { model: { ...model, overlay: model.overlay && popMenu(model.overlay) }, effects: [effect.theme(theme)] };
      case "push": return { model: { ...model, overlay: pushMenu(model.overlay, resolved.title, resolved.items) }, effects: [] };
      case "oauth-login": return { model: { ...model, overlay: null }, effects: [runOAuthLoginEffect(resolved.preset)] };
      case "switch-agent":
        if (resolved.agent && slot.switchTo(resolved.agent)) return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
        return { model: { ...model, overlay: null }, effects: [] };
      case "add-agent":
        addAgent(resolved);
        return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
      case "close-agent": {
        const result = closeAgent(resolved.agent);
        if (result === "quit") return requestQuit({ ...model, overlay: null });
        return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
      }
      case "insert": return { model: { ...model, overlay: null, input: insertText(model.input, resolved.text) }, effects: [] };
      case "command": return { model: { ...model, overlay: null }, effects: [runCommandEffect(resolved.lines)] };
      case "spawn-permission":
        (viewed.spawnPermission = resolved.value);
        return { model: { ...model, overlay: null }, effects: [] };
      case "theme": {
        // the menu lists only known themes; the settings view persists the choice
        if (env && (resolved.value === "default" || env.settings.tui.themes?.[resolved.value])) env.settings.tui.theme = resolved.value;
        theme = resolveTheme(env?.settings ?? {});
        return { model: { ...model, overlay: null }, effects: [effect.theme(theme)] };
      }
      default: return { model: { ...model, overlay: null }, effects: [] };
    }
  }

  /** Build a path-completion request for the word under the caret.
   * @param {object} input - the draft input state ({value, caret})
   * @returns {?object} {dir, value, caret, agent} for the completion task,
   *   or null when the word starts with "/" (a command, not a path)
   */
  function pathRequest(input) {
    const before = input.value.slice(0, input.caret);
    const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
    const word = before.slice(wordStart);
    if (word.startsWith("/")) return null;
    const slash = word.lastIndexOf("/");
    const dir = slash < 0 ? "." : (word.slice(0, slash + 1).replace(/\/$/, "") || ".");
    return { dir, value: input.value, caret: input.caret, agent: slot.current() };
  }

  /** Run one asynchronous filesystem listing for path completion.
   * @param {object} request - pathRequest's result
   * @returns {object} a task effect keyed "completion.path"; read errors
   *   resolve to an empty entry list, never throw
   */
  function pathCompletionEffect(request) {
    return effect.task("completion.path", async ({ send }) => {
      try {
        const entries = await listDir(request.dir);
        send({ type: "completion.path.ready", request, entries: entries.map((entry) => typeof entry === "string" ? entry : entry.name + (entry.isDirectory() ? "/" : "")) });
      } catch { send({ type: "completion.path.ready", request, entries: [] }); }
    });
  }

  /** Ask the completion sources to refresh their catalog; failures still
   *  send completion.catalog.ready so nothing waits forever.
   * @returns {object} a task effect keyed "completion.catalog" */
  function refreshCompletionCatalogEffect() {
    return effect.task("completion.catalog", async ({ send }) => {
      try { await completionSources.refresh?.(); send({ type: "completion.catalog.ready" }); }
      catch { send({ type: "completion.catalog.ready" }); }
    });
  }

  /** Env collects the model catalog in the background (context windows,
   *  live model lists); the status readout and menus read it
   *  synchronously, so each Env.EVENT.MODELS_CHANGED repaints once.
   * @returns {object} a task effect keyed "context.windows"; a no-op task
   *   when Env events are unavailable
   */
  function contextWindowsEffect() {
    return effect.task("context.windows", async ({ send, signal }) => {
      if (!env?.onEvent || !Env.EVENT.MODELS_CHANGED) return;
      const handle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => send({ type: "context.windows.ready" }));
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      env.offEvent(handle);
    });
  }

  /** Move the viewed slot through Env's current registry, wrapping at each end.
   * @param {number} direction - +1 for the next session, -1 for the previous
   * @returns {boolean} true when the slot switched; false with <2 agents or
   *   the current agent missing from the registry
   */
  function pageAgent(direction) {
    const agents = slot.current().env?.agents?.() ?? env?.agents?.() ?? [];
    const current = slot.current();
    const index = agents.indexOf(current);
    if (agents.length < 2 || index < 0) return false;
    return slot.switchTo(agents[(index + direction + agents.length) % agents.length]);
  }

  /** View the current session's parent agent, if it has one.
   * @returns {boolean} true when the slot switched to the parent */
  function switchParentAgent() {
    const parent = slot.current().parent;
    return parent ? slot.switchTo(parent) : false;
  }

  /** Every keyboard (and action.select) message: shortcut hints are
   *  rewritten to keys, then the first matching guard claims it — toolbar
   *  focus, session paging/fork, interrupt/exit policy, completions,
   *  history, copy, overlay menus/viewer, and the questionnaire.
   * @param {object} model - the app model
   * @param {object} message - a "key" message ({key, text?}) or an
   *   action.select whose action starts with "shortcut."
   * @returns {{model: object, effects: Array<object>}} the next state
   */
  function key(model, message) {
    // A clicked hint IS its key: convert before any key handling, so it
    // takes exactly the path the key would (Esc interrupt, ↓ history/toolbar).
    if (!model.question && !model.overlay && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("shortcut.")) {
      message = { type: "key", key: message.action.slice("shortcut.".length) };
    }
    const input = model.input;
    // The status toolbar holds focus below the input. GTUI roves between its
    // chips; every key it declines lands here: Up/Esc return to the input
    // (Esc closes this innermost layer before a further Esc interrupts), and
    // typing returns there WITH the typed text, so no keystroke is lost.
    if (model.focus === "toolbar" && !model.overlay && !model.question && message.type === "key") {
      if (message.key === "up" || message.key === "escape") return { model: { ...model, focus: "input" }, effects: [] };
      if (typeof message.text === "string" && message.text !== "") return { model: { ...model, focus: "input", input: insertText(input, message.text) }, effects: [] };
    }
    if (!model.question && mapped("previousSession", message.key)) {
      return pageAgent(-1) ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && mapped("nextSession", message.key)) {
      return pageAgent(1) ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && message.key === "alt+ctrl+up") {
      return switchParentAgent() ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && mapped("fork", message.key)) {
      const blocks = blocksFor(model);
      const selected = blocks[Math.max(0, Math.min(model.overlay?.index ?? 0, blocks.length - 1))];
      const through = model.overlay?.type === "viewer" && !selected?.virtual
        ? (selected?.message ?? viewed.context.length - 1) + 1
        : viewed.context.length;
      // Fork is a session-store operation on the current agent. When invoked through the viewer, truncate to the selected
      // message first; Agent.fork closes the prior store and snapshots this
      // context into the replacement store without retaining another agent.
      if (through < viewed.context.length) viewed.context.rollback(through);
      viewed.contextFork();
      return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
    }
    // Esc interrupts the displayed agent when it is running; idle Esc
    // retains its usual draft, viewer, or question navigation behavior.
    // Anything open (menu, viewer, question, completions) is dismissed
    // first even mid-turn: Esc closes the innermost layer, and a further
    // Esc interrupts.
    if (message.key === "escape" && !model.turnRunning && !model.overlay && !model.question) {
      // Esc also invalidates a pending lookup before it has a visible popup.
      if (input.completions.length === 0) return { model: { ...model, completionGeneration: model.completionGeneration + 1 }, effects: [] };
    }
    if (message.key === "escape" && model.turnRunning && !model.overlay && !model.question && input.completions.length === 0) {
      return { model, effects: [adapter.interruptEffect()] };
    }
    if (input.completions.length > 0 && !model.question) {
      if (message.key === "tab" || message.key === "down") return { model: { ...model, input: cycleCompletions(input, 1) }, effects: [] };
      if (message.key === "shift+tab" || message.key === "up") return { model: { ...model, input: cycleCompletions(input, -1) }, effects: [] };
      if (message.key === "enter") return { model: { ...model, input: acceptCompletion(input) }, effects: [] };
      if (message.key === "escape") return { model: { ...model, input: dismissCompletions(input) }, effects: [] };
    }
    if (!model.question && !model.overlay && (message.key === "tab" || message.key === "shift+tab")) {
      const opened = openCompletions(input, completionSources);
      // Opening is itself a preview: Tab selects the first choice, while
      // Shift+Tab selects the last. Subsequent navigation is handled above.
      const next = opened.completions.length > 0
        ? cycleCompletions(opened, message.key === "shift+tab" ? -1 : 0)
        : opened;
      // Runtime filesystem discovery is asynchronous; injected listDir sources
      // remain synchronous for deterministic callers and tests.
      // A request nonce distinguishes repeated explicit Tabs on the exact
      // same draft; generation alone only distinguishes an edited draft.
      const nonce = model.completionRequest + 1;
      const path = sources === undefined && next.completions.length === 0 ? pathRequest(input) : null;
      const request = path
        ? { ...path, generation: model.completionGeneration, nonce, direction: message.key === "shift+tab" ? -1 : 0 }
        : null;
      return { model: { ...model, input: next, completionRequest: request ? nonce : model.completionRequest }, effects: request ? [pathCompletionEffect(request)] : [] };
    }
    if (message.key === "alt+shift+up") return { model: { ...model, input: recallDrained(input, viewed.pendingPop?.() ?? [], completionSources) }, effects: [] };
    if (!model.overlay && !model.question && (message.key === "up" || message.key === "down")) {
      const nextInput = navigateHistory(input, message.key === "up" ? -1 : 1, completionSources);
      // Down past the newest draft moves focus to the setting toolbar right
      // below the input (↑ comes back).
      if (nextInput === input && message.key === "down" && model.focus !== "toolbar") return { model: { ...model, focus: "toolbar" }, effects: [] };
      // At a visual boundary with no history to enter/leave, Up/Down is a
      // genuine no-op. Preserve model identity so inline mode emits no
      // pointless border/status repaint.
      return nextInput === input ? { model, effects: [] } : { model: { ...model, input: nextInput }, effects: [] };
    }
    if (message.key === "copy" && !model.overlay && !model.question) {
      // Mouse transcript selection primes model.transcriptSelection (GTUI
      // forwards it through selection.change); it copies through the very
      // same Copy key an input keyboard selection uses, never a separate
      // mouse-only channel.
      const transcript = model.transcriptSelection;
      if (transcript) return { model: { ...model, transcriptSelection: null }, effects: [effect.copy(transcript, `transcript-copy:${++copySequence}`)] };
      const text = selectedText(model.input);
      return text === ""
        ? { model, effects: [] }
        : { model, effects: [effect.copy(text, `input-copy:${++copySequence}`)] };
    }
    // Ctrl+C's plain meaning (parity with lib/tui-helpers/input-keys.js's
    // IS_INTERRUPT branch): a turn in flight cancels; otherwise it's a
    // TUI-only gesture — a non-empty draft clears, an empty one shows
    // "press ^C again to exit" and a SECOND press (still empty, still
    // idle) actually quits. The overlay/viewer/question guards below
    // claim ctrl+c for their own close/abandon meaning FIRST when one
    // of those is actually open.
    if (message.key === "ctrl+c" && !model.overlay && !model.question) {
      if (model.turnRunning) return { model, effects: [adapter.interruptEffect()] };
      if (model.input.value !== "") return { model: { ...model, input: clearInput(model.input) }, effects: [] };
      if (model.exitNotice) return requestQuit(model);
      return { model: { ...model, exitNotice: true }, effects: [] };
    }
    // Ctrl+D: EOF on an empty draft quits — DELIBERATELY regardless of
    // model.turnRunning (parity with lib/tui-helpers/input-keys.js's
    // IS_EOF branch, which has no busy guard either: EOF ends the
    // session even mid-turn, unlike ^C which only ever cancels or
    // clears while busy). A non-empty draft forward-deletes instead
    // (never EOFs mid-edit).
    if (message.key === "ctrl+d" && !model.overlay && !model.question) {
      if (model.input.value === "") return requestQuit(model);
      // A focused GTUI input consumes non-empty Ctrl+D as its generic
      // forward-delete operation before this app-level EOF policy runs.
      return { model, effects: [] };
    }

    if (!model.question && (!model.overlay || model.overlay.type === "viewer") && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("code.copy:")) {
      const match = /^code\.copy:(.+):(\d+):(\d+)$/.exec(message.action);
      const block = match && blocksFor(model).find((item) => `${item.group}:${item.section ?? item.type}:${item.ordinal ?? 0}` === match[1]);
      const start = match ? Number(match[2]) : NaN;
      const end = match ? Number(match[3]) : NaN;
      if (!block || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > (block.text ?? "").length) return { model, effects: [] };
      return { model, effects: [effect.copy(block.text.slice(start, end), `code-copy:${++copySequence}`)] };
    }
    if (!model.question && !model.overlay && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("status.")) {
      return statusAction(model, message.action.slice("status.".length));
    }
    if (!model.question && message.key === "ctrl+x") {
      return { model: { ...model, overlay: model.overlay ? null : openMenu("Menu", buildMenuItems(masterMenuOptions(viewed, env, combo(), { catalog: completionSources.catalog?.() }))) }, effects: [refreshCompletionCatalogEffect()] };
    }
    if (!model.question && message.key === "ctrl+p") {
      return { model: { ...model, overlay: model.overlay ? null : openMenu("Endpoints", buildEndpointItems(endpointMenuOptions(env, combo()))) }, effects: [] };
    }
    if (!model.question && message.key === "ctrl+m") {
      if (model.overlay) return { model: { ...model, overlay: null }, effects: [] };
      const options = modelMenuOptions(viewed, env);
      if (!options) {
        const notified = notify(model, { text: "no endpoint connected — pick one with ^P (the endpoint menu)", kind: "notice" });
        return { model: { ...model, notices: notified.notices }, effects: notified.effects };
      }
      return { model: { ...model, overlay: openMenu(options.value, buildProviderItems(options)) }, effects: [] };
    }
    if (!model.question && message.key === "ctrl+o") {
      const blocks = blocksFor(model);
      return { model: { ...model, overlay: model.overlay?.type === "viewer" ? null : openViewer(blocks) }, effects: [] };
    }
    if (model.overlay?.type === "viewer") {
      const blocks = blocksFor(model);
      if (message.key === "left") return { model: { ...model, overlay: moveViewer(model.overlay, blocks, -1) }, effects: [] };
      if (message.key === "right") return { model: { ...model, overlay: moveViewer(model.overlay, blocks, 1) }, effects: [] };
      if (message.key === "alt+left") return { model: { ...model, overlay: hopViewer(model.overlay, blocks, -1) }, effects: [] };
      if (message.key === "alt+right") return { model: { ...model, overlay: hopViewer(model.overlay, blocks, 1) }, effects: [] };
      if (message.key === "f") return { model: { ...model, overlay: { type: "viewer-filter", viewer: model.overlay, filters: [...(model.overlay.filters ?? [])], draft: model.overlay.search ?? "", focus: "menu" } }, effects: [] };
      if (message.key === "c") {
        const block = blocks[Math.max(0, Math.min(model.overlay.index, blocks.length - 1))];
        return block
          ? { model, effects: [effect.copy(block.text ?? "", `viewer-copy:${++copySequence}`)] }
          : { model, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, overlay: null }, effects: [] };
    }
    if (model.overlay?.type === "viewer-filter") {
      // A Tab keypress (no printable text) swaps focus between the option
      // menu and the search input; text arriving WHILE the input is focused
      // still inserts a tab character like in every other text editor.
      if (message.key === "tab" && !(model.overlay.focus === "input" && typeof message.text === "string" && message.text !== "")) {
        return { model: { ...model, overlay: { ...model.overlay, focus: model.overlay.focus === "menu" ? "input" : "menu" } }, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, overlay: model.overlay.viewer }, effects: [] };
    }
    if (model.question) {
      if (model.question.reading === true) {
        if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, question: { ...model.question, reading: false } }, effects: [] };
        return { model, effects: [] };
      }
      if (model.question.focus === "menu" && typeof message.text === "string" && message.text !== "") {
        const state = model.question.state;
        const selections = [...(state.selections ?? [])];
        if (currentQuestion(state).multiSelect !== true) selections[state.index] = [];
        const draft = model.question.draft ?? "";
        return { model: { ...model, question: { ...model.question, focus: "input", menuTarget: null, caret: draft.length + message.text.length, selection: null,
          state: { ...state, selections }, draft: `${draft}${message.text}` } }, effects: [adapter.resetTimeoutEffect()] };
      }
      // A Tab keypress (no printable text) swaps focus between the option
      // menu and the custom-answer input; text arriving WHILE the input is
      // focused still inserts a tab character like in every other editor.
      if (message.key === "tab" && !(model.question.focus === "input" && typeof message.text === "string" && message.text !== "")) {
        return { model: { ...model, question: { ...model.question, focus: model.question.focus === "menu" ? "input" : "menu", menuTarget: null } }, effects: [] };
      }
      if (message.key === "alt+ctrl+left" || message.key === "alt+ctrl+right") {
        const state = model.question.state;
        const last = state.questions.length - 1;
        const nextIndex = Math.max(0, Math.min(last, state.index + (message.key === "alt+ctrl+right" ? 1 : -1)));
        const nextState = moveQuestion(state, nextIndex, model.question.draft);
        return { model: { ...model, question: { ...model.question, state: nextState, draft: nextState.drafts[nextState.index] ?? "" } }, effects: [adapter.resetTimeoutEffect()] };
      }
      // Crossing the custom-answer input's OWN boundary returns focus to
      // the menu: GTUI's vertical editing move BUBBLES at the first/last
      // visual row (single-line drafts always), and the bubbled ↑/↓
      // crosses back to the option rows / Submit — the same gesture the
      // menu's own arrows perform. Tab keeps its explicit swap.
      if (model.question.focus === "input" && (message.key === "up" || message.key === "down")) {
        const toSubmit = message.key === "up";
        return { model: { ...model, question: { ...model.question, focus: "menu", menuTarget: toSubmit ? "submit" : null,
          menuToken: toSubmit ? `${currentQuestion(model.question.state).header}:submit` : undefined } }, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return updateQuestion(model, abandonQuestions(model.question.state));
    }
    return { model, effects: [] };
  }

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
          ? { model, effects: [effect.copy(message.text, `transcript-copy:${++copySequence}`)] }
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
        const tokens = preview?.type === "theme" ? resolveTheme({ tui: { theme: preview.name, themes: env?.settings?.tui?.themes ?? {} } }) : theme;
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
        return model.overlay ? { model: { ...model, overlay: null }, effects: [effect.theme(theme)] } : { model, effects: [] };
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

  function update(model, message) {
    const result = updateCore(model, message);
    const viewing = ["viewer", "viewer-filter"].includes(result.model.overlay?.type);
    const opened = viewing && !["viewer", "viewer-filter"].includes(model.overlay?.type);
    const changed = ["context.windows.ready", "agent.turn.settled"].includes(message.type)
      || (message.type === "agent.tool.event" && message.event?.type === "tool.result" && (!message.origin || message.origin === slot.current()));
    const refresh = opened || !catalogMatches(result.model.toolCatalog) || changed;
    if (!viewing) return result.model.toolCatalog
      ? { ...result, model: { ...result.model, toolCatalog: undefined } } : result;
    if (!refresh) return result;
    const next = refreshToolCatalog(result.model);
    return { model: next.model, effects: [...result.effects, ...next.effects] };
  }

  /** Reads agent.context live through the slot (Agent, not the model,
   *  owns the conversation) and stays synchronous throughout.
   * @param {object} model - the app model
   * @returns {object} the GTUI view tree (question/overlay takeover, or the
   *   transcript feed with footer, queue, attachment chips, input, status)
   */
  function view(model) {
    // Menus and questions are true viewport takeovers in BOTH modes.
    // Do not build or lay out the transcript/footer behind either one;
    // inline vs alt is only a host rendering choice.
    if (model.question) {
      const view = questionView(
        currentQuestion(model.question.state), model.question.draft, model.question.focus,
        selectedLabels(model.question.state), model.question.menuTarget,
        model.question.caret, model.question.selection, model.question.highlight, model.question.reading === true,
        model.question.state.questions.some((_, index) => index > model.question.state.index && model.question.state.answers[index] === undefined),
      );
      // The Submit-row jump must survive re-renders: a per-render
      // menuTarget-derived stateKey hands GTUI a fresh menu each frame
      // (Enter never sees the highlight), so once the target latches
      // into model.question.menuToken it drives the menu's stateKey.
      if (model.question.menuToken === undefined) return view;
      const menu = view.children[0].children.find((node) => node.id === QUESTION_MENU_ID);
      const patched = view.children[0].children.map((node) => node === menu ? { ...menu, stateKey: model.question.menuToken } : node);
      return { ...view, children: [{ ...view.children[0], children: patched }] };
    }
    if (model.overlay?.type === "menu" || model.overlay?.type === "viewer-filter") return overlayView(model.overlay, []);

    refreshProjection();
    if (model.overlay?.type === "viewer") return overlayView(model.overlay, blocksFor(model));
    const blocks = allBlocksFor(model);

    const transcript = projector.project(blocks, 1, { running: model.turnRunning === true });
    const boundary = blocks.findIndex((block) => block.type !== "system");
    const leading = boundary < 0 ? transcript.length : boundary;
    const available = terminalHeight() - 6;
    const welcome = { key: "startup-banner", done: true, node: available < 18
      ? v.text({ role: "accent md.strong", overflow: "clip-end" }, `${NAMES.Namespace} · ${viewed.model ?? "(none)"}`)
      : welcomeView({ model: viewed.model,
        prompts: completionSources.catalog?.()?.prompts ?? [], width: terminalWidth(),
        compact: available < 25, topSpace: available >= 28 ? 2 : 0 }) };
    const items = [...transcript.slice(0, leading), welcome, ...transcript.slice(leading),
      ...noticeItems(model.notices, Math.max(projector.ceiling(), 1 + transcript.length))];
    // The transcript is the one row that should shrink first when the
    // terminal can't fit everything (an oversized system prompt, a
    // very long reply) — footer controls remain usable and visible.
    const statusFacts = statusData({ agent: viewed, env, cwd, catalog: completionSources.catalog?.() });
    const status = v.column({ priority: 20 }, [statusView(statusFacts, { focus: model.focus === "toolbar", key: model.toolbarKey })]);
    const input = model.input;
    const box = v.input({
      id: "draft", value: input.value, caret: input.caret, selection: input.selection,
      disabled: model.closedInput || viewed.closeMarked === true,
      completions: input.completions, completionIndex: input.completionIndex,
      // Bracketed paste identifies paste but not a terminal drop. This
      // conservative transform recognizes only a whole absolute pathname.
      pasteTransform: (text) => attachmentPaste(text, { cwd: env?.cwd ?? cwd }),
      focus: !model.question && model.focus !== "toolbar", active: statusFacts.viewedWorking, priority: 10,
      placeholder: statusFacts.viewedWorking ? "Queue a message for the agent…" : "Ask anything · / for commands",
    });
    const rows = [v.scroll({ id: TRANSCRIPT_SCROLL_ID, anchor: "end", offset: model.transcriptOffset, keyboard: true, priority: 0 }, [v.feed({ id: feedId, items })])];
    // Live tool output is rendered in the transcript as an open tool block,
    // like thinking; the footer remains for sticky tool information/status.
    const information = informationData(viewed, env, undefined, completionSources.catalog?.());
    if (information.length > 0) rows.push(v.column({ priority: 5 }, [informationView(information)]));
    const queue = queueView(viewed);
    if (queue) rows.push(queue);
    const chips = attachmentChips(input.value);
    if (chips.length > 0) rows.push(v.text({ role: "notice", overflow: "clip-end", priority: 10 }, chips.flatMap((chip, index) => [
      ...(index > 0 ? [{ text: "   " }] : []),
      chip.missing ? { text: `📎 ${chip.name} · missing`, role: "notice.error" } : { text: `📎 ${chip.name} · ${formatBytes(chip.size)}` },
    ])));
    rows.push(box);
    if (model.exitNotice) rows.push(v.text({ role: "notice.action", priority: 10 }, EXIT_NOTICE_TEXT));
    // The shared status block follows the writing/question input in inline
    // and alt alike and closes the view.
    rows.push(status);
    return v.column({ viewportFill: true, rows: ["fill", ...rows.slice(1).map(() => "auto")] }, rows);
  }

  return {
    /** The real Agent currently shown by the TUI. Process front ends use this
     * at shutdown because the user may have switched sessions since startup. */
    currentAgent: slot.current,
    /** @returns {{model: object, effects: Array<object>}} the initial model
     *  (draft history seeded from the viewed context) plus startup effects:
     *  catalog refresh, context-window events, agent close hook, 1 Hz clock */
    init: () => ({ model: initialModel(historyFromContext(viewed.context.messages())), effects: [refreshCompletionCatalogEffect(), contextWindowsEffect(), adapter.closeEffect(), throttleEffect()] }),
    update,
    view,
    /** Keys that must bypass GTUI's input/menu controls entirely — see
     *  each guard above for why (a conflicting native meaning, or the
     *  "swallow anything unrecognized while an overlay is open" rule). */
    bindings: (model) => appBindings(model, Object.values(keymap).flatMap((value) => value == null ? [] : [].concat(value))),
    /** Exposed for the app's owner (a future run.js wiring): drain every
     *  open question before tearing down, so a clean exit never hangs a
     *  tool call waiting on an answer that will never come. */
    abandonPending: adapter.abandonPending,
    /** Tear down: abandon open questions and fail every pending copy waiter
     *  so no Promise outlives the app. */
    dispose: () => {
      adapter.abandonPending();
      for (const resolve of copyWaiters.values()) resolve(false);
      copyWaiters.clear();
    },
    /** Resolved from tui.theme/tui.themes (theme-data.js) — the app's
     *  owner passes this straight through as `new GTUI({host, theme})`'s
     *  theme option; GTUI applies it at render time, so nothing above
     *  needs to read it. */
    theme,
  };
}

export { msg };
