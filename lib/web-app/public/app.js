/**
 * public/app.js — the Omoya web SPA. A zero-dependency chat client (the
 * shape of duck.ai / the ChatGPT web UI) that speaks the lib/web-app
 * protocol over one WebSocket. The server owns the Agent and all state;
 * this client owns only presentation: it renders the transcript (Markdown
 * → safe HTML), streams turn deltas, asks questions, and forwards user
 * intent as validated protocol packets.
 *
 * Presentation is document-flow (not side-bubbles): the transcript is a
 * column of full-width blocks — user messages, assistant Markdown,
 * collapsible thinking, tool activity with a bounded output preview, and
 * command results. Display details (collapse defaults, tool line cap,
 * theme, autocomplete, thinking levels) come from settings.web via the
 * server's settings packet — never hardcoded here.
 */
import { renderMarkdown } from "./markdown.js";

(() => {
"use strict";

const app = document.querySelector("#app");
const toasts = document.querySelector("#toast-region");
const errors = document.querySelector("#error-region");

/* ------------------------------------------------------------------ state */
let ws = null;
let retry = 0;
let reconnectTimer = null;
let ended = false;

let agent = null;                 // current agent info (from hello/sessions)
let sessions = { agents: [], recent: [] };
let settings = { safe: false, thinking: "default", endpoint: null, model: null, models: [] };
// Display preferences from settings.web (server-supplied; defaults applied
// server-side). The client honors these — it never hardcodes them.
let prefs = { autocomplete: true, collapse: { thinking: true, tools: true }, toolLines: 6, theme: "system", thinkingLevels: ["default", "off", "low", "medium", "high", "xhigh"] };
let catalog = { commands: [], prompts: [], tools: [], toolSchemas: [] };
let usage = { input: 0, output: 0, used: 0, available: 0, plan: null };
let contextBlocks = [];
let contextViewerOpen = false;
let contextViewerIndex = 0;
let contextViewerEdit = false;
let contextViewerTarget = null;
let contextViewerSearch = "";
let contextViewerTypes = new Set();
let contextViewerSelections = new Set();
let sidebarOpen = false;
let queuedMessages = [];
let uploadKey = null;
let draftAttachments = []; // { id, name, size }; opaque IDs never enter the visible composer.

// The transcript: an ordered list of blocks the wire builds up.
// {kind:"user"|"text"|"thinking"|"tool"|"error"|"command", text, done, output?}
let blocks = [];
let current = null;               // the in-flight stream block
let openQuestion = null;          // {requestId, questions}

/* ------------------------------------------------------------------ wire */
const send = (packet) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(packet)); };

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
  ws.addEventListener("close", () => { if (!ended) scheduleReconnect(); updateHeader(); updateSidebar(); });
  ws.addEventListener("error", () => ws.close());
}

function scheduleReconnect() {
  retry++;
  const delay = Math.min(10000, 500 * 2 ** retry);
  reconnectTimer = setTimeout(connect, delay);
}

function handle(m) {
  switch (m.type) {
    case "hello":
      agent = m.agent ?? null;
      const previousUploadKey = uploadKey;
      uploadKey = typeof m.uploadKey === "string" ? m.uploadKey : null;
      if (previousUploadKey && previousUploadKey !== uploadKey) { draftAttachments = []; renderAttachmentChips(); }
      if (Array.isArray(m.history)) { blocks = m.history; current = null; }
      queuedMessages = Array.isArray(m.queue) ? m.queue : [];
      if (m.catalog) catalog = { commands: m.catalog.commands ?? [], prompts: m.catalog.prompts ?? [], tools: m.catalog.tools ?? [], toolSchemas: m.catalog.toolSchemas ?? [] };
      if (m.status) usage = m.status;
      render();
      break;
    case "sessions": sessions = { agents: m.agents ?? [], recent: m.recent ?? [] }; updateSidebar(); updateHeader(); updateComposerActivity(); break;
    case "settings":
      settings = { safe: !!m.safe, thinking: m.thinking ?? "default", endpoint: m.endpoint ?? null, model: m.model ?? null, models: m.models ?? [] };
      if (m.prefs) { prefs = { ...prefs, ...m.prefs, collapse: { ...prefs.collapse, ...(m.prefs.collapse ?? {}) } }; applyTheme(); }
      updateHeader();
      updateComposerModel();
      break;
    case "chat.user": pushBlock({ kind: "user", text: m.message?.text ?? "", done: true }); break;
    case "chat.queue": queuedMessages = Array.isArray(m.messages) ? m.messages : []; renderComposerQueue(); break;
    case "chat.unqueued":
      queuedMessages = Array.isArray(m.messages) ? m.messages : [];
      if (textareaEl) { textareaEl.value = m.text ?? ""; textareaEl.dispatchEvent(new Event("input")); textareaEl.focus(); }
      renderComposerQueue();
      break;
    case "turn.start": current = null; if (m.status) usage = m.status; updateUsage(); updateHeader(); updateComposerActivity(); break;
    case "turn.delta": onDelta(m); break;
    case "turn.end": onTurnEnd(m); break;
    case "tool.call.start": startToolCall(m); break;
    case "tool.call.delta": appendToolCall(m); break;
    case "tool.call.end": finishToolCall(); break;
    case "tool.execute": startToolAnswer(m); break;
    case "tool.data": appendToolData(m); break;
    case "tool.result": finishTool(m); break;
    case "context":
      contextBlocks = m.blocks ?? [];
      if (Array.isArray(m.history)) { blocks = m.history; current = null; renderTranscript(); }
      if (contextViewerTarget) {
        const { messageIndex, blockIndex } = contextViewerTarget;
        const found = contextEntries().findIndex((block) => block.messageIndex === messageIndex && block.blockIndex === blockIndex);
        if (found >= 0) contextViewerIndex = found;
        contextViewerTarget = null;
      }
      renderContextViewer(contextViewerEdit);
      contextViewerEdit = false;
      break;
    case "question.open": openQuestion = { requestId: m.requestId, questions: m.questions ?? [] }; renderQuestion(); break;
    case "question.close": openQuestion = null; closeQuestion(); break;
    case "history": if (Array.isArray(m.history)) { blocks = m.history; current = null; renderTranscript(); } break;
    case "command.result": pushBlock({ kind: "command", text: m.text ?? "", done: true }); break;
    case "command.exit": ended = true; toast("Session closed"); render(); break;
    case "error": toast(m.message ?? "error", true); break;
    default: break;
  }
}

