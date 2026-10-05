import { relativeTime, shortId } from "../../text.js";
/** panels.js — Dialogs, pickers, command palette, endpoint login, help, questions, and tool runner. */
import { markdownNode } from "../../markdown-copy.js";
import { state, isMac } from "../../state.js";
import { toast, el, button, kbd } from "../../dom.js";
import { selectedTheme, applyTheme, applyThemeName } from "../../theme-service.js";
import { renderMarkdown } from "../../../markdown.js";
import { buildQuestionDialog } from "../../logic/question-dialog.js";
import { agentDisplayName, agentProjectLabel, agentRef, sameAgent } from "../../logic/agents.js";
import { groupChoices } from "../../logic/header.js";
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
    if (!document.querySelector("dialog[open]")) document.querySelector("form.composer textarea")?.focus({ preventScroll: true });
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
  if (document.querySelector("#login-panel") && (!state.loginSelection || state.loginSelection.oauth)) renderLoginBody();
  if (document.querySelector("#themes-panel")) emit("theme.body");
}

/**
 * Small anchored menu (thinking levels, new-chat variants). Closes on outside
 * pointer-down or Esc; arrows move focus.
 * @param {HTMLElement} anchor - element to position under.
 * @param {Array<object>} items - `{ label, detail?, current?, run?, separator?, actions? }`; `actions` are buttons beside the row (using one closes this menu).
 * @returns {void}
 */
