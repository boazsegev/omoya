/**
 * public/app.js — the Omoya web SPA. A zero-dependency chat client that
 * speaks the lib/web-app protocol over one WebSocket. The server owns the
 * Agent and all state; this client owns only presentation: it renders the
 * transcript (Markdown → safe HTML), streams turn deltas, asks questions,
 * and forwards user intent as validated protocol packets.
 *
 * Feature parity with the TUI is deliberate: shared named theme catalog,
 * endpoint sign-in/out (incl. browser OAuth), live thinking + tool cards,
 * agent/session naming, the ^X menu (here: the Ctrl/⌘+K command palette),
 * block viewer (^O / Ctrl+O, TUI keys), queue recall, linked-agent navigation, and every
 * slash command. Display details (collapse defaults, tool line cap, theme,
 * autocomplete, thinking levels) come from settings.web via the server's
 * settings packet — never hardcoded here.
 *
 * Rendering is incremental: a block owns one DOM node; stream deltas mark
 * blocks dirty and one animation frame patches only those nodes, so long
 * transcripts stay cheap while tokens arrive.
 */
import { renderMarkdown } from "./markdown.js";
import { selectedMarkdown } from "./copy-markdown.js";
import { readPreview } from "./read-preview.js";
import { sanitizeText, BashSanitizer } from "./text-safe.js";
import { aggregateState, formatAmount, formatBytes, formatDuration, parseArgs, quotaUsedTotal, resetText, settingChips, sortedQuotaEntries, toolSummary, toolDisplay } from "./format.js";

(() => {
"use strict";

const app = document.querySelector("#app");
const toasts = document.querySelector("#toast-region");
const errors = document.querySelector("#error-region");

/* ------------------------------------------------------------------ state */
let ws = null;
let retry = 0;
let reconnectTimer = null;
let throttledUntil = null;
let throttleClock = null;
/**
 * Show (or clear) the server-imposed throttle countdown in the header.
 * @param {number|null} until - epoch ms when the throttle lifts; anything not in the future clears it.
 * @returns {void}
 * Effects: sets `throttledUntil`, (re)starts a 250 ms interval repainting the header until expiry.
 */
function showThrottle(until) {
  throttledUntil = Number.isFinite(until) && until > Date.now() ? until : null;
  clearInterval(throttleClock);
  throttleClock = throttledUntil ? setInterval(() => {
    if (Date.now() >= throttledUntil) showThrottle(null);
    else updateHeader();
  }, 250) : null;
  updateHeader();
}

let agent = null;                 // current agent info (from hello/sessions)
let sessions = { agents: [], recent: [] };
let settings = { safe: false, thinking: "default", sessionSave: undefined, spawnPermission: null, delegationLocked: false, endpoint: null, model: null, models: [] };
// Display preferences from settings.web (server-supplied; defaults applied
// server-side). The client honors these — it never hardcodes them.
let prefs = { autocomplete: true, collapse: { thinking: true, tools: true }, previewRows: { default: { system: 8, thinking: 8, tool: 7 } }, theme: "system", thinkingLevels: ["default", "none", "low", "medium", "high", "xhigh", "max"], themes: [], activeTheme: null, themeModes: {} };
let catalog = { commands: [], hints: {}, prompts: [], tools: [], toolSchemas: [] };
let endpoints = { endpoints: [], presets: [], removable: [], providers: [] };
let usage = { input: 0, output: 0, used: 0, available: 0, plan: null };
let oauthState = { active: false, url: null, lines: [], done: false, error: false };
let contextBlocks = [];
let contextTools = null;
let contextView = null;           // { search, types:Set, selected:Set, target, edit, key, editKey } while the block viewer is open
let sidebarOpen = readPref("omoya.web.sidebar", matchMedia("(min-width: 64rem)").matches ? "open" : "closed") === "open";
let queuedMessages = [];
let uploadKey = null;
let draftAttachments = []; // { id, name, size }; opaque IDs never enter the visible composer.
// Composer state is browser-local and keyed by agent: the Agent owns the
// conversation, while this view retains unfinished writing across switches.
// `submitted` fills the small gap before a just-submitted message reappears
// in the Agent-owned context/history snapshot.
const composerByAgent = new Map(); // agent id -> { text, attachments, submitted, historyIndex, historyDraft }

// The transcript: an ordered list of blocks the wire builds up.
// {kind:"user"|"text"|"thinking"|"tool"|"system"|"error"|"command", text, done, …}
let blocks = [];
let current = null;               // the in-flight text/thinking stream block
let openQuestion = null;          // {requestId, questions}

/**
 * Read a localStorage preference.
 * @param {string} key
 * @param {*} fallback - returned when the key is unset or storage is unavailable (private mode).
 * @returns {*} the stored string or `fallback`.
 */
function readPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
/**
 * Persist a localStorage preference.
 * @param {string} key
 * @param {string} value
 * @returns {void}
 * Errors: silently ignored when storage is unavailable (private mode).
 */
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

/* ------------------------------------------------------------------ wire */
/**
 * Send a protocol packet to the server over the WebSocket.
 * @param {object} packet - protocol message, e.g. `{ type: "chat.submit", text }`.
 * @returns {void}
 * Effects: toasts "Not connected — reconnecting…" when the socket is not open.
 */
const send = (packet) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet)); else toast("Not connected — reconnecting…", true); };

/**
 * Open the WebSocket to `/ws` and wire its open/message/close/error handlers.
 * @returns {void}
 * Effects: resets the retry counter and requests the session list on open, dispatches
 * inbound packets to `handle`, and schedules a reconnect on close.
 */
function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener("open", () => { retry = 0; send({ type: "session.list" }); updateHeader(); });
  ws.addEventListener("message", (event) => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    handle(m);
  });
  ws.addEventListener("close", () => { scheduleReconnect(); updateHeader(); updateSidebar(); });
  ws.addEventListener("error", () => ws.close());
}

/**
 * Schedule the next `connect()` with exponential backoff (500·2^retry ms, capped at 10 s).
 * @returns {void}
 */
function scheduleReconnect() {
  retry++;
  const delay = Math.min(10000, 500 * 2 ** retry);
  reconnectTimer = setTimeout(connect, delay);
}

/**
 * Dispatch one inbound protocol packet by its `type`.
 * @param {object} m - parsed server packet (hello, sessions, chat.*, turn.*, tool.*, …).
 * @returns {void}
 * Effects: updates agent/session/settings/usage/queue state and re-renders the affected regions.
 */
function handle(m) {
  switch (m.type) {
    case "hello": {
      saveComposerDraft();
      const switched = agent?.id !== m.agent?.id;
      if (switched) { resetTranscript = true; stickBottom = true; } // agent switch lands at the latest message
      showThrottle(m.throttledUntil ?? null);
      agent = m.agent ?? null;
      const previousUploadKey = uploadKey;
      uploadKey = typeof m.uploadKey === "string" ? m.uploadKey : uploadKey;
      loadComposerDraft();
      if (previousUploadKey && previousUploadKey !== uploadKey) {
        for (const draft of composerByAgent.values()) draft.attachments = [];
        draftAttachments = [];
      }
      if (Array.isArray(m.history)) setHistory(m.history, !switched);
      if (Array.isArray(m.queue)) queuedMessages = m.queue;
      if (m.catalog) catalog = { commands: m.catalog.commands ?? [], hints: m.catalog.hints ?? {}, prompts: m.catalog.prompts ?? [], tools: m.catalog.tools ?? [], toolSchemas: m.catalog.toolSchemas ?? [] };
      if (m.status) usage = m.status;
      if (switched) { contextBlocks = []; contextTools = null; closeContextViewer(); }
      render();
      break;
    }
    case "sessions":
      sessions = { agents: m.agents ?? [], recent: m.recent ?? [] };
      // The running-agents list is the freshest report of the viewed agent's
      // busy flag — fold it in so every sessions push keeps the Stop button
      // and the composer working-animation current (no agent switch needed).
      if (agent) { const mine = agentList().find((item) => item.id === agent.id); if (mine) agent = { ...agent, ...mine, busy: mine.state === "working", state: mine.state }; }
      updateSidebar(); updateHeader(); updateComposerActivity(); updateComposerTools(); break;
    case "agent":
      if (agent && m.agent) {
        agent = m.agent;
        if (m.status) usage = m.status;
        // "idle" is authoritative for not-busy (busy flips only after the
        // run's finally, so a snapshot can briefly carry the mixed pair).
        if (agent.state === "idle") agent.busy = false;
        updateHeader(); updateComposerActivity(); updateComposerTools(); scheduleRender();
      }
      break;
    case "settings":
      settings = {
        safe: !!m.safe,
        thinking: m.thinking ?? "default",
        sessionSave: typeof m.sessionSave === "boolean" ? m.sessionSave : undefined,
        spawnPermission: m.spawnPermission ?? null,
        delegationLocked: m.delegationLocked === true,
        endpoint: m.endpoint ?? null,
        model: m.model ?? null,
        models: m.models ?? [],
      };
      if (m.prefs) { prefs = { ...prefs, ...m.prefs, collapse: { ...prefs.collapse, ...(m.prefs.collapse ?? {}) } }; applyTheme(); }
      updateHeader(); updateComposerTools(); refreshOpenPanels();
      refreshContextCatalog();
      break;
    case "endpoints":
      endpoints = { endpoints: m.endpoints ?? [], presets: m.presets ?? [], removable: m.removable ?? [], providers: m.providers ?? [] };
      refreshOpenPanels();
      break;
    case "oauth": onOAuth(m); break;
    case "chat.user": pushBlock({ kind: "user", text: m.message?.text ?? "", attachments: m.message?.attachments, done: true }); break;
    case "chat.queue": queuedMessages = Array.isArray(m.messages) ? m.messages : []; renderComposerQueue(); break;
    case "chat.unqueued":
      queuedMessages = Array.isArray(m.messages) ? m.messages : [];
      if (textareaEl) { textareaEl.value = [m.text ?? "", textareaEl.value].filter(Boolean).join("\n\n"); noteComposerInput(); autofit(); textareaEl.focus(); }
      renderComposerQueue();
      break;
    case "turn.throttled":
      showThrottle(m.until);
      if (m.until && agent) { agent = { ...agent, busy: false, state: "idle" }; updateComposerActivity(); updateSidebar(); }
      break;
    case "turn.start":
      showThrottle(null);
      settleCurrent();
      if (m.status) usage = m.status;
      // busy flips BEFORE the request's first START, so this report — not a
      // stale snapshot — is what lights the Stop button / working animation.
      if (agent && m.busy === true) agent = { ...agent, busy: true, state: "working" };
      updateUsage(); updateHeader(); updateComposerActivity(); scheduleRender();
      break;
    case "turn.delta": onDelta(m); break;
    case "turn.end": onTurnEnd(m); break;
    case "tool.call.start": startToolCall(m); break;
    case "tool.call.delta": appendToolCall(m); break;
    case "tool.call.end": finishToolCall(m); break;
    case "tool.execute": startToolAnswer(m); break;
    case "tool.data": appendToolData(m); break;
    case "tool.result": finishTool(m); refreshContextCatalog(); break;
    case "context":
      contextBlocks = m.blocks ?? [];
      contextTools = m.tools ?? null;
      if (Array.isArray(m.history)) setHistory(m.history);
      renderContextViewer();
      break;
    case "question.open": openQuestion = { requestId: m.requestId, questions: m.questions ?? [] }; renderQuestion(); break;
    case "question.close": if (!m.requestId || openQuestion?.requestId === m.requestId) closeQuestion(); break;
    case "history": if (Array.isArray(m.history)) setHistory(m.history); break;
    case "command.result": pushBlock({ kind: "command", text: m.text ?? "", done: true }); break;
    case "command.open": openView(m.view, m); break;
    case "command.copy": copyText(m.text ?? "", "Copied the last response"); break;
    case "command.fill": fillComposer(m.text ?? ""); break;
    case "command.exit": toast(agentList().length > 1 ? "Agent closed" : "Agent closed — start a new chat to continue"); break;
    case "error": toast(m.message ?? "error", true); break;
    default: break;
  }
}

/**
 * Replace the transcript with a server-sent history snapshot.
 * @param {Array} list - history items (messages/blocks) to normalize.
 * @param {boolean} [preserveRows=false] - keep mounted DOM rows (same-agent refresh) instead of resetting the transcript.
 * @returns {void}
 * Effects: marks unfinished tool blocks "skipped" on an idle agent, clears the in-flight
 * block, and schedules a render.
 */
function setHistory(list, preserveRows = false) {
  resetTranscript ||= !preserveRows;
  stickBottom ||= !preserveRows; // a full history reload (session resume) lands at the bottom
  blocks = normalizeHistory(list);
  // An unanswered call on an idle agent never ran to completion.
  if (!(agent?.busy || agent?.state === "working")) for (const block of blocks) if (block.kind === "tool" && !block.done) Object.assign(block, { state: "skipped", done: true });
  current = null;
  scheduleRender(true);
}

/**
 * Fold replayed tool-call/tool-answer pairs into one tool card (the live
 * stream's shape), keyed by call id.
 * @param {Array} list - raw history items from the server.
 * @returns {Array} transcript blocks; calls without answers stay "running".
 */
function normalizeHistory(list) {
  const out = [];
  const byCall = new Map();
  for (const item of list) {
    if (item.kind === "tool-call") {
      // No answer yet: the call is still running (a turn in flight).
      const block = { kind: "tool", name: item.name ?? "tool", args: typeof item.text === "string" ? item.text : "", callId: item.callId, state: "running", output: "", done: false, messageIndex: item.messageIndex, blockIndex: item.blockIndex };
      if (item.callId) byCall.set(item.callId, block);
      out.push(block);
    } else if (item.kind === "tool-answer") {
      const call = item.tool ?? {};
      const block = (call.callId && byCall.get(call.callId)) ?? null;
      const state = item.error ? "error" : "ok";
      const display = toolDisplay(item.display).map((text) => sanitizeText(text, { markdown: true }));
      if (block) { block.output = item.output ?? ""; block.display = display; block.state = state; block.done = true; block.resultIndex = item.messageIndex; }
      else out.push({ kind: "tool", name: call.name ?? (typeof item.text === "object" ? item.text?.name : item.text) ?? "tool", args: "", state, output: item.output ?? "", display, done: true, resultIndex: item.messageIndex });
    } else out.push({ ...item });
  }
  return out;
}

/**
 * Append a streamed text/thinking delta to the in-flight block.
 * @param {object} m - `{ kind: "text"|"thinking", text }` delta packet.
 * @returns {void}
 * Effects: closes the previous in-flight block when the kind changes; schedules a render.
 */
function onDelta(m) {
  const kind = m.kind === "thinking" ? "thinking" : "text";
  if (!current || current.kind !== kind) {
    if (current) { current.done = true; current.ended = Date.now(); touch(current); }
    current = { kind, text: "", done: false, started: Date.now() };
    blocks.push(current);
  }
  current.text += m.text ?? "";
  touch(current);
}

/**
 * Close the in-flight text/thinking block (a new request, a tool call,
 * or the turn's end all finish it).
 * @returns {void}
 */
function settleCurrent() {
  if (current) { current.done = true; current.ended = Date.now(); touch(current); }
  current = null;
}

/**
 * Handle the end of a turn: settle streams, swap in authoritative history, and
 * surface terminal errors/cancellations.
 * @param {object} m - `{ history?, terminal?, busy?, status? }` packet.
 * @returns {void}
 * Effects: marks unfinished tool blocks skipped when not busy, updates usage/header/
 * composer/sidebar, schedules a render.
 */
function onTurnEnd(m) {
  settleCurrent();
  // The assembled context can differ from the streamed preview, including
  // delimiters that change Markdown/math layout. Replace the preview with
  // authoritative blocks before the next paint (also refreshes view controls).
  if (Array.isArray(m.history)) setHistory(m.history, true);
  if (m.terminal?.type === "error" && !(blocks.at(-1)?.kind === "error" && blocks.at(-1).text === (m.terminal.error ?? "turn failed"))) pushBlock({ kind: "error", text: m.terminal.error ?? "turn failed", done: true, retry: true });
  else if (m.terminal?.type === "cancelled" || m.terminal?.type === "cancel") pushBlock({ kind: "command", text: "cancelled", done: true });
  if (m.busy !== true) for (const block of blocks) if (block.kind === "tool" && !block.done) { block.state = "skipped"; block.done = true; touch(block); }
  if (m.status) usage = m.status;
  // busy may stay true here (queued messages or a tool round still ahead);
  // the indicators must follow the server's report, not assume the run ended.
  if (agent && typeof m.busy === "boolean") {
    agent = { ...agent, busy: m.busy, state: m.busy ? "working" : "idle" };
    // The sidebar row reads the sessions tree; keep it in step too.
    const row = agentList().find((item) => item.id === agent.id);
    if (row) Object.assign(row, { busy: m.busy, state: agent.state });
    updateSidebar();
  }
  updateUsage(); updateHeader(); updateComposerActivity(); scheduleRender();
}

/* ------------------------------------------------------------- transcript */
/**
 * Append a block to the transcript and schedule its render.
 * @param {object} block - transcript block (`{ kind, text, done, … }`).
 * @returns {void}
 */
function pushBlock(block) { stickBottom = true; blocks.push(block); touch(block); }

/**
 * Get (creating if needed) the per-agent composer draft.
 * @returns {{text: string, attachments: Array, submitted: string[], historyIndex: number|null, historyDraft: string|null}}
 */
function composerDraft() {
  const id = agent?.id;
  if (!id) return { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null };
  if (!composerByAgent.has(id)) composerByAgent.set(id, { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null });
  return composerByAgent.get(id);
}

/**
 * Snapshot the current textarea text and attachments into the viewed agent's draft.
 * @returns {void}
 */
function saveComposerDraft() {
  if (!agent?.id || !textareaEl) return;
  const draft = composerDraft();
  draft.text = textareaEl.value;
  draft.attachments = [...draftAttachments];
}

/**
 * Restore the viewed agent's saved attachments into `draftAttachments`.
 * @returns {void}
 */
function loadComposerDraft() {
  const draft = composerDraft();
  draftAttachments = [...draft.attachments];
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
  const context = blocks.filter((block) => block.kind === "user" && typeof block.text === "string" && block.text).map((block) => block.text);
  const counts = new Map(context.map((text) => [text, 0]));
  for (const text of context) counts.set(text, counts.get(text) + 1);
  const extra = [];
  for (const text of composerDraft().submitted) {
    const count = counts.get(text) ?? 0;
    if (count) counts.set(text, count - 1);
    else extra.push(text);
  }
  return [...context, ...extra];
}

/**
 * Composer height follows content, capped at twelve rows. Preserve the user's
 * reading position as the dock grows; only the first typed input jumps to latest.
 * @param {boolean} [firstWrite=false] - input transitioned from empty to nonempty.
 * @returns {void}
 */
function autofit(firstWrite = false) {
  if (!textareaEl) return;
  const previousScroll = scrollEl?.scrollTop;
  textareaEl.style.height = "auto";
  textareaEl.style.height = Math.min(textareaEl.scrollHeight, 12 * 24) + "px";
  if (!scrollEl) return;
  if (firstWrite) scrollEl.scrollTop = scrollEl.scrollHeight;
  else scrollEl.scrollTop = previousScroll;
}

/**
 * Typing always exits history browsing and the edited text becomes the working
 * draft (parity with the TUI's input-controller edit actions, which reset
 * historyIndex/historyDraft on any edit).
 * @returns {void}
 */
