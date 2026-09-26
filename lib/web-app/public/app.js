/**
 * public/app.js — the Omoya web SPA. A zero-dependency chat client that
 * speaks the lib/web-app protocol over one WebSocket. The server owns the
 * Agent and all state; this client owns only presentation: it renders the
 * transcript (Markdown → safe HTML), streams turn deltas, asks questions,
 * and forwards user intent as validated protocol packets.
 *
 * Feature parity with the TUI is deliberate: themes (shared tui.theme),
 * endpoint sign-in/out (incl. browser OAuth), live thinking + tool cards,
 * agent/session naming, the ^X menu (here: the Ctrl/⌘+K command palette),
 * context viewer (^O), queue recall, linked-agent navigation, and every
 * slash command. Display details (collapse defaults, tool line cap, theme,
 * autocomplete, thinking levels) come from settings.web via the server's
 * settings packet — never hardcoded here.
 *
 * Rendering is incremental: a block owns one DOM node; stream deltas mark
 * blocks dirty and one animation frame patches only those nodes, so long
 * transcripts stay cheap while tokens arrive.
 */
import { renderMarkdown } from "./markdown.js";
import { sanitizeText, BashSanitizer } from "./text-safe.js";

(() => {
"use strict";

const app = document.querySelector("#app");
const toasts = document.querySelector("#toast-region");
const errors = document.querySelector("#error-region");

/* ------------------------------------------------------------------ state */
let ws = null;
let retry = 0;
let reconnectTimer = null;

let agent = null;                 // current agent info (from hello/sessions)
let sessions = { agents: [], recent: [] };
let settings = { safe: false, thinking: "default", sessionSave: undefined, spawnPermission: null, delegationLocked: false, endpoint: null, model: null, models: [] };
// Display preferences from settings.web (server-supplied; defaults applied
// server-side). The client honors these — it never hardcodes them.
let prefs = { autocomplete: true, collapse: { thinking: true, tools: true }, previewRows: { default: { system: 8, thinking: 8, tool: 7 } }, theme: "system", thinkingLevels: ["default", "off", "low", "medium", "high", "xhigh"], themes: [], activeTheme: null, themeModes: {} };
let catalog = { commands: [], hints: {}, prompts: [], tools: [], toolSchemas: [] };
let endpoints = { endpoints: [], presets: [], removable: [], providers: [] };
let usage = { input: 0, output: 0, used: 0, available: 0, plan: null };
let oauthState = { active: false, url: null, lines: [], done: false, error: false };
let contextBlocks = [];
let contextView = null;           // { search, types:Set, selected:Set, target, edit, limit } while the viewer is open
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

function readPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

/* ------------------------------------------------------------------ wire */
const send = (packet) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet)); else toast("Not connected — reconnecting…", true); };

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

function scheduleReconnect() {
  retry++;
  const delay = Math.min(10000, 500 * 2 ** retry);
  reconnectTimer = setTimeout(connect, delay);
}

function handle(m) {
  switch (m.type) {
    case "hello": {
      saveComposerDraft();
      const switched = agent?.id !== m.agent?.id;
      agent = m.agent ?? null;
      const previousUploadKey = uploadKey;
      uploadKey = typeof m.uploadKey === "string" ? m.uploadKey : uploadKey;
      loadComposerDraft();
      if (previousUploadKey && previousUploadKey !== uploadKey) {
        for (const draft of composerByAgent.values()) draft.attachments = [];
        draftAttachments = [];
      }
      if (Array.isArray(m.history)) setHistory(m.history);
      if (Array.isArray(m.queue)) queuedMessages = m.queue;
      if (m.catalog) catalog = { commands: m.catalog.commands ?? [], hints: m.catalog.hints ?? {}, prompts: m.catalog.prompts ?? [], tools: m.catalog.tools ?? [], toolSchemas: m.catalog.toolSchemas ?? [] };
      if (m.status) usage = m.status;
      if (switched) closeContextViewer();
      render();
      break;
    }
    case "sessions":
      sessions = { agents: m.agents ?? [], recent: m.recent ?? [] };
      // The running-agents list is the freshest report of the viewed agent's
      // busy flag — fold it in so every sessions push keeps the Stop button
      // and the composer working-animation current (no agent switch needed).
      if (agent) { const mine = agentList().find((item) => item.id === agent.id); if (mine) agent = { ...agent, ...mine, busy: mine.state === "working", state: mine.state }; }
      updateSidebar(); updateHeader(); updateComposerActivity(); break;
    case "agent":
      if (agent && m.agent) {
        agent = m.agent;
        // "idle" is authoritative for not-busy (busy flips only after the
        // run's finally, so a snapshot can briefly carry the mixed pair).
        if (agent.state === "idle") agent.busy = false;
        updateHeader(); updateComposerActivity(); scheduleRender();
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
    case "turn.start":
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
    case "tool.result": finishTool(m); break;
    case "context":
      contextBlocks = m.blocks ?? [];
      if (Array.isArray(m.history)) setHistory(m.history);
      renderContextViewer();
      break;
    case "question.open": openQuestion = { requestId: m.requestId, questions: m.questions ?? [] }; renderQuestion(); break;
    case "question.close": if (!m.requestId || openQuestion?.requestId === m.requestId) closeQuestion(); break;
    case "history": if (Array.isArray(m.history)) setHistory(m.history); break;
    case "command.result": pushBlock({ kind: "command", text: m.text ?? "", done: true }); break;
    case "command.open": openView(m.view, m); break;
    case "command.copy": copyText(m.text ?? "", "Copied the last response"); break;
    case "command.exit": toast(agentList().length > 1 ? "Agent closed" : "Agent closed — start a new chat to continue"); break;
    case "error": toast(m.message ?? "error", true); break;
    default: break;
  }
}

function setHistory(list) {
  blocks = normalizeHistory(list);
  // An unanswered call on an idle agent never ran to completion.
  if (!(agent?.busy || agent?.state === "working")) for (const block of blocks) if (block.kind === "tool" && !block.done) Object.assign(block, { state: "skipped", done: true });
  current = null;
  scheduleRender(true);
}

/** Fold replayed tool-call/tool-answer pairs into one tool card (the live
 *  stream's shape), keyed by call id. */
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
      if (block) { block.output = item.output ?? ""; block.state = state; block.done = true; block.resultIndex = item.messageIndex; }
      else out.push({ kind: "tool", name: call.name ?? (typeof item.text === "object" ? item.text?.name : item.text) ?? "tool", args: "", state, output: item.output ?? "", done: true, resultIndex: item.messageIndex });
    } else out.push({ ...item });
  }
  return out;
}

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

/** Close the in-flight text/thinking block (a new request, a tool call,
 *  or the turn's end all finish it). */
function settleCurrent() {
  if (current) { current.done = true; current.ended = Date.now(); touch(current); }
  current = null;
}

