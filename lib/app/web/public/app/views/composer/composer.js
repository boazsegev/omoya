import { composerDraft, autofit, noteComposerInput, recallHistory } from "./history.js";
import { composerRefs } from "./refs.js";
import { el, button, toast } from "../../dom.js";
/** composer.js — Message entry, attachments, queued messages, and slash autocomplete. */
import { state } from "../../state.js";
export { composerRefs } from "./refs.js";
import { formatBytes, settingChips } from "../../../format.js";
import { isFirstComposerWrite } from "../../logic/composer-scroll.js";
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
  composerRefs.attachmentChips = el("div", "attachment-chips");
  composerRefs.attachmentChips.setAttribute("aria-live", "polite");
  const wrap = el("div", "composer-input");
  composerRefs.textareaEl = el("textarea");
  composerRefs.textareaEl.rows = 1;
  composerRefs.textareaEl.placeholder = "Message Omoya…";
  composerRefs.textareaEl.setAttribute("aria-label", "Message");
  composerRefs.textareaEl.spellcheck = true;
  // The working draft survives a rebuild; nothing else may reseed the box.
  composerRefs.textareaEl.value = composerDraft().text;
  // Rebuilding while browsing history (agent switch, hello) leaves the
  // session pointing at a recalled entry — drop back to the working draft.
  composerDraft().historyIndex = null; composerDraft().historyDraft = null;
  composerRefs.ghostEl = el("div", "composer-ghost");
  composerRefs.ghostEl.setAttribute("aria-hidden", "true");
  const acList = el("ul", "autocomplete");
  acList.id = "autocomplete";
  acList.hidden = true;
  acList.setAttribute("role", "listbox");
  composerRefs.textareaEl.setAttribute("aria-controls", "autocomplete");
  composerRefs.textareaEl.setAttribute("aria-expanded", "false");
  composerRefs.textareaEl.setAttribute("aria-autocomplete", "list");
  wrap.append(composerRefs.ghostEl, composerRefs.textareaEl, acList);
  composerRefs.attachmentInput = el("input", "attachment-picker");
  composerRefs.attachmentInput.type = "file"; composerRefs.attachmentInput.multiple = true; composerRefs.attachmentInput.hidden = true;
  composerRefs.attachmentInput.addEventListener("change", () => addFiles(composerRefs.attachmentInput.files));
  const toolbar = el("div", "composer-toolbar");
  const left = el("div", "toolbar-group");
  left.id = "composer-tools";
  const right = el("div", "toolbar-group toolbar-end");
  const meter = el("button", "context-meter");
  meter.type = "button"; meter.id = "usage-status";
  meter.addEventListener("click", () => emit("viewer.open"));
  composerRefs.stopBtn = button("composer-stop", null, () => emit("server", { type: "chat.cancel" }), { title: "Stop (Esc)", icon: "■" });
  composerRefs.stopBtn.hidden = !(state.agent?.busy);
  composerRefs.sendBtn = button("composer-send", null, null, { title: "Send (Enter)", icon: "↑", type: "submit" });
  composerRefs.sendBtn.hidden = state.agent?.state === "working" || state.agent?.busy === true;
  right.append(meter, composerRefs.stopBtn, composerRefs.sendBtn);
  toolbar.append(left, right);
  form.append(queue, composerRefs.attachmentChips, wrap, composerRefs.attachmentInput, toolbar);
  form.addEventListener("dragover", (event) => { event.preventDefault(); form.classList.add("drop-target"); });
  form.addEventListener("dragleave", (event) => { if (!form.contains(event.relatedTarget)) form.classList.remove("drop-target"); });
  form.addEventListener("drop", (event) => { event.preventDefault(); form.classList.remove("drop-target"); addFiles(event.dataTransfer?.files); });
  composerRefs.textareaEl.addEventListener("paste", (event) => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
  emit("composer.queue");
  renderAttachmentChips();

  composerRefs.textareaEl.addEventListener("input", () => { const firstWrite = isFirstComposerWrite(composerDraft().text, composerRefs.textareaEl.value); noteComposerInput(); autofit(firstWrite); updateAutocomplete(); updateGhost(); });
  composerRefs.textareaEl.addEventListener("blur", () => setTimeout(hideAutocomplete, 120));
  composerRefs.textareaEl.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (autocompleteKey(e)) return;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && recallHistory(e.key === "ArrowUp" ? -1 : 1)) { e.preventDefault(); updateGhost(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !acOpen()) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = composerRefs.textareaEl.value;
    const text = raw.trim();
    // Whitespace-only input is a continue (TUI parity): re-activate the
    // agent over its context without appending a message.
    if (!text && !state.draftAttachments.length) { if (raw.length && !(state.agent?.busy)) { emit("server", { type: "chat.continue" }); composerRefs.textareaEl.value = ""; autofit(); } return; }
    if (text.startsWith("/") && state.draftAttachments.length) { toast("Commands cannot include attachments", true); return; }
    if (text === "/menu") { clearComposer(); emit("palette.open"); return; }
    emit("server", { type: "chat.submit", text, ...(state.draftAttachments.length ? { attachments: state.draftAttachments.map((file) => file.id) } : {}) });
    const draft = composerDraft();
    if (text && !text.startsWith("/")) draft.submitted.push(text);
    clearComposer();
  });
  queueMicrotask(() => { autofit(); updateGhost(); if (!matchMedia("(pointer: coarse)").matches) composerRefs.textareaEl.focus(); });
  return form;
}