function onDelta(m) {
  const kind = m.kind === "thinking" ? "thinking" : "text";
  if (!current || current.kind !== kind) {
    current = { kind, text: "", done: false };
    blocks.push(current);
  }
  current.text += m.text ?? "";
  renderTranscript();
}

function onTurnEnd(m) {
  if (current) current.done = true;
  current = null;
  if (m.terminal?.type === "error") pushBlock({ kind: "error", text: m.terminal.error ?? "turn failed", done: true });
  renderTranscript();
  if (m.status) usage = m.status;
  updateUsage();
  updateHeader(); // busy flag (Stop button) may have changed
  updateComposerActivity();
}

/* ------------------------------------------------------------- transcript */
function pushBlock(block) { blocks.push(block); renderTranscript(); }

function toolLabel(call) {
  const name = call?.name ?? "tool";
  const args = call?.arguments ?? call?.args;
  const summary = typeof args === "string" ? args : (args ? JSON.stringify(args) : "");
  return { name, summary };
}
function startToolCall(m) { pushBlock({ kind: "tool-call", text: m.text ?? "", done: false }); }
function appendToolCall(m) {
  const block = blocks.findLast((item) => item.kind === "tool-call" && !item.done);
  if (block) { block.text += m.text ?? ""; renderTranscript(); }
}
function finishToolCall() {
  const block = blocks.findLast((item) => item.kind === "tool-call" && !item.done);
  if (block) { block.done = true; renderTranscript(); }
}
function startToolAnswer(m) { pushBlock({ kind: "tool-answer", text: toolLabel(m.call), output: "", tool: m.call, done: false }); }
function appendToolData(m) {
  const block = blocks.findLast((item) => item.kind === "tool-answer" && !item.done);
  if (block) { block.output = (block.output ?? "") + (typeof m.chunk === "string" ? m.chunk : ""); renderTranscript(); }
}
function finishTool(m) {
  const block = blocks.findLast((item) => item.kind === "tool-answer" && !item.done);
  if (block) {
    block.done = true;
    const out = resultText(m.result, m.display);
    if (out) block.output = (block.output ?? "") + out;
  } else pushBlock({ kind: "tool-answer", text: toolLabel(m.result), output: resultText(m.result, m.display), done: true });
  renderTranscript();
}
function resultText(result, display) {
  const shown = [];
  const content = result?.content;
  if (Array.isArray(content)) for (const b of content) if (b?.type === "text" && b.text) shown.push(String(b.text));
  if (Array.isArray(display)) for (const d of display) shown.push(String(d));
  return shown.join("\n");
}

/* --------------------------------------------------------------- elements */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* Persistent shell — built once, updated in place. Rebuilding the whole
 * tree on every state change resets scroll/focus and breaks the inputs, so
 * only the dynamic regions (header chips, sidebar lists, transcript) patch. */
let headerEl, sidebarEl, transcriptContainer, composerEl, textareaEl, stopBtn, sendBtn, attachmentInput, attachmentChips;

function buildShell() {
  app.replaceChildren();
  const shell = el("div", "web-shell" + (sidebarOpen ? " sidebar-open" : ""));
  sidebarEl = buildSidebar();
  const main = el("main", "conversation");
  main.addEventListener("click", (event) => {
    if (sidebarOpen && !event.target.closest(".app-header, .composer")) { sidebarOpen = false; applyShell(); }
  });
  headerEl = buildHeader();
  transcriptContainer = el("div", "transcript");
  transcriptContainer.setAttribute("role", "log");
  composerEl = buildComposer();
  main.append(headerEl, transcriptContainer, composerEl);
  shell.append(sidebarEl, main);
  app.append(shell);
}

function applyShell() {
  document.querySelector(".web-shell")?.classList.toggle("sidebar-open", sidebarOpen);
  sidebarEl?.classList.toggle("open", sidebarOpen);
}

function render() { buildShell(); renderTranscript(); updateHeader(); updateSidebar(); updateUsage(); updateComposerActivity(); }

