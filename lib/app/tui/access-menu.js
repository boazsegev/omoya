/** Pure feature catalog: rows describe navigation or actions; nothing is executed.
 * Pass personalSettings: Env.settings as a snapshot/reference acquired by the caller.
 * Reading Env.settings here would initialize its settings store and violate purity.
 */
import {
  buildEndpointItems, buildEndpointPoliciesItems, buildEndpointPolicyItems, buildHelpItems,
  buildMenuItems, buildPromptItems,
  buildRequestPermissionItems, buildSessionCloseItems, buildSpawnPermissionItems,
  buildThemeItems, buildProviderItems,
} from "./menu-data.js";
import { basename } from "node:path";

// Search-only replacement variants keep the frequent-action root uncluttered.
const NEW_CHAT_VARIANTS = [
  ["New chat, read-only", ["/session-new", "/agent-safe on"]],
  ["New chat, unlogged", ["/session-new false"]],
  ["New chat, unlogged and read-only", ["/session-new false", "/agent-safe on"]],
];

// The entire terminal-setting write allowlist, including the offered values.
// Defaults are read from the caller's Env.settings, never duplicated here.
const TERMINAL_CHOICES = [
  ["tui.alt", "Alternate screen", [[true, "On"], [false, "Off (inline)"]]],
  ["tui.mouse", "Mouse", [[true, "On"], [false, "Off"]]],
  ["tui.osc52", "OSC 52 clipboard", [[true, "On"], [false, "Off"]]],
  ["tui.scroll.show", "Scrollbar", [[true, "On"], [false, "Off"]]],
  ["tui.cursor.shape", "Cursor shape", [["line", "Line"], ["block", "Block"], ["underline", "Underline"]]],
  ["tui.cursor.blink", "Cursor blink", [[false, "Off"], [450, "450 ms"], [750, "750 ms"]]],
];

/** Check one terminal-setting write against the same allowlist used by the menu.
 * @param {string} key Exact dotted setting key; unknown keys are rejected.
 * @param {*} value Offered setting value, or undefined to reset to inheritance.
 * @returns {boolean} Whether this key/value pair can be written by the executor.
 * Pure and idempotent; does not retain/mutate inputs or throw for invalid values.
 * @example terminalSettingAllowed("tui.alt", false); // true
 * @example terminalSettingAllowed("providers.secret", "value"); // false
 */
export function terminalSettingAllowed(key, value) {
  const setting = TERMINAL_CHOICES.find(([candidate]) => candidate === key);
  return setting !== undefined && (value === undefined || setting[2].some(([choice]) => choice === value));
}

function action(label, value, extra = {}) {
  return { kind: "action", label, value, ...extra };
}

function info(label) {
  return { kind: "info", label };
}

function menu(title, rows) {
  return { title, items: [action("← back", { type: "back" }), ...rows] };
}

function normalize(options) {
  const agent = options.agent;
  return {
    commands: [], prompts: [], tools: [], endpoints: [], providers: [],
    agents: [], themes: ["default"], theme: "default", thinkingLevels: [],
    endpointPolicies: [], projects: [], sessionsLoading: false,
    currentEnv: agent?.env, personalSettings: {},
    safeMode: agent?.can?.write === false, sessionSave: agent?.context?.save,
    thinkingLevel: agent?.thinking, can: agent?.can ?? {},
    ...options, savedSessions: options.savedSessions ?? options.sessions ?? [],
    linked: options.linked === true || Boolean(agent?.parent),
  };
}

