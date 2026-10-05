/** shell.js — Persistent shell, header, sidebar, usage, agent navigation, and keyboard shortcuts. */
import { state, writePref } from "../../state.js";

import { el, button, toast } from "../../dom.js";
import { brandWordmark } from "../../wordmark.js";
import { updateAppearanceSwitch } from "../../theme-service.js";
import { relativeTime, shortId, statusWord } from "../../text.js";
import { aggregateState, formatAmount, quotaUsedTotal, resetText, sortedQuotaEntries } from "../../../format.js";
import { headerPresentation, projectChoices } from "../../logic/header.js";
import { agentDisplayName, agentRef, sameAgent } from "../../logic/agents.js";
import { sessionGroups } from "../../logic/sessions.js";

/** Refs are owned by the view that mounts them, never by the data model. */
export const shellRefs = { app: document.querySelector("#app"), shellEl: null, sidebarEl: null, headerEl: null, scrollEl: null, transcriptContainer: null, jumpBtn: null, jumpTopBtn: null, composerEl: null };
/* --------------------------------------------------------------- elements */
/**
 * Build the wordmark: the real word stays in the DOM (copy/paste, find-in-page,
 * screen readers); its first letter is transparent and overlaid with an inline
 * SVG mark — the logo ring + prompt glyph in currentColor, so it tracks themes.
 * @param {string} [word="Omoya"]
 * @returns {HTMLElement} the `.wordmark` span.
 */

/**
 * Build the persistent shell once; later updates patch it in place. Rebuilding
 * the whole tree on every state change would reset scroll/focus and break the
 * inputs, so only the dynamic regions (header, sidebar lists, transcript) patch.
 * @returns {void}
 */
function buildShell() {
  shellRefs.app.replaceChildren();
  shellRefs.shellEl = el("div", "web-shell");
  shellRefs.sidebarEl = buildSidebar();
  const scrim = el("div", "sidebar-scrim");
  scrim.addEventListener("click", () => setSidebar(false));
  const main = el("main", "conversation");
  shellRefs.headerEl = buildHeader();
  shellRefs.scrollEl = el("div", "transcript-scroll");
  shellRefs.transcriptContainer = el("div", "transcript");
  shellRefs.transcriptContainer.setAttribute("role", "log");
  shellRefs.transcriptContainer.setAttribute("aria-live", "polite");
  shellRefs.transcriptContainer.setAttribute("aria-relevant", "additions");
  shellRefs.scrollEl.append(shellRefs.transcriptContainer);
  shellRefs.scrollEl.addEventListener("scroll", () => emit("transcript.jump"), { passive: true });
  shellRefs.jumpBtn = button("jump-bottom", null, () => { shellRefs.scrollEl.scrollTo({ top: shellRefs.scrollEl.scrollHeight, behavior: "smooth" }); }, { title: "Jump to latest", icon: "↓" });
  shellRefs.jumpBtn.hidden = true;
  shellRefs.jumpTopBtn = button("jump-top", null, () => { shellRefs.scrollEl.scrollTo({ top: 0, behavior: "smooth" }); }, { title: "Jump to oldest", icon: "↑" });
  shellRefs.jumpTopBtn.hidden = true;
  shellRefs.composerEl = emit("composer.build");
  const dock = el("div", "composer-dock");
  dock.append(shellRefs.jumpBtn, shellRefs.composerEl);
  main.append(shellRefs.headerEl, shellRefs.jumpTopBtn, shellRefs.scrollEl, dock);
  shellRefs.shellEl.append(shellRefs.sidebarEl, scrim, main);
  shellRefs.app.append(shellRefs.shellEl);
  applyShell();
}

/**
 * Open or close the sidebar, persisting the choice.
 * @param {boolean} open
 * @returns {void}
 */