/* ----------------------------------------------------------------- header */
function buildHeader() {
  const head = el("header", "app-header");
  const toggle = el("button", "icon-button", "☰");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Toggle conversations");
  toggle.addEventListener("click", () => { sidebarOpen = !sidebarOpen; applyShell(); });
  const brand = el("strong", null, "✦ Omoya");
  const chips = el("div", "settings-bar");
  chips.id = "settings-chips";
  const state = el("span", "connection-state");
  state.id = "connection-state";
  head.append(toggle, brand, chips, state);
  return head;
}

function aggregateAgentState() {
  const all = agentList();
  if (agent && !all.some((item) => item.id === agent.id)) all.push(agent);
  if (all.some((item) => item.state === "disconnected")) return "disconnected";
  return all.some((item) => item.state === "working" || item.busy) ? "working" : "idle";
}

function updateHeader() {
  const chips = document.querySelector("#settings-chips");
  const state = document.querySelector("#connection-state");
  if (!chips || !state) return;
  // The TUI's top-level status summarizes every live agent, while the
  // composer only follows the viewed one.
  const online = ws?.readyState === WebSocket.OPEN;
  const activity = aggregateAgentState();
  state.replaceChildren();
  const dot = el("i", `connection-dot${online ? " online" : ""} ${activity}`);
  const label = !online ? "Reconnecting" : activity === "working" ? "Working" : activity === "disconnected" ? "Disconnected" : "Connected";
  state.setAttribute("aria-label", `Connection: ${label}`);
  state.append(dot, activity === "working" && online ? statusWord(label) : document.createTextNode(label));
  // settings chips
  chips.replaceChildren();
  const safe = el("button", "chip" + (settings.safe ? " active" : ""), settings.safe ? "🔒 Read-only" : "🔓 Read/write");
  safe.type = "button";
  safe.setAttribute("aria-label", "Toggle safe (read-only) mode");
  safe.addEventListener("click", () => send({ type: "settings.safe", on: !settings.safe }));
  chips.append(safe);
  const think = el("select", "chip");
  think.setAttribute("aria-label", "Thinking level");
  for (const level of prefs.thinkingLevels) {
    const option = el("option", null, `Thinking: ${level}`);
    option.value = level;
    if (level === settings.thinking) option.selected = true;
    think.append(option);
  }
  think.addEventListener("change", () => send({ type: "settings.thinking", level: think.value }));
  chips.append(think);
  // Stop replaces Send for the viewed agent only; Enter keeps submitting.
  const viewedWorking = agent?.state === "working" || agent?.busy === true;
  if (stopBtn) stopBtn.hidden = !viewedWorking;
  if (sendBtn) sendBtn.hidden = viewedWorking;
}

/* ---------------------------------------------------------------- sidebar */
function buildSidebar() {
  const aside = el("aside", "session-sidebar");
  aside.setAttribute("aria-label", "Conversations");
  const head = el("div", "sidebar-head");
  head.append(el("h1", null, "Omoya"));
  const actions = el("div", "sidebar-actions");
  const fresh = el("button", "session-action", "+ New");
  fresh.type = "button";
  fresh.title = "Replace this agent with a new empty conversation";
  fresh.addEventListener("click", () => send({ type: "session.new" }));
  const add = el("button", "session-action", "+ Add");
  add.type = "button";
  add.title = "Add a conversation while keeping this agent open";
  add.addEventListener("click", () => send({ type: "session.add" }));
  const fork = el("button", "session-action", "⑂ Fork");
  fork.type = "button";
  fork.title = "Fork the current context into a saved branch";
  fork.addEventListener("click", () => send({ type: "session.fork" }));
  actions.append(fresh, add, fork);
  head.append(actions);
  const utilities = el("div", "sidebar-actions sidebar-utilities");
  const inspect = el("button", "session-action utility-action", "▤ Context");
  inspect.type = "button";
  inspect.addEventListener("click", () => { contextViewerOpen = true; send({ type: "context.inspect" }); });
  const tools = el("button", "session-action utility-action", "⚙ Tools");
  tools.type = "button";
  tools.addEventListener("click", renderToolDialog);
  utilities.append(inspect, tools);
  head.append(utilities);
  if (prefs.themes?.length) {
    const theme = el("select", "sidebar-theme");
    theme.setAttribute("aria-label", "Theme");
    const selectedTheme = localStorage.getItem("omoya.web.theme") ?? prefs.theme;
    for (const name of prefs.themes) { const option = el("option", null, `Theme: ${name}`); option.value = name; option.selected = name === selectedTheme; theme.append(option); }
    theme.addEventListener("change", () => { localStorage.setItem("omoya.web.theme", theme.value); applyTheme(); });
    head.append(theme);
  }
  const lists = el("div", null);
  lists.id = "sidebar-lists";
  aside.append(head, lists);
  return aside;
}

function updateSidebar() {
  const lists = document.querySelector("#sidebar-lists");
  if (!lists) return;
  lists.replaceChildren();
  const running = el("section", null);
  const runningList = el("ul", "session-tree-list");
  running.append(el("h2", null, "Running"));
  runningList.append(...sessions.agents.map((a) => sessionAgent(a, 0)));
  running.append(runningList);
  lists.append(running);
  const recent = el("section", null);
  recent.append(el("h2", null, "Recent"));
  for (const item of sessions.recent) {
    const btn = el("button", "session-item", `${item.preview || item.id} — ${item.messages ?? 0} messages`);
    btn.type = "button";
    btn.addEventListener("click", () => send({ type: "session.resume", id: item.id }));
    recent.append(btn);
  }
  lists.append(recent);
}