function openMenu(anchor, items) {
  // Measure first: an anchor inside the menu being replaced (a row action) leaves the DOM with it.
  const rect = anchor.getBoundingClientRect();
  const host = anchor.closest("dialog[open]") ?? document.body;
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
    if (!item.actions?.length) { menu.append(row); continue; }
    const line = el("div", "menu-row");
    const tools = el("span", "menu-actions");
    tools.append(...item.actions);
    tools.addEventListener("click", close); // bubbles after the action's own handler
    line.append(row, tools);
    menu.append(line);
  }
  // Inside a modal dialog the page body is inert and below the top layer: open the menu in the dialog.
  host.append(menu);
  const width = Math.min((items.some((item) => item.actions?.length) ? 24 : 18) * 16, window.innerWidth - 16); // room for row actions
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
  add(A, "New chat", () => emit("server", { type: "session.new" }), { icon: "＋", detail: "saved session" });
  add(A, "New unlogged chat", () => emit("server", { type: "session.new", anonymous: true }), { icon: "＋", detail: "nothing written to disk" });
  add(A, "Add agent…", () => openAddAgent(), { icon: "⧉", detail: "keep this one running" });
  add(A, "Fork session", () => emit("server", { type: "session.fork" }), { icon: "⑂" });
  add(A, "Rename agent…", () => renameAgentPrompt(), { icon: "✎" });
  add(A, "Rename session…", () => renameSessionPrompt(), { icon: "✎" });
  add(A, "Switch model…", () => openModelPicker(), { icon: "◇", detail: state.settings.endpoint ? `${state.settings.endpoint}/${state.settings.model}` : "none selected" });
  add(A, state.settings.safe ? "Turn safe mode off" : "Turn safe mode on (read-only)", () => emit("server", { type: "settings.safe", on: !state.settings.safe }), { icon: state.settings.safe ? "🔓" : "🔒" });
  add(A, state.settings.sessionSave === true ? "Pause session logging" : "Start logging this session", () => emit("server", { type: "settings.session-save", on: state.settings.sessionSave !== true }), { icon: "📝" });
  add(A, "Continue", () => emit("server", { type: "chat.continue" }), { icon: "▶", detail: "re-activate over the current context" });
  add(A, "Copy last response", () => emit("server", { type: "chat.submit", text: "/context-copy" }), { icon: "⧉" });
  add(A, "Block viewer", () => emit("viewer.open"), { icon: "▤", shortcut: "Ctrl O" });
  add(A, "Compact context", () => emit("server", { type: "chat.submit", text: "/context-compact" }), { icon: "⇲", detail: "model summarizes the conversation" });
  add(A, "Clear thinking blocks", () => emit("server", { type: "chat.submit", text: "/context-clear-thoughts" }), { icon: "✦" });
  add(A, "Run a tool…", () => openToolDialog(), { icon: "⚒" });
  add(A, "Agent status", () => emit("server", { type: "chat.submit", text: "/agent-status" }), { icon: "ℹ" });
  add(A, "Clear this session…", () => { if (confirm("Clear every message in this session and restart it?")) emit("server", { type: "session.clear" }); }, { icon: "⌫" });
  add(A, "Delete ALL saved sessions…", () => emit("server", { type: "chat.submit", text: "/session-delete-all!" }), { icon: "⚠" });
  add(A, "Sign in to an endpoint…", () => openLogin(), { icon: "⇄" });
  add(A, "Themes…", () => emit("themes.open"), { icon: "◐" });
  add(A, "Settings", () => openSettings(), { icon: "⚙" });
  add(A, "Keyboard shortcuts", () => openHelp(), { icon: "?" });
  add(A, "Help (commands)", () => emit("server", { type: "chat.submit", text: "/help" }), { icon: "?" });
  for (const level of state.prefs.thinkingLevels) add("Thinking", `Thinking: ${level}`, () => emit("server", { type: "settings.thinking", level }), { current: level === state.settings.thinking, icon: "✦" });
  if (!state.settings.delegationLocked) for (const [label, value] of [["Allow", true], ["Deny", false], ["Ask", null]]) add("Delegation", `Allow to delegate: ${label}`, () => emit("server", { type: "settings.spawn", value }), { current: state.settings.spawnPermission === value, icon: "⇶" });
  for (const a of state.sessions.agents.flatMap(function walk(item) { return [item, ...(item.children ?? []).flatMap(walk)]; })) add("Agents", agentDisplayName(a, state), () => emit("server", { type: "session.switch", ...agentRef(a) }), { current: sameAgent(a, state.agent), detail: [a.model, a.state === "working" ? "working" : ""].filter(Boolean).join(" · "), icon: "●" });
  for (const s of state.sessions.recent) {
    const project = agentProjectLabel(s, state);
    add("Sessions", s.preview || s.id, () => emit("server", { type: "session.resume", id: s.id, ...(s.project ? { project: s.project } : {}) }), { detail: [project, s.agent, relativeTime(s.mtime), `${s.messages ?? 0} msg`, shortId(s.id)].filter(Boolean).join(" · "), keywords: `${s.id} ${s.agent ?? ""} ${project ?? ""}`, icon: "↺" });
  }
  for (const model of state.settings.models) add("Models", model, () => emit("server", { type: "settings.model", model }), { current: model === `${state.settings.endpoint}/${state.settings.model}`, icon: "◇" });
  for (const name of state.catalog.prompts) add("Prompts", `/${name}`, () => emit("composer.insert", `/${name} `), { icon: "❝" });
  for (const schema of state.catalog.toolSchemas) add("Tools", schema.name, () => openToolDialog(schema.name), { detail: String(schema.description ?? "").split("\n")[0].slice(0, 90), icon: "⚒" });
  for (const command of state.catalog.commands) add("Commands", command, () => emit("composer.insert", `${command} `), { detail: state.catalog.hints?.[command] ?? "", icon: "/" });
  for (const name of state.prefs.themes) add("Themes", `Theme: ${name}`, () => emit("theme.choose", name), { current: name === selectedTheme(), icon: "◐", preview: name });
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
  const items = state.endpoints.endpoints.map((endpoint) => endpoint.loginRequired
    ? { label: endpoint.name, detail: "sign-in required", run: () => openLogin(endpoint.name), icon: "⇄" }
    : { label: endpoint.name, detail: `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}`, current: endpoint.name === state.settings.endpoint, run: () => openModelPicker(endpoint.name), icon: "◎" });
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
  for (const endpoint of state.endpoints.endpoints) {
    if (only && endpoint.name !== only) continue;
    if (endpoint.loginRequired) { items.push({ group: endpoint.name, label: `Sign in to ${endpoint.name}`, run: () => openLogin(endpoint.name), icon: "⇄" }); continue; }
    for (const id of endpoint.models) {
      const value = `${endpoint.name}/${id}`;
      items.push({ group: endpoint.name, label: id, detail: "", current: value === `${state.settings.endpoint}/${state.settings.model}`, run: () => emit("server", { type: "settings.model", model: value }), icon: "◇" });
    }
  }
  // Fall back to the settings list when the endpoints packet has not arrived.
  if (!items.length) for (const model of state.settings.models) items.push({ group: model.split("/")[0], label: model.split("/").slice(1).join("/"), current: model === `${state.settings.endpoint}/${state.settings.model}`, run: () => emit("server", { type: "settings.model", model }) });
  items.push({ group: "Endpoints", label: "Sign in to another endpoint…", run: () => openLogin(), icon: "＋" });
  openPicker({ id: "model-picker", title: "Choose a model", placeholder: "Filter models", items });
}