function setSidebar(open) { state.sidebarOpen = open; writePref("omoya.web.sidebar", open ? "open" : "closed"); applyShell(); }
/**
 * Reflect `sidebarOpen` on the shell's class list.
 * @returns {void}
 */
function applyShell() { shellRefs.shellEl?.classList.toggle("sidebar-open", state.sidebarOpen); }

/**
 * Build the shell on first use and refresh every dynamic region.
 * @returns {void}
 */
function render() {
  if (!shellRefs.shellEl) buildShell();
  else { shellRefs.composerEl.replaceWith(shellRefs.composerEl = emit("composer.build")); }
  emit("transcript.render", true); updateHeader(); updateSidebar(); updateUsage(); updateComposerActivity(); emit("composer.tools");
}

/* ----------------------------------------------------------------- header */
/**
 * Build the header: sidebar toggle, identity placeholder, connection state,
 * appearance switch, and the block viewer / palette / settings buttons.
 * @returns {HTMLElement} the `<header>` element.
 */
function buildHeader() {
  const head = el("header", "app-header");
  const toggle = button("icon-button", null, () => setSidebar(!state.sidebarOpen), { title: "Toggle sidebar", icon: "☰" });
  const identity = el("div", "identity");
  identity.id = "identity";
  const headerActions = el("div", "header-actions");
  const connection = el("span", "connection-state");
  connection.id = "connection-state";
  const appearance = el("div", "appearance-switch");
  appearance.setAttribute("role", "group");
  appearance.setAttribute("aria-label", "Appearance");
  for (const [mode, icon, label] of [["system", "◐", "Follow system appearance"], ["light", "☀", "Light appearance"], ["dark", "☾", "Dark appearance"]]) {
    const option = button("appearance-option", null, () => {
      writePref("omoya.web.namedThemeMode", mode);
      if (!["system", "light", "dark"].includes(emit("theme.selected"))) emit("theme.apply");
      else emit("theme.choose", mode);
      updateAppearanceSwitch();
      if (document.querySelector("#themes-panel")) emit("theme.body");
    }, { title: label, icon });
    option.dataset.mode = mode;
    appearance.append(option);
  }
  headerActions.append(
    connection,
    button("icon-button", null, () => emit("viewer.open"), { title: "Block viewer (Ctrl+O)", icon: "▤" }),
    button("icon-button palette-button", null, () => emit("palette.open"), { title: "Command palette (Ctrl/⌘+K)", icon: "⌘" }),
    button("icon-button", null, () => emit("settings.open"), { title: "Settings", icon: "⚙" }),
    appearance,
  );
  head.append(toggle, identity, headerActions);
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
  if (state.agent && !all.some((item) => sameAgent(item, state.agent))) all.push(state.agent);
  return aggregateState(all.map((item) => item.busy ? "working" : item.state));
}

/**
 * Repaint the header: connection state/label, throttle countdown, agent name
 * and session badge, safe-mode badge, Stop/Send visibility, and the tab title.
 * @returns {void}
 */