function sessionAgent(a, depth) {
  const item = el("li", "session-tree");
  item.style.setProperty("--tree-depth", String(depth));
  const row = el("div", "session-row" + (a.active ? " active" : ""));
  if (depth > 0) row.append(el("span", "session-branch", "↳"));
  const select = el("button", "session-item", a.name || a.id);
  select.type = "button";
  select.title = a.description || a.name || a.id;
  select.addEventListener("click", () => send({ type: "session.switch", agentId: a.id }));
  const agentState = a.state ?? (a.busy ? "working" : "idle");
  const status = el("span", "agent-status " + agentState);
  status.setAttribute("aria-label", `Status: ${agentState}`);
  status.append(agentState === "working" ? statusWord(agentState) : document.createTextNode(agentState));
  const close = el("button", "session-close", "×");
  close.type = "button";
  close.title = `Close ${a.name || a.id}`;
  close.setAttribute("aria-label", `Close ${a.name || a.id}`);
  close.addEventListener("click", () => send({ type: "session.close", agentId: a.id }));
  row.append(select, status, close);
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
function renderTranscript() {
  if (!transcriptContainer) return;
  const nearBottom = transcriptContainer.scrollHeight - transcriptContainer.scrollTop - transcriptContainer.clientHeight < 60;
  transcriptContainer.replaceChildren();
  if (!blocks.length) {
    const empty = el("div", "empty-state");
    empty.append(el("h1", null, "Omoya"), el("p", null, "Start a conversation"), el("p", "muted", agent?.session ? "This conversation is saved." : "Ghost mode is private and unlogged until you fork it."));
    transcriptContainer.append(empty);
  } else {
    transcriptContainer.append(...blocks.map(renderBlock));
  }
  if (nearBottom) transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function renderBlock(block) {
  if (block.kind === "user") {
    const node = el("div", "msg msg-user");
    node.append(el("div", "user-text", block.text), blockControls(block));
    return node;
  }
  if (block.kind === "thinking") {
    const node = el("details", "msg msg-thinking");
    node.open = prefs.collapse.thinking ? !block.done : true;
    node.append(el("summary", null, block.done ? "Thought" : "Thinking…"), markdownNode("div", "thinking-body", block.text));
    return node;
  }
  if (block.kind === "tool-call") {
    const node = el("details", "msg msg-tool msg-tool-call" + (block.done ? "" : " running"));
    node.open = prefs.collapse.tools ? !block.done : true;
    node.append(el("summary", null, `⚙ Tool call${block.done ? "" : " …"}`), markdownNode("div", "tool-output", block.text || "Waiting for tool call…"));
    return node;
  }
  if (block.kind === "tool-answer") {
    const node = el("details", "msg msg-tool msg-tool-answer" + (block.done ? "" : " running"));
    node.open = prefs.collapse.tools ? !block.done : true;
    const label = typeof block.text === "object" ? block.text : { name: block.text, summary: "" };
    node.append(el("summary", null, `↳ ${label.name || "Tool answer"}${label.summary ? ` — ${label.summary}` : ""}${block.done ? "" : " …"}`));
    if (block.output) {
      const lines = String(block.output).split("\n");
      const cap = prefs.toolLines;
      const output = lines.length > cap ? lines.slice(0, cap).join("\n") + `\n… ${lines.length - cap} more lines` : lines.join("\n");
      node.append(markdownNode("div", "tool-output", output));
    }
    return node;
  }
  if (block.kind === "error") return el("div", "msg msg-error", block.text);
  if (block.kind === "command") return el("div", "msg msg-command", block.text);
  const node = markdownNode("div", "msg msg-assistant" + (block.done ? "" : " streaming"), block.text);
  node.append(blockControls(block));
  return node;
}

function markdownNode(tag, className, source) {
  const node = el(tag, className);
  node.innerHTML = renderMarkdown(source);
  return node;
}

function blockControls(block) {
  if (!Number.isInteger(block.messageIndex) || !Number.isInteger(block.blockIndex)) return document.createDocumentFragment();
  const controls = el("div", "block-controls");
  const copy = el("button", "block-icon", "⧉");
  copy.type = "button"; copy.title = "Copy message"; copy.setAttribute("aria-label", copy.title);
  copy.addEventListener("click", () => copyBlock(block));
  const view = el("button", "block-icon", "⌕");
  view.type = "button"; view.title = "View in context"; view.setAttribute("aria-label", view.title);
  view.addEventListener("click", () => openContextBlock(block.messageIndex, block.blockIndex));
  controls.append(copy, view);
  if (block.editable) {
    const edit = el("button", "block-icon", "✎");
    edit.type = "button"; edit.title = "Edit context block"; edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => openContextBlock(block.messageIndex, block.blockIndex, true));
    controls.append(edit);
  }
  const remove = el("button", "block-icon block-delete", "⌫");
  remove.type = "button"; remove.title = "Delete message"; remove.setAttribute("aria-label", remove.title);
  remove.addEventListener("click", () => deleteContextMessages([block.messageIndex]));
  controls.append(remove);
  return controls;
}

async function copyBlock(block) {
  try { await navigator.clipboard.writeText(String(block.text ?? block.output ?? "")); toast("Copied"); }
  catch { toast("Could not copy this message", true); }
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
  const wrap = el("div", "composer-input");
  textareaEl = el("textarea");
  textareaEl.rows = 1;
  textareaEl.placeholder = "Message Omoya…  (/ for commands)";
  textareaEl.setAttribute("aria-label", "Message");
  const acList = el("ul", "autocomplete");
  acList.id = "autocomplete";
  acList.hidden = true;
  acList.setAttribute("role", "listbox");
  textareaEl.setAttribute("aria-controls", "autocomplete");
  textareaEl.setAttribute("aria-expanded", "false");
  wrap.append(textareaEl, acList);
  attachmentChips = el("div", "attachment-chips");
  attachmentChips.setAttribute("aria-live", "polite");
  attachmentInput = el("input", "attachment-picker");
  attachmentInput.type = "file"; attachmentInput.multiple = true; attachmentInput.hidden = true;
  attachmentInput.addEventListener("change", () => addFiles(attachmentInput.files));
  const actions = el("div", "composer-actions");
  const attach = el("button", "composer-attach", "＋ File");
  attach.type = "button"; attach.addEventListener("click", () => attachmentInput.click());
  stopBtn = el("button", "composer-stop", "■ Stop");
  stopBtn.type = "button";
  stopBtn.hidden = !(agent?.busy);
  stopBtn.addEventListener("click", () => send({ type: "chat.cancel" }));
  sendBtn = el("button", "composer-send", "➤ Send");
  sendBtn.type = "submit";
  sendBtn.hidden = agent?.state === "working" || agent?.busy === true;
  actions.append(attach, stopBtn, sendBtn);
  const modelRow = el("div", "composer-model-row");
  modelRow.id = "composer-model-row";
  const queue = el("div", "composer-queue"); queue.id = "composer-queue";
  const status = el("div", "usage-status");
  status.id = "usage-status";
  form.append(wrap, attachmentInput, attachmentChips, actions, modelRow, queue, status);
  form.addEventListener("dragover", (event) => { event.preventDefault(); form.classList.add("drop-target"); });
  form.addEventListener("dragleave", () => form.classList.remove("drop-target"));
  form.addEventListener("drop", (event) => { event.preventDefault(); form.classList.remove("drop-target"); addFiles(event.dataTransfer?.files); });
  renderComposerQueue();

  const auto = () => { textareaEl.style.height = "auto"; textareaEl.style.height = Math.min(textareaEl.scrollHeight, 8 * 24) + "px"; };
  textareaEl.addEventListener("input", () => { auto(); updateAutocomplete(); });
  textareaEl.addEventListener("keydown", (e) => autocompleteKey(e) || (e.key === "Enter" && !e.shiftKey && !acOpen() && (e.preventDefault(), form.requestSubmit())));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = textareaEl.value.trim();
    if (!text && !draftAttachments.length) return;
    if (text.startsWith("/") && draftAttachments.length) { toast("Commands cannot include attachments", true); return; }
    send({ type: "chat.submit", text, ...(draftAttachments.length ? { attachments: draftAttachments.map((file) => file.id) } : {}) });
    draftAttachments = []; renderAttachmentChips();
    textareaEl.value = "";
    auto();
    hideAutocomplete();
  });
  setTimeout(() => textareaEl.focus(), 0);
  return form;
}