/**
 * Picker for adding an agent (same model or any configured model) while the
 * current one keeps running.
 * @returns {void}
 */
function openAddAgent() {
  const items = [{ group: "Same model", label: state.settings.endpoint ? `${state.settings.endpoint}/${state.settings.model}` : "Default model", run: () => emit("server", { type: "session.add" }), icon: "＋", detail: "new agent, this one keeps running" }];
  for (const model of state.settings.models) items.push({ group: "Choose a model", label: model, run: () => emit("server", { type: "session.add", model }), icon: "◇" });
  openPicker({ id: "add-agent", title: "Add an agent", placeholder: "Filter models", items });
}

/* ----------------------------------------------------------------- naming */
/**
 * Prompt for a new agent name and send the rename.
 * @param {object} [target=agent] - agent entry to rename (defaults to the viewed one).
 * @returns {void}
 */
function renameAgentPrompt(target = state.agent) {
  if (!target) return;
  const name = prompt("Agent name", target.name ?? "");
  if (name === null || !name.trim() || name.trim() === target.name) return;
  emit("server", { type: "agent.rename", ...agentRef(target), name: name.trim() });
}
/**
 * Rename a saved session: the viewed agent's by default, or a sidebar
 * row's (in its own project). An auto (UUID) id offers an empty name to type.
 * @param {{id: string, project?: string}} [session] - saved session row; omitted targets the viewed session.
 * @returns {void}
 * Effects: toasts when the session is unlogged.
 */
function renameSessionPrompt(session) {
  const id = session?.id;
  const current = id ?? state.agent?.session;
  if (!current) { toast("This session is unlogged — turn logging on to name it", true); return; }
  const name = prompt("Session name (saved as its file name)", /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(current) ? "" : current);
  if (name === null || !name.trim() || name.trim() === current) return;
  emit("server", { type: "session.rename", name: name.trim(), ...(id === undefined ? {} : { id, ...(session.project ? { project: session.project } : {}) }) });
}

/* --------------------------------------------------------------- settings */
/** Endpoints whose per-model list the user expanded (survives settings repaints). */
const openEndpointModels = new Set();
/**
 * A maxActive number field for an endpoint or endpoint/model selector: blank
 * inherits (placeholder shows the capacity in force), 0 excludes.
 * @param {string} selector - `<endpoint>` or `<endpoint>/<model>`
 * @param {number|false|undefined} value - configured override
 * @param {number|undefined} effective - capacity currently in force
 * @returns {HTMLInputElement} the field; a committed change sends endpoint.policy
 */