function updateHeader() {
  const identity = document.querySelector("#identity");
  const connection = document.querySelector("#connection-state");
  if (!identity || !connection) return;
  // The TUI's top-level status summarizes every live agent, while the
  // composer only follows the viewed one.
  const online = state.connection === "open";
  const activity = aggregateAgentState();
  const { label, wait, accessibleLabel, project } = headerPresentation({ isOnline: online, activity, throttledUntil: state.throttledUntil, projects: state.projects, now: Date.now() });
  connection.replaceChildren();
  const dot = el("i", `connection-dot${online ? " online" : ""} ${activity}`);
  connection.setAttribute("aria-label", accessibleLabel);
  connection.title = `${label}${wait} — ${agentList().length || 1} agent(s)`;
  connection.append(dot, activity === "working" && online ? statusWord(label) : el("span", "state-label", label));
  if (wait) connection.append(el("span", "state-label", wait));
  updateAppearanceSwitch();

  identity.replaceChildren();
  if (state.scope === "group") identity.append(button("project-name group-name", state.group, (event) => emit("menu.open", [event.currentTarget, projectMenuItems()]), { title: `Group view: ${state.group}`, icon: "🗂" }), el("span", "identity-separator", "/"));
  if (project) identity.append(button("project-name", project.name, (event) => emit("menu.open", [event.currentTarget, projectMenuItems()]), { title: `Project: ${project.path}`, icon: "📁" }), el("span", "identity-separator", "/"));
  const name = button("agent-name", state.agent?.name ?? "Omoya", () => emit("agent.rename"), { title: "Rename this agent" });
  const session = state.agent?.session;
  const logged = state.settings.sessionSave === true;
  const badge = button("session-badge" + (logged ? " saved" : " ghost"), logged ? shortId(session) : "Unlogged",
    () => emit("session.rename"),
    { title: `Session ${session} — ${logged ? "logged" : "not logged (memory only)"} · click to rename` });
  identity.append(name, badge);
  if (state.settings.safe) identity.append(button("mode-badge", "Read-only", () => emit("server", { type: "settings.safe", on: false }), { title: "Safe mode: read-only tools only — click to allow writes" }));
  // Stop replaces Send for the viewed agent only; Enter keeps submitting.
  const viewedWorking = state.agent?.state === "working" || state.agent?.busy === true;
  if (document.querySelector(".composer-stop")) document.querySelector(".composer-stop").hidden = !viewedWorking;
  if (document.querySelector(".composer-send")) document.querySelector(".composer-send").hidden = viewedWorking;
  document.title = `${viewedWorking ? "● " : ""}${state.scope === "group" ? `${state.group} · ` : ""}${project ? `${project.name} · ` : ""}${state.agent?.name ?? "Omoya"} — Omoya`;
}

/** List project navigation and the locally authorized add action. */
function projectMenuItems() {
  return projectChoices(state.projects, state.canManageProjects, state.scope, state.group).map((choice) => {
    if (choice.separator) return choice;
    if (choice.view) return { ...choice, run: () => { location.href = choice.url; } };
    // Local clients manage each project here too (the same buttons as Settings › Projects).
    const project = state.projects.find((item) => item.path === choice.path);
    if (!choice.add) return { ...choice, ...(state.canManageProjects && project ? { actions: emit("project.actions", project) } : {}), run: () => {
      if (choice.current) return;
      if (choice.inView) emit("server", { type: "project.select", path: choice.path });
      else location.href = choice.url;
    } };
    return { label: choice.label, run: () => {
      const path = prompt("Project folder: absolute path or ~/…");
      if (path?.trim()) emit("server", { type: "project.add", path: path.trim() });
    } };
  });
}