function onTurnEnd(m) {
  settleCurrent();
  if (m.terminal?.type === "error") pushBlock({ kind: "error", text: m.terminal.error ?? "turn failed", done: true, retry: true });
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
function pushBlock(block) { blocks.push(block); touch(block); }

function composerDraft() {
  const id = agent?.id;
  if (!id) return { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null };
  if (!composerByAgent.has(id)) composerByAgent.set(id, { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null });
  return composerByAgent.get(id);
}

function saveComposerDraft() {
  if (!agent?.id || !textareaEl) return;
  const draft = composerDraft();
  draft.text = textareaEl.value;
  draft.attachments = [...draftAttachments];
}

function loadComposerDraft() {
  const draft = composerDraft();
  draftAttachments = [...draft.attachments];
}

// Agent context is authoritative for old messages. Locally remembered submits
// are included only until that same text has appeared in context, so recalling
// a normal sent message does not create a duplicate entry.
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

// Composer height follows content, capped at twelve rows.
function autofit() {
  if (!textareaEl) return;
  textareaEl.style.height = "auto";
  textareaEl.style.height = Math.min(textareaEl.scrollHeight, 12 * 24) + "px";
}

// Typing always exits history browsing and the edited text becomes the
// working draft (parity with the TUI's input-controller edit actions, which
// reset historyIndex/historyDraft on any edit).
function noteComposerInput() {
  const draft = composerDraft();
  draft.historyIndex = null;
  draft.historyDraft = null;
  draft.text = textareaEl.value;
}

function recallHistory(direction) {
  if (!textareaEl) return false;
  const history = messageHistory();
  if (!history.length) return false;
  const draft = composerDraft();
  // Arrows keep their native caret movement between lines: recall takes over
  // only at a text boundary — no newline before the caret for Up, none after
  // it for Down — like the TUI's visual-edge trigger. This is what lets a
  // multi-line draft be edited without every Up/Down swapping its content.
  const beforeCaret = textareaEl.value.slice(0, textareaEl.selectionStart ?? 0);
  const afterCaret = textareaEl.value.slice(textareaEl.selectionEnd ?? textareaEl.value.length);
  if (direction < 0 && beforeCaret.includes("\n")) return false;
  if (direction > 0 && (draft.historyIndex === null || afterCaret.includes("\n"))) return false;
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

/** Tool name + a short human summary of its arguments (the first string
 *  field — a path, command, query — rather than a JSON dump). */
function toolLabel(call) {
  const name = call?.name ?? "tool";
  const args = parseArgs(call?.arguments ?? call?.args);
  let summary = "";
  if (typeof args === "string") summary = args;
  else if (args && typeof args === "object") {
    const preferred = ["command", "cmd", "path", "file", "file_path", "query", "url", "pattern", "name", "prompt", "question"];
    // Preferred keys first, then the first string anywhere (depth-first).
    const find = (value, depth) => {
      if (typeof value === "string" || typeof value === "number") return String(value);
      if (!value || typeof value !== "object" || depth > 3) return "";
      const key = Array.isArray(value) ? null : preferred.find((k) => typeof value[k] === "string");
      if (key) return value[key];
      for (const entry of Object.values(value)) { const found = find(entry, depth + 1); if (found) return found; }
      return "";
    };
    summary = find(args, 0);
  }
  summary = summary.replace(/\s+/g, " ").trim();
  return { name, summary: summary.length > 96 ? `${summary.slice(0, 95)}…` : summary };
}
function parseArgs(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return JSON.parse(text); } catch { return value; }
}
function argsText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") { const parsed = parseArgs(value); return typeof parsed === "string" ? value : JSON.stringify(parsed, null, 2); }
  return JSON.stringify(value, null, 2);
}

// Live tool cards. A card starts when the model begins composing the call
// (tool.call.start), fills with streamed arguments, runs (tool.execute),
// streams output (tool.data) and settles on tool.result — one card per call.
const liveTool = (predicate) => blocks.findLast((block) => block.kind === "tool" && !block.done && predicate(block));
function startToolCall(m) {
  settleCurrent();
  pushBlock({ kind: "tool", name: m.name ?? m.text ?? "tool", args: typeof m.args === "string" ? m.args : m.args !== undefined ? JSON.stringify(m.args) : "", index: m.index, callId: m.callId, state: "composing", output: "", done: false, started: Date.now() });
}
function appendToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  block.args += typeof m.args === "string" ? m.args : m.text ?? "";
  touch(block);
}
function finishToolCall(m) {
  const block = liveTool((item) => item.state === "composing" && (m?.index === undefined || item.index === m.index)) ?? liveTool((item) => item.state === "composing");
  if (!block) return;
  if (m?.args !== undefined && typeof m.args !== "string") block.args = JSON.stringify(m.args);
  block.state = "queued";
  touch(block);
}
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
const toolKey = (call) => String(call?.callId ?? call?.name ?? "tool");
function sanitizerFor(call) {
  const key = toolKey(call);
  let sanitizer = toolSanitizers.get(key);
  if (sanitizer === undefined) { sanitizer = new BashSanitizer({ markdown: true }); toolSanitizers.set(key, sanitizer); }
  return sanitizer;
}
function appendToolData(m) {
  const block = (m.call?.callId && liveTool((item) => item.callId === m.call.callId)) ?? liveTool((item) => item.state === "running");
  if (!block) return;
  block.output = (block.output ?? "") + sanitizerFor(m.call ?? block).push(typeof m.chunk === "string" ? m.chunk : "");
  block.streamed = true;
  touch(block);
}
function finishTool(m) {
  const result = m.result ?? {};
  const block = (result.callId && liveTool((item) => item.callId === result.callId)) ?? liveTool((item) => item.state === "running");
  const key = toolKey(block ?? result);
  const sanitizer = toolSanitizers.get(key);
  let tail = "";
  if (sanitizer !== undefined) { tail = sanitizer.end(); toolSanitizers.delete(key); }
  const final = resultText(result);
  const shown = Array.isArray(m.display) ? m.display.map((d) => sanitizeText(typeof d === "string" ? d : JSON.stringify(d), { markdown: true })) : [];
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
function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? sanitizeText(result, { markdown: true }) : "";
  return content.filter((b) => b?.type === "text" && b.text).map((b) => sanitizeText(String(b.text), { markdown: true })).join("\n");
}