async function addFiles(files) {
  for (const file of [...(files ?? [])]) {
    if (!uploadKey) { toast("Upload connection is not ready", true); break; }
    if (draftAttachments.length >= 10) { toast("At most 10 attachments", true); break; }
    const form = new FormData(); form.append("file", file, file.name);
    try {
      const response = await fetch("/upload", { method: "POST", headers: { "X-Omoya-Upload": uploadKey }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "upload failed");
      draftAttachments.push(result); renderAttachmentChips();
    } catch (error) { toast(error?.message ?? "upload failed", true); }
  }
  if (attachmentInput) attachmentInput.value = "";
}
function renderAttachmentChips() {
  if (!attachmentChips) return;
  attachmentChips.replaceChildren();
  for (const [index, file] of draftAttachments.entries()) {
    const chip = el("span", "attachment-chip");
    chip.append(el("span", null, `${file.name} (${Math.ceil(file.size / 1024)} KB)`));
    const remove = el("button", "attachment-remove", "×");
    remove.type = "button"; remove.title = `Remove ${file.name}`; remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => { draftAttachments.splice(index, 1); renderAttachmentChips(); });
    chip.append(remove); attachmentChips.append(chip);
  }
}

/* ----------------------------------------------------------- autocomplete */
const acListEl = () => document.querySelector("#autocomplete");
let acItems = [];
let acIndex = -1;

const acOpen = () => acItems.length > 0;

function allSlash() {
  const promptNames = catalog.prompts.map((p) => (p.startsWith("/") ? p : `/${p}`));
  return [...catalog.commands, ...promptNames, ...catalog.tools];
}

function updateAutocomplete() {
  hideAutocomplete();
  if (!prefs.autocomplete) return;
  const value = textareaEl.value;
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return;
  const query = value.toLowerCase();
  acItems = allSlash().filter((c) => c.toLowerCase().startsWith(query)).slice(0, 12);
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
    const btn = el("button", i === acIndex ? "active" : "", item);
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); pickAutocomplete(i); });
    li.append(btn);
    list.append(li);
  });
}

function hideAutocomplete() { acItems = []; acIndex = -1; const list = acListEl(); if (list) list.hidden = true; textareaEl?.setAttribute("aria-expanded", "false"); }