/**
 * Load text (an expanded /<prompt>) into the composer for review/editing —
 * replaces the input like the TUI's fill, caret at the end.
 * @param {string} text
 * @returns {void}
 */
function fillComposer(text) {
  if (!composerRefs.textareaEl) return;
  composerRefs.textareaEl.value = text;
  noteComposerInput(); autofit(); updateGhost();
  composerRefs.textareaEl.focus();
  composerRefs.textareaEl.setSelectionRange(text.length, text.length);
}

/**
 * Empty the composer: clear the draft, attachments, autocomplete, and ghost.
 * @returns {void}
 */
function clearComposer() {
  const draft = composerDraft();
  draft.text = ""; draft.attachments = []; draft.historyIndex = null; draft.historyDraft = null;
  state.draftAttachments = []; renderAttachmentChips();
  composerRefs.textareaEl.value = "";
  autofit(); hideAutocomplete(); updateGhost();
}

/**
 * Insert text into the composer (appended to existing text unless `replace`).
 * @param {string} text
 * @param {boolean} [replace=false]
 * @returns {void}
 */
function insertComposer(text, replace = false) {
  if (!composerRefs.textareaEl) return;
  composerRefs.textareaEl.value = replace || !composerRefs.textareaEl.value ? text : `${composerRefs.textareaEl.value.replace(/\s*$/, " ")}${text}`;
  noteComposerInput(); autofit(); updateGhost();
  composerRefs.textareaEl.focus();
  composerRefs.textareaEl.setSelectionRange(composerRefs.textareaEl.value.length, composerRefs.textareaEl.value.length);
}

/**
 * Dim argument hint after a complete command (TUI ghost text).
 * @returns {void}
 */