/* --------------------------------------------------------------- elements */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function button(className, label, onClick, { title, icon, type = "button" } = {}) {
  const node = el("button", className);
  node.type = type;
  if (icon) node.append(el("span", "icon", icon));
  if (label !== undefined && label !== null) node.append(icon ? el("span", "label", label) : document.createTextNode(label));
  if (title) { node.title = title; if (!label) node.setAttribute("aria-label", title); }
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/* Wordmark: the real word stays in the DOM (copy/paste, find-in-page, screen
 * readers); its first letter is transparent and overlaid with an inline SVG
 * mark — the logo ring + prompt glyph in currentColor, so it tracks themes. */
const SVG_NS = "http://www.w3.org/2000/svg";
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

/* Persistent shell — built once, updated in place. Rebuilding the whole
 * tree on every state change resets scroll/focus and breaks the inputs, so
 * only the dynamic regions (header, sidebar lists, transcript) patch. */
let shellEl, sidebarEl, headerEl, scrollEl, transcriptContainer, jumpBtn, composerEl, textareaEl, stopBtn, sendBtn, attachmentInput, attachmentChips, ghostEl;

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
  scrollEl.addEventListener("scroll", () => { jumpBtn.hidden = nearBottom(); }, { passive: true });
  jumpBtn = button("jump-bottom", null, () => { scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" }); }, { title: "Jump to latest", icon: "↓" });
  jumpBtn.hidden = true;
  composerEl = buildComposer();
  const dock = el("div", "composer-dock");
  dock.append(jumpBtn, composerEl);
  main.append(headerEl, scrollEl, dock);
  shellEl.append(sidebarEl, scrim, main);
  app.append(shellEl);
  applyShell();
}

function setSidebar(open) { sidebarOpen = open; writePref("omoya.web.sidebar", open ? "open" : "closed"); applyShell(); }
function applyShell() { shellEl?.classList.toggle("sidebar-open", sidebarOpen); }

function render() {
  if (!shellEl) buildShell();
  else { composerEl.replaceWith(composerEl = buildComposer()); }
  scheduleRender(true); updateHeader(); updateSidebar(); updateUsage(); updateComposerActivity(); updateComposerTools();
}

/* ----------------------------------------------------------------- header */
function buildHeader() {
  const head = el("header", "app-header");
  const toggle = button("icon-button", null, () => setSidebar(!sidebarOpen), { title: "Toggle sidebar", icon: "☰" });
  const identity = el("div", "identity");
  identity.id = "identity";
  const actions = el("div", "header-actions");
  const state = el("span", "connection-state");
  state.id = "connection-state";
  actions.append(
    state,
    button("icon-button", null, () => openContextViewer(), { title: "Context viewer (Ctrl+Shift+O)", icon: "▤" }),
    button("icon-button palette-button", null, () => openPalette(), { title: "Command palette (Ctrl/⌘+K)", icon: "⌘" }),
    button("icon-button", null, () => openSettings(), { title: "Settings", icon: "⚙" }),
  );
  head.append(toggle, identity, actions);
  return head;
}

function aggregateAgentState() {
  const all = agentList();
  if (agent && !all.some((item) => item.id === agent.id)) all.push(agent);
  if (all.some((item) => item.state === "disconnected")) return "disconnected";
  return all.some((item) => item.state === "working" || item.busy) ? "working" : "idle";
}

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
  state.setAttribute("aria-label", `Connection: ${label}`);
  state.title = `${label} — ${agentList().length || 1} agent(s)`;
  state.append(dot, activity === "working" && online ? statusWord(label) : el("span", "state-label", label));

  identity.replaceChildren();
  const name = button("agent-name", agent?.name ?? "Omoya", () => renameAgentPrompt(), { title: "Rename this agent" });
  const session = agent?.session;
  const badge = button("session-badge" + (session ? (settings.sessionSave === false ? " paused" : " saved") : " ghost"),
    session ? (settings.sessionSave === false ? "Not logging" : shortId(session)) : "Unlogged",
    () => session ? renameSessionPrompt() : send({ type: "settings.session-save", on: true }),
    { title: session ? `Session ${session} — click to rename` : "Anonymous (not saved) — click to start logging" });
  identity.append(name, badge);
  if (settings.safe) identity.append(button("mode-badge", "Read-only", () => send({ type: "settings.safe", on: false }), { title: "Safe mode: read-only tools only — click to allow writes" }));
  // Stop replaces Send for the viewed agent only; Enter keeps submitting.
  const viewedWorking = agent?.state === "working" || agent?.busy === true;
  if (stopBtn) stopBtn.hidden = !viewedWorking;
  if (sendBtn) sendBtn.hidden = viewedWorking;
  document.title = `${viewedWorking ? "● " : ""}${agent?.name ?? "Omoya"} — Omoya`;
}

const shortId = (id) => (String(id).length > 18 ? `${String(id).slice(0, 8)}…` : String(id));

/* ---------------------------------------------------------------- sidebar */
let sessionFilter = "";
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
  const items = sessions.recent.filter((item) => !query || `${item.id} ${item.preview ?? ""}`.toLowerCase().includes(query));
  for (const item of items.slice(0, 200)) {
    const li = el("li");
    const row = button("recent-item" + (item.id === agent?.session ? " active" : ""), null, () => send({ type: "session.resume", id: item.id }), { title: `Resume ${item.id}` });
    row.append(el("span", "recent-title", item.preview || item.id), el("span", "recent-meta", [relativeTime(item.mtime), `${item.messages ?? 0} msg`, item.preview ? shortId(item.id) : null].filter(Boolean).join(" · ")));
    li.append(row);
    list.append(li);
  }
  if (!items.length) list.append(el("li", "muted empty-row", query ? "No matching sessions" : "No saved sessions yet"));
  recent.append(list);
  lists.append(running, recent);
}

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