function rootRows(data) {
  const path = data.currentEnv?.folder ?? data.projects.find((project) => project.current)?.path;
  const endpoints = buildEndpointItems({ providers: data.providers }).filter((row) => row.kind !== "header").map((row) => {
    const current = row.value?.type === "provider" && (data.currentModel === row.value.value || data.currentModel?.startsWith(`${row.value.value}/`));
    return current ? { ...row, note: `current · ${data.currentModel}`, role: "menu.text menu.current" } : row;
  });
  return [
    { kind: "header", label: "Quick actions" },
    action("New chat", { type: "command", lines: ["/session-new"] }, { hint: "Replaces the current chat. Use Add agent to keep it open." }),
    ...(path === undefined ? [] : [action("Add agent", { type: "access.add.form", path }, { note: data.currentEnv?.name ?? path })]),
    action("Themes", { type: "themes", themes: [...data.themes], value: data.theme }, { note: `current: ${data.theme} · applies now` }),
    action("Models", { type: "access.models" }, { note: data.currentModel, hint: "Choose across all endpoints; Ctrl+M opens the current endpoint." }),
    { kind: "header", label: `Agents · ${data.agents.length} active` },
    ...agentRows(data),
    action("Close agent…", { type: "session-close-menu", agents: [...data.agents] }),
    { kind: "header", label: "Endpoints · Ctrl+P" },
    ...endpoints,
    { kind: "header", label: "Browse" },
    action("Projects", { type: "access.projects" }),
    action("Saved sessions", { type: "access.sessions" }, { hint: "Select a session to resume it; its manage row offers rename and delete." }),
    action("Tools", { type: "access.tools.list" }, { note: `${data.tools.length} registered` }),
    action("Prompts", { type: "prompts", prompts: [...data.prompts] }, { note: `${data.prompts.length} available` }),
    { kind: "header", label: "Context" },
    action("View context", { type: "access.viewer" }, { note: "Ctrl+O" }),
    action("Compact context", { type: "command", lines: ["/compact"] }),
    action("Fork", { type: "command", lines: ["/session-fork"] }),
    action("Continue", { type: "command", lines: ["/continue"] }),
    { kind: "header", label: "Settings & help" },
    action("Agent settings", { type: "access.settings.agent" }, { note: data.agent?.name ?? "viewed agent" }),
    action("Auto-compaction", { type: "autocompact-menu" }, { note: "Triggers and limits · new agents or model selection" }),
    action("Terminal settings", { type: "access.settings.terminal" }, { note: "Personal · next launch" }),
    action("Endpoint settings", { type: "access.settings.endpoints" }, { hint: "Disable endpoints, limit active agents, or remove credentials." }),
    action("Help", { type: "help" }),
  ];
}

function projectLabel(project) {
  return project.name ?? (basename(project.path) || project.path);
}

// The list shows names, never folder paths: users know where their projects
// live, and the path is not editable here.
function projectNote(project) {
  return [project.current ? "current" : undefined, project.open ? "open" : undefined,
    project.pinned ? "pinned" : undefined, ...(project.groups ?? [])].filter(Boolean).join(" · ");
}

function groupNames(data) {
  return [...new Set(data.projects.flatMap((project) => project.groups ?? []))].sort();
}

function projectsMenu(source, data) {
  const projects = source.group === undefined ? data.projects : data.projects.filter((project) => project.groups?.includes(source.group));
  const rows = [action("Open folder…", { type: "access.project.open" }),
    action("All groups", { type: "access.projects" }, { note: source.group === undefined ? "current filter" : undefined }),
    ...groupNames(data).map((group) => action(`Group: ${group}`, { type: "access.projects", group }, { note: source.group === group ? "current filter" : undefined }))];
  for (const project of projects) {
    rows.push(action(projectLabel(project), { type: "access.project.select", path: project.path }, {
      note: projectNote(project), description: project.description,
      preview: project.description ? { type: "agent-description", description: project.description } : undefined,
      role: project.current ? "menu.project menu.current" : "menu.project",
    }), action(`${projectLabel(project)} — add agent…`, { type: "access.add.form", path: project.path }, { note: "Keep existing chats open" }),
    action(`${projectLabel(project)} — details`, { type: "access.project.details", path: project.path }));
  }
  if (projects.length === 0) rows.push(info(source.group === undefined ? "(no known projects)" : "(no projects in this group)"));
  return menu(source.group === undefined ? "Projects" : `Projects / ${source.group}`, rows);
}

function projectMenu(source, data) {
  const project = data.projects.find(({ path }) => path === source.path);
  if (!project) return menu("Project", [info("(project is no longer available)")]);
  const name = projectLabel(project);
  const note = projectNote(project);
  return menu(`Project / ${name}`, [
    ...(note ? [info(note)] : []), ...(project.description ? [info(project.description)] : []),
    action("Select project", { type: "access.project.select", path: project.path }),
    action(project.pinned ? "Unpin project" : "Pin project", { type: "access.project.pin", path: project.path, pinned: !project.pinned }),
    action("Edit description…", { type: "access.project.description", path: project.path }),
    ...(project.open ? [action("Close project", { type: "access.project.close", path: project.path }, { hint: "Does not unpin the project." })] : []),
    { kind: "header", label: "Groups" },
    info("Joining a group pins this project and lets its agents reach the other members' resources."),
    ...groupNames(data).map((group) => {
      const member = project.groups?.includes(group) === true;
      return action(`${member ? "Leave" : "Join"} ${group}`, { type: "access.project.group", path: project.path, group, member: !member }, { note: member ? "member" : "not a member" });
    }),
    action("Create group…", { type: "access.project.group.new", path: project.path }),
  ]);
}