function noteComposerInput() {
  const draft = composerDraft();
  draft.historyIndex = null;
  draft.historyDraft = null;
  draft.text = textareaEl.value;
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
  const value = textarea.value;
  if (direction < 0 ? value.slice(0, index).includes("\n") : value.slice(index).includes("\n")) return false;
  const tops = caretRowTops(textarea, index);
  return tops.caret === (direction < 0 ? tops.start : tops.end);
}

/**
 * Arrow-key recall of previously sent messages into the composer. Recall takes
 * over only on the first visual row for Up and the last for Down — like the
 * TUI's visual-edge trigger — so normal caret movement between rows is kept.
 * @param {number} direction - -1 for older (Up), +1 for newer (Down).
 * @returns {boolean} true when recall consumed the key (caller should preventDefault).
 */
function recallHistory(direction) {
  if (!textareaEl) return false;
  const history = messageHistory();
  if (!history.length) return false;
  const draft = composerDraft();
  // Arrows keep their native caret movement between rows, hard and soft
  // wrapped alike: recall takes over only on the first visual row for Up and
  // the last for Down — like the TUI's visual-edge trigger. This is what
  // lets a long or multi-line draft be edited without every Up/Down
  // swapping its content.
  if (direction > 0 && draft.historyIndex === null) return false;
  const caret = direction < 0 ? (textareaEl.selectionStart ?? 0) : (textareaEl.selectionEnd ?? textareaEl.value.length);
  if (!caretOnEdgeRow(textareaEl, caret, direction)) return false;
  const apply = (value, index) => {
    // draft.text is never touched here: the working draft must survive
    // browsing, and a composer rebuild restores draft.text — a recalled
    // entry written there would resurrect as the "draft" later.
    draft.historyIndex = index;     // null = back at the working draft
    if (index === null) draft.historyDraft = null;
    textareaEl.value = value;
    autofit();
    hideAutocomplete();             // a recalled entry is not being typed
  };
  if (direction < 0) {
    // Entering history saves the unsent draft once; Down past the newest
    // entry returns to it, while typing or submitting supersedes it.
    if (draft.historyIndex === null) draft.historyDraft = textareaEl.value;
    const index = draft.historyIndex === null ? history.length - 1 : draft.historyIndex - 1;
    if (index < 0) return true;     // already at the oldest entry
    apply(history[index], index);
  } else {
    const index = draft.historyIndex + 1;
    if (index >= history.length) apply(draft.historyDraft ?? "", null);
    else apply(history[index], index);
  }
  return true;
}

/**
 * Tool name + a short human summary of its arguments (format.js).
 * @param {object} [call] - `{ name?, arguments?|args? }` tool call shape.
 * @returns {{name: string, summary: string}}
 */
function toolLabel(call) {
  return { name: call?.name ?? "tool", summary: toolSummary(call?.arguments ?? call?.args) };
}
/**
 * Render tool arguments as text: JSON-parse strings (pretty-printing structured
 * payloads), pretty-print objects, empty string for null/undefined.
 * @param {*} value - raw args (string or structured).
 * @returns {string}
 */
function argsText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") { const parsed = parseArgs(value); return typeof parsed === "string" ? value : JSON.stringify(parsed, null, 2); }
  return JSON.stringify(value, null, 2);
}

// Live tool cards. A card starts when the model begins composing the call
// (tool.call.start), fills with streamed arguments, runs (tool.execute),
// streams output (tool.data) and settles on tool.result — one card per call.
/**
 * Find the most recent unfinished tool block matching `predicate`.
 * @param {(block: object) => boolean} predicate
 * @returns {object|undefined} the matching live tool block.
 */
const liveTool = (predicate) => blocks.findLast((block) => block.kind === "tool" && !block.done && predicate(block));
/**
 * Begin a live tool card as the model starts composing the call (tool.call.start).
 * @param {object} m - `{ name?, text?, args?, index?, callId? }` packet.
 * @returns {void}
 */
function startToolCall(m) {
  settleCurrent();
  pushBlock({ kind: "tool", name: m.name ?? m.text ?? "tool", args: typeof m.args === "string" ? m.args : m.args !== undefined ? JSON.stringify(m.args) : "", index: m.index, callId: m.callId, state: "composing", output: "", done: false, started: Date.now() });
}
/**
 * Append streamed argument text to the composing tool card (tool.call.delta).
 * @param {object} m - `{ args?|text?, index? }` delta.
 * @returns {void}
 */
function appendToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  block.args += typeof m.args === "string" ? m.args : m.text ?? "";
  touch(block);
}
/**
 * Finish call composition; the card moves to "queued" awaiting execution (tool.call.end).
 * @param {object} [m] - `{ args?, index? }`; structured args replace the streamed text.
 * @returns {void}
 */
function finishToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m?.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  if (m?.args !== undefined && typeof m.args !== "string") block.args = JSON.stringify(m.args);
  block.state = "queued";
  touch(block);
}
/**
 * Mark a queued tool card as running (tool.execute), creating it if the call was never seen.
 * @param {object} m - `{ call: { callId?, name?, arguments? } }` packet.
 * @returns {void}
 */
function startToolAnswer(m) {
  const call = m.call ?? {};
  let block = (call.callId && liveTool((item) => item.callId === call.callId))
    ?? liveTool((item) => item.state === "queued" && item.name === call.name)
    ?? liveTool((item) => item.state === "queued");
  if (!block) { block = { kind: "tool", name: call.name ?? "tool", args: "", output: "", done: false }; blocks.push(block); }
  Object.assign(block, { name: call.name ?? block.name, callId: call.callId ?? block.callId, state: "running", started: block.started ?? Date.now(), runStarted: Date.now() });
  if (call.arguments !== undefined) block.args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
  touch(block);
}
// One streaming sanitizer PER LIVE TOOL CALL (its look-back buffer catches
// escape sequences split across chunks — never shared between calls).
// Untrusted chunks are sanitized at this ingest boundary; the wire carries
// byte-exact output and the Agent's persisted result is never altered.
const toolSanitizers = new Map(); // call key → BashSanitizer
/**
 * Map a tool call to its sanitizer bucket key (call id, else name).
 * @param {object} [call] - `{ callId?, name? }`.
 * @returns {string}
 */
const toolKey = (call) => String(call?.callId ?? call?.name ?? "tool");
/**
 * Get (creating if needed) the streaming sanitizer for one live tool call.
 * @param {object} [call] - the tool call (keyed by `toolKey`).
 * @returns {BashSanitizer}
 */
function sanitizerFor(call) {
  const key = toolKey(call);
  let sanitizer = toolSanitizers.get(key);
  if (sanitizer === undefined) { sanitizer = new BashSanitizer({ markdown: true }); toolSanitizers.set(key, sanitizer); }
  return sanitizer;
}
/**
 * Sanitize and append a streamed output chunk to the running tool card (tool.data).
 * @param {object} m - `{ call?, chunk }` packet.
 * @returns {void}
 */
function appendToolData(m) {
  const block = (m.call?.callId && liveTool((item) => item.callId === m.call.callId)) ?? liveTool((item) => item.state === "running");
  if (!block) return;
  block.output = (block.output ?? "") + sanitizerFor(m.call ?? block).push(typeof m.chunk === "string" ? m.chunk : "");
  block.streamed = true;
  touch(block);
}
/**
 * Settle a tool card with its final result (tool.result): flush the sanitizer tail,
 * apply authoritative output/display, and mark the card ok/error + done.
 * @param {object} m - `{ result?, display? }` packet.
 * @returns {void}
 */
function finishTool(m) {
  const result = m.result ?? {};
  const block = (result.callId && liveTool((item) => item.callId === result.callId)) ?? liveTool((item) => item.state === "running");
  const key = toolKey(block ?? result);
  const sanitizer = toolSanitizers.get(key);
  let tail = "";
  if (sanitizer !== undefined) { tail = sanitizer.end(); toolSanitizers.delete(key); }
  const final = resultText(result);
  const shown = toolDisplay(m.display).map((text) => sanitizeText(text, { markdown: true }));
  const target = block ?? { kind: "tool", name: result.name ?? "tool", args: "", output: "" };
  if (!block) blocks.push(target);
  // The final result is authoritative; streamed output stays when the
  // result carries no text of its own (e.g. a status-only answer).
  target.output = final || ((target.output ?? "") + tail);
  target.display = shown;
  target.state = result.error === true ? "error" : "ok";
  target.done = true;
  target.ended = Date.now();
  touch(target);
}
/**
 * Extract the sanitized display text of a tool result.
 * @param {object|string} result - `{ content: [{type, text}], error? }` or a plain string.
 * @returns {string} joined, markdown-safe text blocks; "" when there is none.
 */
function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? sanitizeText(result, { markdown: true }) : "";
  return content.filter((b) => b?.type === "text" && b.text).map((b) => sanitizeText(String(b.text), { markdown: true })).join("\n");
}

/* --------------------------------------------------------------- elements */
/**
 * Create an element with optional class and text content.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
/**
 * Create a <button> with optional icon, label, tooltip and click handler.
 * @param {string} className
 * @param {string|null} [label] - visible label; omit for an icon-only button.
 * @param {(event: MouseEvent) => void} [onClick]
 * @param {object} [options]
 * @param {string} [options.title] - tooltip; also the aria-label when there is no label.
 * @param {string} [options.icon] - icon glyph prepended to the label.
 * @param {string} [options.type="button"]
 * @returns {HTMLButtonElement}
 */
function button(className, label, onClick, { title, icon, type = "button" } = {}) {
  const node = el("button", className);
  node.type = type;
  if (icon) node.append(el("span", "icon", icon));
  if (label !== undefined && label !== null) node.append(icon ? el("span", "label", label) : document.createTextNode(label));
  if (title) { node.title = title; if (!label) node.setAttribute("aria-label", title); }
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * Build the wordmark: the real word stays in the DOM (copy/paste, find-in-page,
 * screen readers); its first letter is transparent and overlaid with an inline
 * SVG mark — the logo ring + prompt glyph in currentColor, so it tracks themes.
 * @param {string} [word="Omoya"]
 * @returns {HTMLElement} the `.wordmark` span.
 */
function brandWordmark(word = "Omoya") {
  const o = el("span", "wordmark-o");
  o.append(el("span", "wordmark-o-text", word[0]));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "wordmark-mark");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", "256"); ring.setAttribute("cy", "256"); ring.setAttribute("r", "142");
  const glyph = document.createElementNS(SVG_NS, "path");
  glyph.setAttribute("d", "M218 207 274 256 218 305 M282 305h38");
  glyph.setAttribute("stroke-linecap", "round");
  glyph.setAttribute("stroke-linejoin", "round");
  svg.append(ring, glyph);
  o.append(svg);
  const wordmark = el("span", "wordmark");
  wordmark.append(o, document.createTextNode(word.slice(1)));
  return wordmark;
}

let shellEl, sidebarEl, headerEl, scrollEl, transcriptContainer, jumpBtn, jumpTopBtn, composerEl, textareaEl, stopBtn, sendBtn, attachmentInput, attachmentChips, ghostEl;

/**
 * Build the persistent shell once; later updates patch it in place. Rebuilding
 * the whole tree on every state change would reset scroll/focus and break the
 * inputs, so only the dynamic regions (header, sidebar lists, transcript) patch.
 * @returns {void}
 */
function buildShell() {
  app.replaceChildren();
  shellEl = el("div", "web-shell");
  sidebarEl = buildSidebar();
  const scrim = el("div", "sidebar-scrim");
  scrim.addEventListener("click", () => setSidebar(false));
  const main = el("main", "conversation");
  headerEl = buildHeader();
  scrollEl = el("div", "transcript-scroll");
  transcriptContainer = el("div", "transcript");
  transcriptContainer.setAttribute("role", "log");
  transcriptContainer.setAttribute("aria-live", "polite");
  transcriptContainer.setAttribute("aria-relevant", "additions");
  scrollEl.append(transcriptContainer);
  scrollEl.addEventListener("scroll", syncJumpButtons, { passive: true });
  jumpBtn = button("jump-bottom", null, () => { scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" }); }, { title: "Jump to latest", icon: "↓" });
  jumpBtn.hidden = true;
  jumpTopBtn = button("jump-top", null, () => { scrollEl.scrollTo({ top: 0, behavior: "smooth" }); }, { title: "Jump to oldest", icon: "↑" });
  jumpTopBtn.hidden = true;
  composerEl = buildComposer();
  const dock = el("div", "composer-dock");
  dock.append(jumpBtn, composerEl);
  main.append(headerEl, jumpTopBtn, scrollEl, dock);
  shellEl.append(sidebarEl, scrim, main);
  app.append(shellEl);
  applyShell();
}

/**
 * Open or close the sidebar, persisting the choice.
 * @param {boolean} open
 * @returns {void}
 */
function setSidebar(open) { sidebarOpen = open; writePref("omoya.web.sidebar", open ? "open" : "closed"); applyShell(); }
/**
 * Reflect `sidebarOpen` on the shell's class list.
 * @returns {void}
 */
function applyShell() { shellEl?.classList.toggle("sidebar-open", sidebarOpen); }

/**
 * Build the shell on first use and refresh every dynamic region.
 * @returns {void}
 */
function render() {
  if (!shellEl) buildShell();
  else { composerEl.replaceWith(composerEl = buildComposer()); }
  scheduleRender(true); updateHeader(); updateSidebar(); updateUsage(); updateComposerActivity(); updateComposerTools();
}

/* ----------------------------------------------------------------- header */
/**
 * Build the header: sidebar toggle, identity placeholder, connection state,
 * appearance switch, and the block viewer / palette / settings buttons.
 * @returns {HTMLElement} the `<header>` element.
 */
function buildHeader() {
  const head = el("header", "app-header");
  const toggle = button("icon-button", null, () => setSidebar(!sidebarOpen), { title: "Toggle sidebar", icon: "☰" });
  const identity = el("div", "identity");
  identity.id = "identity";
  const actions = el("div", "header-actions");
  const state = el("span", "connection-state");
  state.id = "connection-state";
  const appearance = el("div", "appearance-switch");
  appearance.setAttribute("role", "group");
  appearance.setAttribute("aria-label", "Appearance");
  for (const [mode, icon, label] of [["system", "◐", "Follow system appearance"], ["light", "☀", "Light appearance"], ["dark", "☾", "Dark appearance"]]) {
    const option = button("appearance-option", null, () => {
      writePref("omoya.web.namedThemeMode", mode);
      if (!["system", "light", "dark"].includes(selectedTheme())) applyTheme();
      else chooseTheme(mode);
      updateAppearanceSwitch();
      if (document.querySelector("#themes-panel")) renderThemesBody();
    }, { title: label, icon });
    option.dataset.mode = mode;
    appearance.append(option);
  }
  actions.append(
    state,
    button("icon-button", null, () => openContextViewer(), { title: "Block viewer (Ctrl+O)", icon: "▤" }),
    button("icon-button palette-button", null, () => openPalette(), { title: "Command palette (Ctrl/⌘+K)", icon: "⌘" }),
    button("icon-button", null, () => openSettings(), { title: "Settings", icon: "⚙" }),
    appearance,
  );
  head.append(toggle, identity, actions);
  return head;
}

/**
 * Aggregate the state of every live agent (working > disconnected > idle), the
 * TUI's top-level summary. The viewed agent is included even if the sessions
 * list has not caught up yet.
 * @returns {string} aggregate state, e.g. "working" | "idle" | "disconnected".
 */
function aggregateAgentState() {
  const all = agentList();
  if (agent && !all.some((item) => item.id === agent.id)) all.push(agent);
  return aggregateState(all.map((item) => item.busy ? "working" : item.state));
}

/**
 * Repaint the header: connection state/label, throttle countdown, agent name
 * and session badge, safe-mode badge, Stop/Send visibility, and the tab title.
 * @returns {void}
 */
function updateHeader() {
  const identity = document.querySelector("#identity");
  const state = document.querySelector("#connection-state");
  if (!identity || !state) return;
  // The TUI's top-level status summarizes every live agent, while the
  // composer only follows the viewed one.
  const online = ws?.readyState === WebSocket.OPEN;
  const activity = aggregateAgentState();
  state.replaceChildren();
  const dot = el("i", `connection-dot${online ? " online" : ""} ${activity}`);
  const label = !online ? "Reconnecting" : activity === "working" ? "Working" : activity === "disconnected" ? "Disconnected" : "Ready";
  const wait = throttledUntil && throttledUntil > Date.now()
    ? ` · continuing in ${Math.ceil((throttledUntil - Date.now()) / 1000)}s` : "";
  state.setAttribute("aria-label", `Connection: ${label}${wait}`);
  state.title = `${label}${wait} — ${agentList().length || 1} agent(s)`;
  state.append(dot, activity === "working" && online ? statusWord(label) : el("span", "state-label", label));
  if (wait) state.append(el("span", "state-label", wait));
  updateAppearanceSwitch();

  identity.replaceChildren();
  const name = button("agent-name", agent?.name ?? "Omoya", () => renameAgentPrompt(), { title: "Rename this agent" });
  const session = agent?.session;
  const logged = settings.sessionSave === true;
  const badge = button("session-badge" + (logged ? " saved" : " ghost"), logged ? shortId(session) : "Unlogged",
    () => renameSessionPrompt(),
    { title: `Session ${session} — ${logged ? "logged" : "not logged (memory only)"} · click to rename` });
  identity.append(name, badge);
  if (settings.safe) identity.append(button("mode-badge", "Read-only", () => send({ type: "settings.safe", on: false }), { title: "Safe mode: read-only tools only — click to allow writes" }));
  // Stop replaces Send for the viewed agent only; Enter keeps submitting.
  const viewedWorking = agent?.state === "working" || agent?.busy === true;
  if (stopBtn) stopBtn.hidden = !viewedWorking;
  if (sendBtn) sendBtn.hidden = viewedWorking;
  document.title = `${viewedWorking ? "● " : ""}${agent?.name ?? "Omoya"} — Omoya`;
}

/**
 * Truncate a long id for display.
 * @param {*} id
 * @returns {string} `abcdef12…` when longer than 18 chars, else the id as text.
 */
const shortId = (id) => (String(id).length > 18 ? `${String(id).slice(0, 8)}…` : String(id));

/* ---------------------------------------------------------------- sidebar */
let sessionFilter = "";
/**
 * Build the sidebar: brand, new-chat row (+ variants menu), agent/session
 * lists placeholder, and the footer links.
 * @returns {HTMLElement} the `<aside>` element.
 */
function buildSidebar() {
  const aside = el("aside", "session-sidebar");
  aside.setAttribute("aria-label", "Agents and sessions");
  const top = el("div", "sidebar-top");
  const brand = el("strong", "app-brand");
  brand.append(brandWordmark());
  top.append(brand, button("icon-button sidebar-close", null, () => setSidebar(false), { title: "Hide sidebar", icon: "⟨" }));
  const primary = el("div", "new-chat-row");
  primary.append(
    button("new-chat", "New chat", () => send({ type: "session.new" }), { icon: "＋", title: "Replace this agent with a fresh saved session" }),
    button("icon-button new-chat-more", null, (event) => openMenu(event.currentTarget, newSessionItems()), { title: "More ways to start", icon: "▾" }),
  );
  const lists = el("div", "sidebar-lists");
  lists.id = "sidebar-lists";
  const footer = el("div", "sidebar-footer");
  footer.append(
    button("sidebar-link", "Endpoints", () => openLogin(), { icon: "⇄", title: "Sign in to or out of model endpoints" }),
    button("sidebar-link", "Themes", () => openThemes(), { icon: "◐" }),
    button("sidebar-link", "Tools", () => openToolDialog(), { icon: "⚒" }),
    button("sidebar-link", "Shortcuts", () => openHelp(), { icon: "?" }),
  );
  aside.append(top, primary, lists, footer);
  return aside;
}

/**
 * Menu items for the "More ways to start" dropdown next to "New chat".
 * @returns {Array<object>} openMenu items (saved/unlogged variants, add agent, fork).
 */
function newSessionItems() {
  return [
    { label: "New chat", detail: "Saved session (replaces this one)", run: () => send({ type: "session.new" }) },
    { label: "New chat, read-only", detail: "Saved, safe mode on", run: () => send({ type: "session.new", safe: true }) },
    { label: "Unlogged chat", detail: "Nothing is written to disk", run: () => send({ type: "session.new", anonymous: true }) },
    { label: "Unlogged, read-only", detail: "Anonymous + safe mode", run: () => send({ type: "session.new", anonymous: true, safe: true }) },
    { separator: true },
    { label: "Add agent…", detail: "Keep this one running; pick a model", run: () => openAddAgent() },
    { label: "Fork this session", detail: "Branch the current context", run: () => send({ type: "session.fork" }) },
  ];
}

/**
 * Repaint the sidebar lists: running agents tree and the filterable recent-sessions list.
 * @returns {void}
 */
function updateSidebar() {
  const lists = document.querySelector("#sidebar-lists");
  if (!lists) return;
  const hadFocus = document.activeElement?.classList.contains("session-search");
  lists.replaceChildren();
  const running = el("section", "sidebar-section");
  const runningHead = el("div", "section-head");
  runningHead.append(el("h2", null, "Agents"), button("icon-button tiny", null, () => openAddAgent(), { title: "Add an agent (keeps this one running)", icon: "＋" }));
  const runningList = el("ul", "session-tree-list");
  runningList.append(...sessions.agents.map((a) => sessionAgent(a, 0)));
  if (!sessions.agents.length) runningList.append(el("li", "muted empty-row", "No running agents"));
  running.append(runningHead, runningList);
  const recent = el("section", "sidebar-section");
  const recentHead = el("div", "section-head");
  recentHead.append(el("h2", null, "Sessions"), el("span", "count", String(sessions.recent.length)));
  recent.append(recentHead);
  if (sessions.recent.length > 6) {
    const search = el("input", "session-search");
    search.type = "search"; search.placeholder = "Filter sessions"; search.value = sessionFilter;
    search.setAttribute("aria-label", "Filter saved sessions");
    search.addEventListener("input", () => { sessionFilter = search.value; updateSidebar(); });
    recent.append(search);
    if (hadFocus) queueMicrotask(() => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); });
  }
  const list = el("ul", "recent-list");
  const query = sessionFilter.trim().toLowerCase();
  const items = sessions.recent.filter((item) => !query || `${item.id} ${item.agent ?? ""} ${item.preview ?? ""}`.toLowerCase().includes(query));
  for (const item of items.slice(0, 200)) {
    const li = el("li");
    const row = el("div", "recent-row" + (item.id === agent?.session ? " active" : ""));
    const open = button("recent-item", null, () => send({ type: "session.resume", id: item.id }), { title: [item.agent ? `Agent: ${item.agent}` : null, `Resume ${item.id}`].filter(Boolean).join("\n") });
    open.append(el("span", "recent-title", item.preview || item.id), el("span", "recent-meta", [relativeTime(item.mtime), `${item.messages ?? 0} msg`, item.preview ? shortId(item.id) : null].filter(Boolean).join(" · ")));
    const rename = button("row-action", null, () => renameSessionPrompt(item.id), { title: `Rename session ${item.id}`, icon: "✎" });
    row.append(open, rename);
    row.append(button("row-action session-close", null, () => {
      const warning = item.live ? " This will also close the agent using it (stop its turn first if working)." : "";
      if (confirm(`Delete session “${item.preview || item.id}” permanently?${warning}`)) send({ type: "session.delete", id: item.id });
    }, { title: `Delete session ${item.id}${item.live ? " and close its agent" : ""}`, icon: "×" }));
    li.append(row);
    list.append(li);
  }
  if (!items.length) list.append(el("li", "muted empty-row", query ? "No matching sessions" : "No saved sessions yet"));
  recent.append(list);
  lists.append(running, recent);
}