function pickAutocomplete(i) {
  const item = acItems[i];
  if (item === undefined) return;
  textareaEl.value = item + " ";
  hideAutocomplete();
  textareaEl.focus();
  textareaEl.dispatchEvent(new Event("input"));
}

function autocompleteKey(e) {
  if (!acOpen()) return false;
  if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; drawAutocomplete(); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; drawAutocomplete(); return true; }
  if (e.key === "Tab" || (e.key === "Enter" && acIndex >= 0)) { e.preventDefault(); pickAutocomplete(acIndex); return true; }
  if (e.key === "Escape") { e.preventDefault(); hideAutocomplete(); return true; }
  return false;
}

/* --------------------------------------------------------------- question */
function renderQuestion() {
  closeQuestion();
  if (!openQuestion) return;
  const cover = el("div", "question-overlay");
  cover.id = "question-overlay";
  const dialog = el("div", "question-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  for (const q of openQuestion.questions) {
    const section = el("section");
    section.append(el("h3", null, q.header ?? "Question"), el("p", null, q.question ?? ""));
    if (q.details) section.append(el("p", "question-details", q.details));
    const list = el("div", "question-options");
    list.setAttribute("role", q.multiSelect ? "group" : "radiogroup");
    for (const option of q.options ?? []) {
      const btn = el("button", "question-option", option.label ?? "");
      btn.type = "button";
      btn.dataset.label = option.label ?? "";
      btn.title = option.description ?? "";
      btn.setAttribute("aria-label", [option.label, option.description, option.preview ? "Preview available" : ""].filter(Boolean).join(" — "));
      if (!q.multiSelect) btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.append(el("span", "question-option-description", option.description ?? ""));
      if (option.preview !== undefined) {
        const preview = typeof option.preview === "string" ? { type: "text", content: option.preview } : option.preview;
        const detail = el("span", "question-preview", preview?.content ?? "");
        detail.dataset.type = preview?.type === "code" ? "code" : "text";
        if (preview?.title) detail.dataset.title = preview.title;
        btn.append(detail);
      }
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          btn.classList.toggle("selected");
          btn.setAttribute("aria-checked", String(btn.classList.contains("selected")));
        } else {
          list.querySelectorAll(".question-option").forEach((button) => {
            const selected = button === btn;
            button.classList.toggle("selected", selected);
            button.setAttribute("aria-checked", String(selected));
          });
        }
      });
      list.append(btn);
    }
    section.append(list);
    dialog.append(section);
  }
  const actions = el("div", "question-actions");
  const submit = el("button", "question-submit", "Submit answers");
  submit.type = "button";
  submit.addEventListener("click", () => {
    const answers = [...dialog.querySelectorAll(".question-options")].map((list) => ({ labels: [...list.querySelectorAll(".question-option.selected")].map((button) => button.dataset.label) }));
    send({ type: "question.answer", requestId: openQuestion.requestId, answers });
    openQuestion = null;
    closeQuestion();
  });
  const dismiss = el("button", "question-dismiss", "Dismiss");
  dismiss.type = "button";
  dismiss.addEventListener("click", () => {
    send({ type: "question.answer", requestId: openQuestion.requestId, answers: null });
    openQuestion = null;
    closeQuestion();
  });
  actions.append(submit, dismiss);
  dialog.append(actions);
  cover.append(dialog);
  document.body.append(cover);
}
function closeQuestion() { document.querySelector("#question-overlay")?.remove(); }

/* ------------------------------------------------------------------ toast */
function toast(text, isError = false) {
  const node = el("div", "toast" + (isError ? " toast-error" : ""), String(text));
  (isError ? errors : toasts).append(node);
  setTimeout(() => node.remove(), 6000);
}

/* ------------------------------------------------------------------ theme */
const dark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const saved = localStorage.getItem("omoya.web.theme");
  const preferred = saved && prefs.themes?.includes(saved) ? saved : prefs.theme;
  const mode = preferred === "system" ? (dark.matches ? "dark" : "light") : preferred;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = prefs.themes?.includes(mode) ? mode : "";
}

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
// planPercentText (lib/tui-app/status-data.js) so both surfaces read the
// same data, most important quota first (see sortedQuotaEntries) —
// rounded to whole percent here, matching this surface's own
// context-percentage convention (updateUsage's Math.round below), not
// tui-app's one-decimal style: `plan: 5h 2% · 7d 12%`, or "" when no
// quota sizes a percentage (e.g. a currency balance, which has no total).
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

// Mirrors lib/tui-app/status-data.js's humanDuration/resetCountdown (see
// that file for the fuller rationale). windowSeconds itself isn't used
// directly here — it only ever fed the quota's own name (e.g. "5h") —
// but the reset TIMESTAMP it rides alongside is what makes a live
// countdown possible at all.
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

// The compact line only has room for a percentage; the reset countdown
// (and raw counts) live in this hover tooltip instead of crowding it —
// most important quota first (see sortedQuotaEntries).
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

function updateUsage() {
  const node = document.querySelector("#usage-status");
  if (!node) return;
  const used = Number(usage.used ?? 0);
  const available = Number(usage.available ?? 0);
  const percent = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : null;
  const plan = planPercentText(usage.plan);
  node.textContent = `${used.toLocaleString()}/${available ? available.toLocaleString() : "—"}${percent === null ? "" : ` (${percent}%)`}${plan ? ` · ${plan}` : ""}`;
  node.title = planTooltipText(usage.plan);
}