function agentRows(data) {
  return [
    ...data.agents.map(({ agent, name, child, current, busy, waitingForUser, description }) => action(
      `${child ? "  " : ""}${name ?? agent?.name ?? "__"}`,
      { type: "agent.switch", agent }, { note: [current ? "current" : undefined, busy ? "working" : undefined, waitingForUser ? "⚠️ waiting for your response" : undefined].filter(Boolean).join(" · "), role: current ? "menu.text menu.current" : undefined,
        preview: description ? { type: "agent-description", description } : undefined })),
    ...(data.agents.length === 0 ? [info("(no active agents)")] : []),
  ];
}

function sessionDescription(session) {
  const date = new Date(session.mtime ?? session.date);
  const when = Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 16).replace("T", " ");
  return [session.projectName ?? session.project ?? session.env?.name, session.id, when,
    `${session.messages ?? session.count ?? 0} messages`, session.live ? "live" : undefined].filter(Boolean).join(" · ");
}

function sessionProject(session) {
  return session.project ?? session.env?.folder;
}

function sessionProjects(data) {
  const projects = new Map(data.projects.map((project) => [project.path, projectLabel(project)]));
  for (const session of data.savedSessions) {
    const path = sessionProject(session);
    if (path !== undefined && !projects.has(path)) projects.set(path, session.projectName ?? session.env?.name ?? path);
  }
  return projects;
}

function sessionsMenu(source, data) {
  if (source.type === "access.session.actions") {
    const session = source.session;
    return menu(`Saved session / ${session.name ?? session.id}`, [
      info(sessionDescription(session)), ...(session.preview ? [info(session.preview)] : []),
      action(session.live ? "Resume — switch to live agent" : "Resume", { type: "access.session.resume", session }),
      action("Rename…", { type: "access.session.rename", session }),
      action("Delete…", { type: "access.session.delete", session }),
    ]);
  }
  const projects = sessionProjects(data);
  const sessions = source.project === undefined ? data.savedSessions : data.savedSessions.filter((session) => sessionProject(session) === source.project);
  const rows = [
    action("All projects", { type: "access.sessions" }, { note: source.project === undefined ? "current filter" : undefined }),
    ...[...projects].map(([project, name]) => action(`Project: ${name}`, { type: "access.sessions", project }, {
      note: source.project === project ? "current filter" : undefined,
    })),
    ...sessions.flatMap((session) => [action(session.name ?? session.preview ?? session.id, { type: "access.session.resume", session }, {
      note: sessionDescription(session), description: session.preview,
      hint: session.live ? "Switch to the live agent." : "Resume this saved session.",
      preview: session.preview ? { type: "agent-description", description: session.preview } : undefined,
    }), action(`${session.name ?? session.id} — manage…`, { type: "access.session.actions", session }, { note: "Rename or delete saved session" })]),
  ];
  if (data.sessionsLoading) rows.push(info("Loading saved sessions…"));
  else if (sessions.length === 0) rows.push(info(source.project === undefined ? "(no saved sessions)" : "(no saved sessions for this project)"));
  return menu(source.project === undefined ? "Saved sessions" : `Saved sessions / ${projects.get(source.project) ?? source.project}`, rows);
}

function currentSession(data) {
  const agent = data.agent;
  const env = agent?.env ?? data.currentEnv;
  const id = agent?.context?.id;
  return data.savedSessions.find((session) => (agent !== undefined && session.live === agent)
    || (id !== undefined && session.id === id && (!session.env || session.env === env) && (!session.project || session.project === env?.folder)))
    ?? { id, project: env?.folder, projectName: env?.name, env, live: agent };
}

function agentSettingsMenu(data) {
  // Existing builders own the permission locks and existing action vocabulary.
  const controls = buildMenuItems(data).filter((row) => ["thinking", "safe", "session-save", "agent.can.delegate-menu", "agent.can.request-menu"].includes(row.value?.type)
    || (row.kind === "info" && row.label.startsWith("Allow")));
  return menu("Agent settings", [
    info(`Applies to the viewed agent${data.agent?.name ? `: ${data.agent.name}` : ""}.`),
    action("Rename agent…", { type: "access.agent.rename", agent: data.agent }),
    ...controls,
    action("Fork session", { type: "command", lines: ["/session-fork"] }),
    action("Rename session…", { type: "access.session.rename", session: currentSession(data) }),
  ]);
}