/**
 * Human relative time for an mtime ("just now", "5m ago", …, then a locale date).
 * @param {number} mtime - epoch ms; non-positive/NaN yields "".
 * @returns {string}
 */
function relativeTime(mtime) {
  const at = Number(mtime);
  if (!Number.isFinite(at) || at <= 0) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * Build one sidebar agent row (with recursive children).
 * @param {object} a - agent entry from the sessions packet (`{ id, name, state, children?, … }`).
 * @param {number} depth - tree depth, drives the `--tree-depth` indent.
 * @returns {HTMLElement} the `<li>`.
 */
function sessionAgent(a, depth) {
  const item = el("li", "session-tree");
  item.style.setProperty("--tree-depth", String(depth));
  const row = el("div", "session-row" + (a.active || a.id === agent?.id ? " active" : ""));
  const agentState = a.state ?? (a.busy ? "working" : "idle");
  const dot = el("i", "agent-dot " + agentState);
  dot.setAttribute("aria-hidden", "true");
  const select = button("session-item", null, () => send({ type: "session.switch", agentId: a.id }), { title: a.description || a.name || a.id });
  const text = el("span", "session-item-text");
  text.append(el("span", "session-item-name", a.name || a.id), el("span", "session-item-meta", [a.model ? a.model : null, a.logged ? "saved" : "unlogged"].filter(Boolean).join(" · ")));
  select.append(dot, text);
  const status = el("span", "agent-status " + agentState);
  status.setAttribute("aria-label", `Status: ${agentState}`);
  status.append(agentState === "working" ? statusWord("working") : document.createTextNode(agentState === "idle" ? "" : agentState));
  const rename = button("row-action", null, () => renameAgentPrompt(a), { title: `Rename ${a.name || a.id}`, icon: "✎" });
  const close = button("row-action session-close", null, () => { if (!a.busy || confirm(`${a.name} is working. Close it anyway?`)) send({ type: "session.close", agentId: a.id }); }, { title: `Close ${a.name || a.id}`, icon: "×" });
  row.append(select, status, rename, close);
  item.append(row);
  const children = a.children ?? [];
  if (children.length) {
    const list = el("ul", "session-children");
    list.append(...children.map((child) => sessionAgent(child, depth + 1)));
    item.append(list);
  }
  return item;
}

/**
 * The animated "working" status word.
 * @param {string} text
 * @returns {HTMLElement} the `.working-word` span.
 */
function statusWord(text) { return el("span", "working-word", text); }

/* ------------------------------------------------------------- transcript */
// One mounted row per bubble. Stream patches and same-agent history refreshes
// retain rows so entrance/hover motion is independent of their content.
const nodes = [];          // nodes[i] is the stable hover frame for blocks[i]
const rowBlocks = new WeakMap();
const dirty = new Set();
let fullRender = true;
let resetTranscript = false;
let stickBottom = false; // force the next flush to the bottom (agent switch, history reload, own message)
let frame = 0;
let frameTimer = 0;

/**
 * Mark a block dirty and schedule a render.
 * @param {object} block - transcript block that changed.
 * @returns {void}
 */
function touch(block) { dirty.add(block); scheduleRender(); }
/**
 * Schedule a transcript repaint on the next animation frame, or a timer when
 * the browser withholds frames (hidden tab, occluded/minimized window, Safari
 * low-power): otherwise a stream piles up unseen and then lands all at once.
 * @param {boolean} [full=false] - force every block to re-render, not just dirty ones.
 * @returns {void}
 */
function scheduleRender(full = false) {
  if (full) fullRender = true;
  if (frame) return;
  frame = requestAnimationFrame(flushRender);
  frameTimer = setTimeout(flushRender, 100);
}
/**
 * Whether the transcript is scrolled to (within 80 px of) the bottom.
 * @returns {boolean} true when there is no scroll element yet.
 */
function nearBottom() { return !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80; }
/**
 * Show the jump-to-latest button off the bottom and the jump-to-oldest
 * button once the transcript is scrolled down past one viewport.
 * @returns {void}
 */
function syncJumpButtons() {
  jumpBtn.hidden = nearBottom();
  jumpTopBtn.hidden = scrollEl.scrollTop < scrollEl.clientHeight;
}

/**
 * Wrap a rendered block in its stable hover frame row (one mounted row per bubble).
 * @param {object} block - transcript block.
 * @returns {HTMLElement} the `.message-row` element.
 */
function messageFrame(block) {
  const row = el("div", `${messageRowClass(block)} entering`);
  rowBlocks.set(row, block);
  row.append(renderBlock(block));
  return row;
}

/**
 * CSS classes for a block's row, including the tool state class for tool cards.
 * @param {object} block
 * @returns {string}
 */
function messageRowClass(block) {
  return `message-row message-${block.kind}${block.kind === "tool" ? ` tool-${block.state ?? (block.done ? "ok" : "running")}` : ""}`;
}

/**
 * Whether a mounted row still hosts the same bubble (same kind and call id),
 * so it can be patched instead of replaced.
 * @param {HTMLElement} row
 * @param {object} block
 * @returns {boolean}
 */
function sameBubble(row, block) {
  const previous = rowBlocks.get(row);
  return previous?.kind === block.kind && previous.callId === block.callId;
}

/**
 * Patch one mounted row in place for a changed block. Card handlers close over
 * the block; a history replacement needs fresh handlers, while deltas on the
 * same block preserve spinner/shimmer nodes via `patchStreamingCard`.
 * @param {HTMLElement} row
 * @param {object} block
 * @returns {void}
 */
function patchMessage(row, block) {
  const previous = rowBlocks.get(row);
  if (previous !== block && previous?.open !== undefined) block.open ??= previous.open;
  row.className = `${messageRowClass(block)}${row.classList.contains("entering") ? " entering" : ""}`;
  rowBlocks.set(row, block);
  const next = renderBlock(block);
  // Card handlers close over the block; a history replacement needs fresh
  // handlers, while deltas on the same block preserve spinner/shimmer nodes.
  if (previous === block && (block.kind === "tool" || block.kind === "thinking") && !block.done && row.firstElementChild?.className === next.className) patchStreamingCard(row, next);
  else row.replaceChildren(next);
}

/**
 * Reconcile the mounted rows with the block list: append/replace/patch as needed.
 * @param {boolean} refresh - patch every retained row regardless of dirty state.
 * @returns {void}
 */
function renderMessages(refresh) {
  for (const row of nodes.splice(blocks.length)) row.remove();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const row = nodes[i];
    if (!row || !sameBubble(row, block)) {
      const next = messageFrame(block);
      if (row) row.replaceWith(next);
      else transcriptContainer.append(next);
      nodes[i] = next;
    } else if (refresh || dirty.has(block)) patchMessage(row, block);
  }
}

/**
 * Make `parent`'s children exactly `children`, in order, keeping mounted nodes.
 * Streamed cards retain their mounted header, so its spinner/shimmer keeps
 * playing. Completed cards can be replaced normally when their state changes.
 * @param {HTMLElement} parent
 * @param {Node[]} children
 * @returns {void}
 */
function reconcileCardChildren(parent, children) {
  for (const child of Array.from(parent.childNodes)) if (!children.includes(child)) child.remove();
  for (let i = 0; i < children.length; i++) {
    if (parent.childNodes[i] !== children[i]) parent.insertBefore(children[i], parent.childNodes[i] ?? null);
  }
}

/**
 * Patch a streaming tool/thinking card in place, preserving its mounted
 * spinner/shimmer/kind nodes so their animations keep playing.
 * @param {HTMLElement} row - mounted row whose first child is the card.
 * @param {HTMLElement} fresh - freshly rendered card to copy content from.
 * @returns {void}
 */
function patchStreamingCard(row, fresh) {
  const card = row.firstElementChild;
  const summary = card.querySelector("summary");
  const nextSummary = fresh.querySelector("summary");
  const head = summary.querySelector(".card-head");
  const nextHead = nextSummary.querySelector(".card-head");
  const preserved = new Map();
  for (const selector of [".tool-state", ".shimmer-dots", ".block-kind"]) {
    const old = head.querySelector(selector);
    if (old) preserved.set(selector, old);
  }
  const fields = Array.from(nextHead.childNodes, (node) => {
    const selector = [...preserved.keys()].find((key) => node.matches?.(key));
    if (!selector) return node;
    const old = preserved.get(selector);
    old.textContent = node.textContent;
    if (selector === ".tool-state") old.setAttribute("aria-label", node.getAttribute("aria-label"));
    return old;
  });
  reconcileCardChildren(head, fields);
  reconcileCardChildren(summary, [head, ...Array.from(nextSummary.childNodes).slice(1)]);
  reconcileCardChildren(card, [summary, ...Array.from(fresh.childNodes).slice(1)]);
}

/**
 * Keep the empty-state welcome pinned above the first non-system block.
 * @returns {void}
 */
function syncWelcome() {
  const welcome = transcriptContainer.querySelector(".empty-state");
  const firstUser = blocks.findIndex((block) => block.kind === "user");
  const boundary = firstUser < 0 ? blocks.findIndex((block) => block.kind !== "system") : firstUser;
  const next = boundary < 0 ? null : nodes[boundary];
  if (welcome && welcome.nextElementSibling === (next ?? null)) return;
  transcriptContainer.insertBefore(welcome ?? emptyState(), next ?? null);
}

/**
 * Flush the scheduled render: reconcile rows, sync the welcome, render the
 * working indicator, and keep the scroll pinned when already near the bottom.
 * @returns {void}
 */
function flushRender() {
  cancelAnimationFrame(frame);
  clearTimeout(frameTimer);
  frame = 0;
  if (!transcriptContainer) return;
  // Reset drops every row, so nearBottom() measured against the emptied
  // container lies — stickBottom carries the intent to land at the bottom.
  const stick = stickBottom || (!resetTranscript && nearBottom());
  stickBottom = false;
  if (resetTranscript) {
    resetTranscript = false;
    nodes.length = 0;
    transcriptContainer.replaceChildren();
  }
  renderMessages(fullRender);
  fullRender = false;
  dirty.clear();
  syncWelcome();
  renderWorkingIndicator();
  if (stick) scrollEl.scrollTop = scrollEl.scrollHeight;
  syncJumpButtons();
}

/**
 * Show a "Working" indicator when the agent is busy but nothing is streaming yet.
 * @returns {void}
 */
function renderWorkingIndicator() {
  transcriptContainer.querySelector(".working-row")?.remove();
  const working = agent?.state === "working" || agent?.busy === true;
  const last = blocks.at(-1);
  const streaming = last && !last.done && (last.kind === "text" || last.kind === "thinking" || last.kind === "tool");
  if (!working || streaming) return;
  const row = el("div", "working-row");
  row.append(el("span", "dots"), statusWord("Working"));
  transcriptContainer.append(row);
}

/**
 * The empty-state hero: wordmark, endpoint/model lead, prompt suggestions, and key hints.
 * @returns {HTMLElement} the `.empty-state` element.
 */
function emptyState() {
  const empty = el("div", "empty-state");
  const title = el("h1", null);
  title.append(brandWordmark());
  empty.append(title);
  const model = settings.endpoint ? `${settings.endpoint}/${settings.model ?? "?"}` : null;
  empty.append(el("p", "empty-lead", model ? `Talking to ${model}` : "Pick a model or sign in to an endpoint to begin."));
  if (!model) empty.append(button("primary-button", "Sign in to an endpoint", () => openLogin()));
  const tips = el("div", "empty-tips");
  const prompts = catalog.prompts.slice(0, 6);
  for (const name of prompts) tips.append(button("suggestion", `/${name}`, () => insertComposer(`/${name} `), { title: "Insert this prompt" }));
  if (prompts.length) empty.append(el("p", "muted small", "Your prompts"), tips);
  empty.append(el("p", "muted small", settings.sessionSave === true ? "This conversation is saved — resume it any time." : "Unlogged: nothing is written to disk until you turn logging on."));
  const keys = el("p", "muted small keys-line");
  keys.append(kbd("/"), document.createTextNode(" commands · "), kbd(isMac ? "⌘K" : "Ctrl K"), document.createTextNode(" palette · "), kbd("Shift ↵"), document.createTextNode(" new line"));
  empty.append(keys);
  return empty;
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
/**
 * A `<kbd>` element for a key label.
 * @param {string} text
 * @returns {HTMLElement}
 */
function kbd(text) { return el("kbd", null, text); }

/**
 * Render a transcript block to DOM, dispatching on its kind.
 * @param {object} block - `{ kind: "user"|"thinking"|"tool"|"system"|"error"|"command"|…, … }`.
 * @returns {HTMLElement} the message bubble.
 */
function renderBlock(block) {
  switch (block.kind) {
    case "user": return renderUser(block);
    case "thinking": return renderThinking(block);
    case "tool": return renderTool(block);
    case "system": return renderSystem(block);
    case "error": {
      const node = el("div", "msg msg-error");
      node.append(el("span", "msg-error-icon", "!"), el("span", "msg-error-text", block.text));
      if (block.retry) node.append(button("chip", "Retry", () => send({ type: "chat.continue" }), { title: "Continue over the current context" }));
      return node;
    }
    case "command": {
      const node = el("div", "msg msg-command");
      node.append(el("pre", null, block.text));
      return node;
    }
    default: {
      const node = el("div", "msg msg-assistant" + (block.done ? "" : " streaming"));
      const md = markdownNode("div", "md", block.text);
      if (!block.done) { const tail = md.lastElementChild; (tail && !/^(PRE|TABLE|UL|OL|DIV|HR)$/.test(tail.tagName) ? tail : md).append(el("span", "caret")); }
      node.append(md);
      node.append(blockControls(block));
      return node;
    }
  }
}

/**
 * Render a user message bubble, including attachment chips and block controls.
 * @param {object} block - `{ text, attachments?, … }`.
 * @returns {HTMLElement}
 */
function renderUser(block) {
  const node = el("div", "msg msg-user");
  const body = markdownNode("div", "md user-text", block.text);
  node.append(body);
  if (Array.isArray(block.attachments) && block.attachments.length) {
    const list = el("div", "attachment-chips inline");
    for (const file of block.attachments) list.append(el("span", "attachment-chip", `📎 ${file.name}${file.size ? ` · ${formatBytes(file.size)}` : ""}`));
    node.append(list);
  }
  node.append(blockControls(block));
  return node;
}

/**
 * Preview row cap for a block kind under the selected theme (theme
 * `<role>.preview.maxRows`, shared with the TUI); false = uncapped.
 * @param {string} kind - "system" | "thinking" | "tool".
 * @returns {number|false}
 */
function previewRows(kind) {
  const rows = prefs.previewRows?.[selectedTheme()] ?? prefs.previewRows?.default;
  return rows?.[kind] ?? false;
}

/**
 * TUI preview window: the first line, an omission marker, then the last
 * `rows - 2` lines — so a streaming block shows its tail with the head
 * cropped. Windowed BEFORE any Markdown parsing so a cut fence cannot
 * swallow the tail. Thinking previews render each visible window as Markdown.
 * @param {*} text - block text.
 * @param {number|false} rows - row cap; false = uncapped.
 * @param {string} [className=""] - extra classes.
 * @param {boolean} [markdown=false] - render each window as Markdown.
 * @returns {HTMLElement} the `.block-preview` element.
 */
function previewNode(text, rows, className = "", markdown = false) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  const node = el("div", `block-preview ${className}${markdown ? " md markdown-preview" : ""}`.trim());
  if (rows === false || lines.length <= rows) {
    if (markdown) node.append(markdownNode("div", "", lines.join("\n")));
    else node.textContent = lines.join("\n");
    return node;
  }
  const tail = Math.max(0, rows - 2);
  const hidden = lines.length - 1 - tail;
  const gap = el("span", "preview-gap", `⋯ ${hidden} more line${hidden === 1 ? "" : "s"}`);
  if (markdown) {
    node.append(markdownNode("div", "", lines[0]), gap);
    if (tail) node.append(markdownNode("div", "", lines.slice(-tail).join("\n")));
  } else node.append(document.createTextNode(`${lines[0]}\n`), gap, document.createTextNode(tail ? `\n${lines.slice(-tail).join("\n")}` : ""));
  return node;
}