/* ---------------------------------------------------------------- sidebar */
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
    button("new-chat", "New chat", () => emit("server", { type: "session.new" }), { icon: "＋", title: "Replace this agent with a fresh saved session" }),
    button("icon-button new-chat-more", null, (event) => emit("menu.open", [event.currentTarget, newSessionItems()]), { title: "More ways to start", icon: "▾" }),
  );
  const lists = el("div", "sidebar-lists");
  lists.id = "sidebar-lists";
  const footer = el("div", "sidebar-footer");
  footer.append(
    button("sidebar-link", "Endpoints", () => emit("login.open"), { icon: "⇄", title: "Sign in to or out of model endpoints" }),
    button("sidebar-link", "Themes", () => emit("themes.open"), { icon: "◐" }),
    button("sidebar-link", "Tools", () => emit("tools.open"), { icon: "⚒" }),
    button("sidebar-link", "Shortcuts", () => emit("help.open"), { icon: "?" }),
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
    { label: "New chat", detail: "Saved session (replaces this one)", run: () => emit("server", { type: "session.new" }) },
    { label: "New chat, read-only", detail: "Saved, safe mode on", run: () => emit("server", { type: "session.new", safe: true }) },
    { label: "Unlogged chat", detail: "Nothing is written to disk", run: () => emit("server", { type: "session.new", anonymous: true }) },
    { label: "Unlogged, read-only", detail: "Anonymous + safe mode", run: () => emit("server", { type: "session.new", anonymous: true, safe: true }) },
    { separator: true },
    { label: "Add agent…", detail: "Keep this one running; pick a model", run: () => emit("agent.add") },
    { label: "Fork this session", detail: "Branch the current context", run: () => emit("server", { type: "session.fork" }) },
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
  runningHead.append(el("h2", null, "Agents"), button("icon-button tiny", null, () => emit("agent.add"), { title: "Add an agent (keeps this one running)", icon: "＋" }));
  const runningList = el("ul", "session-tree-list");
  runningList.append(...state.sessions.agents.map((a) => sessionAgent(a, 0)));
  if (!state.sessions.agents.length) runningList.append(el("li", "muted empty-row", "No running agents"));
  running.append(runningHead, runningList);
  const recent = el("section", "sidebar-section");
  const recentHead = el("div", "section-head");
  recentHead.append(el("h2", null, "Sessions"), el("span", "count", String(state.sessions.recent.length)));
  // The filter always shows: a few sessions per project still add up across projects.
  const search = el("input", "session-search");
  search.type = "search"; search.placeholder = "Filter sessions"; search.value = state.sessionFilter;
  search.setAttribute("aria-label", "Filter saved sessions");
  search.addEventListener("input", () => { state.sessionFilter = search.value; updateSidebar(); });
  recent.append(recentHead, search);
  if (hadFocus) queueMicrotask(() => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); });
  const query = state.sessionFilter.trim();
  const groups = sessionGroups({ recent: state.sessions.recent, projects: state.projects, scope: state.scope, group: state.group, query });
  // A project view lists its own sessions; multi-project views give each project a collapsible section.
  if (state.scope === "project") recent.append(recentList(groups[0]?.items ?? [], query));
  else {
    for (const group of groups) {
      if (query && !group.items.length) continue;
      const section = el("details", "project-sessions");
      section.open = !state.sessionCollapsed.has(group.path);
      section.addEventListener("toggle", () => { if (section.open) state.sessionCollapsed.delete(group.path); else state.sessionCollapsed.add(group.path); });
      const summary = el("summary", "project-sessions-head");
      summary.title = group.path;
      summary.append(el("span", "project-sessions-name", group.name), el("span", "count", query ? `${group.items.length} / ${group.total}` : String(group.total)));
      section.append(summary, recentList(group.items, query));
      recent.append(section);
    }
    if (query && groups.every((group) => !group.items.length)) recent.append(el("p", "muted empty-row", "No matching sessions"));
  }
  lists.append(running, recent);
}

/**
 * Build one saved-session list; rows address their project (the all-projects view reaches every project).
 * @param {Array<object>} items - saved sessions (`{ id, project, preview?, agent?, mtime, messages, live? }`).
 * @param {string} query - active filter (selects the empty-list wording).
 * @returns {HTMLElement} the `<ul>`.
 */