function sessionAgent(a, depth) {
  const item = el("li", "session-tree");
  item.style.setProperty("--tree-depth", String(depth));
  const row = el("div", "session-row" + (a.active || a.id === agent?.id ? " active" : ""));
  const agentState = a.state ?? (a.busy ? "working" : "idle");
  const dot = el("i", "agent-dot " + agentState);
  dot.setAttribute("aria-hidden", "true");
  const select = button("session-item", null, () => send({ type: "session.switch", agentId: a.id }), { title: a.description || a.name || a.id });
  const text = el("span", "session-item-text");
  text.append(el("span", "session-item-name", a.name || a.id), el("span", "session-item-meta", [a.model ? a.model : null, a.session ? "saved" : "unlogged"].filter(Boolean).join(" · ")));
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

function statusWord(text) { return el("span", "working-word", text); }

/* ------------------------------------------------------------- transcript */
// One DOM node per block; a frame patches only dirty blocks (and appends new
// ones). A full render rebuilds every node (history replaced, prefs changed).
const nodes = [];          // nodes[i] renders blocks[i]
const dirty = new Set();
let fullRender = true;
let frame = 0;
let frameTimer = 0;

function touch(block) { dirty.add(block); scheduleRender(); }
// The next animation frame, or a timer when the browser withholds frames
// (hidden tab, occluded/minimized window, Safari low-power): otherwise a
// stream piles up unseen and then lands all at once.
function scheduleRender(full = false) {
  if (full) fullRender = true;
  if (frame) return;
  frame = requestAnimationFrame(flushRender);
  frameTimer = setTimeout(flushRender, 100);
}
function nearBottom() { return !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80; }

function flushRender() {
  cancelAnimationFrame(frame);
  clearTimeout(frameTimer);
  frame = 0;
  if (!transcriptContainer) return;
  const stick = nearBottom();
  if (fullRender) {
    fullRender = false;
    dirty.clear();
    nodes.length = 0;
    transcriptContainer.replaceChildren();
    if (!blocks.length) transcriptContainer.append(emptyState());
    else for (const block of blocks) { const node = renderBlock(block); nodes.push(node); transcriptContainer.append(node); }
  } else {
    if (nodes.length === 0 && blocks.length) transcriptContainer.replaceChildren();
    for (let i = 0; i < blocks.length; i++) {
      if (i >= nodes.length) { const node = renderBlock(blocks[i]); nodes.push(node); transcriptContainer.append(node); }
      else if (dirty.has(blocks[i])) { const node = renderBlock(blocks[i]); nodes[i].replaceWith(node); nodes[i] = node; }
    }
    dirty.clear();
  }
  renderWorkingIndicator();
  if (stick) scrollEl.scrollTop = scrollEl.scrollHeight;
  jumpBtn.hidden = nearBottom();
}

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
  empty.append(el("p", "muted small", agent?.session ? "This conversation is saved — resume it any time." : "Unlogged: nothing is written to disk until you turn logging on."));
  const keys = el("p", "muted small keys-line");
  keys.append(kbd("/"), document.createTextNode(" commands · "), kbd(isMac ? "⌘K" : "Ctrl K"), document.createTextNode(" palette · "), kbd("Shift ↵"), document.createTextNode(" new line"));
  empty.append(keys);
  return empty;
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
function kbd(text) { return el("kbd", null, text); }

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

function renderUser(block) {
  const node = el("div", "msg msg-user");
  const body = el("div", "user-text", block.text);
  node.append(body);
  if (Array.isArray(block.attachments) && block.attachments.length) {
    const list = el("div", "attachment-chips inline");
    for (const file of block.attachments) list.append(el("span", "attachment-chip", `📎 ${file.name}${file.size ? ` · ${formatBytes(file.size)}` : ""}`));
    node.append(list);
  }
  node.append(blockControls(block));
  return node;
}

/** Preview rows for a block kind under the selected theme (theme
 *  `<role>.preview.maxRows`, shared with the TUI); false = uncapped. */
function previewRows(kind) {
  const rows = prefs.previewRows?.[selectedTheme()] ?? prefs.previewRows?.default;
  return rows?.[kind] ?? false;
}

/** TUI preview window: the first line, an omission marker, then the last
 *  `rows - 2` lines — so a streaming block shows its tail with the head
 *  cropped. Windowed BEFORE any Markdown parsing (a cut fence must never
 *  swallow the rest of the card), and rendered as plain text. */
function previewNode(text, rows, className = "") {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  const node = el("div", `block-preview ${className}`.trim());
  if (rows === false || lines.length <= rows) { node.textContent = lines.join("\n"); return node; }
  const tail = Math.max(0, rows - 2);
  const hidden = lines.length - 1 - tail;
  node.append(document.createTextNode(`${lines[0]}\n`), el("span", "preview-gap", `⋯ ${hidden} more line${hidden === 1 ? "" : "s"}`), document.createTextNode(tail ? `\n${lines.slice(-tail).join("\n")}` : ""));
  return node;
}

/** A collapsible card: <summary> holds the header row plus the collapsed
 *  preview (a closed <details> renders nothing but its summary). */
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

function renderSystem(block) {
  const { node, summary, head } = cardShell(block, "msg msg-system", false);
  head.append(el("span", "block-kind", "System"));
  summary.append(previewNode(block.text, previewRows("system")));
  node.append(markdownNode("div", "md system-body", block.text), blockControls(block));
  return node;
}

function renderThinking(block) {
  const { node, summary, head } = cardShell(block, "msg msg-thinking" + (block.done ? "" : " streaming"), !prefs.collapse.thinking);
  const seconds = block.started && block.ended ? Math.max(1, Math.round((block.ended - block.started) / 1000)) : null;
  head.append(el("span", "block-kind", block.done ? (seconds ? `Thought for ${seconds}s` : "Thought") : "Thinking"));
  if (!block.done) head.append(el("span", "shimmer-dots"));
  summary.append(previewNode(block.text, previewRows("thinking"), "thinking-preview"));
  node.append(markdownNode("div", "md thinking-body", block.text), blockControls(block));
  return node;
}

const TOOL_STATE = { composing: ["…", "writing call"], queued: ["◌", "queued"], running: ["◌", "running"], ok: ["✓", "done"], error: ["✕", "failed"], skipped: ["–", "not run"] };
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
  if (payload) summary.append(previewNode(payload, rows, `tool-preview${state === "error" ? " error" : ""}`));
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
    for (const text of block.display ?? []) body.append(markdownNode("div", "md tool-display", text));
    if (!args && !block.output && !(block.display ?? []).length) body.append(el("p", "muted small", state === "running" ? "Waiting for output…" : "No output"));
    body.append(blockControls(block));
    node.append(body);
  };
  if (node.open) fillToolBody();
  return node;
}

function formatDuration(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`; }
function formatBytes(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`; }

function markdownNode(tag, className, source) {
  const node = el(tag, className);
  node.innerHTML = renderMarkdown(source);
  for (const pre of node.querySelectorAll("pre.md-code")) {
    const bar = el("div", "code-bar");
    bar.append(el("span", "code-lang", pre.dataset.lang || "text"), button("code-copy", "Copy", (event) => { event.stopPropagation(); copyText(pre.querySelector("code")?.textContent ?? "", "Code copied"); }));
    pre.prepend(bar);
  }
  return node;
}

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

function deleteContextMessages(messageIndexes) {
  const unique = [...new Set(messageIndexes)].sort((a, b) => a - b);
  const label = unique.length === 1 ? "this message" : `${unique.length} messages`;
  if (!confirm(`Delete ${label} from context? This cannot be undone.`)) return;
  send({ type: "context.delete", messageIndexes: unique });
}

/* --------------------------------------------------------------- composer */
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

  textareaEl.addEventListener("input", () => { noteComposerInput(); autofit(); updateAutocomplete(); updateGhost(); });
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

function clearComposer() {
  const draft = composerDraft();
  draft.text = ""; draft.attachments = []; draft.historyIndex = null; draft.historyDraft = null;
  draftAttachments = []; renderAttachmentChips();
  textareaEl.value = "";
  autofit(); hideAutocomplete(); updateGhost();
}

function insertComposer(text, replace = false) {
  if (!textareaEl) return;
  textareaEl.value = replace || !textareaEl.value ? text : `${textareaEl.value.replace(/\s*$/, " ")}${text}`;
  noteComposerInput(); autofit(); updateGhost();
  textareaEl.focus();
  textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
}

/** Dim argument hint after a complete command (TUI ghost text). */
function updateGhost() {
  if (!ghostEl || !textareaEl) return;
  const value = textareaEl.value;
  const match = value.match(/^(\/\S+) ?$/);
  const hint = match ? catalog.hints?.[match[1]] : null;
  ghostEl.replaceChildren();
  if (!hint) return;
  ghostEl.append(el("span", "ghost-typed", value.endsWith(" ") ? value : `${value} `), el("span", "ghost-hint", hint));
}

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

/* Composer toolbar: attach, model, thinking, safe mode — the per-agent
 * settings live next to where you type (the TUI keeps them one ^X away). */