/**
 * A collapsible card: <summary> holds the header row plus the collapsed
 * preview (a closed <details> renders nothing but its summary).
 * @param {object} block - transcript block; `block.open` persists the toggle state.
 * @param {string} className - card classes.
 * @param {boolean} isOpen - default open state when the block has no remembered one.
 * @returns {{node: HTMLElement, summary: HTMLElement, head: HTMLElement}}
 */
function cardShell(block, className, isOpen) {
  const node = el("details", className);
  node.open = block.open ?? isOpen;
  node.addEventListener("toggle", () => { block.open = node.open; });
  const summary = el("summary", null);
  const head = el("span", "card-head");
  summary.append(head);
  node.append(summary);
  return { node, summary, head };
}

/**
 * Render a system block as a collapsed card.
 * @param {object} block - `{ text, … }`.
 * @returns {HTMLElement}
 */
function renderSystem(block) {
  const { node, summary, head } = cardShell(block, "msg msg-system", false);
  head.append(el("span", "block-kind", "System"));
  summary.append(previewNode(block.text, previewRows("system")));
  node.append(markdownNode("div", "md system-body", block.text), blockControls(block));
  return node;
}

/**
 * Render a thinking block as a card with elapsed-time header and Markdown preview.
 * @param {object} block - `{ text, done, started?, ended?, … }`.
 * @returns {HTMLElement}
 */
function renderThinking(block) {
  const { node, summary, head } = cardShell(block, "msg msg-thinking" + (block.done ? "" : " streaming"), !prefs.collapse.thinking);
  const seconds = block.started && block.ended ? Math.max(1, Math.round((block.ended - block.started) / 1000)) : null;
  head.append(el("span", "block-kind", block.done ? (seconds ? `Thought for ${seconds}s` : "Thought") : "Thinking"));
  if (!block.done) head.append(el("span", "shimmer-dots"));
  summary.append(previewNode(block.text, previewRows("thinking"), "thinking-preview", true));
  node.append(markdownNode("div", "md thinking-body", block.text), blockControls(block));
  return node;
}

const TOOL_STATE = { composing: ["…", "writing call"], queued: ["◌", "queued"], running: ["◌", "running"], ok: ["✓", "done"], error: ["✕", "failed"], skipped: ["–", "not run"] };
/**
 * Render a tool card: state glyph, name, args summary, duration, windowed output
 * preview, and a lazily filled body (Input/Output sections, display payloads).
 * @param {object} block - tool block `{ name, args, state, output, done, … }`.
 * @returns {HTMLElement}
 */
function renderTool(block) {
  const state = block.state ?? (block.done ? "ok" : "running");
  const { node, summary, head } = cardShell(block, `msg msg-tool tool-${state}`, !prefs.collapse.tools || state === "error");
  node.addEventListener("toggle", () => { if (node.open) fillToolBody(); });
  const { name, summary: argSummary } = toolLabel({ name: block.name, arguments: block.args });
  const [glyph, label] = TOOL_STATE[state] ?? TOOL_STATE.running;
  const icon = el("span", "tool-state", glyph);
  icon.setAttribute("aria-label", label);
  head.append(icon, el("span", "tool-name", name));
  if (argSummary) head.append(el("span", "tool-args-summary", argSummary));
  const meta = el("span", "tool-meta");
  if (block.ended && block.runStarted) meta.textContent = formatDuration(block.ended - block.runStarted);
  else meta.textContent = state === "ok" || state === "error" ? "" : label;
  head.append(meta);
  // Collapsed: the output's preview window — or the arguments while the
  // model is still writing the call (the payload streaming right now).
  const rows = previewRows("tool");
  const payload = block.output || (state === "composing" || state === "queued" ? argsText(block.args) : "");
  if (payload) {
    const preview = readPreview(state === "ok" ? block.name : "", payload);
    if (preview.mime) head.append(el("span", "tool-meta", preview.mime));
    summary.append(previewNode(preview.text, rows, `tool-preview${state === "error" ? " error" : ""}`, preview.markdown));
  }
  // Display is meant for the user, not the model: keep it visible even when
  // the tool's input/output details are collapsed (notably edit diffs).
  for (const text of block.display ?? []) summary.append(markdownNode("div", "md tool-display", text));
  // The body renders lazily: collapsed cards in a long history cost nothing.
  const fillToolBody = () => {
    if (node.querySelector(".tool-body")) return;
    const body = el("div", "tool-body");
    const args = argsText(block.args);
    if (args) {
      const section = el("div", "tool-section");
      section.append(el("div", "tool-section-label", "Input"), state === "composing" ? previewNode(args, rows, "tool-args") : el("pre", "tool-args", args));
      body.append(section);
    }
    if (block.output) {
      const section = el("div", "tool-section");
      section.append(el("div", "tool-section-label", state === "error" ? "Error" : "Output"));
      // Streaming output stays windowed even when open (TUI parity: a huge
      // live payload never re-renders in full per frame); settled output is
      // shown complete.
      section.append(block.done ? markdownNode("div", "md tool-output", block.output) : previewNode(block.output, rows, "tool-output"));
      body.append(section);
    }
    if (!args && !block.output && !(block.display ?? []).length) body.append(el("p", "muted small", state === "running" ? "Waiting for output…" : "No output"));
    body.append(blockControls(block));
    node.append(body);
  };
  if (node.open) fillToolBody();
  return node;
}


const markdownSources = new WeakMap();
/**
 * Render Markdown source into an element, remembering the source for
 * Markdown-preserving copy and adding a copy bar to fenced code blocks.
 * @param {string} tag - element tag.
 * @param {string} className
 * @param {*} source - Markdown source.
 * @returns {HTMLElement}
 */
function markdownNode(tag, className, source) {
  const node = el(tag, className);
  node.innerHTML = renderMarkdown(source);
  markdownSources.set(node, String(source ?? ""));
  for (const pre of node.querySelectorAll("pre.md-code")) {
    const bar = el("div", "code-bar");
    bar.append(el("span", "code-lang", pre.dataset.lang || "text"), button("code-copy", "Copy", (event) => { event.stopPropagation(); copyText(pre.querySelector("code")?.textContent ?? "", "Code copied"); }));
    pre.prepend(bar);
  }
  return node;
}

/**
 * Per-block action icons: copy, view-in-context, edit (when editable),
 * edit-&-resend (user blocks), and delete.
 * @param {object} block
 * @returns {HTMLElement} the `.block-controls` row.
 */
function blockControls(block) {
  const controls = el("div", "block-controls");
  const text = block.kind === "tool" ? [argsText(block.args), block.output].filter(Boolean).join("\n\n") : block.text;
  controls.append(button("block-icon", null, () => copyText(String(text ?? ""), "Copied"), { title: "Copy", icon: "⧉" }));
  const index = Number.isInteger(block.messageIndex) ? block.messageIndex : Number.isInteger(block.resultIndex) ? block.resultIndex : null;
  if (index === null) return controls;
  const blockIndex = Number.isInteger(block.blockIndex) ? block.blockIndex : 0;
  controls.append(button("block-icon", null, () => openContextViewer({ messageIndex: index, blockIndex }), { title: "View in context", icon: "⌕" }));
  if (block.editable) controls.append(button("block-icon", null, () => openContextViewer({ messageIndex: index, blockIndex }, true), { title: "Edit", icon: "✎" }));
  if (block.kind === "user") controls.append(button("block-icon", null, () => { if (confirm("Remove this message and everything after it, and put its text back in the composer?")) { send({ type: "context.rollback", messageIndex: index }); insertComposer(block.text, true); } }, { title: "Edit & resend from here", icon: "↺" }));
  controls.append(button("block-icon block-delete", null, () => deleteContextMessages([index]), { title: "Delete message", icon: "⌫" }));
  return controls;
}

// Native select+copy keeps the browser's visible selection and writes the
// matching raw Markdown instead of flattening headings, links or emphasis.
document.addEventListener("copy", (event) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  for (let root = range.commonAncestorContainer; root; root = root.parentNode) {
    const source = markdownSources.get(root);
    if (source === undefined) continue;
    const text = selectedMarkdown(root, source, range);
    if (text === null || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    return;
  }
});

/**
 * Copy text to the clipboard and toast the result.
 * @param {*} text
 * @param {string} [message="Copied"] - success toast text.
 * @returns {Promise<void>}
 * Errors: falls back to a hidden-selection `execCommand("copy")` when the
 * Clipboard API is unavailable (insecure context or older browser).
 */
async function copyText(text, message = "Copied") {
  try { await navigator.clipboard.writeText(String(text)); toast(message); }
  catch {
    // Clipboard API needs a secure context; loopback http normally is one,
    // but fall back to a hidden selection for older browsers.
    const area = el("textarea"); area.value = String(text); area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select();
    const ok = document.execCommand?.("copy"); area.remove();
    toast(ok ? message : "Could not copy", !ok);
  }
}

/**
 * Delete messages from context after confirmation (single message or batch).
 * @param {number[]} messageIndexes
 * @returns {void}
 */
function deleteContextMessages(messageIndexes) {
  const unique = [...new Set(messageIndexes)].sort((a, b) => a - b);
  const label = unique.length === 1 ? "this message" : `${unique.length} messages`;
  if (!confirm(`Delete ${label} from context? This cannot be undone.`)) return;
  send({ type: "context.delete", messageIndexes: unique });
}

/* --------------------------------------------------------------- composer */
/**
 * Build the composer: textarea (restored from the agent's working draft), ghost
 * hint, autocomplete list, attachment picker/chips, queue strip, and the toolbar
 * with context meter, Stop and Send. Enter submits; whitespace-only input is a
 * continue (TUI parity); "/menu" opens the palette.
 * @returns {HTMLElement} the `<form>` element.
 */
function buildComposer() {
  const form = el("form", "composer");
  const queue = el("div", "composer-queue"); queue.id = "composer-queue";
  attachmentChips = el("div", "attachment-chips");
  attachmentChips.setAttribute("aria-live", "polite");
  const wrap = el("div", "composer-input");
  textareaEl = el("textarea");
  textareaEl.rows = 1;
  textareaEl.placeholder = "Message Omoya…";
  textareaEl.setAttribute("aria-label", "Message");
  textareaEl.spellcheck = true;
  // The working draft survives a rebuild; nothing else may reseed the box.
  textareaEl.value = composerDraft().text;
  // Rebuilding while browsing history (agent switch, hello) leaves the
  // session pointing at a recalled entry — drop back to the working draft.
  composerDraft().historyIndex = null; composerDraft().historyDraft = null;
  ghostEl = el("div", "composer-ghost");
  ghostEl.setAttribute("aria-hidden", "true");
  const acList = el("ul", "autocomplete");
  acList.id = "autocomplete";
  acList.hidden = true;
  acList.setAttribute("role", "listbox");
  textareaEl.setAttribute("aria-controls", "autocomplete");
  textareaEl.setAttribute("aria-expanded", "false");
  textareaEl.setAttribute("aria-autocomplete", "list");
  wrap.append(ghostEl, textareaEl, acList);
  attachmentInput = el("input", "attachment-picker");
  attachmentInput.type = "file"; attachmentInput.multiple = true; attachmentInput.hidden = true;
  attachmentInput.addEventListener("change", () => addFiles(attachmentInput.files));
  const toolbar = el("div", "composer-toolbar");
  const left = el("div", "toolbar-group");
  left.id = "composer-tools";
  const right = el("div", "toolbar-group toolbar-end");
  const meter = el("button", "context-meter");
  meter.type = "button"; meter.id = "usage-status";
  meter.addEventListener("click", () => openContextViewer());
  stopBtn = button("composer-stop", null, () => send({ type: "chat.cancel" }), { title: "Stop (Esc)", icon: "■" });
  stopBtn.hidden = !(agent?.busy);
  sendBtn = button("composer-send", null, null, { title: "Send (Enter)", icon: "↑", type: "submit" });
  sendBtn.hidden = agent?.state === "working" || agent?.busy === true;
  right.append(meter, stopBtn, sendBtn);
  toolbar.append(left, right);
  form.append(queue, attachmentChips, wrap, attachmentInput, toolbar);
  form.addEventListener("dragover", (event) => { event.preventDefault(); form.classList.add("drop-target"); });
  form.addEventListener("dragleave", (event) => { if (!form.contains(event.relatedTarget)) form.classList.remove("drop-target"); });
  form.addEventListener("drop", (event) => { event.preventDefault(); form.classList.remove("drop-target"); addFiles(event.dataTransfer?.files); });
  textareaEl.addEventListener("paste", (event) => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
  renderComposerQueue();
  renderAttachmentChips();

  textareaEl.addEventListener("input", () => { const firstWrite = !composerDraft().text && !!textareaEl.value; noteComposerInput(); autofit(firstWrite); updateAutocomplete(); updateGhost(); });
  textareaEl.addEventListener("blur", () => setTimeout(hideAutocomplete, 120));
  textareaEl.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (autocompleteKey(e)) return;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && recallHistory(e.key === "ArrowUp" ? -1 : 1)) { e.preventDefault(); updateGhost(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !acOpen()) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = textareaEl.value;
    const text = raw.trim();
    // Whitespace-only input is a continue (TUI parity): re-activate the
    // agent over its context without appending a message.
    if (!text && !draftAttachments.length) { if (raw.length && !(agent?.busy)) { send({ type: "chat.continue" }); textareaEl.value = ""; autofit(); } return; }
    if (text.startsWith("/") && draftAttachments.length) { toast("Commands cannot include attachments", true); return; }
    if (text === "/menu") { clearComposer(); openPalette(); return; }
    send({ type: "chat.submit", text, ...(draftAttachments.length ? { attachments: draftAttachments.map((file) => file.id) } : {}) });
    const draft = composerDraft();
    if (text && !text.startsWith("/")) draft.submitted.push(text);
    clearComposer();
  });
  queueMicrotask(() => { autofit(); updateGhost(); if (!matchMedia("(pointer: coarse)").matches) textareaEl.focus(); });
  return form;
}

/**
 * Load text (an expanded /<prompt>) into the composer for review/editing —
 * replaces the input like the TUI's fill, caret at the end.
 * @param {string} text
 * @returns {void}
 */
function fillComposer(text) {
  if (!textareaEl) return;
  textareaEl.value = text;
  noteComposerInput(); autofit(); updateGhost();
  textareaEl.focus();
  textareaEl.setSelectionRange(text.length, text.length);
}

/**
 * Empty the composer: clear the draft, attachments, autocomplete, and ghost.
 * @returns {void}
 */
function clearComposer() {
  const draft = composerDraft();
  draft.text = ""; draft.attachments = []; draft.historyIndex = null; draft.historyDraft = null;
  draftAttachments = []; renderAttachmentChips();
  textareaEl.value = "";
  autofit(); hideAutocomplete(); updateGhost();
}

/**
 * Insert text into the composer (appended to existing text unless `replace`).
 * @param {string} text
 * @param {boolean} [replace=false]
 * @returns {void}
 */
function insertComposer(text, replace = false) {
  if (!textareaEl) return;
  textareaEl.value = replace || !textareaEl.value ? text : `${textareaEl.value.replace(/\s*$/, " ")}${text}`;
  noteComposerInput(); autofit(); updateGhost();
  textareaEl.focus();
  textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
}

/**
 * Dim argument hint after a complete command (TUI ghost text).
 * @returns {void}
 */
function updateGhost() {
  if (!ghostEl || !textareaEl) return;
  const value = textareaEl.value;
  const match = value.match(/^(\/\S+) ?$/);
  const hint = match ? catalog.hints?.[match[1]] : null;
  ghostEl.replaceChildren();
  if (!hint) return;
  ghostEl.append(el("span", "ghost-typed", value.endsWith(" ") ? value : `${value} `), el("span", "ghost-hint", hint));
}

/**
 * Upload files as draft attachments (POST /upload keyed by the session's
 * uploadKey), showing pending chips and toasting failures. At most 10 files;
 * uploads invalidated by a reconnect are dropped.
 * @param {FileList|File[]} files
 * @returns {Promise<void>}
 */