function modelsMenu(data) {
  const rows = data.providers.flatMap(({ name, models = [], loginRequired }) => {
    if (loginRequired) return [action(`${name} — login required`, { type: "login", endpoint: name })];
    return (models.length ? models : [name]).map((model) => {
      const id = typeof model === "string" ? model : model.id;
      const value = models.length === 0 || id.startsWith(`${name}/`) ? id : `${name}/${id}`;
      return action(value, { type: "model", value }, { note: value === data.currentModel ? "current" : undefined });
    });
  });
  return menu("Models", rows.length ? rows : [info("(no known models)")]);
}

function settingRead(settings, key) {
  return key.split(".").reduce((value, part) => value?.[part], settings);
}

function settingLabel(value) {
  return value === undefined ? "inherit / automatic" : String(value);
}

function terminalMenu(data) {
  const rows = [info("Saved in your personal settings; applies on next launch. Project settings may override these choices.")];
  for (const [key, label, choices] of TERMINAL_CHOICES) {
    const personal = settingRead(data.personalSettings, key);
    const effective = settingRead(data.currentEnv?.settings, key) ?? personal;
    const note = `Personal: ${settingLabel(personal)} · Effective: ${settingLabel(effective)}${effective !== personal ? " (project override)" : ""}`;
    rows.push({ kind: "header", label: `${label} | ${note}` });
    for (const [value, choice] of choices) rows.push(action(`${label}: ${choice}`, { type: "access.terminal.set", key, value }, { note, hint: "Personal · next launch" }));
    rows.push(action(`${label}: Reset to inherit`, { type: "access.terminal.set", key, value: undefined }, { note, hint: "Personal · next launch" }));
  }
  return menu("Terminal settings", rows);
}

function toolsMenu(data) {
  const rows = data.tools.map(({ name, description, schema }) => {
    const required = schema?.parameters?.required ?? schema?.inputSchema?.required ?? schema?.required ?? [];
    const hint = required.length ? `Required arguments: ${required.join(", ")}. Complete JSON arguments before running.` : "Review the tool and JSON arguments before running.";
    return action(`/${name}`, { type: "access.tool", name, schema }, {
      description: description ?? schema?.description, note: required.length ? `required: ${required.join(", ")}` : "JSON arguments",
      hint, preview: { type: "agent-description", description: [description ?? schema?.description, hint].filter(Boolean).join("\n") },
    });
  });
  return menu("Tools", rows.length ? rows : [info("(no tools registered)")]);
}

function accessItems(source, data) {
  switch (source?.type) {
    case "access.projects": return projectsMenu(source, data);
    case "access.project.details": return projectMenu(source, data);
    case "access.sessions":
    case "access.session.actions": return sessionsMenu(source, data);
    case "access.settings.agent": return agentSettingsMenu(data);
    case "access.models": return modelsMenu(data);
    case "access.settings.terminal": return terminalMenu(data);
    case "access.settings.endpoints": return {
      title: "Endpoint settings", items: [
        ...buildEndpointPoliciesItems({ endpoints: data.endpointPolicies }),
        ...data.endpoints.map((endpoint) => action(`Logout — ${endpoint}`, { type: "logout", endpoint })),
      ],
    };
    case "access.tools.list": return toolsMenu(data);
    case "endpoint-policy": return {
      title: `Endpoints / ${source.endpoint}`,
      items: buildEndpointPolicyItems(data.endpointPolicies.find(({ name }) => name === source.endpoint) ?? { name: source.endpoint }).map((row) =>
        row.value?.type === "max-active-menu" ? { ...row, label: `${row.label}…`, value: { ...row.value, type: "access.endpoint.max" } } : row),
    };
    default: return undefined;
  }
}

/** Build a task-first root with live agent/endpoint rows (not the full search catalog).
 * @param {object} [options={}] masterMenuOptions plus agent, currentEnv, projects,
 * savedSessions, sessionsLoading and personalSettings (the caller's Env.settings).
 * Collections must be arrays; records use the menu-data shapes. Inputs are not
 * mutated. Agent, environment, session and tool-schema references are retained.
 * @returns {object[]} Fresh rows. Every action value is an object with a type.
 * No I/O, validation, execution or confirmation occurs; malformed records may throw.
 * @example buildAccessRoot({ projects: [{ path: "/work", name: "work" }] });
 */
export function buildAccessRoot(options = {}) {
  return rootRows(normalize(options));
}