function updateComposerTools() {
  const tools = document.querySelector("#composer-tools");
  if (!tools) return;
  tools.replaceChildren();
  tools.append(button("tool-chip icon-only", null, () => attachmentInput.click(), { title: "Attach files (or drop / paste them)", icon: "📎" }));
  const model = settings.endpoint ? `${settings.model ?? "?"}` : "Choose model";
  const modelBtn = button("tool-chip model-chip", model, () => openModelPicker(), { title: settings.endpoint ? `Model: ${settings.endpoint}/${settings.model} — click to switch` : "Choose a model", icon: "◇" });
  tools.append(modelBtn);
  const thinking = button("tool-chip" + (settings.thinking !== "default" && settings.thinking !== "off" ? " active" : ""), settings.thinking === "default" ? "Think: auto" : `Think: ${settings.thinking}`,
    (event) => openMenu(event.currentTarget, prefs.thinkingLevels.map((level) => ({ label: level, detail: level === "default" ? "provider default" : "", current: level === settings.thinking, run: () => send({ type: "settings.thinking", level }) }))),
    { title: "Thinking level", icon: "✦" });
  tools.append(thinking);
  const safe = button("tool-chip" + (settings.safe ? " active warn" : ""), settings.safe ? "Read-only" : "Read/write", () => send({ type: "settings.safe", on: !settings.safe }), { title: settings.safe ? "Safe mode on: only read-only tools run — click to allow writes" : "Tools may write — click for read-only safe mode", icon: settings.safe ? "🔒" : "🔓" });
  safe.setAttribute("aria-pressed", String(settings.safe));
  tools.append(safe);
}

/* ----------------------------------------------------------- autocomplete */
let acItems = [];
let acIndex = -1;
let acArg = false; // completing an argument (replace only the last token)

const acListEl = () => document.querySelector("#autocomplete");
const acOpen = () => acItems.length > 0;

function toolDescription(name) { return String(catalog.toolSchemas.find((schema) => `/tool-${schema.name}` === name)?.description ?? "").split("\n")[0]; }
function allSlash() {
  const promptNames = catalog.prompts.map((p) => ({ value: p.startsWith("/") ? p : `/${p}`, detail: "prompt" }));
  return [
    ...catalog.commands.map((value) => ({ value, detail: catalog.hints?.[value] ?? "" })),
    ...promptNames,
    ...catalog.tools.map((value) => ({ value, detail: toolDescription(value) })),
  ];
}

/** Argument candidates for commands whose arguments come from live state. */
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

function hideAutocomplete() { acItems = []; acIndex = -1; const list = acListEl(); if (list) list.hidden = true; textareaEl?.setAttribute("aria-expanded", "false"); }

function pickAutocomplete(i) {
  const item = acItems[i];
  if (item === undefined) return;
  textareaEl.value = acArg ? textareaEl.value.replace(/\S*$/, item.value) : item.value + " ";
  hideAutocomplete();
  textareaEl.focus();
  noteComposerInput(); autofit(); updateGhost();
  if (!acArg) updateAutocomplete(); // chain into argument candidates
}

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
/** A native <dialog>: focus trap, Esc, and backdrop come from the browser. */
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

function refreshOpenPanels() {
  if (document.querySelector("#settings-panel")) renderSettingsBody();
  if (document.querySelector("#login-panel") && (!loginSelection || loginSelection.oauth)) renderLoginBody();
  if (document.querySelector("#themes-panel")) renderThemesBody();
}

/** Small anchored menu (thinking levels, new-chat variants). */
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