function updateComposerActivity() {
  composerEl?.classList.toggle("working", agent?.state === "working" || agent?.busy === true);
}

function updateComposerModel() {
  const row = document.querySelector("#composer-model-row");
  if (!row) return;
  row.replaceChildren();
  if (!settings.models.length) return;
  const model = el("select", "composer-model");
  model.setAttribute("aria-label", "Model");
  const selected = settings.endpoint ? `${settings.endpoint}/${settings.model ?? ""}` : null;
  for (const id of settings.models) { const option = el("option", null, id); option.value = id; option.selected = id === selected; model.append(option); }
  model.addEventListener("change", () => send({ type: "settings.model", model: model.value }));
  row.append(el("span", "composer-model-label", "Model"), model);
}

function renderComposerQueue() {
  const node = document.querySelector("#composer-queue");
  if (!node) return;
  node.replaceChildren();
  if (!queuedMessages.length) return;
  const text = queuedMessages.length === 1 ? "1 message queued" : `${queuedMessages.length} messages queued`;
  const recall = el("button", "composer-unqueue", `Edit ${text}`);
  recall.type = "button";
  recall.title = "Remove queued messages and put them back in the editor";
  recall.addEventListener("click", () => send({ type: "chat.unqueue" }));
  node.append(recall, el("span", "composer-queue-preview", queuedMessages[0]));
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
  if (!event.altKey || !event.ctrlKey || event.shiftKey || event.metaKey) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp") {
    event.preventDefault();
    if (event.key === "ArrowUp") navigateParentAgent();
    else navigateAgent(event.key === "ArrowRight" ? 1 : -1);
  }
});

function contextEntries() {
  return contextBlocks.flatMap((message) => (message.content ?? []).map((block) => ({ ...block, source: block.text ?? JSON.stringify(block.data) })));
}

function filteredContextEntries(entries) {
  let pattern;
  try { pattern = contextViewerSearch ? new RegExp(contextViewerSearch, "i") : null; } catch { return { entries: [], error: "Enter a valid regular expression." }; }
  return { entries: entries.filter((block) => (!contextViewerTypes.size || contextViewerTypes.has(block.viewerType)) && (!pattern || pattern.test(`${block.viewerType}\n${block.source}`))), error: null };
}

function openContextBlock(messageIndex, blockIndex, edit = false) {
  contextViewerOpen = true;
  contextViewerTarget = { messageIndex, blockIndex };
  contextViewerSearch = "";
  contextViewerTypes.clear();
  contextViewerSelections.clear();
  contextViewerEdit = edit;
  send({ type: "context.inspect" });
}

function renderContextViewer(openEdit = false) {
  document.querySelector("#context-viewer")?.remove();
  if (!contextViewerOpen) return;
  const allEntries = contextEntries();
  const { entries, error } = filteredContextEntries(allEntries);
  contextViewerIndex = Math.max(0, Math.min(contextViewerIndex, Math.max(0, entries.length - 1)));
  const dialog = el("section", "context-viewer"); dialog.id = "context-viewer"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Context viewer");
  const head = el("header", "context-viewer-head");
  const search = el("input"); search.type = "search"; search.placeholder = "RegExp search all blocks"; search.value = contextViewerSearch; search.setAttribute("aria-label", "Search all context blocks with a regular expression");
  search.addEventListener("input", () => { contextViewerSearch = search.value; contextViewerIndex = 0; renderContextViewer(); });
  const close = el("button", "chip", "Close"); close.type = "button"; close.addEventListener("click", () => { contextViewerOpen = false; renderContextViewer(); }); head.append(el("h2", null, "Context blocks"), search, close);
  const filters = el("fieldset", "context-filters"); filters.append(el("legend", null, "Block types"));
  for (const type of ["system", "user", "thinking", "assistant", "tool call", "tool answer", "tool display"]) {
    const label = el("label"); const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = contextViewerTypes.has(type); checkbox.addEventListener("change", () => { checkbox.checked ? contextViewerTypes.add(type) : contextViewerTypes.delete(type); contextViewerIndex = 0; renderContextViewer(); }); label.append(checkbox, document.createTextNode(type)); filters.append(label);
  }
  const bulk = el("div", "context-bulk-actions");
  const deleteSelected = el("button", "chip block-delete", "Delete selected"); deleteSelected.type = "button"; deleteSelected.disabled = contextViewerSelections.size === 0; deleteSelected.addEventListener("click", () => deleteContextMessages([...contextViewerSelections]));
  bulk.append(deleteSelected);
  const navigation = el("div", "context-navigation");
  const previous = el("button", "chip", "← Previous"); previous.type = "button"; previous.disabled = contextViewerIndex === 0; previous.addEventListener("click", () => { contextViewerIndex--; renderContextViewer(); });
  const index = el("input", "context-index"); index.type = "number"; index.min = "1"; index.max = String(entries.length); index.value = String(contextViewerIndex + 1); index.setAttribute("aria-label", "Context block index");
  index.addEventListener("change", () => { const value = Number.parseInt(index.value, 10); if (Number.isInteger(value)) { contextViewerIndex = Math.max(0, Math.min(entries.length - 1, value - 1)); renderContextViewer(); } });
  const next = el("button", "chip", "Next →"); next.type = "button"; next.disabled = contextViewerIndex >= entries.length - 1; next.addEventListener("click", () => { contextViewerIndex++; renderContextViewer(); });
  navigation.append(previous, index, el("span", "context-page-count", `/${entries.length}`), next);
  const list = el("div", "context-block-list");
  if (error || !entries.length) list.append(el("p", "muted", error ?? "No context blocks match the current filters."));
  else {
    const block = entries[contextViewerIndex]; const card = el("article", "context-block");
    const meta = el("header", "context-block-meta"); const select = el("input"); select.type = "checkbox"; select.checked = contextViewerSelections.has(block.messageIndex); select.setAttribute("aria-label", `Select message ${block.messageIndex + 1}`); select.addEventListener("change", () => { select.checked ? contextViewerSelections.add(block.messageIndex) : contextViewerSelections.delete(block.messageIndex); renderContextViewer(); });
    meta.append(select, el("strong", "context-block-type", block.viewerType), el("small", null, `Message ${block.messageIndex + 1}, block ${block.blockIndex + 1}`)); card.append(meta);
    if (block.viewerType === "thinking" || block.viewerType === "assistant" || block.viewerType === "tool answer" || block.viewerType === "tool display") card.append(markdownNode("div", "context-markdown", block.source));
    else card.append(el("pre", null, block.source));
    const actions = el("div", "block-controls"); const copy = el("button", "block-icon", "⧉"); copy.type = "button"; copy.title = "Copy message"; copy.setAttribute("aria-label", copy.title); copy.addEventListener("click", () => copyBlock(block)); actions.append(copy);
    if (typeof block.text === "string" && block.viewerType !== "tool display") { const edit = el("button", "block-icon", "✎"); edit.type = "button"; edit.title = "Edit context block"; edit.setAttribute("aria-label", edit.title); edit.addEventListener("click", () => { const text = prompt("Edit context block", block.text); if (text !== null) send({ type: "context.edit-text", messageIndex: block.messageIndex, blockIndex: block.blockIndex, text }); }); actions.append(edit); if (openEdit) setTimeout(() => edit.click(), 0); }
    const remove = el("button", "block-icon block-delete", "⌫"); remove.type = "button"; remove.title = "Delete message"; remove.setAttribute("aria-label", remove.title); remove.addEventListener("click", () => deleteContextMessages([block.messageIndex])); actions.append(remove); card.append(actions);
    list.append(card);
  }
  dialog.append(head, filters, bulk, navigation, list); document.body.append(dialog);
}