function maxActiveInput(selector, value, effective) {
  const input = el("input", "max-active");
  input.type = "number"; input.min = "0"; input.step = "1"; input.inputMode = "numeric";
  input.value = value === false ? "0" : Number.isInteger(value) ? String(value) : "";
  input.placeholder = effective === undefined ? "inherit" : `inherit (${effective})`;
  input.setAttribute("aria-label", `Max active for ${selector}`);
  input.addEventListener("change", () => {
    const text = input.value.trim();
    const number = Number(text);
    if (text !== "" && (!Number.isInteger(number) || number < 0)) { toast("Max active must be a whole number ≥ 0 (blank inherits)"); return; }
    emit("server", { type: "endpoint.policy", selector, change: { maxActive: text === "" ? null : number } });
  });
  return input;
}
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
  const nameInput = el("input"); nameInput.value = state.agent?.name ?? ""; nameInput.setAttribute("aria-label", "Agent name");
  nameForm.append(nameInput, button("chip", "Rename", null, { type: "submit" }));
  nameForm.addEventListener("submit", (event) => { event.preventDefault(); if (nameInput.value.trim() && nameInput.value.trim() !== state.agent?.name) emit("server", { type: "agent.rename", agentId: state.agent?.id, name: nameInput.value.trim() }); });
  agentSection.append(row("Name", nameForm, "Shown in the sidebar and to linked agents"));
  const model = button("chip wide-chip", state.settings.endpoint ? `${state.settings.endpoint}/${state.settings.model}` : "Choose…", () => openModelPicker(), { icon: "◇" });
  agentSection.append(row("Model", model));
  const thinking = el("select"); thinking.setAttribute("aria-label", "Thinking level");
  for (const level of state.prefs.thinkingLevels) { const option = el("option", null, level === "default" ? "default (provider)" : level); option.value = level; option.selected = level === state.settings.thinking; thinking.append(option); }
  thinking.addEventListener("change", () => emit("server", { type: "settings.thinking", level: thinking.value }));
  agentSection.append(row("Thinking", thinking));
  agentSection.append(row("Tool access", segmented([["Read/write", false], ["Read-only", true]], state.settings.safe, (on) => emit("server", { type: "settings.safe", on })), "Read-only publishes and runs only safe tools"));
  agentSection.append(row("Allow to delegate", segmented([["Allow", true], ["Deny", false], ["Ask", null]], state.settings.spawnPermission, (value) => emit("server", { type: "settings.spawn", value }), state.settings.delegationLocked), state.settings.delegationLocked ? "Linked (child) agents never delegate" : "Whether this agent may spawn helper agents"));

  const sessionSection = section("Session", state.settings.sessionSave === true ? `Saved as “${state.agent?.session}”.` : "Unlogged — nothing is written to disk.");
  if (state.agent?.session) {
    const sessionForm = el("form", "inline-form");
    const sessionInput = el("input"); sessionInput.value = state.agent.session; sessionInput.setAttribute("aria-label", "Session name");
    sessionForm.append(sessionInput, button("chip", "Rename", null, { type: "submit" }));
    sessionForm.addEventListener("submit", (event) => { event.preventDefault(); if (sessionInput.value.trim() && sessionInput.value.trim() !== state.agent.session) emit("server", { type: "session.rename", name: sessionInput.value.trim() }); });
    sessionSection.append(row("Name", sessionForm, "Renames the session file"));
  }
  sessionSection.append(row("Logging", segmented([["On", true], ["Off", false]], state.settings.sessionSave === true, (on) => emit("server", { type: "settings.session-save", on })), "On writes the whole conversation; off keeps it in memory only"));
  const sessionActions = el("div", "button-row");
  sessionActions.append(
    button("chip", "Fork", () => emit("server", { type: "session.fork" }), { icon: "⑂" }),
    button("chip", "Compact", () => emit("server", { type: "chat.submit", text: "/context-compact" }), { icon: "⇲" }),
    button("chip danger", "Clear session", () => { if (confirm("Clear every message in this session and restart it?")) emit("server", { type: "session.clear" }); }, { icon: "⌫" }),
    button("chip danger", "Delete all sessions…", () => { document.querySelector("#settings-panel")?.close(); emit("server", { type: "chat.submit", text: "/session-delete-all!" }); }, { icon: "⚠" }),
  );
  sessionSection.append(sessionActions);

  const endpointSection = section("Endpoints", "Model providers this machine can reach. Sign-ins and endpoint settings are shared with the terminal UI. Max active: blank inherits, 0 excludes.");
  const list = el("ul", "endpoint-list");
  // Policies list every endpoint (disabled ones too); the published list adds sign-in state.
  const policies = new Map(state.endpoints.policies.map((policy) => [policy.name, policy]));
  const names = [...new Set([...state.endpoints.endpoints.map((endpoint) => endpoint.name), ...policies.keys()])];
  for (const name of names) {
    const endpoint = state.endpoints.endpoints.find((item) => item.name === name) ?? { name, models: [] };
    const policy = policies.get(name);
    const li = el("li", "endpoint-row");
    const head = el("div", "endpoint-head");
    const text = el("div", "endpoint-text");
    const status = policy?.disabled ? "disabled — hidden, refuses requests" : endpoint.loginRequired ? "sign-in required" : `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"}${name === state.settings.endpoint ? " · in use" : ""}`;
    text.append(el("strong", null, name), el("small", "muted", status));
    head.append(text);
    if (policy) head.append(segmented([["Enabled", false], ["Disabled", true]], policy.disabled === true, (disabled) => emit("server", { type: "endpoint.policy", selector: name, change: { disabled } })));
    if (endpoint.loginRequired) head.append(button("chip", "Sign in", () => openLogin(name)));
    if (state.endpoints.removable.includes(name)) head.append(button("chip danger", "Sign out", () => { if (confirm(`Remove endpoint "${name}" (its settings and stored credentials)?`)) emit("server", { type: "endpoint.logout", name }); }));
    li.append(head);
    if (policy) {
      li.append(row("Max active", maxActiveInput(name, policy.maxActive, policy.effective), "Concurrently running agents on this endpoint"));
      if (policy.models.length) {
        const details = el("details", "endpoint-models");
        details.open = openEndpointModels.has(name);
        details.addEventListener("toggle", () => { if (details.open) openEndpointModels.add(name); else openEndpointModels.delete(name); });
        details.append(el("summary", "muted small", `Per-model max active (${policy.models.length})`));
        for (const model of policy.models) details.append(row(model.id, maxActiveInput(`${name}/${model.id}`, model.maxActive, model.effective)));
        li.append(details);
      }
    }
    list.append(li);
  }
  if (!names.length) list.append(el("li", "muted", "No endpoints configured yet."));
  endpointSection.append(list, button("primary-button", "Sign in / add endpoint", () => openLogin(), { icon: "＋" }));

  const appearance = section("Appearance", "Named themes are available in both apps; the web selection is saved separately.");
  appearance.append(button("chip wide-chip", `Theme: ${selectedTheme()}`, () => emit("themes.open"), { icon: "◐" }));
  if (state.projects.length) {
    const projects = section("Projects", state.canManageProjects
      ? "Folders this web app serves. Pinned projects are served every time the web app starts; ＋ adds one to a group (pinning it); × stops serving one."
      : "Folders this web app serves.");
    const list = el("ul", "project-list");
    for (const project of state.projects) {
      const li = el("li", "project-row" + (project.current ? " current" : ""));
      const text = el("div", "project-text");
      text.append(el("strong", null, `${project.name}${project.current ? " (this view)" : ""}`), el("code", "project-path", project.path));
      if (project.groups?.length) {
        const groups = el("span", "project-groups");
        for (const group of project.groups) groups.append(el("span", "project-group", group));
        text.append(groups);
      }
      li.append(text);
      if (state.canManageProjects) li.append(...projectActions(project));
      list.append(li);
    }
    projects.append(list);
  }
  body.scrollTop = scroll;
}