function recentList(items, query) {
  const list = el("ul", "recent-list");
  for (const item of items) {
    const where = item.project ? { project: item.project } : {};
    const li = el("li");
    const active = item.id === state.agent?.session && (!item.project || item.project === state.agent?.project);
    const row = el("div", "recent-row" + (active ? " active" : ""));
    const open = button("recent-item", null, () => emit("server", { type: "session.resume", id: item.id, ...where }), { title: [item.agent ? `Agent: ${item.agent}` : null, `Resume ${item.id}`].filter(Boolean).join("\n") });
    open.append(el("span", "recent-title", item.preview || item.id), el("span", "recent-meta", [relativeTime(item.mtime), `${item.messages ?? 0} msg`, item.preview ? shortId(item.id) : null].filter(Boolean).join(" · ")));
    const rename = button("row-action", null, () => emit("session.rename", item), { title: `Rename session ${item.id}`, icon: "✎" });
    row.append(open, rename);
    row.append(button("row-action session-close", null, () => {
      const warning = item.live ? " This will also close the agent using it (stop its turn first if working)." : "";
      if (confirm(`Delete session “${item.preview || item.id}” permanently?${warning}`)) emit("server", { type: "session.delete", id: item.id, ...where });
    }, { title: `Delete session ${item.id}${item.live ? " and close its agent" : ""}`, icon: "×" }));
    li.append(row);
    list.append(li);
  }
  if (!items.length) list.append(el("li", "muted empty-row", query ? "No matching sessions" : "No saved sessions yet"));
  return list;
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
  const row = el("div", "session-row" + (a.active || sameAgent(a, state.agent) ? " active" : ""));
  const agentState = a.state ?? (a.busy ? "working" : "idle");
  const dot = el("i", "agent-dot " + agentState);
  dot.setAttribute("aria-hidden", "true");
  const select = button("session-item", null, () => emit("server", { type: "session.switch", ...agentRef(a) }), { title: a.description || agentDisplayName(a, state) });
  const text = el("span", "session-item-text");
  text.append(el("span", "session-item-name", agentDisplayName(a, state)), el("span", "session-item-meta", [a.model ? a.model : null, a.logged ? "saved" : "unlogged"].filter(Boolean).join(" · ")));
  select.append(dot, text);
  const status = el("span", "agent-status " + agentState);
  status.setAttribute("aria-label", `Status: ${agentState}`);
  status.append(agentState === "working" ? statusWord("working") : document.createTextNode(agentState === "idle" ? "" : agentState));
  const rename = button("row-action", null, () => emit("agent.rename", a), { title: `Rename ${agentDisplayName(a, state)}`, icon: "✎" });
  const close = button("row-action session-close", null, () => { if (!a.busy || confirm(`${agentDisplayName(a, state)} is working. Close it anyway?`)) emit("server", { type: "session.close", ...agentRef(a) }); }, { title: `Close ${agentDisplayName(a, state)}`, icon: "×" });
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
  const used = Number(state.usage.used ?? 0);
  const available = Number(state.usage.available ?? 0);
  const percent = available > 0 ? Math.min(100, Math.round((used / available) * 100)) : null;
  const plan = planPercentText(state.usage.plan);
  node.replaceChildren();
  const ring = el("span", "meter-ring");
  ring.style.setProperty("--pct", String(percent ?? 0));
  ring.classList.toggle("high", (percent ?? 0) >= 80);
  node.append(ring, el("span", "meter-text", `${compact(used)}${available ? `/${compact(available)}` : ""}${plan ? ` · ${plan}` : ""}`));
  node.title = [
    `Context: ${used.toLocaleString()} / ${available ? available.toLocaleString() : "—"} tokens${percent === null ? "" : ` (${percent}%)`}`,
    `Session: ${Number(state.usage.input ?? 0).toLocaleString()} in · ${Number(state.usage.output ?? 0).toLocaleString()} out`,
    planTooltipText(state.usage.plan),
    "Click to open the block viewer (Ctrl+O)",
  ].filter(Boolean).join("\n");
  node.setAttribute("aria-label", `Context ${percent === null ? used : `${percent}%`} used`);
}

/**
 * Reflect the viewed agent's busy state on the composer (working animation).
 * @returns {void}
 */
function updateComposerActivity() {
  shellRefs.composerEl?.classList.toggle("working", state.agent?.state === "working" || state.agent?.busy === true);
}

/**
 * Repaint the queued-messages strip above the composer.
 * @returns {void}
 */