function updateGhost() {
  if (!composerRefs.ghostEl || !composerRefs.textareaEl) return;
  const value = composerRefs.textareaEl.value;
  const match = value.match(/^(\/\S+) ?$/);
  const hint = match ? state.catalog.hints?.[match[1]] : null;
  composerRefs.ghostEl.replaceChildren();
  if (!hint) return;
  composerRefs.ghostEl.append(el("span", "ghost-typed", value.endsWith(" ") ? value : `${value} `), el("span", "ghost-hint", hint));
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
  const key = state.uploadKey;
  for (const file of [...(files ?? [])]) {
    if (!key) { toast("Upload connection is not ready", true); break; }
    if (state.draftAttachments.length >= 10) { toast("At most 10 attachments", true); break; }
    const form = new FormData(); form.append("file", file, file.name);
    const pending = { id: `pending-${Math.random()}`, name: file.name, size: file.size, pending: true };
    state.draftAttachments.push(pending); renderAttachmentChips();
    try {
      const response = await fetch("./upload", { method: "POST", headers: { "X-Omoya-Upload": key }, body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "upload failed");
      state.draftAttachments = state.draftAttachments.filter((item) => item !== pending);
      if (key !== state.uploadKey) continue; // Reconnect invalidated this opaque upload ID.
      draft.attachments.push(result);
      if (composerDraft() === draft) state.draftAttachments = [...draft.attachments];
    } catch (error) {
      state.draftAttachments = state.draftAttachments.filter((item) => item !== pending);
      toast(error?.message ?? "upload failed", true);
    }
    renderAttachmentChips();
  }
  if (composerRefs.attachmentInput) composerRefs.attachmentInput.value = "";
}
/**
 * Repaint the attachment chips (pending uploads show "uploading…" and no remove button).
 * @returns {void}
 */
function renderAttachmentChips() {
  if (!composerRefs.attachmentChips) return;
  composerRefs.attachmentChips.replaceChildren();
  for (const [index, file] of state.draftAttachments.entries()) {
    const chip = el("span", "attachment-chip" + (file.pending ? " pending" : ""));
    chip.append(el("span", null, `📎 ${file.name} · ${file.pending ? "uploading…" : formatBytes(file.size)}`));
    if (!file.pending) chip.append(button("attachment-remove", null, () => { state.draftAttachments.splice(index, 1); composerDraft().attachments = state.draftAttachments.filter((f) => !f.pending); renderAttachmentChips(); }, { title: `Remove ${file.name}`, icon: "×" }));
    composerRefs.attachmentChips.append(chip);
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
  tools.append(button("tool-chip icon-only", null, () => composerRefs.attachmentInput.click(), { title: "Attach files (or drop / paste them)", icon: "📎" }));
  // Wording, state, and order come from the shared settingChips (the TUI
  // status toolbar shows the same chips); this toolbar owns the click
  // behavior per chip key.
  const chips = settingChips({
    endpoint: state.settings.endpoint, model: state.settings.model, thinking: state.settings.thinking, safe: state.settings.safe,
    sessionSave: state.settings.sessionSave === true,
  });
  const byKey = Object.fromEntries(chips.map((chip) => [chip.key, chip]));
  const behavior = {
    endpoint: { run: () => emit("endpoint.open"), extra: " model-chip" },
    model: { run: () => emit("model.open"), extra: " model-chip" },
    thinking: { run: (event) => emit("menu.open", [event.currentTarget, state.prefs.thinkingLevels.map((level) => ({ label: level, detail: level === "default" ? "provider default" : "", current: level === state.settings.thinking, run: () => emit("server", { type: "settings.thinking", level }) }))]) },
    safe: { run: () => emit("server", { type: "settings.safe", on: !state.settings.safe }) },
    logging: { run: () => emit("server", { type: "settings.session-save", on: !byKey.logging.pressed }) },
  };
  for (const chip of chips) {
    const { run, extra = "" } = behavior[chip.key] ?? {};
    const node = button("tool-chip" + extra + (chip.active ? " active" : "") + (chip.warn ? " warn" : ""), chip.label, run, { title: `${chip.title} — click to ${chip.action}`, icon: chip.icon });
    if (chip.pressed !== undefined) node.setAttribute("aria-pressed", String(chip.pressed));
    tools.append(node);
  }
}

/* ----------------------------------------------------------- autocomplete */

/**
 * The autocomplete list element.
 * @returns {HTMLElement|null}
 */
const acListEl = () => document.querySelector("#autocomplete");
/**
 * Whether the autocomplete popup has candidates.
 * @returns {boolean}
 */
const acOpen = () => state.acItems.length > 0;

/**
 * First line of a /tool-… command's description, from the tool schemas catalog.
 * @param {string} name - slash command, e.g. "/tool-bash".
 * @returns {string}
 */
function toolDescription(name) { return String(state.catalog.toolSchemas.find((schema) => `/tool-${schema.name}` === name)?.description ?? "").split("\n")[0]; }
/**
 * All slash candidates: commands, prompts, and /tool-… entries.
 * @returns {Array<{value: string, detail: string}>}
 */
function allSlash() {
  const promptNames = state.catalog.prompts.map((p) => ({ value: p.startsWith("/") ? p : `/${p}`, detail: "prompt" }));
  return [
    ...state.catalog.commands.map((value) => ({ value, detail: state.catalog.hints?.[value] ?? "" })),
    ...promptNames,
    ...state.catalog.tools.map((value) => ({ value, detail: toolDescription(value) })),
  ];
}

/**
 * Argument candidates for commands whose arguments come from live state.
 * @param {string} command - e.g. "/endpoint-model".
 * @returns {string[]|null} candidates, or null when the command has none.
 */
function argumentSource(command) {
  switch (command) {
    case "/endpoint-model": return state.settings.models;
    // The command runs in the viewed agent's project: offer only its sessions.
    case "/session-resume": return ["latest", ...state.sessions.recent.filter((item) => !item.project || item.project === state.agent?.project).map((item) => item.id)];
    case "/agent-thinking": return state.prefs.thinkingLevels;
    case "/agent-safe": return ["on", "off"];
    case "/agent-session-save": return ["true", "false"];
    case "/endpoint-logout": return state.endpoints.removable;
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
  if (!state.prefs.autocomplete || !composerRefs.textareaEl) return;
  const value = composerRefs.textareaEl.value;
  if (!value.startsWith("/") || value.includes("\n")) return;
  const argMatch = value.match(/^(\/\S+)\s+(\S*)$/);
  if (argMatch) {
    const source = argumentSource(argMatch[1]);
    if (!source) return;
    const query = argMatch[2].toLowerCase();
    state.acItems = source.filter((item) => item.toLowerCase().includes(query) && item !== argMatch[2]).slice(0, 12).map((item) => ({ value: item, detail: "" }));
    state.acArg = true;
  } else {
    if (value.includes(" ")) return;
    const query = value.toLowerCase();
    const all = allSlash();
    const starts = all.filter((c) => c.value.toLowerCase().startsWith(query));
    const contains = all.filter((c) => !starts.includes(c) && c.value.toLowerCase().includes(query.slice(1)));
    state.acItems = [...starts, ...contains].slice(0, 14);
    state.acArg = false;
  }
  state.acIndex = state.acItems.length ? 0 : -1;
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
  if (!state.acItems.length) { list.hidden = true; composerRefs.textareaEl?.setAttribute("aria-expanded", "false"); return; }
  list.hidden = false;
  composerRefs.textareaEl?.setAttribute("aria-expanded", "true");
  state.acItems.forEach((item, i) => {
    const li = el("li");
    const btn = el("button", i === state.acIndex ? "active" : "");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(i === state.acIndex));
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
function hideAutocomplete() { state.acItems = []; state.acIndex = -1; const list = acListEl(); if (list) list.hidden = true; composerRefs.textareaEl?.setAttribute("aria-expanded", "false"); }

/**
 * Accept autocomplete candidate `i`: replace the token (or last argument when
 * completing an argument) and chain into argument candidates.
 * @param {number} i - index into `acItems`.
 * @returns {void}
 */
function pickAutocomplete(i) {
  const item = state.acItems[i];
  if (item === undefined) return;
  composerRefs.textareaEl.value = state.acArg ? composerRefs.textareaEl.value.replace(/\S*$/, item.value) : item.value + " ";
  hideAutocomplete();
  composerRefs.textareaEl.focus();
  noteComposerInput(); autofit(); updateGhost();
  if (!state.acArg) updateAutocomplete(); // chain into argument candidates
}

/**
 * Keyboard handling for the autocomplete popup: arrows cycle, Tab/Enter accept,
 * Esc closes. Enter on an exact command match submits instead of re-completing.
 * @param {KeyboardEvent} e
 * @returns {boolean} true when the key was consumed.
 */
function autocompleteKey(e) {
  if (!acOpen()) return false;
  if (e.key === "ArrowDown") { e.preventDefault(); state.acIndex = (state.acIndex + 1) % state.acItems.length; drawAutocomplete(); return true; }
  if (e.key === "ArrowUp") { e.preventDefault(); state.acIndex = (state.acIndex - 1 + state.acItems.length) % state.acItems.length; drawAutocomplete(); return true; }
  if (e.key === "Tab" || (e.key === "Enter" && state.acIndex >= 0 && !e.shiftKey)) {
    // Enter on an exact command match submits instead of re-completing.
    if (e.key === "Enter" && state.acItems[state.acIndex]?.value === composerRefs.textareaEl.value.trim()) { hideAutocomplete(); return false; }
    e.preventDefault(); pickAutocomplete(state.acIndex); return true;
  }
  if (e.key === "Escape") { e.preventDefault(); hideAutocomplete(); return true; }
  return false;
}

export { buildComposer, fillComposer, clearComposer, insertComposer, updateGhost, addFiles, renderAttachmentChips, updateComposerTools, acListEl, acOpen, toolDescription, allSlash, argumentSource, updateAutocomplete, drawAutocomplete, hideAutocomplete, pickAutocomplete, autocompleteKey };

let emit = () => {};
export function mount(_root, { emit: dispatch }) { emit = dispatch; }