async function addFiles(files) {
  const draft = composerDraft();
  const key = uploadKey;
  for (const file of [...(files ?? [])]) {
    if (!key) { toast("Upload connection is not ready", true); break; }
    if (draftAttachments.length >= 10) { toast("At most 10 attachments", true); break; }
    const form = new FormData(); form.append("file", file, file.name);
    const pending = { id: `pending-${Math.random()}`, name: file.name, size: file.size, pending: true };
    draftAttachments.push(pending); renderAttachmentChips();
    try {
      const response = await fetch("/upload", { method: "POST", headers: { "X-Omoya-Upload": key }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "upload failed");
      draftAttachments = draftAttachments.filter((item) => item !== pending);
      if (key !== uploadKey) continue; // Reconnect invalidated this opaque upload ID.
      draft.attachments.push(result);
      if (composerDraft() === draft) draftAttachments = [...draft.attachments];
    } catch (error) {
      draftAttachments = draftAttachments.filter((item) => item !== pending);
      toast(error?.message ?? "upload failed", true);
    }
    renderAttachmentChips();
  }
  if (attachmentInput) attachmentInput.value = "";
}
/**
 * Repaint the attachment chips (pending uploads show "uploading…" and no remove button).
 * @returns {void}
 */
function renderAttachmentChips() {
  if (!attachmentChips) return;
  attachmentChips.replaceChildren();
  for (const [index, file] of draftAttachments.entries()) {
    const chip = el("span", "attachment-chip" + (file.pending ? " pending" : ""));
    chip.append(el("span", null, `📎 ${file.name} · ${file.pending ? "uploading…" : formatBytes(file.size)}`));
    if (!file.pending) chip.append(button("attachment-remove", null, () => { draftAttachments.splice(index, 1); composerDraft().attachments = draftAttachments.filter((f) => !f.pending); renderAttachmentChips(); }, { title: `Remove ${file.name}`, icon: "×" }));
    attachmentChips.append(chip);
  }
}

/**
 * Rebuild the composer toolbar: attach button, then the setting chips in the
 * shared settingChips order (endpoint, model, thinking, safe mode, logging) —
 * the per-agent settings live next to where you type (the TUI keeps them one
 * ^X away). Wording/state come from settingChips; this toolbar owns the clicks.
 * @returns {void}
 */
function updateComposerTools() {
  const tools = document.querySelector("#composer-tools");
  if (!tools) return;
  tools.replaceChildren();
  tools.append(button("tool-chip icon-only", null, () => attachmentInput.click(), { title: "Attach files (or drop / paste them)", icon: "📎" }));
  // Wording, state, and order come from the shared settingChips (the TUI
  // status toolbar shows the same chips); this toolbar owns the click
  // behavior per chip key.
  const chips = settingChips({
    endpoint: settings.endpoint, model: settings.model, thinking: settings.thinking, safe: settings.safe,
    sessionSave: settings.sessionSave === true,
  });
  const byKey = Object.fromEntries(chips.map((chip) => [chip.key, chip]));
  const behavior = {
    endpoint: { run: () => openEndpointPicker(), extra: " model-chip" },
    model: { run: () => openModelPicker(), extra: " model-chip" },
    thinking: { run: (event) => openMenu(event.currentTarget, prefs.thinkingLevels.map((level) => ({ label: level, detail: level === "default" ? "provider default" : "", current: level === settings.thinking, run: () => send({ type: "settings.thinking", level }) }))) },
    safe: { run: () => send({ type: "settings.safe", on: !settings.safe }) },
    logging: { run: () => send({ type: "settings.session-save", on: !byKey.logging.pressed }) },
  };
  for (const chip of chips) {
    const { run, extra = "" } = behavior[chip.key] ?? {};
    const node = button("tool-chip" + extra + (chip.active ? " active" : "") + (chip.warn ? " warn" : ""), chip.label, run, { title: `${chip.title} — click to ${chip.action}`, icon: chip.icon });
    if (chip.pressed !== undefined) node.setAttribute("aria-pressed", String(chip.pressed));
    tools.append(node);
  }
}

/* ----------------------------------------------------------- autocomplete */
let acItems = [];
let acIndex = -1;
let acArg = false; // completing an argument (replace only the last token)

/**
 * The autocomplete list element.
 * @returns {HTMLElement|null}
 */
const acListEl = () => document.querySelector("#autocomplete");
/**
 * Whether the autocomplete popup has candidates.
 * @returns {boolean}
 */
const acOpen = () => acItems.length > 0;

/**
 * First line of a /tool-… command's description, from the tool schemas catalog.
 * @param {string} name - slash command, e.g. "/tool-bash".
 * @returns {string}
 */
function toolDescription(name) { return String(catalog.toolSchemas.find((schema) => `/tool-${schema.name}` === name)?.description ?? "").split("\n")[0]; }
/**
 * All slash candidates: commands, prompts, and /tool-… entries.
 * @returns {Array<{value: string, detail: string}>}
 */
function allSlash() {
  const promptNames = catalog.prompts.map((p) => ({ value: p.startsWith("/") ? p : `/${p}`, detail: "prompt" }));
  return [
    ...catalog.commands.map((value) => ({ value, detail: catalog.hints?.[value] ?? "" })),
    ...promptNames,
    ...catalog.tools.map((value) => ({ value, detail: toolDescription(value) })),
  ];
}

/**
 * Argument candidates for commands whose arguments come from live state.
 * @param {string} command - e.g. "/endpoint-model".
 * @returns {string[]|null} candidates, or null when the command has none.
 */
function argumentSource(command) {
  switch (command) {
    case "/endpoint-model": return settings.models;
    case "/session-resume": return ["latest", ...sessions.recent.map((item) => item.id)];
    case "/agent-thinking": return prefs.thinkingLevels;
    case "/agent-safe": return ["on", "off"];
    case "/agent-session-save": return ["true", "false"];
    case "/endpoint-logout": return endpoints.removable;
    case "/endpoint-login": return ["package", "local"];
    case "/new": case "/session-new": case "/session-fork": return ["false"];
    default: return null;
  }
}

/**
 * Recompute autocomplete candidates from the current composer text: command
 * completion for a leading "/token", argument completion for known commands.
 * @returns {void}
 */
function updateAutocomplete() {
  hideAutocomplete();
  if (!prefs.autocomplete || !textareaEl) return;
  const value = textareaEl.value;
  if (!value.startsWith("/") || value.includes("\n")) return;
  const argMatch = value.match(/^(\/\S+)\s+(\S*)$/);
  if (argMatch) {
    const source = argumentSource(argMatch[1]);
    if (!source) return;
    const query = argMatch[2].toLowerCase();
    acItems = source.filter((item) => item.toLowerCase().includes(query) && item !== argMatch[2]).slice(0, 12).map((item) => ({ value: item, detail: "" }));
    acArg = true;
  } else {
    if (value.includes(" ")) return;
    const query = value.toLowerCase();
    const all = allSlash();
    const starts = all.filter((c) => c.value.toLowerCase().startsWith(query));
    const contains = all.filter((c) => !starts.includes(c) && c.value.toLowerCase().includes(query.slice(1)));
    acItems = [...starts, ...contains].slice(0, 14);
    acArg = false;
  }
  acIndex = acItems.length ? 0 : -1;
  drawAutocomplete();
}

/**
 * Repaint the autocomplete list from `acItems`, marking `acIndex` active.
 * @returns {void}
 */
function drawAutocomplete() {
  const list = acListEl();
  if (!list) return;
  list.replaceChildren();
  if (!acItems.length) { list.hidden = true; textareaEl?.setAttribute("aria-expanded", "false"); return; }
  list.hidden = false;
  textareaEl?.setAttribute("aria-expanded", "true");
  acItems.forEach((item, i) => {
    const li = el("li");
    const btn = el("button", i === acIndex ? "active" : "");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(i === acIndex));
    btn.append(el("span", "ac-value", item.value));
    if (item.detail) btn.append(el("span", "ac-detail", item.detail));
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); pickAutocomplete(i); });
    li.append(btn);
    list.append(li);
  });
  list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

/**
 * Close and clear the autocomplete popup.
 * @returns {void}
 */
function hideAutocomplete() { acItems = []; acIndex = -1; const list = acListEl(); if (list) list.hidden = true; textareaEl?.setAttribute("aria-expanded", "false"); }

/**
 * Accept autocomplete candidate `i`: replace the token (or last argument when
 * completing an argument) and chain into argument candidates.
 * @param {number} i - index into `acItems`.
 * @returns {void}
 */
function pickAutocomplete(i) {
  const item = acItems[i];
  if (item === undefined) return;
  textareaEl.value = acArg ? textareaEl.value.replace(/\S*$/, item.value) : item.value + " ";
  hideAutocomplete();
  textareaEl.focus();
  noteComposerInput(); autofit(); updateGhost();
  if (!acArg) updateAutocomplete(); // chain into argument candidates
}

/**
 * Keyboard handling for the autocomplete popup: arrows cycle, Tab/Enter accept,
 * Esc closes. Enter on an exact command match submits instead of re-completing.
 * @param {KeyboardEvent} e
 * @returns {boolean} true when the key was consumed.
 */
function autocompleteKey(e) {
  if (!acOpen()) return false;
  if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; drawAutocomplete(); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; drawAutocomplete(); return true; }
  if (e.key === "Tab" || (e.key === "Enter" && acIndex >= 0 && !e.shiftKey)) {
    // Enter on an exact command match submits instead of re-completing.
    if (e.key === "Enter" && acItems[acIndex]?.value === textareaEl.value.trim()) { hideAutocomplete(); return false; }
    e.preventDefault(); pickAutocomplete(acIndex); return true;
  }
  if (e.key === "Escape") { e.preventDefault(); hideAutocomplete(); return true; }
  return false;
}

/* ---------------------------------------------------------------- dialogs */
/**
 * A native <dialog>: focus trap, Esc, and backdrop come from the browser.
 * Replaces any open dialog with the same id; closing returns focus to the composer.
 * @param {object} [options]
 * @param {string} options.id - element id (must be unique).
 * @param {string} options.title
 * @param {string} [options.className=""]
 * @param {boolean} [options.wide=false]
 * @param {() => void} [options.onClose] - skipped when a same-id replacement took over.
 * @param {boolean} [options.backdropCloses=true]
 * @returns {{dialog: HTMLDialogElement, body: HTMLElement, head: HTMLElement}}
 */
function openDialog({ id, title, className = "", wide = false, onClose, backdropCloses = true } = {}) {
  const previous = document.querySelector(`#${id}`);
  if (previous) { previous.close(); previous.remove(); }
  const dialog = el("dialog", `panel${wide ? " wide" : ""} ${className}`);
  dialog.id = id;
  const head = el("header", "panel-head");
  head.append(el("h2", null, title), button("icon-button", null, () => dialog.close(), { title: "Close (Esc)", icon: "×" }));
  const body = el("div", "panel-body");
  dialog.append(head, body);
  dialog.addEventListener("close", () => {
    // A same-id replacement already took over: its state must survive.
    const replaced = document.querySelector(`#${id}`) && document.querySelector(`#${id}`) !== dialog;
    dialog.remove();
    if (replaced) return;
    onClose?.();
    if (!document.querySelector("dialog[open]")) textareaEl?.focus({ preventScroll: true });
  });
  if (backdropCloses) dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, head };
}

/**
 * Re-render any open panels after a settings/endpoints push.
 * @returns {void}
 */
function refreshOpenPanels() {
  if (document.querySelector("#settings-panel")) renderSettingsBody();
  if (document.querySelector("#login-panel") && (!loginSelection || loginSelection.oauth)) renderLoginBody();
  if (document.querySelector("#themes-panel")) renderThemesBody();
}

/**
 * Small anchored menu (thinking levels, new-chat variants). Closes on outside
 * pointer-down or Esc; arrows move focus.
 * @param {HTMLElement} anchor - element to position under.
 * @param {Array<object>} items - `{ label, detail?, current?, run?, separator? }`.
 * @returns {void}
 */
function openMenu(anchor, items) {
  document.querySelector(".popup-menu")?.remove();
  const menu = el("div", "popup-menu");
  menu.setAttribute("role", "menu");
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", outside, true); };
  const outside = (event) => { if (!menu.contains(event.target) && event.target !== anchor) close(); };
  for (const item of items) {
    if (item.separator) { menu.append(el("hr")); continue; }
    const row = button("menu-item" + (item.current ? " current" : ""), null, () => { close(); item.run(); anchor.focus?.(); });
    row.setAttribute("role", "menuitem");
    row.append(el("span", "menu-label", item.label));
    if (item.detail) row.append(el("span", "menu-detail", item.detail));
    if (item.current) row.append(el("span", "menu-check", "✓"));
    menu.append(row);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(18 * 16, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 6;
  if (below + menu.offsetHeight > window.innerHeight - 8) menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  else menu.style.top = `${below}px`;
  menu.addEventListener("keydown", (event) => {
    const rows = [...menu.querySelectorAll(".menu-item")];
    const at = rows.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close(); anchor.focus?.(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); rows[(at + 1) % rows.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); rows[(at - 1 + rows.length) % rows.length]?.focus(); }
  });
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  (menu.querySelector(".menu-item.current") ?? menu.querySelector(".menu-item"))?.focus();
}

/**
 * Filterable, grouped, keyboard-driven list (palette, model picker).
 * @param {object} options
 * @param {string} options.id - dialog id.
 * @param {string} options.title
 * @param {string} [options.placeholder]
 * @param {Array<object>} options.items - `{ label, detail?, group?, keywords?, icon?, current?, shortcut?, keep?, run? }`.
 * @param {(item: object|undefined) => void} [options.onHover] - active-row callback (theme preview).
 * @param {() => void} [options.onClose]
 * @returns {HTMLDialogElement}
 */
function openPicker({ id, title, placeholder, items, onHover, onClose }) {
  const { dialog, body } = openDialog({ id, title, className: "picker", onClose });
  const input = el("input", "picker-input");
  input.type = "search"; input.placeholder = placeholder ?? "Type to filter"; input.setAttribute("aria-label", placeholder ?? "Filter");
  const list = el("div", "picker-list");
  list.setAttribute("role", "listbox");
  body.append(input, list);
  let shown = [];
  let active = 0;
  const score = (item, query) => {
    if (!query) return 1;
    const hay = `${item.label} ${item.detail ?? ""} ${item.group ?? ""} ${item.keywords ?? ""}`.toLowerCase();
    if (item.label.toLowerCase().startsWith(query)) return 3;
    if (hay.includes(query)) return 2;
    let at = 0;
    for (const char of query) { at = hay.indexOf(char, at); if (at < 0) return 0; at++; }
    return 1;
  };
  const draw = () => {
    const query = input.value.trim().toLowerCase();
    shown = items.map((item, order) => ({ item, order, s: score(item, query) })).filter((entry) => entry.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0) || a.order - b.order).map((entry) => entry.item).slice(0, 300);
    if (!query) shown.sort((a, b) => (items.indexOf(a) - items.indexOf(b)));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren();
    let group = null;
    shown.forEach((item, i) => {
      if (!query && item.group !== group) { group = item.group; if (group) list.append(el("div", "picker-group", group)); }
      const row = el("button", "picker-row" + (i === active ? " active" : "") + (item.current ? " current" : ""));
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === active));
      if (item.icon) row.append(el("span", "picker-icon", item.icon));
      const text = el("span", "picker-text");
      text.append(el("span", "picker-label", item.label));
      if (item.detail) text.append(el("span", "picker-detail", item.detail));
      row.append(text);
      if (query && item.group) row.append(el("span", "picker-tag", item.group));
      if (item.current) row.append(el("span", "picker-check", "✓"));
      if (item.shortcut) row.append(kbd(item.shortcut));
      row.addEventListener("click", () => pick(i));
      row.addEventListener("mousemove", () => { if (active !== i) { active = i; mark(); } });
      list.append(row);
    });
    if (!shown.length) list.append(el("p", "muted picker-empty", "Nothing matches"));
    mark();
  };
  const mark = () => {
    list.querySelectorAll(".picker-row").forEach((row, i) => { row.classList.toggle("active", i === active); row.setAttribute("aria-selected", String(i === active)); });
    list.querySelectorAll(".picker-row")[active]?.scrollIntoView({ block: "nearest" });
    onHover?.(shown[active]);
  };
  const pick = (i) => { const item = shown[i]; if (!item) return; if (!item.keep) dialog.close(); item.run?.(); };
  input.addEventListener("input", () => { active = 0; draw(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); active = (active + 1) % Math.max(1, shown.length); mark(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); mark(); }
    else if (event.key === "Enter") { event.preventDefault(); pick(active); }
    else if (event.key === "PageDown") { event.preventDefault(); active = Math.min(shown.length - 1, active + 8); mark(); }
    else if (event.key === "PageUp") { event.preventDefault(); active = Math.max(0, active - 8); mark(); }
  });
  const currentIndex = items.findIndex((item) => item.current);
  if (currentIndex >= 0 && items.length > 8) active = currentIndex;
  draw();
  input.focus();
  return dialog;
}

/* ---------------------------------------------------------------- palette */
/**
 * Open the command palette (Ctrl/⌘+K): actions, thinking levels, delegation,
 * agents, sessions, models, prompts, tools, commands, and themes in one picker.
 * Hovering a theme previews it; closing restores the saved selection.
 * @returns {void}
 */
function openPalette() {
  const items = [];
  const add = (group, label, run, extra = {}) => items.push({ group, label, run, ...extra });
  const A = "Actions";
  add(A, "New chat", () => send({ type: "session.new" }), { icon: "＋", detail: "saved session" });
  add(A, "New unlogged chat", () => send({ type: "session.new", anonymous: true }), { icon: "＋", detail: "nothing written to disk" });
  add(A, "Add agent…", () => openAddAgent(), { icon: "⧉", detail: "keep this one running" });
  add(A, "Fork session", () => send({ type: "session.fork" }), { icon: "⑂" });
  add(A, "Rename agent…", () => renameAgentPrompt(), { icon: "✎" });
  add(A, "Rename session…", () => renameSessionPrompt(), { icon: "✎" });
  add(A, "Switch model…", () => openModelPicker(), { icon: "◇", detail: settings.endpoint ? `${settings.endpoint}/${settings.model}` : "none selected" });
  add(A, settings.safe ? "Turn safe mode off" : "Turn safe mode on (read-only)", () => send({ type: "settings.safe", on: !settings.safe }), { icon: settings.safe ? "🔓" : "🔒" });
  add(A, settings.sessionSave === true ? "Pause session logging" : "Start logging this session", () => send({ type: "settings.session-save", on: settings.sessionSave !== true }), { icon: "📝" });
  add(A, "Continue", () => send({ type: "chat.continue" }), { icon: "▶", detail: "re-activate over the current context" });
  add(A, "Copy last response", () => send({ type: "chat.submit", text: "/context-copy" }), { icon: "⧉" });
  add(A, "Block viewer", () => openContextViewer(), { icon: "▤", shortcut: "Ctrl O" });
  add(A, "Compact context", () => send({ type: "chat.submit", text: "/context-compact" }), { icon: "⇲", detail: "model summarizes the conversation" });
  add(A, "Clear thinking blocks", () => send({ type: "chat.submit", text: "/context-clear-thoughts" }), { icon: "✦" });
  add(A, "Run a tool…", () => openToolDialog(), { icon: "⚒" });
  add(A, "Agent status", () => send({ type: "chat.submit", text: "/agent-status" }), { icon: "ℹ" });
  add(A, "Clear this session…", () => { if (confirm("Clear every message in this session and restart it?")) send({ type: "session.clear" }); }, { icon: "⌫" });
  add(A, "Delete ALL saved sessions…", () => send({ type: "chat.submit", text: "/session-delete-all!" }), { icon: "⚠" });
  add(A, "Sign in to an endpoint…", () => openLogin(), { icon: "⇄" });
  add(A, "Themes…", () => openThemes(), { icon: "◐" });
  add(A, "Settings", () => openSettings(), { icon: "⚙" });
  add(A, "Keyboard shortcuts", () => openHelp(), { icon: "?" });
  add(A, "Help (commands)", () => send({ type: "chat.submit", text: "/help" }), { icon: "?" });
  for (const level of prefs.thinkingLevels) add("Thinking", `Thinking: ${level}`, () => send({ type: "settings.thinking", level }), { current: level === settings.thinking, icon: "✦" });
  if (!settings.delegationLocked) for (const [label, value] of [["Allow", true], ["Deny", false], ["Ask", null]]) add("Delegation", `Allow to delegate: ${label}`, () => send({ type: "settings.spawn", value }), { current: settings.spawnPermission === value, icon: "⇶" });
  for (const a of agentList()) add("Agents", a.name, () => send({ type: "session.switch", agentId: a.id }), { current: a.id === agent?.id, detail: [a.model, a.state === "working" ? "working" : ""].filter(Boolean).join(" · "), icon: "●" });
  for (const s of sessions.recent) add("Sessions", s.preview || s.id, () => send({ type: "session.resume", id: s.id }), { detail: [s.agent, relativeTime(s.mtime), `${s.messages ?? 0} msg`, shortId(s.id)].filter(Boolean).join(" · "), keywords: `${s.id} ${s.agent ?? ""}`, icon: "↺" });
  for (const model of settings.models) add("Models", model, () => send({ type: "settings.model", model }), { current: model === `${settings.endpoint}/${settings.model}`, icon: "◇" });
  for (const name of catalog.prompts) add("Prompts", `/${name}`, () => insertComposer(`/${name} `), { icon: "❝" });
  for (const schema of catalog.toolSchemas) add("Tools", schema.name, () => openToolDialog(schema.name), { detail: String(schema.description ?? "").split("\n")[0].slice(0, 90), icon: "⚒" });
  for (const command of catalog.commands) add("Commands", command, () => insertComposer(`${command} `), { detail: catalog.hints?.[command] ?? "", icon: "/" });
  for (const name of prefs.themes) add("Themes", `Theme: ${name}`, () => chooseTheme(name), { current: name === selectedTheme(), icon: "◐", preview: name });
  openPicker({
    id: "palette", title: "Command palette", placeholder: "Search actions, agents, sessions, models, prompts, tools…", items,
    onHover: (item) => { if (item?.preview) applyThemeName(item.preview); else applyTheme(); },
    onClose: applyTheme,
  });
}

