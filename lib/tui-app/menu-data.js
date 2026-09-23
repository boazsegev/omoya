/** AI-specific menu trees and action values. No layout, input loop, or terminal styling. */

export const KEYBINDINGS = Object.freeze([
  ["Enter", "submit (trailing \\ continues the line)"],
  ["Shift/Alt+Enter", "soft break (same as trailing \\)"],
  ["Tab / ↓", "complete command / argument / path"],
  ["Shift+Tab / ↑", "previous completion while the list is open"],
  ["↑ / ↓", "move in buffer, then history"],
  ["Alt+← / →", "word left / right"],
  ["Ctrl+← / →", "start / end of line"],
  ["Alt+Backspace", "delete last word"],
  ["Ctrl+Backspace", "delete the line"],
  ["^O", "full view of thinking/tool/text blocks (toggles)"],
  ["Alt+Shift+F", "fork the session through the viewed message"],
  ["^X", "this menu (toggles)"],
  ["^P", "provider selection menu"],
  ["^M", "model menu of the current endpoint (CSI terminals)"],
  ["PgUp / PgDn", "scroll the transcript (the wheel scrolls too)"],
  ["Alt+Shift+↑", "unqueue the pending messages into the input"],
  ["Alt+Ctrl+← / →", "move between questions while one is open"],
  ["Alt+Ctrl+← / →", "move between questions while one is open"],
  ["Mouse", "click: cursor / pick a menu row · wheel: scroll"],
  ["^C / Esc", "close the pager/menu; cancel the running response"],
  ["^C", "clear the input; again on empty input exits"],
  ["^D", "delete forward; EOF on an empty line"],
]);

const item = (kind, label, value, when = () => true) => ({ kind, label, value, when });
const each = (values, build, when = () => true) => ({ each: values, build, when });
const count = (values, one, many) => values.length === 1 ? one : many(values.length);

/** Declarative main-menu layout. Reorder, remove, or insert rows here only. */
export const MENU_SCHEMA = Object.freeze([
  item("action", "Help | keybindings", { type: "help" }),
  item("action", ({ prompts }) => `Prompts | ${count(prompts, "1 prompt", (n) => `${n} prompts`)}`, ({ prompts }) => ({ type: "prompts", prompts }), ({ prompts }) => prompts.length > 0),
  item("action", ({ tools }) => `Tools | ${count(tools, "1 tool", (n) => `${n} tools`)}`, ({ tools }) => ({ type: "tools", tools }), ({ tools }) => tools.length > 0),
  item("action", ({ theme }) => `Themes | current: ${theme}`, ({ themes, theme }) => ({ type: "themes", themes, value: theme })),
  item("header", ({ agents }) => `Sessions | ${agents.length} active`),
  each(({ agents }) => agents, ({ agent, current, child, busy, description }) => ({
    kind: "action",
    label: `${child ? "  " : ""}${agent?.name ?? "__"}${busy ? " | 🟠 working" : ""}`,
    role: current ? "menu.text menu.current" : undefined,
    value: { type: "agent.switch", agent },
    preview: description ? { type: "agent-description", description } : undefined,
  })),
  item("action", "New | replace this session", ({ providers }) => ({ type: "session-new-menu", providers })),
  item("action", "Add | keep this session open", ({ addProviders }) => ({ type: "session-add-menu", providers: addProviders })),
  item("action", ({ agents }) => `Close | ${count(agents, "1 active session", (n) => `${n} active sessions`)}`, ({ agents }) => ({ type: "session-close-menu", agents: [...agents] }), ({ agents }) => agents.length > 0),
  item("action", ({ sessions }) => `Resume | replace this session${sessions.length ? ` (${sessions.length} saved)` : ""}`, ({ sessions }) => ({ type: "sessions", sessions: [...sessions] })),
  item("header", ({ currentModel }) => `Models | current: ${currentModel}`),
  item("action", "(no known models)", { type: "none" }, ({ providers }) => providers.length === 0),
  each(({ providers }) => providers, ({ name, models = [], loginRequired }) => loginRequired === true
    ? { kind: "action", label: `${name}  (login)`, value: { type: "login", endpoint: name } }
    : { kind: "action", label: `${name}  (${count(models, "1 model", (n) => `${n} models`)})`, value: { type: "provider", value: name, models } }),
  item("action", "Login | add an endpoint", { type: "login" }),
  item("action", ({ endpoints }) => `Logout | (remove one of ${endpoints.length} endpoints)`, ({ endpoints }) => ({ type: "logout-menu", endpoints: [...endpoints] }), ({ endpoints }) => endpoints.length > 0),
  item("header", ({ thinkingLevel }) => `Settings — thinking level (current: ${thinkingLevel ?? "provider default"})`, undefined, ({ thinkingLevels }) => thinkingLevels.length > 0),
  each(({ thinkingLevels }) => thinkingLevels, (level) => ({ kind: "action", label: `thinking: ${level}`, value: { type: "thinking", value: level } })),
  item("action", ({ safeMode }) => `safe mode: ${safeMode ? "on (read-only tools only)" : "off"}  (toggle)`, ({ safeMode }) => ({ type: "safe", value: safeMode ? "off" : "on" })),
  item("action", ({ sessionSave }) => `session save: ${sessionSave ? "on" : "off (memory only)"}  (toggle)`, ({ sessionSave }) => ({ type: "session-save", value: sessionSave !== true }), ({ sessionSave }) => sessionSave !== undefined),
  item("action", ({ spawnPermission }) => `Allow to Delegate | ${spawnPermission === true ? "Allow" : spawnPermission === false ? "Deny" : "Ask"}`, ({ spawnPermission }) => ({
    type: "spawn-permission-menu",
    value: spawnPermission,
  })),
  item("header", "Commands — top level (Enter inserts into the input)", undefined, ({ commands }) => commands.some((command) => !command.slice(1).includes("-"))),
  each(({ commands }) => commands.filter((command) => !command.slice(1).includes("-")), (command) => ({ kind: "action", label: command, value: { type: "insert", text: `${command} ` } })),
  item("header", "Commands — built-in", undefined, ({ commands }) => commands.some((command) => command.slice(1).includes("-"))),
  each(({ commands }) => commands.filter((command) => command.slice(1).includes("-")), (command) => ({ kind: "action", label: command, value: { type: "insert", text: `${command} ` } })),
]);