/** Resolve one access navigation source into its menu, without executing it.
 * @param {object} source An access.* descriptor or endpoint-policy.
 * access.sessions accepts project: path to filter (omitting it selects all projects).
 * Missing projects produce an explanatory menu; unknown/leaf types are unsupported.
 * @param {object} [options={}] Same snapshot contract as buildAccessRoot. Supply
 * personalSettings: Env.settings and currentEnv.settings for truthful terminal scope.
 * @returns {{title:string,items:object[]}|undefined} Fresh submenu with a back row,
 * or undefined for an unsupported type. Retains target references; no mutation/I/O.
 * Property access errors from malformed input propagate (safe to retry after repair).
 * @example buildAccessItems({ type: "access.projects", group: "team" }, options);
 * @example buildAccessItems({ type: "unknown" }) === undefined;
 */
export function buildAccessItems(source, options = {}) {
  return accessItems(source, normalize(options));
}

function searchChildren(value, data) {
  const own = accessItems(value, data);
  if (own) return own;
  switch (value.type) {
    case "help": return { title: "Help", items: buildHelpItems() };
    case "prompts": return { title: "Prompts", items: buildPromptItems(value) };
    case "themes": return { title: "Themes", items: buildThemeItems(value) };
    case "provider": return { title: value.value, items: buildProviderItems(value) };
    case "session-close-menu": return { title: "Close agent", items: buildSessionCloseItems(value) };
    case "agent.can.delegate-menu": return { title: "Allow to Delegate", items: buildSpawnPermissionItems(value) };
    case "agent.can.request-menu": return { title: "Allow group request", items: buildRequestPermissionItems(value) };
    default: return undefined;
  }
}

/** Build a flat, unfiltered action-search catalog, including nested choices.
 * @param {object} [options={}] Same snapshot contract as buildAccessRoot. Duplicate
 * names are supported; captured agent/session identities distinguish their actions.
 * @returns {object[]} Fresh action rows with breadcrumb note and contextual hint.
 * Excludes info/back rows, does not mutate or execute inputs, and performs no I/O.
 * Work is proportional to the snapshot menus and their emitted choices. Errors
 * from malformed records propagate; rebuild after repairing the snapshot.
 * @example buildActionSearch(options).filter((row) => row.label.includes("model"));
 * @example buildAccessItems(buildAccessRoot(options).find((row) => row.value?.type === "access.projects").value, options);
 */
export function buildActionSearch(options = {}) {
  const data = normalize(options);
  const result = [];
  const visited = new Set();
  const emitted = new Set();
  const identities = new Map();
  const identity = (value) => {
    if (!identities.has(value)) identities.set(value, identities.size);
    return identities.get(value);
  };
  // Values are trusted catalog records; do not stringify retained Env/Agent objects.
  const keyFor = (value) => Object.entries(value).map(([key, field]) =>
    `${key}:${field !== null && typeof field === "object" ? `#${identity(field)}` : `${typeof field}:${String(field)}`}`).join("|");
  const visit = (items, breadcrumb) => {
    for (const row of items) {
      const value = row.value;
      if (row.kind !== "action" || !value || value.type === "back") continue;
      // Collection snapshots are deliberately not part of a navigation key.
      const key = keyFor(Object.fromEntries(Object.entries(value).filter(([name]) => !["agents", "themes", "prompts", "endpoints", "lines"].includes(name))))
        + (value.lines ? `|${value.lines.join("\n")}` : "");
      if (!emitted.has(key)) {
        emitted.add(key);
        result.push({ ...row, note: [breadcrumb.join(" › "), row.note].filter(Boolean).join(" · "), hint: row.hint ?? row.description ?? "Select to open or apply this action." });
      }
      if (visited.has(key)) continue;
      visited.add(key);
      // Filters revisit actions already indexed by their unfiltered menus.
      if ((value.type === "access.projects" && value.group !== undefined)
        || (value.type === "access.sessions" && value.project !== undefined)) continue;
      const child = searchChildren(value, data);
      if (child) visit(child.items, [...breadcrumb, row.label]);
    }
  };
  visit(rootRows(data), ["Actions"]);
  visit(NEW_CHAT_VARIANTS.map(([label, lines]) => action(label, { type: "command", lines: [...lines] }, {
    hint: "Replaces the current chat. To keep it open, use Add agent.",
  })), ["Actions", "New chat"]);
  visit(data.commands.map((command) => action(command, { type: "insert", text: `${command} ` })), ["Commands"]);
  return result;
}