/** Filterable, grouped, keyboard-driven list (palette, model picker). */
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
function openPalette() {
  const items = [];
  const add = (group, label, run, extra = {}) => items.push({ group, label, run, ...extra });
  const A = "Actions";
  add(A, "New chat", () => send({ type: "session.new" }), { icon: "＋", detail: "saved session" });
  add(A, "New unlogged chat", () => send({ type: "session.new", anonymous: true }), { icon: "＋", detail: "nothing written to disk" });
  add(A, "Add agent…", () => openAddAgent(), { icon: "⧉", detail: "keep this one running" });
  add(A, "Fork session", () => send({ type: "session.fork" }), { icon: "⑂" });
  add(A, "Rename agent…", () => renameAgentPrompt(), { icon: "✎" });
  if (agent?.session) add(A, "Rename session…", () => renameSessionPrompt(), { icon: "✎" });
  add(A, "Switch model…", () => openModelPicker(), { icon: "◇", detail: settings.endpoint ? `${settings.endpoint}/${settings.model}` : "none selected" });
  add(A, settings.safe ? "Turn safe mode off" : "Turn safe mode on (read-only)", () => send({ type: "settings.safe", on: !settings.safe }), { icon: settings.safe ? "🔓" : "🔒" });
  if (agent?.session) add(A, settings.sessionSave === false ? "Resume session logging" : "Pause session logging", () => send({ type: "settings.session-save", on: settings.sessionSave === false }), { icon: "📝" });
  else add(A, "Start logging this session", () => send({ type: "settings.session-save", on: true }), { icon: "📝" });
  add(A, "Continue", () => send({ type: "chat.continue" }), { icon: "▶", detail: "re-activate over the current context" });
  add(A, "Copy last response", () => send({ type: "chat.submit", text: "/context-copy" }), { icon: "⧉" });
  add(A, "Context viewer", () => openContextViewer(), { icon: "▤", shortcut: isMac ? "⇧⌘O" : "Ctrl⇧O" });
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
  for (const s of sessions.recent) add("Sessions", s.preview || s.id, () => send({ type: "session.resume", id: s.id }), { detail: `${relativeTime(s.mtime)} · ${s.messages ?? 0} msg · ${shortId(s.id)}`, keywords: s.id, icon: "↺" });
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

function openModelPicker() {
  const items = [];
  for (const endpoint of endpoints.endpoints) {
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

function openAddAgent() {
  const items = [{ group: "Same model", label: settings.endpoint ? `${settings.endpoint}/${settings.model}` : "Default model", run: () => send({ type: "session.add" }), icon: "＋", detail: "new agent, this one keeps running" }];
  for (const model of settings.models) items.push({ group: "Choose a model", label: model, run: () => send({ type: "session.add", model }), icon: "◇" });
  openPicker({ id: "add-agent", title: "Add an agent", placeholder: "Filter models", items });
}

/* ----------------------------------------------------------------- naming */
function renameAgentPrompt(target = agent) {
  if (!target) return;
  const name = prompt("Agent name", target.name ?? "");
  if (name === null || !name.trim() || name.trim() === target.name) return;
  send({ type: "agent.rename", agentId: target.id, name: name.trim() });
}
function renameSessionPrompt() {
  if (!agent?.session) { toast("This session is unlogged — turn logging on to name it", true); return; }
  const name = prompt("Session name (saved as its file name)", agent.session);
  if (name === null || !name.trim() || name.trim() === agent.session) return;
  send({ type: "session.rename", name: name.trim() });
}

/* --------------------------------------------------------------- settings */
function openSettings() {
  openDialog({ id: "settings-panel", title: "Settings", wide: true });
  renderSettingsBody();
}
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

  const sessionSection = section("Session", agent?.session ? `Saved as “${agent.session}”.` : "Unlogged — nothing is written to disk.");
  if (agent?.session) {
    const sessionForm = el("form", "inline-form");
    const sessionInput = el("input"); sessionInput.value = agent.session; sessionInput.setAttribute("aria-label", "Session name");
    sessionForm.append(sessionInput, button("chip", "Rename", null, { type: "submit" }));
    sessionForm.addEventListener("submit", (event) => { event.preventDefault(); if (sessionInput.value.trim() && sessionInput.value.trim() !== agent.session) send({ type: "session.rename", name: sessionInput.value.trim() }); });
    sessionSection.append(row("Name", sessionForm, "Renames the session file"));
  }
  sessionSection.append(row("Logging", segmented([["On", true], ["Off", false]], settings.sessionSave === true, (on) => send({ type: "settings.session-save", on })), agent?.session ? "Off keeps the conversation in memory only" : "On starts a saved session"));
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

  const appearance = section("Appearance", "Themes are shared with the terminal UI (tui.theme).");
  appearance.append(button("chip wide-chip", `Theme: ${selectedTheme()}`, () => openThemes(), { icon: "◐" }));
  body.scrollTop = scroll;
}

/* ------------------------------------------------------------------ login */
let loginSelection = null; // null = preset list; {preset?|manual}
function openLogin(endpointName) {
  send({ type: "endpoint.list" });
  const preset = endpointName ? endpoints.presets.find((item) => item.name === endpointName) : null;
  loginSelection = preset ? { preset } : null;
  if (preset?.oauth) startOAuth(preset);
  openDialog({ id: "login-panel", title: "Sign in to an endpoint", onClose: () => { loginSelection = null; } });
  renderLoginBody();
}
function startOAuth(preset) {
  oauthState = { active: true, url: null, lines: [], done: false, error: false, name: preset.name };
  loginSelection = { preset, oauth: true };
  send({ type: "endpoint.oauth", name: preset.name });
}
function onOAuth(m) {
  if (m.state === "url") oauthState = { ...oauthState, active: true, url: m.url };
  else if (m.state === "log") oauthState = { ...oauthState, active: true, lines: [...oauthState.lines, m.text].slice(-20) };
  else if (m.state === "done") { oauthState = { ...oauthState, active: false, done: true, lines: [...oauthState.lines, m.text] }; toast(m.text); }
  else if (m.state === "error") { oauthState = { ...oauthState, active: false, error: true, lines: [...oauthState.lines, m.text] }; toast(m.text, true); }
  if (document.querySelector("#login-panel")) renderLoginBody();
}
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
function selectedTheme() {
  if (prefs.activeTheme && prefs.themes?.includes(prefs.activeTheme)) return prefs.activeTheme;
  const saved = readPref("omoya.web.theme", null);
  if (saved && ["system", "light", "dark"].includes(saved)) return saved;
  return prefs.theme ?? "system";
}
function applyThemeName(name) {
  const named = name && !["system", "light", "dark"].includes(name) && prefs.themes?.includes(name);
  const mode = named ? (prefs.themeModes?.[name] ?? (dark.matches ? "dark" : "light")) : name === "system" || !name ? (dark.matches ? "dark" : "light") : name;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = named ? name : "";
  document.documentElement.style.colorScheme = mode;
  queueMicrotask(() => document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).backgroundColor));
}
// Previews apply a theme directly; leaving a preview re-applies the saved
// selection, so no "before" snapshot is ever needed.
function applyTheme() { applyThemeName(selectedTheme()); }
function chooseTheme(name) {
  writePref("omoya.web.theme", name);
  // Named themes persist to tui.theme (shared with the TUI); the web-only
  // system/light/dark modes reset it to the TUI default.
  prefs = { ...prefs, activeTheme: ["system", "light", "dark"].includes(name) ? null : name };
  applyTheme();
  send({ type: "settings.theme", name });
  refreshOpenPanels();
}
function openThemes() {
  openDialog({ id: "themes-panel", title: "Themes", wide: true, onClose: applyTheme });
  renderThemesBody();
}
function renderThemesBody() {
  const body = document.querySelector("#themes-panel .panel-body");
  if (!body) return;
  body.replaceChildren(el("p", "muted small", "Hover or focus to preview · click to apply. Named themes are shared with the terminal UI."));
  const grid = el("div", "theme-grid");
  const current = selectedTheme();
  for (const name of prefs.themes ?? []) {
    const named = !["system", "light", "dark"].includes(name);
    const card = button("theme-card" + (name === current ? " current" : ""), null, () => chooseTheme(name));
    if (named) card.dataset.theme = name;
    card.dataset.mode = named ? (prefs.themeModes?.[name] ?? "") : name;
    const swatch = el("span", "theme-swatch");
    swatch.append(el("span", "sw-bg"), el("span", "sw-fg"), el("span", "sw-accent"), el("span", "sw-user"));
    card.append(swatch, el("span", "theme-name", name), el("span", "theme-mode", named ? (prefs.themeModes?.[name] ?? "") : name === "system" ? "follows OS" : "built-in"));
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
  [isMac ? "⌘K" : "Ctrl+K", "command palette (TUI ^X)"], [isMac ? "⇧⌘O" : "Ctrl+Shift+O", "context viewer (TUI ^O)"],
  ["Esc", "stop the running response / close dialogs"], ["Alt+Shift+↑", "put queued messages back in the composer"],
  ["Ctrl+Alt+← / →", "previous / next agent"], ["Ctrl+Alt+↑", "parent agent"], [isMac ? "⌘B" : "Ctrl+B", "toggle the sidebar"],
];
function openHelp() {
  const { body } = openDialog({ id: "help-panel", title: "Keyboard shortcuts" });
  const table = el("dl", "shortcut-list");
  for (const [key, action] of SHORTCUTS) { const dt = el("dt"); for (const part of key.split(" / ")) dt.append(kbd(part), document.createTextNode(" ")); table.append(dt, el("dd", null, action)); }
  body.append(table, button("chip", "All slash commands", () => { document.querySelector("#help-panel")?.close(); send({ type: "chat.submit", text: "/help" }); }));
}

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
    // The pane keeps its place while any option has a preview, so choosing
    // an option never shifts the buttons under the pointer.
    const previewPane = el("div", "question-preview-pane");
    previewPane.hidden = !(q.options ?? []).some((option) => option.preview !== undefined);
    previewPane.append(el("p", "muted small", "Hover or focus an option to preview it"));
    const showPreview = (option) => {
      const preview = option?.preview === undefined ? null : typeof option.preview === "string" ? { type: "text", content: option.preview } : option.preview;
      previewPane.replaceChildren();
      if (!preview) { previewPane.append(el("p", "muted small", "No preview for this option")); return; }
      if (preview.title) previewPane.append(el("div", "question-preview-title", preview.title));
      previewPane.append(preview.type === "code" ? el("pre", "question-preview", preview.content ?? "") : markdownNode("div", "md question-preview", preview.content ?? ""));
    };
    (q.options ?? []).forEach((option, oi) => {
      const btn = el("button", "question-option");
      btn.type = "button";
      btn.dataset.label = option.label ?? "";
      if (!q.multiSelect) btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      const key = el("span", "option-key", String(oi + 1));
      const text = el("span", "option-text");
      text.append(el("span", "question-option-label", option.label ?? ""));
      if (option.description) text.append(el("span", "question-option-description", option.description));
      btn.append(key, text);
      if (option.preview !== undefined) btn.append(el("span", "option-has-preview", "preview"));
      btn.addEventListener("focus", () => showPreview(option));
      btn.addEventListener("mouseenter", () => showPreview(option));
      btn.addEventListener("click", () => {
        const state = states[qi];
        if (q.multiSelect) { if (state.labels.has(btn.dataset.label)) state.labels.delete(btn.dataset.label); else state.labels.add(btn.dataset.label); }
        else { state.labels = new Set([btn.dataset.label]); }
        list.querySelectorAll(".question-option").forEach((button) => {
          const selected = state.labels.has(button.dataset.label);
          button.classList.toggle("selected", selected);
          button.setAttribute("aria-checked", String(selected));
        });
        showPreview(option);
        refresh();
      });
      list.append(btn);
    });
    list.addEventListener("keydown", (event) => {
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= (q.options ?? []).length && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); list.querySelectorAll(".question-option")[n - 1]?.click(); }
    });
    const other = el("input", "question-other");
    other.placeholder = q.multiSelect ? "Add a note (optional)" : "Or type your own answer";
    other.setAttribute("aria-label", `Custom answer for: ${q.question ?? "question"}`);
    other.addEventListener("input", () => {
      states[qi].text = other.value;
      if (!q.multiSelect && other.value.trim()) { states[qi].labels.clear(); list.querySelectorAll(".question-option").forEach((b) => { b.classList.remove("selected"); b.setAttribute("aria-checked", "false"); }); }
      refresh();
    });
    other.addEventListener("keydown", (event) => { if (event.key === "Enter" && !submit.disabled) { event.preventDefault(); submit.click(); } });
    section.append(list, previewPane, other);
    body.append(section);
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
  const dismiss = button("chip question-dismiss", "Dismiss", () => dialog.close(), { title: "Refuse to answer (Esc)" });
  actions.append(dismiss, submit);
  body.append(actions);
  refresh();
  body.querySelector(".question-option")?.focus();
}
function closeQuestion() { const node = document.querySelector("#question-overlay"); if (node) { openQuestion = null; node.close(); } }