/**
 * Endpoints first: picking one narrows the model picker to its models.
 * Falls back to the model picker when no endpoints are known.
 * @returns {void}
 */
function openEndpointPicker() {
  const items = endpoints.endpoints.map((endpoint) => endpoint.loginRequired
    ? { label: endpoint.name, detail: "sign-in required", run: () => openLogin(endpoint.name), icon: "⇄" }
    : { label: endpoint.name, detail: `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}`, current: endpoint.name === settings.endpoint, run: () => openModelPicker(endpoint.name), icon: "◎" });
  if (!items.length) return openModelPicker();
  items.push({ label: "Sign in to another endpoint…", run: () => openLogin(), icon: "＋" });
  openPicker({ id: "endpoint-picker", title: "Choose an endpoint", placeholder: "Filter endpoints", items });
}

/**
 * Model picker, grouped by endpoint; falls back to the settings list when the
 * endpoints packet has not arrived.
 * @param {string} [only] - list just this endpoint's models.
 * @returns {void}
 */
function openModelPicker(only) {
  const items = [];
  for (const endpoint of endpoints.endpoints) {
    if (only && endpoint.name !== only) continue;
    if (endpoint.loginRequired) { items.push({ group: endpoint.name, label: `Sign in to ${endpoint.name}`, run: () => openLogin(endpoint.name), icon: "⇄" }); continue; }
    for (const id of endpoint.models) {
      const value = `${endpoint.name}/${id}`;
      items.push({ group: endpoint.name, label: id, detail: "", current: value === `${settings.endpoint}/${settings.model}`, run: () => send({ type: "settings.model", model: value }), icon: "◇" });
    }
  }
  // Fall back to the settings list when the endpoints packet has not arrived.
  if (!items.length) for (const model of settings.models) items.push({ group: model.split("/")[0], label: model.split("/").slice(1).join("/"), current: model === `${settings.endpoint}/${settings.model}`, run: () => send({ type: "settings.model", model }) });
  items.push({ group: "Endpoints", label: "Sign in to another endpoint…", run: () => openLogin(), icon: "＋" });
  openPicker({ id: "model-picker", title: "Choose a model", placeholder: "Filter models", items });
}

/**
 * Picker for adding an agent (same model or any configured model) while the
 * current one keeps running.
 * @returns {void}
 */
function openAddAgent() {
  const items = [{ group: "Same model", label: settings.endpoint ? `${settings.endpoint}/${settings.model}` : "Default model", run: () => send({ type: "session.add" }), icon: "＋", detail: "new agent, this one keeps running" }];
  for (const model of settings.models) items.push({ group: "Choose a model", label: model, run: () => send({ type: "session.add", model }), icon: "◇" });
  openPicker({ id: "add-agent", title: "Add an agent", placeholder: "Filter models", items });
}

/* ----------------------------------------------------------------- naming */
/**
 * Prompt for a new agent name and send the rename.
 * @param {object} [target=agent] - agent entry to rename (defaults to the viewed one).
 * @returns {void}
 */
function renameAgentPrompt(target = agent) {
  if (!target) return;
  const name = prompt("Agent name", target.name ?? "");
  if (name === null || !name.trim() || name.trim() === target.name) return;
  send({ type: "agent.rename", agentId: target.id, name: name.trim() });
}
/**
 * Rename a saved session: the viewed agent's by default, or `id` (a
 * sidebar row). An auto (UUID) id offers an empty name to type.
 * @param {string} [id] - session id; omitted targets the viewed session.
 * @returns {void}
 * Effects: toasts when the session is unlogged.
 */
function renameSessionPrompt(id) {
  const current = id ?? agent?.session;
  if (!current) { toast("This session is unlogged — turn logging on to name it", true); return; }
  const name = prompt("Session name (saved as its file name)", /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(current) ? "" : current);
  if (name === null || !name.trim() || name.trim() === current) return;
  send({ type: "session.rename", name: name.trim(), ...(id === undefined ? {} : { id }) });
}

/* --------------------------------------------------------------- settings */
/**
 * Open the settings dialog.
 * @returns {void}
 */
function openSettings() {
  openDialog({ id: "settings-panel", title: "Settings", wide: true });
  renderSettingsBody();
}
/**
 * Repaint the settings dialog body (agent, session, endpoints, appearance).
 * Skips the repaint while the user is typing in one of its fields so a server
 * push never wipes the input.
 * @returns {void}
 */
function renderSettingsBody() {
  const body = document.querySelector("#settings-panel .panel-body");
  if (!body) return;
  // A server push must never wipe a field the user is typing in.
  if (body.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && body.childElementCount) return;
  const scroll = body.scrollTop;
  body.replaceChildren();
  const section = (title, hint) => { const node = el("section", "settings-section"); node.append(el("h3", null, title)); if (hint) node.append(el("p", "muted small", hint)); body.append(node); return node; };
  const row = (label, control, hint) => { const node = el("div", "settings-row"); const text = el("div", "settings-label"); text.append(el("span", null, label)); if (hint) text.append(el("small", "muted", hint)); node.append(text, control); return node; };
  const segmented = (options, value, onPick, disabled = false) => {
    const group = el("div", "segmented");
    group.setAttribute("role", "radiogroup");
    for (const [label, option] of options) {
      const btn = button("segment" + (option === value ? " active" : ""), label, () => onPick(option));
      btn.setAttribute("role", "radio"); btn.setAttribute("aria-checked", String(option === value)); btn.disabled = disabled;
      group.append(btn);
    }
    return group;
  };

  const agentSection = section("Agent", "Applies to the agent you are viewing.");
  const nameForm = el("form", "inline-form");
  const nameInput = el("input"); nameInput.value = agent?.name ?? ""; nameInput.setAttribute("aria-label", "Agent name");
  nameForm.append(nameInput, button("chip", "Rename", null, { type: "submit" }));
  nameForm.addEventListener("submit", (event) => { event.preventDefault(); if (nameInput.value.trim() && nameInput.value.trim() !== agent?.name) send({ type: "agent.rename", agentId: agent?.id, name: nameInput.value.trim() }); });
  agentSection.append(row("Name", nameForm, "Shown in the sidebar and to linked agents"));
  const model = button("chip wide-chip", settings.endpoint ? `${settings.endpoint}/${settings.model}` : "Choose…", () => openModelPicker(), { icon: "◇" });
  agentSection.append(row("Model", model));
  const thinking = el("select"); thinking.setAttribute("aria-label", "Thinking level");
  for (const level of prefs.thinkingLevels) { const option = el("option", null, level === "default" ? "default (provider)" : level); option.value = level; option.selected = level === settings.thinking; thinking.append(option); }
  thinking.addEventListener("change", () => send({ type: "settings.thinking", level: thinking.value }));
  agentSection.append(row("Thinking", thinking));
  agentSection.append(row("Tool access", segmented([["Read/write", false], ["Read-only", true]], settings.safe, (on) => send({ type: "settings.safe", on })), "Read-only publishes and runs only safe tools"));
  agentSection.append(row("Allow to delegate", segmented([["Allow", true], ["Deny", false], ["Ask", null]], settings.spawnPermission, (value) => send({ type: "settings.spawn", value }), settings.delegationLocked), settings.delegationLocked ? "Linked (child) agents never delegate" : "Whether this agent may spawn helper agents"));

  const sessionSection = section("Session", settings.sessionSave === true ? `Saved as “${agent?.session}”.` : "Unlogged — nothing is written to disk.");
  if (agent?.session) {
    const sessionForm = el("form", "inline-form");
    const sessionInput = el("input"); sessionInput.value = agent.session; sessionInput.setAttribute("aria-label", "Session name");
    sessionForm.append(sessionInput, button("chip", "Rename", null, { type: "submit" }));
    sessionForm.addEventListener("submit", (event) => { event.preventDefault(); if (sessionInput.value.trim() && sessionInput.value.trim() !== agent.session) send({ type: "session.rename", name: sessionInput.value.trim() }); });
    sessionSection.append(row("Name", sessionForm, "Renames the session file"));
  }
  sessionSection.append(row("Logging", segmented([["On", true], ["Off", false]], settings.sessionSave === true, (on) => send({ type: "settings.session-save", on })), "On writes the whole conversation; off keeps it in memory only"));
  const sessionActions = el("div", "button-row");
  sessionActions.append(
    button("chip", "Fork", () => send({ type: "session.fork" }), { icon: "⑂" }),
    button("chip", "Compact", () => send({ type: "chat.submit", text: "/context-compact" }), { icon: "⇲" }),
    button("chip danger", "Clear session", () => { if (confirm("Clear every message in this session and restart it?")) send({ type: "session.clear" }); }, { icon: "⌫" }),
    button("chip danger", "Delete all sessions…", () => { document.querySelector("#settings-panel")?.close(); send({ type: "chat.submit", text: "/session-delete-all!" }); }, { icon: "⚠" }),
  );
  sessionSection.append(sessionActions);

  const endpointSection = section("Endpoints", "Model providers this machine can reach. Sign-ins are shared with the terminal UI.");
  const list = el("ul", "endpoint-list");
  for (const endpoint of endpoints.endpoints) {
    const li = el("li", "endpoint-row");
    const text = el("div", "endpoint-text");
    text.append(el("strong", null, endpoint.name), el("small", "muted", endpoint.loginRequired ? "sign-in required" : `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}${endpoint.name === settings.endpoint ? " · in use" : ""}`));
    li.append(text);
    if (endpoint.loginRequired) li.append(button("chip", "Sign in", () => openLogin(endpoint.name)));
    if (endpoints.removable.includes(endpoint.name)) li.append(button("chip danger", "Sign out", () => { if (confirm(`Remove endpoint "${endpoint.name}" (its settings and stored credentials)?`)) send({ type: "endpoint.logout", name: endpoint.name }); }));
    list.append(li);
  }
  if (!endpoints.endpoints.length) list.append(el("li", "muted", "No endpoints configured yet."));
  endpointSection.append(list, button("primary-button", "Sign in / add endpoint", () => openLogin(), { icon: "＋" }));

  const appearance = section("Appearance", "Named themes are available in both apps; the web selection is saved separately.");
  appearance.append(button("chip wide-chip", `Theme: ${selectedTheme()}`, () => openThemes(), { icon: "◐" }));
  body.scrollTop = scroll;
}

/* ------------------------------------------------------------------ login */
let loginSelection = null; // null = preset list; {preset?|manual}
/**
 * Open the endpoint sign-in dialog, optionally preselecting an endpoint's preset.
 * @param {string} [endpointName] - preset name to preselect (starts OAuth immediately).
 * @returns {void}
 */
function openLogin(endpointName) {
  send({ type: "endpoint.list" });
  const preset = endpointName ? endpoints.presets.find((item) => item.name === endpointName) : null;
  loginSelection = preset ? { preset } : null;
  if (preset?.oauth) startOAuth(preset);
  openDialog({ id: "login-panel", title: "Sign in to an endpoint", onClose: () => { loginSelection = null; } });
  renderLoginBody();
}
/**
 * Begin browser OAuth for a preset: reset the OAuth state and request the flow.
 * @param {object} preset - endpoint preset `{ name, label, provider, oauth }`.
 * @returns {void}
 */
function startOAuth(preset) {
  oauthState = { active: true, url: null, lines: [], done: false, error: false, name: preset.name };
  loginSelection = { preset, oauth: true };
  send({ type: "endpoint.oauth", name: preset.name });
}
/**
 * Fold a server OAuth progress packet into `oauthState` and repaint the login dialog.
 * @param {object} m - `{ state: "url"|"log"|"done"|"error", url?, text? }`.
 * @returns {void}
 */
function onOAuth(m) {
  if (m.state === "url") oauthState = { ...oauthState, active: true, url: m.url };
  else if (m.state === "log") oauthState = { ...oauthState, active: true, lines: [...oauthState.lines, m.text].slice(-20) };
  else if (m.state === "done") { oauthState = { ...oauthState, active: false, done: true, lines: [...oauthState.lines, m.text] }; toast(m.text); }
  else if (m.state === "error") { oauthState = { ...oauthState, active: false, error: true, lines: [...oauthState.lines, m.text] }; toast(m.text, true); }
  if (document.querySelector("#login-panel")) renderLoginBody();
}
/**
 * Repaint the login dialog body: OAuth progress page, preset form, or the
 * preset grid + manual card.
 * @returns {void}
 */
function renderLoginBody() {
  const body = document.querySelector("#login-panel .panel-body");
  if (!body) return;
  body.replaceChildren();
  if (loginSelection?.oauth) {
    const preset = loginSelection.preset;
    body.append(el("p", null, `Browser sign-in for ${preset.label}.`));
    if (oauthState.url) {
      const link = el("a", "primary-button", "Open the sign-in page ↗");
      link.href = oauthState.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      body.append(link, el("p", "muted small", "Finish signing in there; this dialog updates when it completes."));
    } else if (oauthState.active) body.append(el("p", "muted", "Preparing the sign-in…"));
    const log = el("div", "oauth-log");
    for (const line of oauthState.lines) log.append(el("div", null, line));
    if (oauthState.lines.length) body.append(log);
    if (oauthState.active) {
      const paste = el("form", "inline-form");
      const input = el("input"); input.placeholder = "Paste the redirect URL (or code#state) if the page could not return here"; input.setAttribute("aria-label", "Sign-in redirect");
      paste.append(input, button("chip", "Submit", null, { type: "submit" }));
      paste.addEventListener("submit", (event) => { event.preventDefault(); if (input.value.trim()) { send({ type: "endpoint.oauth-paste", input: input.value.trim() }); input.value = ""; } });
      body.append(el("p", "muted small", "Headless or a different machine?"), paste);
    }
    const actions = el("div", "button-row");
    if (oauthState.done) actions.append(button("primary-button", "Done", () => document.querySelector("#login-panel")?.close()));
    else actions.append(button("chip", "Back", () => { loginSelection = null; renderLoginBody(); }));
    body.append(actions);
    return;
  }
  if (loginSelection) { body.append(loginForm(loginSelection.preset)); return; }
  body.append(el("p", "muted small", "Pick a provider. Browser sign-in presets open the provider's login page; others take a URL and an optional API key."));
  const grid = el("div", "preset-grid");
  for (const preset of endpoints.presets) {
    const card = button("preset-card", null, () => { if (preset.oauth) startOAuth(preset); else loginSelection = { preset }; renderLoginBody(); });
    card.append(el("strong", null, preset.label), el("small", "muted", `${preset.provider}${preset.oauth ? " · browser sign-in" : ""}`));
    if (endpoints.endpoints.some((endpoint) => endpoint.name === preset.name && !endpoint.loginRequired)) card.append(el("span", "badge", "connected"));
    grid.append(card);
  }
  const manual = button("preset-card manual", null, () => { loginSelection = { manual: true }; renderLoginBody(); });
  manual.append(el("strong", null, "Manual"), el("small", "muted", "Enter every field yourself"));
  grid.append(manual);
  body.append(grid);
}
/**
 * The endpoint login form (name, provider, base URL, optional API key, scope).
 * @param {object} [preset] - preset to prefill from; undefined = manual entry.
 * @returns {HTMLElement} the `<form>`.
 */
function loginForm(preset) {
  const form = el("form", "login-form");
  const field = (label, input, hint) => { const wrap = el("label", "field"); wrap.append(el("span", null, label), input); if (hint) wrap.append(el("small", "muted", hint)); return wrap; };
  const scope = el("select"); for (const [value, label] of [["package", "This machine (all projects)"], ["local", "This project only"]]) { const option = el("option", null, label); option.value = value; scope.append(option); }
  const name = el("input"); name.required = true; name.value = preset?.name ?? ""; name.placeholder = "e.g. my-openai";
  const provider = el("input"); provider.required = true; provider.value = preset?.provider ?? ""; provider.setAttribute("list", "provider-options");
  const providers = el("datalist"); providers.id = "provider-options";
  for (const value of new Set([...(endpoints.providers ?? []), ...endpoints.presets.map((item) => item.provider)])) { const option = el("option"); option.value = value; providers.append(option); }
  const url = el("input"); url.required = true; url.type = "url"; url.value = preset?.url ?? ""; url.placeholder = "https://…";
  const token = el("input"); token.type = "password"; token.autocomplete = "off"; token.placeholder = "optional API key";
  form.append(
    el("p", null, preset ? `Connect ${preset.label}` : "Add an endpoint"),
    field("Endpoint name", name), field("Provider", provider), providers, field("Base URL", url), field("API key", token, "Stored in the endpoint's auth file, never sent to the browser again"), field("Save for", scope),
  );
  const actions = el("div", "button-row");
  actions.append(button("chip", "Back", () => { loginSelection = null; renderLoginBody(); }), button("primary-button", "Save endpoint", null, { type: "submit" }));
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send({ type: "endpoint.login", scope: scope.value, name: name.value.trim(), provider: provider.value.trim(), url: url.value.trim(), ...(token.value ? { token: token.value } : {}) });
    token.value = "";
    document.querySelector("#login-panel")?.close();
  });
  queueMicrotask(() => (preset ? token : name).focus());
  return form;
}

/* ----------------------------------------------------------------- themes */
const dark = matchMedia("(prefers-color-scheme: dark)");
/**
 * The saved appearance choice for dual-mode named themes.
 * @returns {"system"|"light"|"dark"}
 */
const themeModeChoice = () => ["system", "light", "dark"].includes(readPref("omoya.web.namedThemeMode", "system")) ? readPref("omoya.web.namedThemeMode", "system") : "system";
/**
 * Mark the header appearance option matching the current selection.
 * @returns {void}
 */
function updateAppearanceSwitch() {
  const selected = selectedTheme();
  const mode = ["system", "light", "dark"].includes(selected) ? selected : themeModeChoice();
  for (const option of document.querySelectorAll(".appearance-option")) {
    option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
  }
}
/**
 * The selected theme: the active named theme when still known, else the saved
 * preference ("system" | "light" | "dark" | name).
 * @returns {string}
 */
function selectedTheme() {
  if (prefs.activeTheme && prefs.themes?.includes(prefs.activeTheme)) return prefs.activeTheme;
  return prefs.theme ?? "system";
}
/**
 * Apply a theme to the document: dark class, data-theme/data-mode attributes,
 * color-scheme, and the theme-color meta. Named themes resolve their mode from
 * the theme catalog (dual themes follow the appearance choice).
 * @param {string} [name] - theme name or "system"/"light"/"dark"; falsy = system.
 * @returns {void}
 */
function applyThemeName(name) {
  const named = name && !["system", "light", "dark"].includes(name) && prefs.themes?.includes(name);
  const choice = named && prefs.dualThemes?.includes(name) ? themeModeChoice() : "system";
  const mode = named ? (prefs.dualThemes?.includes(name) ? (choice === "system" ? (dark.matches ? "dark" : "light") : choice) : (prefs.themeModes?.[name] ?? (dark.matches ? "dark" : "light"))) : name === "system" || !name ? (dark.matches ? "dark" : "light") : name;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = named ? name : "";
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
  queueMicrotask(() => document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).backgroundColor));
}
/**
 * Re-apply the saved selection. Previews apply a theme directly; leaving a
 * preview re-applies the saved selection, so no "before" snapshot is ever needed.
 * @returns {void}
 */