/**
 * A served project's management buttons — groups (＋), pin (📌), remove (×) —
 * shared by Settings › Projects and the header's project menu (local clients only).
 * @param {{name: string, path: string, pinned?: boolean}} project
 * @returns {HTMLElement[]}
 */
function projectActions(project) {
  const group = button("icon-button project-group-add", null, (event) => openMenu(event.currentTarget, groupChoices(project, state.projects).map((choice) => {
    if (choice.separator) return choice;
    if (choice.create) return { label: choice.label, run: () => {
      const name = prompt(`New group for ${project.name}:`)?.trim();
      if (name) emit("server", { type: "project.group", path: project.path, group: name, member: true });
    } };
    return { ...choice, detail: choice.current ? "member — pick to leave" : undefined, run: () => emit("server", { type: "project.group", path: project.path, group: choice.group, member: choice.member }) };
  })), { icon: "＋", title: `Groups of ${project.name}` });
  const pin = button("icon-button project-pin" + (project.pinned ? " active" : ""), null, () => emit("server", { type: "project.pin", path: project.path, pinned: !project.pinned }),
    { icon: "📌", title: project.pinned ? `Unpin ${project.name}` : `Pin ${project.name} (serve it every time the web app starts)` });
  pin.setAttribute("aria-pressed", String(project.pinned === true));
  const remove = button("icon-button project-remove", null, () => {
    if (confirm(`Stop serving "${project.name}"?${project.pinned ? " It is unpinned too." : ""} Its open agents close; saved sessions stay.`)) emit("server", { type: "project.remove", path: project.path });
  }, { icon: "×", title: `Remove ${project.name}` });
  remove.disabled = state.projects.length === 1;
  return [group, pin, remove];
}