/* ------------------------------------------------------------------ toast */
function toast(text, isError = false) {
  const node = el("div", "toast" + (isError ? " toast-error" : ""), String(text));
  node.addEventListener("click", () => node.remove());
  (isError ? errors : toasts).append(node);
  setTimeout(() => node.remove(), isError ? 8000 : 3500);
}

/* ------------------------------------------------------------ usage meter */
// Sort key mirroring lib/tui-app/status-data.js's quotaImportance: an
// actual time-to-reset wins (soonest first) over a mere window SIZE
// (smallest first), which wins over neither (kept in insertion order).
// Two-tier so a 30-day window's raw windowSeconds (a big number) can
// never sort before a 5-minute-away reset just because it's a smaller
// tier-1 number than tier-0 would suggest — the tiers never interleave.
function quotaImportance(quota) {
  const resetAt = typeof quota?.reset === "string" ? Date.parse(quota.reset) : NaN;
  if (Number.isFinite(resetAt)) return [0, resetAt];
  if (Number.isFinite(quota?.windowSeconds)) return [1, quota.windowSeconds];
  return [2, 0];
}

function sortedQuotaEntries(quotas) {
  return Object.entries(quotas ?? {})
    .map((entry, index) => ({ entry, index, key: quotaImportance(entry[1]) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ entry }) => entry);
}

// A quota amount as currency when `unit` names one (a prepaid wallet
// balance, e.g. Kimi's — no token total, so it never reaches the
// percentage branch below), else the raw number.
function formatAmount(value, unit) {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  if (unit === "cny") return `¥${value.toFixed(2)}`;
  return String(value);
}

// Provider-reported plan/quota percentage, mirrored from tui-app's
// planPercentText (lib/tui-app/status-data.js), most important quota first
// — rounded to whole percent: `plan: 5h 2% · 7d 12%`, or "" when no quota
// sizes a percentage (e.g. a currency balance, which has no total).
function planPercentText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || typeof quotas !== "object") return "";
  const parts = sortedQuotaEntries(quotas).map(([name, quota]) => {
    const total = Number(quota?.total);
    if (!(total > 0)) return null;
    const used = Number.isFinite(quota?.used) ? Number(quota.used)
      : Number.isFinite(quota?.remaining) ? total - Number(quota.remaining) : null;
    return used === null ? null : `${name} ${Math.round((used / total) * 100)}%`;
  }).filter(Boolean);
  return parts.length ? `plan: ${parts.join(" · ")}` : "";
}

// Mirrors lib/tui-app/status-data.js's humanDuration/resetCountdown.
function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const units = d ? [[d, "d"], [h, "h"]] : h ? [[h, "h"], [m, "m"]] : m ? [[m, "m"], [s % 60, "s"]] : [[s, "s"]];
  return units.filter(([n], i) => n > 0 || i === 0).map(([n, suffix]) => `${n}${suffix}`).join("");
}

function resetCountdown(reset) {
  if (typeof reset !== "string" || reset === "") return null;
  const at = Date.parse(reset);
  if (!Number.isFinite(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  return seconds <= 0 ? "resets now" : `resets in ${humanDuration(seconds)}`;
}

// The compact meter only has room for a percentage; the reset countdown
// (and raw counts) live in this hover tooltip instead of crowding it.
function planTooltipText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || typeof quotas !== "object") return "";
  return sortedQuotaEntries(quotas).map(([name, quota]) => {
    const bits = [];
    if (Number.isFinite(quota?.used) && Number.isFinite(quota?.total)) bits.push(`${quota.used}/${quota.total} used`);
    else if (Number.isFinite(quota?.remaining)) bits.push(`${formatAmount(quota.remaining, quota?.unit)} left`);
    const countdown = resetCountdown(quota?.reset);
    if (countdown) bits.push(countdown);
    else if (typeof quota?.reset === "string" && quota.reset) bits.push(`reset ${quota.reset}`);
    return `${name}: ${bits.join(", ")}`;
  }).join("\n");
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
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
  node.append(ring, el("span", "meter-text", `${compact(used)}${available ? `/${compact(available)}` : ""}${plan ? ` · ${plan.replace("plan: ", "")}` : ""}`));
  node.title = [
    `Context: ${used.toLocaleString()} / ${available ? available.toLocaleString() : "—"} tokens${percent === null ? "" : ` (${percent}%)`}`,
    `Session: ${Number(usage.input ?? 0).toLocaleString()} in · ${Number(usage.output ?? 0).toLocaleString()} out`,
    planTooltipText(usage.plan),
    "Click to open the context viewer",
  ].filter(Boolean).join("\n");
  node.setAttribute("aria-label", `Context ${percent === null ? used : `${percent}%`} used`);
}

function updateComposerActivity() {
  composerEl?.classList.toggle("working", agent?.state === "working" || agent?.busy === true);
}

function renderComposerQueue() {
  const node = document.querySelector("#composer-queue");
  if (!node) return;
  node.replaceChildren();
  if (!queuedMessages.length) return;
  const text = queuedMessages.length === 1 ? "1 queued" : `${queuedMessages.length} queued`;
  node.append(el("span", "queue-label", text), el("span", "composer-queue-preview", queuedMessages.join(" · ")));
  node.append(button("composer-unqueue", "Edit", () => send({ type: "chat.unqueue" }), { title: "Remove queued messages and put them back in the editor (Alt+Shift+↑)" }));
}

function agentList() {
  const agents = [];
  const visit = (items) => { for (const item of items ?? []) { agents.push(item); visit(item.children); } };
  visit(sessions.agents);
  return agents;
}