function renderToolDialog() {
  const prior = document.querySelector("#tool-dialog"); if (prior) return prior.remove();
  const dialog = el("section", "context-viewer"); dialog.id = "tool-dialog"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Run a tool");
  const select = el("select"); for (const schema of catalog.toolSchemas) { const option = el("option", null, schema.name); option.value = schema.name; select.append(option); }
  const description = el("p", "tool-schema-description");
  const schemaView = el("pre", "tool-schema-view");
  const form = el("form", "tool-schema-form");
  const args = el("textarea"); args.placeholder = "JSON arguments (default {})"; args.setAttribute("aria-label", "Tool JSON arguments");
  const selectedSchema = () => catalog.toolSchemas.find((schema) => schema.name === select.value) ?? {};
  const update = () => {
    const schema = selectedSchema();
    description.textContent = schema.description ?? "";
    schemaView.textContent = JSON.stringify(schema.inputSchema ?? schema.schema ?? {}, null, 2);
    form.replaceChildren();
    const inputSchema = schema.inputSchema ?? schema.schema ?? {};
    for (const [name, property] of Object.entries(inputSchema.properties ?? {})) {
      const field = el("label", "tool-field");
      const label = `${name}${(inputSchema.required ?? []).includes(name) ? " *" : ""}`;
      const input = property.enum ? el("select") : el(property.type === "boolean" ? "input" : "input");
      input.name = name;
      if (property.enum) for (const value of property.enum) { const option = el("option", null, String(value)); option.value = String(value); input.append(option); }
      else if (property.type === "boolean") { input.type = "checkbox"; }
      else { input.type = property.type === "number" || property.type === "integer" ? "number" : "text"; }
      input.addEventListener("input", () => { const value = {}; for (const control of form.querySelectorAll("[name]")) { if (control.type === "checkbox") value[control.name] = control.checked; else if (control.value !== "") value[control.name] = control.type === "number" ? Number(control.value) : control.value; } args.value = JSON.stringify(value, null, 2); });
      field.append(el("span", null, label), input); if (property.description) field.append(el("small", null, property.description)); form.append(field);
    }
  };
  select.addEventListener("change", update); update();
  const run = el("button", "composer-send", "Run tool"); run.type = "button"; run.addEventListener("click", () => { try { send({ type: "tool.call", name: select.value, args: args.value.trim() ? JSON.parse(args.value) : {} }); dialog.remove(); } catch { toast("Arguments must be valid JSON", true); } }); const close = el("button", "chip", "Close"); close.type = "button"; close.addEventListener("click", () => dialog.remove()); dialog.append(el("h2", null, "Run a tool"), select, description, el("h3", null, "Schema"), schemaView, form, el("label", null, "JSON arguments"), args, run, close); document.body.append(dialog);
}
dark.addEventListener("change", applyTheme);
applyTheme();

/* ------------------------------------------------------------------- boot */
connect();
render();
})();