function applyTheme() { applyThemeName(selectedTheme()); }
/**
 * Select a theme, apply it, and persist it on the server.
 * @param {string} name - theme name or "system"/"light"/"dark".
 * @returns {void}
 */
function chooseTheme(name) {
  prefs = { ...prefs, theme: name, activeTheme: ["system", "light", "dark"].includes(name) ? null : name };
  applyTheme();
  updateAppearanceSwitch();
  send({ type: "settings.theme", name });
  refreshOpenPanels();
}
/**
 * Open the themes dialog.
 * @returns {void}
 */
function openThemes() {
  openDialog({ id: "themes-panel", title: "Themes", wide: true, onClose: applyTheme });
  renderThemesBody();
}
/**
 * Repaint the themes grid; hover/focus previews, click applies.
 * @returns {void}
 */
function renderThemesBody() {
  const body = document.querySelector("#themes-panel .panel-body");
  if (!body) return;
  body.replaceChildren(el("p", "muted small", "Hover or focus to preview · click to apply. Change light, dark or system appearance in the top-right header. Named themes are available in both apps; each app saves its own selection."));
  const grid = el("div", "theme-grid");
  const current = selectedTheme();
  for (const name of [...new Set(["dark", "light", ...(prefs.themes ?? [])])].filter((item) => item !== "system").sort((a, b) => a.localeCompare(b))) {
    const named = !["system", "light", "dark"].includes(name);
    const card = button("theme-card" + (name === current ? " current" : ""), null, () => chooseTheme(name));
    if (named) card.dataset.theme = name;
    card.dataset.mode = named ? (prefs.dualThemes?.includes(name) ? (themeModeChoice() === "system" ? (dark.matches ? "dark" : "light") : themeModeChoice()) : (prefs.themeModes?.[name] ?? (dark.matches ? "dark" : "light"))) : name === "system" ? (dark.matches ? "dark" : "light") : name;
    const swatch = el("span", "theme-swatch");
    swatch.append(el("span", "sw-bg"), el("span", "sw-fg"), el("span", "sw-accent"), el("span", "sw-user"));
    card.append(swatch, el("span", "theme-name", name), el("span", "theme-mode", named ? (prefs.dualThemes?.includes(name) ? (themeModeChoice() === "system" ? "follows OS" : themeModeChoice()) : (prefs.themeModes?.[name] ?? "follows OS")) : name === "system" ? "follows OS" : "built-in"));
    if (name === current) card.append(el("span", "badge", "current"));
    const preview = () => applyThemeName(name);
    card.addEventListener("mouseenter", preview);
    card.addEventListener("focus", preview);
    card.addEventListener("mouseleave", applyTheme);
    card.addEventListener("blur", applyTheme);
    grid.append(card);
  }
  body.append(grid);
}

/* ------------------------------------------------------------------- help */
const SHORTCUTS = [
  ["Enter", "send"], ["Shift+Enter", "new line"], ["↑ / ↓", "recall sent messages (at the first/last line)"],
  ["Tab", "complete command / argument"], ["/", "commands, prompts, tools"], ["Enter on empty (spaces)", "continue the agent"],
  [isMac ? "⌘K" : "Ctrl+K", "command palette (TUI ^X)"], ["Ctrl+O", "block viewer (TUI ^O; also " + (isMac ? "⇧⌘O" : "Ctrl+Shift+O") + ")"],
  ["← / → · Alt+← / →", "block viewer: previous / next block · 10 messages"], ["↑ ↓ · Space / B · F · G · C", "block viewer: scroll · page · search · go to # · copy"],
  ["Esc", "stop the running response / close dialogs"], ["Alt+Shift+↑", "put queued messages back in the composer"],
  ["Ctrl+Alt+← / →", "previous / next agent"], ["Ctrl+Alt+↑", "parent agent"], [isMac ? "⌘B" : "Ctrl+B", "toggle the sidebar"],
];
/**
 * Open the keyboard-shortcuts dialog.
 * @returns {void}
 */
function openHelp() {
  const { body } = openDialog({ id: "help-panel", title: "Keyboard shortcuts" });
  const table = el("dl", "shortcut-list");
  for (const [key, action] of SHORTCUTS) { const dt = el("dt"); for (const part of key.split(" / ")) dt.append(kbd(part), document.createTextNode(" ")); table.append(dt, el("dd", null, action)); }
  body.append(table, button("chip", "All slash commands", () => { document.querySelector("#help-panel")?.close(); send({ type: "chat.submit", text: "/help" }); }));
}

/**
 * Open a server-requested view (command.open).
 * @param {string} view - "palette" | "login" | "help" | "context".
 * @param {object} [m={}] - the packet; `index` targets a context message.
 * @returns {void}
 */
function openView(view, m = {}) {
  if (view === "palette") openPalette();
  else if (view === "login") openLogin();
  else if (view === "help") openHelp();
  else if (view === "context") {
    const index = Number.isInteger(m.index) ? m.index : null;
    openContextViewer(index === null ? null : { messageIndex: index, blockIndex: 0 }, index !== null);
  }
}

/* --------------------------------------------------------------- question */
/**
 * Render the pending question dialog: option buttons (single/multi select),
 * per-question preview pane, custom-answer input, and digit/arrow shortcuts.
 * Esc/closing without an answer refuses (null), like the TUI's ^C.
 * @returns {void}
 */
function renderQuestion() {
  if (!openQuestion) return;
  const requestId = openQuestion.requestId;
  const { dialog, body, head } = openDialog({ id: "question-overlay", title: openQuestion.questions.length > 1 ? `${openQuestion.questions.length} questions` : (openQuestion.questions[0]?.header ?? "Question"), className: "question-dialog", backdropCloses: false }); // a stray click must never refuse
  // Esc / closing without an answer refuses (null), like the TUI's ^C.
  let answered = false;
  dialog.addEventListener("close", () => { if (!answered && openQuestion?.requestId === requestId) { send({ type: "question.answer", requestId, answers: null }); openQuestion = null; } });
  head.querySelector("h2")?.prepend(el("span", "question-badge", "?"));
  const states = openQuestion.questions.map(() => ({ labels: new Set(), text: "" }));
  const submit = button("primary-button question-submit", "Submit answers", null);
  submit.title = "Focus Submit answers, then press Enter";
  const refresh = () => {
    const ready = states.every((state) => state.labels.size || state.text.trim());
    submit.disabled = !ready;
    submit.textContent = ready ? "Submit answers" : `Answer ${states.filter((state) => !state.labels.size && !state.text.trim()).length} more`;
  };
  openQuestion.questions.forEach((q, qi) => {
    const section = el("section", "question");
    if (openQuestion.questions.length > 1 && q.header) section.append(el("h3", "question-header", q.header));
    section.append(el("p", "question-text", q.question ?? ""));
    if (q.details) section.append(markdownNode("div", "md question-details", q.details));
    if (q.multiSelect) section.append(el("p", "muted small", "Select all that apply"));
    const list = el("div", "question-options");
    list.setAttribute("role", q.multiSelect ? "group" : "radiogroup");
    // Preview is tied to the selected answer, never pointer position or focus.
    // Reserve its space so selecting another answer cannot move the dialog.
    const previewPane = el("div", "question-preview-pane");
    previewPane.hidden = !(q.options ?? []).some((option) => option.preview !== undefined);
    previewPane.append(el("p", "muted small", "Pick an option to preview it"));
    const showPreview = () => {
      const label = [...states[qi].labels].at(-1);
      const choice = (q.options ?? []).find((option) => option.label === label);
      const preview = choice?.preview === undefined ? null : typeof choice.preview === "string" ? { type: "text", content: choice.preview } : choice.preview;
      previewPane.replaceChildren();
      if (!preview) { previewPane.append(el("p", "muted small", label ? "No preview for this option" : "Pick an option to preview it")); return; }
      if (preview.title) previewPane.append(el("div", "question-preview-title", preview.title));
      previewPane.append(preview.type === "code" ? el("pre", "question-preview", preview.content ?? "") : markdownNode("div", "md question-preview", preview.content ?? ""));
    };
    (q.options ?? []).forEach((option, oi) => {
      const btn = el("button", "question-option");
      btn.type = "button";
      btn.dataset.label = option.label ?? "";
      if (!q.multiSelect) btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.title = oi + 1 <= 9 ? `Select (key ${oi + 1})` : "Select";
      const key = el("span", "option-key", String(oi + 1));
      const text = el("span", "option-text");
      text.append(el("span", "question-option-label", option.label ?? ""));
      if (option.description) text.append(el("span", "question-option-description", option.description));
      btn.append(key, text);
      if (option.preview !== undefined) btn.append(el("span", "option-has-preview", "preview"));
      btn.addEventListener("click", () => {
        const state = states[qi];
        if (q.multiSelect) { if (state.labels.has(btn.dataset.label)) state.labels.delete(btn.dataset.label); else state.labels.add(btn.dataset.label); }
        else { state.labels = new Set([btn.dataset.label]); }
        list.querySelectorAll(".question-option").forEach((button) => {
          const selected = state.labels.has(button.dataset.label);
          button.classList.toggle("selected", selected);
          button.setAttribute("aria-checked", String(selected));
        });
        showPreview();
        refresh();
      });
      list.append(btn);
    });
    const other = el("input", "question-other");
    other.placeholder = q.multiSelect ? "Add a note (optional)" : "Or type your own answer";
    other.setAttribute("aria-label", `Custom answer for: ${q.question ?? "question"}`);
    other.addEventListener("input", () => {
      states[qi].text = other.value;
      if (!q.multiSelect && other.value.trim()) { states[qi].labels.clear(); list.querySelectorAll(".question-option").forEach((b) => { b.classList.remove("selected"); b.setAttribute("aria-checked", "false"); }); showPreview(); }
      refresh();
    });
    other.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
    section.append(list, previewPane, other);
    body.append(section);
  });
  // Native button activation owns Enter/Space: the focused option selects,
  // while only the focused Submit button sends. Dialog owns Esc and Tab.
  dialog.addEventListener("keydown", (event) => {
    const typing = event.target.matches?.("input, textarea, select") || event.target.isContentEditable;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing) return;
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      // Flatten across questions: the Nth key picks the Nth option overall.
      // Submit receives focus only after every question has an answer.
      const chosen = [...body.querySelectorAll(".question-option")][n - 1];
      if (chosen) {
        event.preventDefault();
        chosen.click();
        if (!submit.disabled) submit.focus();
        else chosen.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const options = [...body.querySelectorAll(".question-option")];
      if (!options.length) return;
      event.preventDefault();
      const at = options.indexOf(document.activeElement);
      const next = event.key === "ArrowDown"
        ? (at < 0 ? 0 : Math.min(options.length - 1, at + 1))
        : (at < 0 ? options.length - 1 : Math.max(0, at - 1));
      options[next].focus();
      return;
    }
  });
  const actions = el("div", "question-actions");
  submit.addEventListener("click", () => {
    const answers = states.map((state) => {
      const labels = [...state.labels];
      const text = state.text.trim();
      if (labels.length && text) return { labels, text };
      if (labels.length) return { labels };
      if (text) return { text };
      return { abandoned: true };
    });
    answered = true;
    send({ type: "question.answer", requestId, answers });
    openQuestion = null;
    dialog.close();
  });
  const dismissBtn = button("chip question-dismiss", "Dismiss", () => dialog.close(), { title: "Refuse to answer (Esc)" });
  const hasOptions = openQuestion.questions.some((q) => (q.options ?? []).length > 0);
  actions.append(el("span", "muted small question-keys", `${hasOptions ? "1–9 select, then Enter to submit · ↑/↓ move · Enter/Space select focused · " : ""}Tab to Submit · Esc dismiss`), dismissBtn, submit);
  body.append(actions);
  refresh();
  body.querySelector(".question-option")?.focus();
}
/**
 * Close the question overlay, if open.
 * @returns {void}
 */
function closeQuestion() { const node = document.querySelector("#question-overlay"); if (node) { openQuestion = null; node.close(); } }

/* ------------------------------------------------------------------ toast */
/**
 * Show a transient toast (click dismisses; errors live longer and go to the error region).
 * @param {*} text
 * @param {boolean} [isError=false]
 * @returns {void}
 */
function toast(text, isError = false) {
  const node = el("div", "toast" + (isError ? " toast-error" : ""), String(text));
  node.addEventListener("click", () => node.remove());
  (isError ? errors : toasts).append(node);
  setTimeout(() => node.remove(), isError ? 8000 : 3500);
}

/* ------------------------------------------------------------ usage meter */
/**
 * Provider-reported plan/quota percentage (the TUI's status line shows the
 * same, to one decimal), most important quota first — rounded to whole
 * percent: `5h 2% · 7d 12%`, or "" when no quota sizes a percentage (e.g. a
 * currency balance, which has no total). No bare "plan:" prefix — the meter
 * sits right beside the context counters, so that word would be noise, not
 * information.
 * @param {object} [plan] - `{ quotas }` from the usage status.
 * @returns {string}
 */
function planPercentText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || typeof quotas !== "object") return "";
  const parts = sortedQuotaEntries(quotas).map(([name, quota]) => {
    const ut = quotaUsedTotal(quota);
    return ut ? `${name} ${Math.round((ut.used / ut.total) * 100)}%` : null;
  }).filter(Boolean);
  return parts.join(" · ");
}

/**
 * Multi-line quota detail for the meter tooltip: raw counts/remaining and the
 * reset countdown that the compact meter has no room for.
 * @param {object} [plan] - `{ quotas }`.
 * @returns {string}
 */
function planTooltipText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || typeof quotas !== "object") return "";
  return sortedQuotaEntries(quotas).map(([name, quota]) => {
    const bits = [];
    if (Number.isFinite(quota?.used) && Number.isFinite(quota?.total)) bits.push(`${quota.used}/${quota.total} used`);
    else if (Number.isFinite(quota?.remaining)) bits.push(`${formatAmount(quota.remaining, quota?.unit)} left`);
    const countdown = resetText(quota?.reset);
    if (countdown) bits.push(countdown);
    return `${name}: ${bits.join(", ")}`;
  }).join("\n");
}

/**
 * Compact number for the meter: 12.3M / 10k / 9.9k / 999.
 * @param {number} n
 * @returns {string}
 */
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
/**
 * Repaint the context-usage meter: ring, token counts, plan percentages, tooltip.
 * @returns {void}
 */
function updateUsage() {
  const node = document.querySelector("#usage-status");
  if (!node) return;
  const used = Number(usage.used ?? 0);
  const available = Number(usage.available ?? 0);
  const percent = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : null;
  const plan = planPercentText(usage.plan);
  node.replaceChildren();
  const ring = el("span", "meter-ring");
  ring.style.setProperty("--pct", String(percent ?? 0));
  ring.classList.toggle("high", (percent ?? 0) >= 80);
  node.append(ring, el("span", "meter-text", `${compact(used)}${available ? `/${compact(available)}` : ""}${plan ? ` · ${plan}` : ""}`));
  node.title = [
    `Context: ${used.toLocaleString()} / ${available ? available.toLocaleString() : "—"} tokens${percent === null ? "" : ` (${percent}%)`}`,
    `Session: ${Number(usage.input ?? 0).toLocaleString()} in · ${Number(usage.output ?? 0).toLocaleString()} out`,
    planTooltipText(usage.plan),
    "Click to open the block viewer (Ctrl+O)",
  ].filter(Boolean).join("\n");
  node.setAttribute("aria-label", `Context ${percent === null ? used : `${percent}%`} used`);
}

/**
 * Reflect the viewed agent's busy state on the composer (working animation).
 * @returns {void}
 */
function updateComposerActivity() {
  composerEl?.classList.toggle("working", agent?.state === "working" || agent?.busy === true);
}

/**
 * Repaint the queued-messages strip above the composer.
 * @returns {void}
 */
function renderComposerQueue() {
  const node = document.querySelector("#composer-queue");
  if (!node) return;
  node.replaceChildren();
  if (!queuedMessages.length) return;
  const text = queuedMessages.length === 1 ? "1 queued" : `${queuedMessages.length} queued`;
  node.append(el("span", "queue-label", text), el("span", "composer-queue-preview", queuedMessages.join(" · ")));
  node.append(button("composer-unqueue", "Edit", () => send({ type: "chat.unqueue" }), { title: "Remove queued messages and put them back in the editor (Alt+Shift+↑)" }));
}

/**
 * Flatten the sessions agent tree (depth-first) into a list.
 * @returns {object[]}
 */
function agentList() {
  const agents = [];
  const visit = (items) => { for (const item of items ?? []) { agents.push(item); visit(item.children); } };
  visit(sessions.agents);
  return agents;
}

/**
 * Switch to the previous/next agent in the flattened list (wraps).
 * @param {number} direction - +1 next, -1 previous.
 * @returns {void}
 */
function navigateAgent(direction) {
  const agents = agentList();
  const currentIndex = agents.findIndex((item) => item.id === agent?.id);
  if (agents.length < 2 || currentIndex < 0) return;
  send({ type: "session.switch", agentId: agents[(currentIndex + direction + agents.length) % agents.length].id });
}

/**
 * Switch to the viewed agent's parent, when it has one.
 * @returns {void}
 */
function navigateParentAgent() {
  const parentId = agentList().find((item) => item.id === agent?.id)?.parentId;
  if (parentId) send({ type: "session.switch", agentId: parentId });
}

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const dialogOpen = Boolean(document.querySelector("dialog[open]"));
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); if (document.querySelector("#palette")) document.querySelector("#palette").close(); else openPalette(); return; }
  // Ctrl+O toggles the block viewer like the TUI's ^O (⇧⌘O / Ctrl+Shift+O also opens it).
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") { event.preventDefault(); if (document.querySelector("#context-viewer")) closeContextViewer(); else openContextViewer(); return; }
  if (mod && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); openContextViewer(); return; }
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") { event.preventDefault(); setSidebar(!sidebarOpen); return; }
  if (event.altKey && event.shiftKey && !mod && event.key === "ArrowUp" && queuedMessages.length) { event.preventDefault(); send({ type: "chat.unqueue" }); return; }
  if (event.key === "Escape" && !dialogOpen && !acOpen() && !document.querySelector(".popup-menu")) {
    if (agent?.state === "working" || agent?.busy === true) { event.preventDefault(); send({ type: "chat.cancel" }); toast("Stopping…"); }
    return;
  }
  if (event.altKey && event.ctrlKey && !event.shiftKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp")) {
    event.preventDefault();
    if (event.key === "ArrowUp") navigateParentAgent();
    else navigateAgent(event.key === "ArrowRight" ? 1 : -1);
    return;
  }
  // Typing anywhere outside a field lands in the composer.
  if (!dialogOpen && !mod && !event.altKey && event.key.length === 1 && event.key !== " " && textareaEl && (!document.activeElement || document.activeElement === document.body) && window.getSelection()?.isCollapsed !== false) textareaEl.focus();
});

/* ------------------------------------------------------------ block viewer */
const VIEWER_TYPES = ["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"];
/**
 * Flatten context messages into per-block viewer entries with a text `source`.
 * @returns {Array<object>}
 */