/* ------------------------------------------------------------------ login */
/**
 * Open the endpoint sign-in dialog, optionally preselecting an endpoint's preset.
 * @param {string} [endpointName] - preset name to preselect (starts OAuth immediately).
 * @returns {void}
 */
function openLogin(endpointName) {
  emit("server", { type: "endpoint.list" });
  const preset = endpointName ? state.endpoints.presets.find((item) => item.name === endpointName) : null;
  state.loginSelection = preset ? { preset } : null;
  if (preset?.oauth) startOAuth(preset);
  openDialog({ id: "login-panel", title: "Sign in to an endpoint", onClose: () => { state.loginSelection = null; } });
  renderLoginBody();
}
/**
 * Begin browser OAuth for a preset: reset the OAuth state and request the flow.
 * @param {object} preset - endpoint preset `{ name, label, provider, oauth }`.
 * @returns {void}
 */
function startOAuth(preset) {
  state.oauthState = { active: true, url: null, lines: [], done: false, error: false, name: preset.name };
  state.loginSelection = { preset, oauth: true };
  emit("server", { type: "endpoint.oauth", name: preset.name });
}
/**
 * Fold a server OAuth progress packet into `oauthState` and repaint the login dialog.
 * @param {object} m - `{ state: "url"|"log"|"done"|"error", url?, text? }`.
 * @returns {void}
 */