const resolve = (value, data) => typeof value === "function" ? value(data) : value;
export function buildFromSchema(schema, data) {
  const items = [];
  for (const row of schema) {
    if (!row.when(data)) continue;
    if (row.each) {
      for (const value of resolve(row.each, data)) items.push(row.build(value, data));
      continue;
    }
    const built = { kind: row.kind, label: resolve(row.label, data) };
    const value = resolve(row.value, data);
    if (value !== undefined) built.value = value;
    items.push(built);
  }
  return items;
}

export function buildMenuItems(options = {}) {
  const data = {
    commands: [], prompts: [], tools: [], endpoints: [], providers: [], currentModel: "(none)",
    thinkingLevels: [], thinkingLevel: undefined, sessions: [], agents: [], addProviders: [], safeMode: false, sessionSave: undefined, themes: ["default"],
    theme: "default", spawnPermission: undefined, ...options,
  };
  return buildFromSchema(MENU_SCHEMA, data);
}

export function buildSpawnPermissionItems({ value } = {}) {
  const current = value === true ? "Allow" : value === false ? "Deny" : "Ask";
  return [
    { kind: "header", label: "Allow to Delegate" },
    { kind: "action", label: "← back", value: { type: "back" } },
    { kind: "action", label: `Allow${current === "Allow" ? " (current)" : ""}`, value: { type: "spawn-permission", value: true } },
    { kind: "action", label: `Deny${current === "Deny" ? " (current)" : ""}`, value: { type: "spawn-permission", value: false } },
    { kind: "action", label: `Ask${current === "Ask" ? " (current)" : ""}`, value: { type: "spawn-permission", value: "Ask" } },
  ];
}