function renderComposerQueue() {
  const node = document.querySelector("#composer-queue");
  if (!node) return;
  node.replaceChildren();
  if (!state.queuedMessages.length) return;
  const text = state.queuedMessages.length === 1 ? "1 queued" : `${state.queuedMessages.length} queued`;
  node.append(el("span", "queue-label", text), el("span", "composer-queue-preview", state.queuedMessages.join(" · ")));
  node.append(button("composer-unqueue", "Edit", () => emit("server", { type: "chat.unqueue" }), { title: "Remove queued messages and put them back in the editor (Alt+Shift+↑)" }));
}

/**
 * Flatten the sessions agent tree (depth-first) into a list.
 * @returns {object[]}
 */
function agentList() {
  const agents = [];
  const visit = (items) => { for (const item of items ?? []) { agents.push(item); visit(item.children); } };
  visit(state.sessions.agents);
  return agents;
}

/**
 * Switch to the previous/next agent in the flattened list (wraps).
 * @param {number} direction - +1 next, -1 previous.
 * @returns {void}
 */
function navigateAgent(direction) {
  const agents = agentList();
  const currentIndex = agents.findIndex((item) => sameAgent(item, state.agent));
  if (agents.length < 2 || currentIndex < 0) return;
  emit("server", { type: "session.switch", ...agentRef(agents[(currentIndex + direction + agents.length) % agents.length]) });
}

/**
 * Switch to the viewed agent's parent, when it has one.
 * @returns {void}
 */
function navigateParentAgent() {
  const parentId = agentList().find((item) => sameAgent(item, state.agent))?.parentId;
  if (parentId) emit("server", { type: "session.switch", ...agentRef({ id: parentId, project: state.agent.project }) });
}

function installKeys() {
  document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const dialogOpen = Boolean(document.querySelector("dialog[open]"));
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); if (document.querySelector("#palette")) document.querySelector("#palette").close(); else emit("palette.open"); return; }
  // Ctrl+O toggles the block viewer like the TUI's ^O (⇧⌘O / Ctrl+Shift+O also opens it).
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") { event.preventDefault(); if (document.querySelector("#context-viewer")) emit("viewer.close"); else emit("viewer.open"); return; }
  if (mod && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); emit("viewer.open"); return; }
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") { event.preventDefault(); setSidebar(!state.sidebarOpen); return; }
  if (event.altKey && event.shiftKey && !mod && event.key === "ArrowUp" && state.queuedMessages.length) { event.preventDefault(); emit("server", { type: "chat.unqueue" }); return; }
  if (event.key === "Escape" && !dialogOpen && !emit("composer.acOpen") && !document.querySelector(".popup-menu")) {
    if (state.agent?.state === "working" || state.agent?.busy === true) { event.preventDefault(); emit("server", { type: "chat.cancel" }); toast("Stopping…"); }
    return;
  }
  if (event.altKey && event.ctrlKey && !event.shiftKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp")) {
    event.preventDefault();
    if (event.key === "ArrowUp") navigateParentAgent();
    else navigateAgent(event.key === "ArrowRight" ? 1 : -1);
    return;
  }
  // Typing anywhere outside a field lands in the composer.
  if (!dialogOpen && !mod && !event.altKey && event.key.length === 1 && event.key !== " " && document.querySelector("form.composer textarea") && (!document.activeElement || document.activeElement === document.body) && window.getSelection()?.isCollapsed !== false) document.querySelector("form.composer textarea").focus();
  });
}

let emit = () => {};
export function mount(root, { emit: dispatch }) { shellRefs.app = root; emit = dispatch; }
export { el, button, relativeTime, shortId, statusWord, brandWordmark, buildShell, setSidebar, applyShell, render, buildHeader, aggregateAgentState, updateHeader, projectMenuItems, buildSidebar, newSessionItems, updateSidebar, recentList, sessionAgent, planPercentText, planTooltipText, compact, updateUsage, updateComposerActivity, renderComposerQueue, agentList, navigateAgent, navigateParentAgent, installKeys };