function onOAuth(m) {
  if (m.state === "url") state.oauthState = { ...state.oauthState, active: true, url: m.url };
  else if (m.state === "log") state.oauthState = { ...state.oauthState, active: true, lines: [...state.oauthState.lines, m.text].slice(-20) };
  else if (m.state === "done") { state.oauthState = { ...state.oauthState, active: false, done: true, lines: [...state.oauthState.lines, m.text] }; toast(m.text); }
  else if (m.state === "error") { state.oauthState = { ...state.oauthState, active: false, error: true, lines: [...state.oauthState.lines, m.text] }; toast(m.text, true); }
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
  if (state.loginSelection?.oauth) {
    const preset = state.loginSelection.preset;
    body.append(el("p", null, `Browser sign-in for ${preset.label}.`));
    if (state.oauthState.url) {
      const link = el("a", "primary-button", "Open the sign-in page ↗");
      link.href = state.oauthState.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      body.append(link, el("p", "muted small", "Finish signing in there; this dialog updates when it completes."));
    } else if (state.oauthState.active) body.append(el("p", "muted", "Preparing the sign-in…"));
    const log = el("div", "oauth-log");
    for (const line of state.oauthState.lines) log.append(el("div", null, line));
    if (state.oauthState.lines.length) body.append(log);
    if (state.oauthState.active) {
      const paste = el("form", "inline-form");
      const input = el("input"); input.placeholder = state.loginSelection.mcp ? "Paste the full MCP redirect URL" : "Paste the redirect URL (or code#state) if the page could not return here"; input.setAttribute("aria-label", "Sign-in redirect");
      paste.append(input, button("chip", "Submit", null, { type: "submit" }));
      paste.addEventListener("submit", (event) => { event.preventDefault(); if (input.value.trim()) {
        if (state.loginSelection.mcp) emit("server", { type: "mcp.oauth-paste", input: input.value.trim() });
        else emit("server", { type: "endpoint.oauth-paste", input: input.value.trim() });
        input.value = "";
      } });
      body.append(el("p", "muted small", "Headless or a different machine?"), paste);
    }
    const buttonRow = el("div", "button-row");
    if (state.oauthState.done) buttonRow.append(button("primary-button", "Done", () => document.querySelector("#login-panel")?.close()));
    else buttonRow.append(button("chip", "Back", () => { state.loginSelection = null; renderLoginBody(); }));
    body.append(buttonRow);
    return;
  }
  if (state.loginSelection) { body.append(loginForm(state.loginSelection.preset)); return; }
  body.append(el("p", "muted small", "Pick a provider. Browser sign-in presets open the provider's login page; others take a URL and an optional API key."));
  const grid = el("div", "preset-grid");
  for (const preset of state.endpoints.presets) {
    const card = button("preset-card", null, () => { if (preset.oauth) startOAuth(preset); else state.loginSelection = { preset }; renderLoginBody(); });
    card.append(el("strong", null, preset.label), el("small", "muted", `${preset.provider}${preset.oauth ? " · browser sign-in" : ""}`));
    if (state.endpoints.endpoints.some((endpoint) => endpoint.name === preset.name && !endpoint.loginRequired)) card.append(el("span", "badge", "connected"));
    grid.append(card);
  }
  const manual = button("preset-card manual", null, () => { state.loginSelection = { manual: true }; renderLoginBody(); });
  manual.append(el("strong", null, "Manual"), el("small", "muted", "Enter every field yourself"));
  grid.append(manual);
  for (const mcp of state.endpoints.mcp ?? []) {
    const card = button("preset-card", null, () => {
      state.oauthState = { active: true, url: null, lines: [], done: false, error: false, name: mcp.name };
      state.loginSelection = { preset: { name: mcp.name, label: mcp.name }, oauth: true, mcp: true };
      emit("server", { type: "mcp.oauth", name: mcp.name }); renderLoginBody();
    });
    card.append(el("strong", null, `MCP: ${mcp.name}`), el("small", "muted", mcp.state === "needs-sign-in" ? "needs sign-in" : mcp.state));
    grid.append(card);
  }
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
  for (const value of new Set([...(state.endpoints.providers ?? []), ...state.endpoints.presets.map((item) => item.provider)])) { const option = el("option"); option.value = value; providers.append(option); }
  const url = el("input"); url.required = true; url.type = "url"; url.value = preset?.url ?? ""; url.placeholder = "https://…";
  const token = el("input"); token.type = "password"; token.autocomplete = "off"; token.placeholder = "optional API key";
  form.append(
    el("p", null, preset ? `Connect ${preset.label}` : "Add an endpoint"),
    field("Endpoint name", name), field("Provider", provider), providers, field("Base URL", url), field("API key", token, "Stored in the endpoint's auth file, never sent to the browser again"), field("Save for", scope),
  );
  const buttonRow = el("div", "button-row");
  buttonRow.append(button("chip", "Back", () => { state.loginSelection = null; renderLoginBody(); }), button("primary-button", "Save endpoint", null, { type: "submit" }));
  form.append(buttonRow);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    emit("server", { type: "endpoint.login", scope: scope.value, name: name.value.trim(), provider: provider.value.trim(), url: url.value.trim(), ...(token.value ? { token: token.value } : {}) });
    token.value = "";
    document.querySelector("#login-panel")?.close();
  });
  queueMicrotask(() => (preset ? token : name).focus());
  return form;
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
  body.append(table, button("chip", "All slash commands", () => { document.querySelector("#help-panel")?.close(); emit("server", { type: "chat.submit", text: "/help" }); }));
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
    emit("viewer.open", [index === null ? null : { messageIndex: index, blockIndex: 0 }, index !== null]);
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
  const question = state.openQuestion;
  if (!question) return;
  const view = openDialog({ id: "question-overlay", title: question.questions.length > 1 ? `${question.questions.length} questions` : (question.questions[0]?.header ?? "Question"), className: "question-dialog", backdropCloses: false }); // a stray click must never refuse
  const settle = () => {
    if (state.openQuestion?.requestId !== question.requestId) return false;
    state.openQuestion = null;
    return true;
  };
  buildQuestionDialog(view, question, { el: el, button: button, markdownNode: markdownNode, send: (packet) => emit("server", packet), settle, document });
}
/**
 * Close the question overlay, if open.
 * @returns {void}
 */