function navigateAgent(direction) {
  const agents = agentList();
  const currentIndex = agents.findIndex((item) => item.id === agent?.id);
  if (agents.length < 2 || currentIndex < 0) return;
  send({ type: "session.switch", agentId: agents[(currentIndex + direction + agents.length) % agents.length].id });
}

function navigateParentAgent() {
  const parentId = agentList().find((item) => item.id === agent?.id)?.parentId;
  if (parentId) send({ type: "session.switch", agentId: parentId });
}

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const dialogOpen = Boolean(document.querySelector("dialog[open]"));
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); if (document.querySelector("#palette")) document.querySelector("#palette").close(); else openPalette(); return; }
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

/* ---------------------------------------------------------- context viewer */
const VIEWER_TYPES = ["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"];
function contextEntries() {
  return contextBlocks.flatMap((message) => (message.content ?? []).map((block) => ({ ...block, source: block.text ?? JSON.stringify(block.data, null, 2) })));
}

function filteredContextEntries(entries) {
  let pattern;
  try { pattern = contextView.search ? new RegExp(contextView.search, "i") : null; } catch { return { entries: [], error: "Enter a valid regular expression." }; }
  return { entries: entries.filter((block) => (!contextView.types.size || contextView.types.has(block.viewerType)) && (!pattern || pattern.test(`${block.viewerType}\n${block.source}`))), error: null };
}

function openContextViewer(target = null, edit = false) {
  contextView = { search: "", types: new Set(), selected: new Set(), target, edit, limit: 60 };
  openDialog({ id: "context-viewer", title: "Context", wide: true, className: "context-viewer", onClose: () => { contextView = null; } });
  renderContextViewer(true);
  send({ type: "context.inspect" });
}
function closeContextViewer() { document.querySelector("#context-viewer")?.close(); }

function renderContextViewer(initial = false) {
  const dialog = document.querySelector("#context-viewer");
  if (!dialog || !contextView) return;
  const body = dialog.querySelector(".panel-body");
  const searchFocused = document.activeElement?.classList.contains("context-search");
  const all = contextEntries();
  const { entries, error } = filteredContextEntries(all);
  body.replaceChildren();
  const tools = el("div", "context-tools");
  const search = el("input", "context-search"); search.type = "search"; search.placeholder = "RegExp search all blocks"; search.value = contextView.search; search.setAttribute("aria-label", "Search all context blocks with a regular expression");
  search.addEventListener("input", () => { contextView.search = search.value; contextView.limit = 60; renderContextViewer(); });
  const filters = el("div", "context-filters");
  filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Block types");
  for (const type of VIEWER_TYPES) {
    const count = all.filter((block) => block.viewerType === type).length;
    const chip = button("filter-chip" + (contextView.types.has(type) ? " active" : ""), `${type} ${count}`, () => { if (contextView.types.has(type)) contextView.types.delete(type); else contextView.types.add(type); renderContextViewer(); });
    chip.setAttribute("aria-pressed", String(contextView.types.has(type)));
    chip.disabled = count === 0;
    filters.append(chip);
  }
  const bulk = el("div", "context-bulk-actions");
  bulk.append(el("span", "muted small", initial && !all.length ? "Loading…" : `${entries.length} of ${all.length} blocks · ${contextBlocks.length} messages`));
  const deleteSelected = button("chip danger", `Delete selected (${contextView.selected.size})`, () => deleteContextMessages([...contextView.selected]));
  deleteSelected.disabled = contextView.selected.size === 0;
  bulk.append(deleteSelected);
  tools.append(search, filters, bulk);
  const list = el("div", "context-block-list");
  if (error) list.append(el("p", "muted", error));
  else if (!entries.length && !initial) list.append(el("p", "muted", "No context blocks match the current filters."));
  let targetNode = null;
  const targetIndex = contextView.target ? entries.findIndex((block) => block.messageIndex === contextView.target.messageIndex && block.blockIndex === contextView.target.blockIndex) : -1;
  const limit = Math.max(contextView.limit, targetIndex + 10);
  for (const [i, block] of entries.slice(0, limit).entries()) {
    const card = contextCard(block, i === targetIndex && contextView.edit);
    if (i === targetIndex) { card.classList.add("target"); targetNode = card; }
    list.append(card);
  }
  if (entries.length > limit) list.append(button("chip load-more", `Show ${Math.min(60, entries.length - limit)} more`, () => { contextView.limit = limit + 60; renderContextViewer(); }));
  body.append(tools, list);
  if (searchFocused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  if (targetNode && all.length) { queueMicrotask(() => targetNode.scrollIntoView({ block: "center" })); contextView.target = null; contextView.edit = false; }
}

function contextCard(block, editing) {
  const card = el("article", "context-block");
  const meta = el("header", "context-block-meta");
  const select = el("input"); select.type = "checkbox"; select.checked = contextView.selected.has(block.messageIndex); select.setAttribute("aria-label", `Select message ${block.messageIndex + 1}`);
  select.addEventListener("change", () => { if (select.checked) contextView.selected.add(block.messageIndex); else contextView.selected.delete(block.messageIndex); renderContextViewer(); });
  meta.append(select, el("strong", `context-block-type type-${block.viewerType.replace(" ", "-")}`, block.viewerType), el("small", null, `#${block.messageIndex} · block ${block.blockIndex}`));
  const actions = el("div", "block-controls always");
  actions.append(button("block-icon", null, () => copyText(block.source, "Copied"), { title: "Copy", icon: "⧉" }));
  const canEdit = typeof block.text === "string" && block.viewerType !== "tool display";
  if (canEdit) actions.append(button("block-icon", null, () => { card.replaceWith(contextCard(block, true)); }, { title: "Edit", icon: "✎" }));
  actions.append(button("block-icon", null, () => { if (confirm(`Remove message #${block.messageIndex} and everything after it?`)) send({ type: "context.rollback", messageIndex: block.messageIndex }); }, { title: "Roll back to here (drop this and later messages)", icon: "⤒" }));
  actions.append(button("block-icon block-delete", null, () => deleteContextMessages([block.messageIndex]), { title: "Delete message", icon: "⌫" }));
  meta.append(actions);
  card.append(meta);
  if (editing && canEdit) {
    const form = el("form", "context-edit");
    const area = el("textarea"); area.value = block.text; area.rows = Math.min(20, Math.max(4, block.text.split("\n").length + 1)); area.setAttribute("aria-label", "Edit block text");
    const row = el("div", "button-row");
    row.append(button("chip", "Cancel", () => card.replaceWith(contextCard(block, false))), button("primary-button", "Save", null, { type: "submit" }));
    form.append(area, row);
    form.addEventListener("submit", (event) => { event.preventDefault(); send({ type: "context.edit-text", messageIndex: block.messageIndex, blockIndex: block.blockIndex, text: area.value }); });
    area.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
    card.append(form);
    queueMicrotask(() => area.focus());
  } else if (["thinking", "assistant", "tool answer", "tool display", "user", "system"].includes(block.viewerType)) card.append(markdownNode("div", "md context-markdown", block.source));
  else card.append(el("pre", "context-pre", block.source));
  return card;
}

/* ------------------------------------------------------------ tool runner */
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

dark.addEventListener("change", applyTheme);
applyTheme();

/* ------------------------------------------------------------------- boot */
connect();
render();
})();