function contextEntries() {
  const stored = contextBlocks.flatMap((message) => (message.content ?? []).map((block) => ({ ...block, source: block.text ?? JSON.stringify(block.data, null, 2) })));
  const tools = contextTools ?? { messageIndex: -1, blockIndex: 0, viewerType: "system", name: "Tools", virtual: true, text: "Loading published tools…" };
  return [{ ...tools, source: tools.text }, ...stored];
}

/**
 * Apply the viewer's type filters and RegExp search to entries.
 * @param {Array<object>} entries
 * @returns {{entries: Array<object>, error: string|null}} error is set for an invalid RegExp.
 */
function filteredContextEntries(entries) {
  let pattern;
  try { pattern = contextView.search ? new RegExp(contextView.search, "i") : null; } catch { return { entries: [], error: "Enter a valid regular expression." }; }
  return { entries: entries.filter((block) => (!contextView.types.size || contextView.types.has(block.viewerType)) && (!pattern || pattern.test(`${block.viewerType}\n${block.source}`))), error: null };
}

// The block viewer pages ONE context block at a time, like the TUI's ^O
// viewer: `TYPE [i/N] — name · message.part`, ←/→ blocks, Alt+←/→ ten
// messages, ↑/↓ Space/B scroll, F search, C copy, Esc close. Filters and
// search narrow the pages; the selected block survives re-filtering and
// context refreshes (or falls back to its nearest predecessor).
const VIEWER_HOP = 10;
const VIEWER_KEYS = "← → blocks · Alt+←/→ 10 messages · G go to # · ↑ ↓ / Space B scroll · F search · C copy · Esc close";
/**
 * Stable identity of a context block for the viewer (`messageIndex:blockIndex`).
 * @param {object} block
 * @returns {string}
 */
const blockKey = (block) => `${block.messageIndex}:${block.blockIndex}`;

/**
 * Open the block viewer (Ctrl+O), optionally targeting a specific block and/or
 * starting in edit mode; requests the context snapshot from the server.
 * @param {{messageIndex: number, blockIndex: number}|null} [target=null]
 * @param {boolean} [edit=false]
 * @returns {void}
 */
function openContextViewer(target = null, edit = false) {
  contextTools = null;
  contextView = { search: "", types: new Set(), selected: new Set(), target, edit, key: null, editKey: null };
  const { dialog } = openDialog({ id: "context-viewer", title: "Block viewer", wide: true, className: "context-viewer", onClose: () => { contextView = null; } });
  dialog.addEventListener("keydown", viewerKey);
  renderContextViewer(true);
  send({ type: "context.inspect" });
}
/**
 * Close the block viewer, if open.
 * @returns {void}
 */
function closeContextViewer() { document.querySelector("#context-viewer")?.close(); }

/** Refresh an open inspector after tool/settings changes without showing a stale catalog. */
function refreshContextCatalog() {
  if (!contextView) return;
  contextTools = null;
  renderContextViewer();
  send({ type: "context.inspect" });
}

/**
 * `3.2` for the second block of a multi-block message, else `message 3`.
 * @param {object} block - viewer entry `{ messageIndex, blockIndex }`.
 * @param {Array<object>} all - all (unfiltered) entries.
 * @returns {string}
 */
function viewerWhere(block, all) {
  if (block.virtual) return "virtual system block";
  const parts = all.filter((entry) => entry.messageIndex === block.messageIndex).length;
  return parts > 1 ? `${block.messageIndex + 1}.${block.blockIndex + 1}` : `message ${block.messageIndex + 1}`;
}

/**
 * The current page among the filtered entries: the target (a "View in
 * context" jump), else the kept block key, else its nearest predecessor,
 * else the newest block.
 * @param {Array<object>} entries - filtered entries.
 * @returns {number} index into `entries`, -1 when empty.
 */
function viewerIndex(entries) {
  if (!entries.length) return -1;
  if (contextView.target) {
    const index = entries.findIndex((block) => block.messageIndex === contextView.target.messageIndex && block.blockIndex === contextView.target.blockIndex);
    if (index >= 0) return index;
  }
  if (contextView.key === null) return entries.length - 1;
  const index = entries.findIndex((block) => blockKey(block) === contextView.key);
  if (index >= 0) return index;
  const [message, part] = contextView.key.split(":").map(Number);
  const before = entries.findLastIndex((block) => block.messageIndex < message || (block.messageIndex === message && block.blockIndex < part));
  return Math.max(0, before);
}

/**
 * Jump to the n-th (1-based) filtered block, clamped to the range.
 * @param {number} n
 * @returns {void}
 */
function gotoViewer(n) {
  const { entries } = filteredContextEntries(contextEntries());
  if (!entries.length || !Number.isFinite(n)) return;
  contextView.key = blockKey(entries[Math.max(0, Math.min(entries.length - 1, Math.round(n) - 1))]);
  renderContextViewer();
}

/**
 * Move the viewer one block forward/back, clamped.
 * @param {number} step
 * @returns {void}
 */
function moveViewer(step) {
  const { entries } = filteredContextEntries(contextEntries());
  const index = viewerIndex(entries);
  if (index < 0) return;
  const next = entries[Math.max(0, Math.min(entries.length - 1, index + step))];
  contextView.key = blockKey(next);
  renderContextViewer();
}

/**
 * Hop by logical messages (a message's blocks stay together).
 * @param {number} direction - ±1; each hop spans VIEWER_HOP messages.
 * @returns {void}
 */
function hopViewer(direction) {
  const { entries } = filteredContextEntries(contextEntries());
  const index = viewerIndex(entries);
  if (index < 0) return;
  const starts = entries.map((block, i) => i).filter((i) => i === 0 || entries[i].messageIndex !== entries[i - 1].messageIndex);
  const group = starts.findLastIndex((i) => i <= index);
  const destination = starts[Math.max(0, Math.min(starts.length - 1, group + direction * VIEWER_HOP))];
  contextView.key = blockKey(entries[destination]);
  renderContextViewer();
}

/**
 * Block-viewer key handling: ←/→ blocks, Alt+←/→ message hops, ↑/↓ Space/B
 * scroll, F search, G go-to, C copy. Search/index inputs get their own Enter
 * and arrow behavior.
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function viewerKey(event) {
  if (!contextView) return;
  const typing = event.target.matches?.("input, textarea, select");
  if (typing) {
    if (event.key === "Enter" && event.target.classList.contains("context-search")) { event.preventDefault(); document.querySelector("#context-viewer .viewer-body")?.focus(); }
    if (event.target.classList.contains("viewer-index")) {
      if (event.key === "Enter") { event.preventDefault(); gotoViewer(Number(event.target.value)); document.querySelector("#context-viewer .viewer-body")?.focus(); }
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveViewer(event.key === "ArrowUp" ? -1 : 1); document.querySelector("#context-viewer .viewer-index")?.select(); }
    }
    return;
  }
  if (event.metaKey || event.ctrlKey) return;
  const body = document.querySelector("#context-viewer .viewer-body");
  const page = () => Math.max(40, (body?.clientHeight ?? 400) - 40);
  const key = event.key;
  const act = {
    ArrowLeft: () => (event.altKey ? hopViewer(-1) : moveViewer(-1)),
    ArrowRight: () => (event.altKey ? hopViewer(1) : moveViewer(1)),
    ArrowUp: () => body?.scrollBy({ top: -40 }),
    ArrowDown: () => body?.scrollBy({ top: 40 }),
    " ": () => body?.scrollBy({ top: event.shiftKey ? -page() : page() }),
    b: () => body?.scrollBy({ top: -page() }),
    B: () => body?.scrollBy({ top: -page() }),
    f: () => document.querySelector("#context-viewer .context-search")?.focus(),
    F: () => document.querySelector("#context-viewer .context-search")?.focus(),
    g: () => document.querySelector("#context-viewer .viewer-index")?.focus(),
    G: () => document.querySelector("#context-viewer .viewer-index")?.focus(),
    c: () => { const block = currentViewerBlock(); if (block) copyText(block.source, "Block copied"); },
    C: () => { const block = currentViewerBlock(); if (block) copyText(block.source, "Block copied"); },
  }[key];
  if (!act) return;
  event.preventDefault();
  act();
}

/**
 * The currently paged viewer block, or null.
 * @returns {object|null}
 */
function currentViewerBlock() {
  const { entries } = filteredContextEntries(contextEntries());
  return entries[viewerIndex(entries)] ?? null;
}

/**
 * Repaint the block viewer: search field, type filter chips, pager with editable
 * block number, the paged block card, and the footer with the delete-selected
 * action. Focus is restored after repaint.
 * @param {boolean} [initial=false] - first paint (shows "Loading…" before context arrives).
 * @returns {void}
 */
function renderContextViewer(initial = false) {
  const dialog = document.querySelector("#context-viewer");
  if (!dialog || !contextView) return;
  const body = dialog.querySelector(".panel-body");
  const searchFocused = document.activeElement?.classList.contains("context-search");
  const indexFocused = document.activeElement?.classList.contains("viewer-index");
  const all = contextEntries();
  const { entries, error } = filteredContextEntries(all);
  body.replaceChildren();
  const tools = el("div", "context-tools");
  const search = el("input", "context-search"); search.type = "search"; search.placeholder = "RegExp search all blocks (F)"; search.value = contextView.search; search.setAttribute("aria-label", "Search all context blocks with a regular expression");
  search.addEventListener("input", () => { contextView.search = search.value; renderContextViewer(); });
  const filters = el("div", "context-filters");
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Block types");
  for (const type of VIEWER_TYPES) {
    const count = all.filter((block) => block.viewerType === type).length;
    const chip = button("filter-chip" + (contextView.types.has(type) ? " active" : ""), `${type} ${count}`, () => { if (contextView.types.has(type)) contextView.types.delete(type); else contextView.types.add(type); renderContextViewer(); });
    chip.setAttribute("aria-pressed", String(contextView.types.has(type)));
    chip.disabled = count === 0;
    filters.append(chip);
  }
  tools.append(search, filters);
  body.append(tools);

  const index = error ? -1 : viewerIndex(entries);
  const block = entries[index] ?? null;
  if (block) contextView.key = blockKey(block);
  const pager = el("div", "viewer-pager");
  const nav = (label, title, onClick, disabled) => { const node = button("chip viewer-nav", label, onClick, { title }); node.disabled = disabled; return node; };
  const title = el("div", "viewer-title");
  if (block) {
    // `[i/N]` where i is an editable field: type a number, Enter jumps there.
    const jump = el("input", "viewer-index");
    jump.type = "text"; jump.inputMode = "numeric"; jump.autocomplete = "off"; jump.spellcheck = false;
    jump.value = String(index + 1); jump.title = "Go to block (G) — type a number, Enter"; jump.setAttribute("aria-label", `Block number, 1 to ${entries.length}`);
    jump.style.setProperty("--digits", String(String(entries.length).length));
    jump.addEventListener("focus", () => jump.select());
    jump.addEventListener("input", () => { jump.value = jump.value.replace(/\D/g, ""); });
    jump.addEventListener("blur", () => { jump.value = String(index + 1); });
    const count = el("span", "viewer-count");
    count.append("[", jump, `/${entries.length}]`);
    title.append(el("strong", `context-block-type type-${block.viewerType.replace(" ", "-")}`, block.viewerType.toUpperCase()), " ", count);
    if (block.name) title.append(el("span", null, ` — ${block.name}`));
    title.append(el("small", null, ` · ${viewerWhere(block, all)}`));
  } else title.append(el("span", "muted", initial && !all.length ? "Loading…" : error ?? "No context blocks match the current filters."));
  pager.append(
    nav("«", "Back 10 messages (Alt+←)", () => hopViewer(-1), index <= 0),
    nav("‹", "Previous block (←)", () => moveViewer(-1), index <= 0),
    title,
    nav("›", "Next block (→)", () => moveViewer(1), index < 0 || index >= entries.length - 1),
    nav("»", "Forward 10 messages (Alt+→)", () => hopViewer(1), index < 0 || index >= entries.length - 1),
  );
  body.append(pager);

  const page = el("div", "viewer-body");
  page.tabIndex = 0;
  page.setAttribute("aria-label", "Block content (↑ ↓ Space B to scroll)");
  if (block && contextView.edit && contextView.target !== null && all.length) contextView.editKey = blockKey(block);
  if (block) page.append(contextCard(block, contextView.editKey === blockKey(block)));
  body.append(page);

  const foot = el("div", "viewer-foot");
  const deleteSelected = button("chip danger", `Delete selected (${contextView.selected.size})`, () => deleteContextMessages([...contextView.selected]));
  deleteSelected.disabled = contextView.selected.size === 0;
  foot.append(el("span", "muted small viewer-keys", VIEWER_KEYS), el("span", "muted small", `${all.length} blocks · ${contextBlocks.length} messages`), deleteSelected);
  body.append(foot);

  if (all.length) { contextView.target = null; contextView.edit = false; }
  if (searchFocused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  else if (indexFocused && dialog.querySelector(".viewer-index")) dialog.querySelector(".viewer-index").focus();
  else if (dialog.querySelector(".context-edit textarea")) dialog.querySelector(".context-edit textarea").focus();
  else page.focus({ preventScroll: true });
}

/**
 * One context block card in the viewer: select checkbox, copy/edit/rollback/delete
 * actions, and either the edit form or the rendered content (Markdown or <pre>).
 * @param {object} block - viewer entry.
 * @param {boolean} editing - render the inline edit form.
 * @returns {HTMLElement}
 */
function contextCard(block, editing) {
  const card = el("article", "context-block");
  const meta = el("header", "context-block-meta");
  if (!block.virtual) {
    const select = el("input"); select.type = "checkbox"; select.checked = contextView.selected.has(block.messageIndex); select.setAttribute("aria-label", `Select message ${block.messageIndex + 1}`);
    select.addEventListener("change", () => { if (select.checked) contextView.selected.add(block.messageIndex); else contextView.selected.delete(block.messageIndex); renderContextViewer(); });
    meta.append(select, el("small", null, `Select message ${block.messageIndex + 1}`));
  } else meta.append(el("small", null, "Read-only publication snapshot"));
  const actions = el("div", "block-controls always");
  actions.append(button("block-icon", null, () => copyText(block.source, "Copied"), { title: "Copy", icon: "⧉" }));
  const canEdit = !block.virtual && typeof block.text === "string" && block.viewerType !== "tool display";
  if (canEdit) actions.append(button("block-icon", null, () => { contextView.editKey = blockKey(block); renderContextViewer(); }, { title: "Edit", icon: "✎" }));
  if (!block.virtual) {
    actions.append(button("block-icon", null, () => { if (confirm(`Remove message #${block.messageIndex} and everything after it?`)) send({ type: "context.rollback", messageIndex: block.messageIndex }); }, { title: "Roll back to here (drop this and later messages)", icon: "⤒" }));
    actions.append(button("block-icon block-delete", null, () => deleteContextMessages([block.messageIndex]), { title: "Delete message", icon: "⌫" }));
  }
  meta.append(actions);
  card.append(meta);
  if (editing && canEdit) {
    const form = el("form", "context-edit");
    const area = el("textarea"); area.value = block.text; area.rows = Math.min(20, Math.max(4, block.text.split("\n").length + 1)); area.setAttribute("aria-label", "Edit block text");
    const row = el("div", "button-row");
    row.append(button("chip", "Cancel", () => { contextView.editKey = null; renderContextViewer(); }), button("primary-button", "Save", null, { type: "submit" }));
    form.append(area, row);
    form.addEventListener("submit", (event) => { event.preventDefault(); contextView.editKey = null; send({ type: "context.edit-text", messageIndex: block.messageIndex, blockIndex: block.blockIndex, text: area.value }); });
    area.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
    card.append(form);
    queueMicrotask(() => area.focus());
  } else if (["thinking", "assistant", "tool answer", "tool display", "user", "system"].includes(block.viewerType)) card.append(markdownNode("div", "md context-markdown", block.source));
  else card.append(el("pre", "context-pre", block.source));
  return card;
}

/* ------------------------------------------------------------ tool runner */
/**
 * Open the "Run a tool" dialog: schema-driven form fields mirrored into the
 * JSON arguments textarea, with the raw schema shown for reference.
 * @param {string} [preselect] - tool name to preselect.
 * @returns {void}
 */
function openToolDialog(preselect) {
  const { body } = openDialog({ id: "tool-dialog", title: "Run a tool", wide: true });
  if (!catalog.toolSchemas.length) { body.append(el("p", "muted", "No tools are registered.")); return; }
  const select = el("select"); select.setAttribute("aria-label", "Tool");
  for (const schema of [...catalog.toolSchemas].sort((a, b) => a.name.localeCompare(b.name))) { const option = el("option", null, schema.name); option.value = schema.name; option.selected = schema.name === preselect; select.append(option); }
  const description = el("div", "md tool-schema-description");
  const form = el("form", "tool-schema-form");
  const args = el("textarea", "tool-json"); args.placeholder = "JSON arguments (default {})"; args.setAttribute("aria-label", "Tool JSON arguments"); args.rows = 6;
  const schemaView = el("details", "tool-schema-details");
  const schemaPre = el("pre", "tool-schema-view");
  schemaView.append(el("summary", null, "Schema"), schemaPre);
  const selectedSchema = () => catalog.toolSchemas.find((schema) => schema.name === select.value) ?? {};
  const sync = () => {
    const value = {};
    for (const control of form.querySelectorAll("[name]")) {
      if (control.type === "checkbox") { if (control.checked) value[control.name] = true; }
      else if (control.value !== "") value[control.name] = control.type === "number" ? Number(control.value) : control.value;
    }
    args.value = JSON.stringify(value, null, 2);
  };
  const update = () => {
    const schema = selectedSchema();
    description.innerHTML = renderMarkdown(String(schema.description ?? ""));
    const inputSchema = schema.inputSchema ?? schema.schema ?? schema.parameters ?? {};
    schemaPre.textContent = JSON.stringify(inputSchema, null, 2);
    form.replaceChildren();
    for (const [name, property] of Object.entries(inputSchema.properties ?? {})) {
      const field = el("label", "tool-field");
      const required = (inputSchema.required ?? []).includes(name);
      const input = property.enum ? el("select") : property.type === "string" && /content|text|body|prompt|code/i.test(name) ? el("textarea") : el("input");
      input.name = name;
      if (property.enum) { if (!required) input.append(el("option", null, "")); for (const value of property.enum) { const option = el("option", null, String(value)); option.value = String(value); input.append(option); } }
      else if (property.type === "boolean") input.type = "checkbox";
      else if (input.tagName === "INPUT") input.type = property.type === "number" || property.type === "integer" ? "number" : "text";
      input.addEventListener("input", sync); input.addEventListener("change", sync);
      const label = el("span", "tool-field-label", name);
      if (required) label.append(el("span", "required", " *"));
      field.append(label, input);
      if (property.description) field.append(el("small", null, String(property.description).split("\n")[0]));
      form.append(field);
    }
    args.value = "{}";
  };
  select.addEventListener("change", update); update();
  const run = button("primary-button", "Run tool", () => {
    let parsed;
    try { parsed = args.value.trim() ? JSON.parse(args.value) : {}; } catch { toast("Arguments must be valid JSON", true); return; }
    send({ type: "tool.call", name: select.value, args: parsed });
    document.querySelector("#tool-dialog")?.close();
  }, { icon: "▶" });
  body.append(select, description, form, el("label", "field-label", "JSON arguments"), args, schemaView, run);
  select.focus();
}

dark.addEventListener("change", () => { applyTheme(); if (document.querySelector("#themes-panel")) renderThemesBody(); });
applyTheme();

/* ------------------------------------------------------------------- boot */
connect();
render();
})();