function closeQuestion() { const node = document.querySelector("#question-overlay"); if (node) { state.openQuestion = null; node.close(); } }

/* ------------------------------------------------------------------ toast */
/**
 * Show a transient toast (click dismisses; errors live longer and go to the error region).
 * @param {*} text
 * @param {boolean} [isError=false]
 * @returns {void}
 */
/* ------------------------------------------------------------ tool runner */
/**
 * Open the "Run a tool" dialog: schema-driven form fields mirrored into the
 * JSON arguments textarea, with the raw schema shown for reference.
 * @param {string} [preselect] - tool name to preselect.
 * @returns {void}
 */
function openToolDialog(preselect) {
  const { body } = openDialog({ id: "tool-dialog", title: "Run a tool", wide: true });
  if (!state.catalog.toolSchemas.length) { body.append(el("p", "muted", "No tools are registered.")); return; }
  const select = el("select"); select.setAttribute("aria-label", "Tool");
  for (const schema of [...state.catalog.toolSchemas].sort((a, b) => a.name.localeCompare(b.name))) { const option = el("option", null, schema.name); option.value = schema.name; option.selected = schema.name === preselect; select.append(option); }
  const description = el("div", "md tool-schema-description");
  const form = el("form", "tool-schema-form");
  const args = el("textarea", "tool-json"); args.placeholder = "JSON arguments (default {})"; args.setAttribute("aria-label", "Tool JSON arguments"); args.rows = 6;
  const schemaView = el("details", "tool-schema-details");
  const schemaPre = el("pre", "tool-schema-view");
  schemaView.append(el("summary", null, "Schema"), schemaPre);
  const selectedSchema = () => state.catalog.toolSchemas.find((schema) => schema.name === select.value) ?? {};
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
    emit("server", { type: "tool.call", name: select.value, args: parsed });
    document.querySelector("#tool-dialog")?.close();
  }, { icon: "▶" });
  body.append(select, description, form, el("label", "field-label", "JSON arguments"), args, schemaView, run);
  select.focus();
}

export { openDialog, refreshOpenPanels, openMenu, projectActions, openPicker, openPalette, openEndpointPicker, openModelPicker, openAddAgent, renameAgentPrompt, renameSessionPrompt, openSettings, renderSettingsBody, openLogin, startOAuth, onOAuth, renderLoginBody, loginForm, SHORTCUTS, openHelp, openView, renderQuestion, closeQuestion, toast, openToolDialog };

let emit = () => {};
export function mount(_root, { emit: dispatch }) { emit = dispatch; }