export function buildThemeItems({ themes = ["default"], value = "default" } = {}) {
  return [
    { kind: "header", label: "Themes — ↑/↓ preview · Enter apply" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...themes.map((name) => ({ kind: "action", label: `${name}${name === value ? " (current)" : ""}`, value: { type: "theme.set", value: name }, preview: { type: "theme", name } })),
  ];
}

export function buildHelpItems() {
  return [
    { kind: "header", label: "Help — keybindings" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...KEYBINDINGS.map(([key, action]) => ({ kind: "info", label: `${key.padEnd(10)} ${action}` })),
  ];
}

export function buildPromptItems({ prompts = [] } = {}) {
  return [
    { kind: "header", label: "Prompts (Enter inserts into the input)" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...prompts.map((name) => ({ kind: "action", label: `/${name}`, value: { type: "insert", text: `/${name} ` } })),
  ];
}

export function buildToolsItems({ tools = [] } = {}) {
  const items = [
    { kind: "header", label: "Tools (Enter inserts into the input; add JSON args before Enter)" },
    { kind: "action", label: "← back", value: { type: "back" } },
  ];
  if (tools.length === 0) return [...items, { kind: "info", label: "(no tools registered)" }];
  return [...items, ...tools.map(({ name, description }) => ({
    kind: "action", label: `/${name}${description ? ` — ${description}` : ""}`, value: { type: "insert", text: `/${name} ` },
  }))];
}

export function buildResumeItems({ sessions = [] } = {}) {
  const items = [{ kind: "header", label: "Resume — sessions (latest first)" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (sessions.length === 0) return [...items, { kind: "info", label: "(no sessions of this folder)" }];
  for (const session of sessions) {
    const date = new Date(session.mtime);
    const when = `${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0, 5)}`;
    const id = session.id.length > 12 ? `${session.id.slice(0, 8)}…` : session.id;
    items.push({
      kind: "action",
      label: `${id}  ${when} (${session.messages} messages)`,
      description: session.preview ? `“${session.preview}”` : undefined,
      value: { type: "resume", value: session.id },
    });
  }
  return items;
}

export function buildLogoutItems({ endpoints = [] } = {}) {
  const items = [{ kind: "header", label: "Logout — choose endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (endpoints.length === 0) return [...items, { kind: "info", label: "(no endpoints configured)" }];
  return [...items, ...endpoints.map((endpoint) => ({ kind: "action", label: `${endpoint} | remove settings + auth`, value: { type: "logout", endpoint } }))];
}

export function buildSessionMenuItems({ providers = [], sessions = [] } = {}) {
  return buildMenuItems({ providers, sessions });
}
export function buildSessionAddItems({ providers = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / Add — choose endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (providers.length === 0) return [...items, { kind: "info", label: "(no endpoints configured)" }];
  return [...items, ...providers.map(({ name, models = [], available, limit, excluded }) => ({
    kind: excluded ? "info" : "action",
    label: `${name} | ${available}/${limit} available`,
    value: excluded ? undefined : { type: "session-add-provider", endpoint: name, models },
  }))];
}

export function buildSessionAddModelItems({ endpoint, models = [] } = {}) {
  const items = [{ kind: "header", label: `Sessions / Add — ${endpoint}` }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (models.length === 0) return [...items, { kind: "info", label: "(no models available)" }];
  return [...items, ...models.map(({ id, available, limit, excluded }) => ({
    kind: excluded ? "info" : "action",
    label: `${id} | ${available}/${limit} available`,
    value: excluded ? undefined : { type: "session-add", endpoint, model: id },
  }))];
}

export function buildSessionNewItems({ providers = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / New — replace this session" }, { kind: "action", label: "← back", value: { type: "back" } },
    { kind: "action", label: "New", value: { type: "new-session" } }, { kind: "action", label: "New, Read Only", value: { type: "new-session", safe: true } },
    { kind: "action", label: "Unlogged", value: { type: "anon-session" } }, { kind: "action", label: "Unlogged, Read Only", value: { type: "anon-session", safe: true } }];
  return items;
}

/** A frozen active-agent snapshot prevents menu redraws from changing its target. */
export function buildSessionCloseItems({ agents = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / Close — choose session" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (agents.length === 0) return [...items, { kind: "info", label: "(no active sessions)" }];
  return [...items, ...agents.map(({ agent, current, child, busy }) => ({
    kind: "action",
    label: `${child ? "  " : ""}${agent?.name ?? "__"}${current ? " (current)" : ""}${busy ? " | 🟠 working" : ""}`,
    value: { type: "agent.close", agent },
  }))];
}
/**
 * ^P — the endpoint selection menu: every configured endpoint (Enter
 * drills into its models via buildProviderItems, the same sub-menu the
 * ^X menu's Models section uses) plus a row to add a new one.
 */
export function buildEndpointItems({ providers = [], combo = "" } = {}) {
  const items = [{ kind: "header", label: `Endpoints (current: ${combo})` }];
  if (providers.length === 0) items.push({ kind: "info", label: "(no endpoints configured)" });
  for (const { name, models = [], loginRequired } of providers) {
    items.push(loginRequired === true
      ? { kind: "action", label: `${name}  (login)`, value: { type: "login", endpoint: name } }
      : { kind: "action", label: `${name}  (${models.length === 1 ? "1 model" : `${models.length} models`})`, value: { type: "provider", value: name, models } });
  }
  items.push({ kind: "action", label: "Login — add an endpoint", value: { type: "login" } });
  return items;
}

/**
 * The login wizard's preset picker: env.knownEndpoints() presets plus a
 * manual fallback. Selecting one INSERTS the matching `/endpoint-login`
 * command into the input box (a preset's oauth descriptor still needs
 * automatic browser sign-in — noted, not run, until that's built) so
 * the user only ever completes/submits ONE already-tested command.
 */
export function buildLoginItems({ presets = [] } = {}) {
  const items = [{ kind: "header", label: "Login — choose an endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  for (const preset of presets) {
    const note = preset.oauth ? " (browser sign-in)" : "";
    items.push({
      kind: "action",
      label: `${preset.label}${note}`,
      value: preset.oauth ? { type: "oauth-login" } : { type: "insert", text: `/endpoint-login package ${preset.name} ${preset.provider} ${preset.url} ` },
    });
  }
  items.push({ kind: "action", label: "Manual — enter every field yourself", value: { type: "insert", text: "/endpoint-login " } });
  return items;
}

export function buildProviderItems({ value: name, models = [] } = {}) {
  const items = [{ kind: "header", label: `Models — ${name}` }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (models.length === 0) items.push({ kind: "action", label: "(no cached models — select the provider's first available)", value: { type: "model", value: name } });
  for (const id of models) items.push({ kind: "action", label: id.startsWith(`${name}/`) ? id.slice(name.length + 1) : id, value: { type: "model", value: `${name}/${id}` } });
  return items;
}
