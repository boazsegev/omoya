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

/** Create a schema row descriptor.
 * @param {string} kind - Row kind.
 * @param {*} label - Static label or data-to-label function.
 * @param {*} value - Static value or data-to-value function.
 * @param {Function} [when=() => true] - Predicate controlling row inclusion.
 * @returns {{kind: string, label: *, value: *, when: Function}} Schema descriptor; does not mutate inputs.
 */
const item = (kind, label, value, when = () => true) => ({ kind, label, value, when });
/** Create a repeated schema row descriptor.
 * @param {*} values - Static collection or function returning collection.
 * @param {Function} build - Builds one menu row per collection value.
 * @param {Function} [when=() => true] - Predicate controlling inclusion.
 * @returns {{each: *, build: Function, when: Function}} Schema descriptor.
 */
const each = (values, build, when = () => true) => ({ each: values, build, when });
/** Format a singular/plural count.
 * @param {{length:number}} values - Counted collection.
 * @param {*} one - Result when length is one.
 * @param {Function} many - Formats all other lengths, receiving length.
 * @returns {*} The selected singular or plural representation.
 */
const count = (values, one, many) => values.length === 1 ? one : many(values.length);

/** Declarative main-menu layout. Reorder, remove, or insert rows here only. */
export const MENU_SCHEMA = Object.freeze([
  item("action", "Help | keybindings", { type: "help" }),
  item("action", ({ prompts }) => `Prompts | ${count(prompts, "1 prompt", (n) => `${n} prompts`)}`, ({ prompts }) => ({ type: "prompts", prompts }), ({ prompts }) => prompts.length > 0),
  item("action", ({ tools }) => `Tools | ${count(tools, "1 tool", (n) => `${n} tools`)}`, ({ tools }) => ({ type: "tools", tools }), ({ tools }) => tools.length > 0),
  item("action", ({ theme }) => `Themes | current: ${theme}`, ({ themes, theme }) => ({ type: "themes", themes, value: theme })),
  item("header", ({ agents }) => `Sessions | ${agents.length} active`),
  each(({ agents }) => agents, ({ agent, name, current, child, busy, description }) => ({
    kind: "action",
    label: `${child ? "  " : ""}${name ?? agent?.name ?? "__"}${busy ? " | 🟠 working" : ""}`,
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
  item("action", ({ endpointPolicies }) => `Endpoints | disable · max active (${count(endpointPolicies, "1 endpoint", (n) => `${n} endpoints`)})`, { type: "endpoint-policies" }, ({ endpointPolicies }) => endpointPolicies.length > 0),
  item("header", "Commands — top level (Enter inserts into the input)", undefined, ({ commands }) => commands.some((command) => !command.slice(1).includes("-"))),
  each(({ commands }) => commands.filter((command) => !command.slice(1).includes("-")), (command) => ({ kind: "action", label: command, value: { type: "insert", text: `${command} ` } })),
  item("header", "Commands — built-in", undefined, ({ commands }) => commands.some((command) => command.slice(1).includes("-"))),
  each(({ commands }) => commands.filter((command) => command.slice(1).includes("-")), (command) => ({ kind: "action", label: command, value: { type: "insert", text: `${command} ` } })),
]);

/** Resolve a literal or data-dependent schema value.
 * @param {*} value - Literal value or function accepting data.
 * @param {*} data - Data passed to a function value.
 * @returns {*} The literal or function result. Function errors propagate.
 */
const resolve = (value, data) => typeof value === "function" ? value(data) : value;
/** Build menu rows from declarative schema entries.
 * @param {Array} schema - Row descriptors, evaluated in order.
 * @param {*} data - Input supplied to row predicates and value functions.
 * @returns {Array} Renderable menu item objects. Callback errors propagate; inputs are not mutated.
 */
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

/** Build the main menu using defaults overridden by supplied data.
 * @param {Object} [options={}] - Menu data (commands, providers, sessions, settings, and related collections).
 * @returns {Array} Main-menu item objects. Does not mutate options; malformed data errors propagate.
 */
export function buildMenuItems(options = {}) {
  const data = {
    commands: [], prompts: [], tools: [], endpoints: [], providers: [], currentModel: "(none)",
    thinkingLevels: [], thinkingLevel: undefined, sessions: [], agents: [], addProviders: [], safeMode: false, sessionSave: undefined, themes: ["default"],
    theme: "default", spawnPermission: undefined, endpointPolicies: [], ...options,
  };
  return buildFromSchema(MENU_SCHEMA, data);
}

/** Build permission-choice rows, marking the current choice.
 * @param {Object} [options={}] - Options object.
 * @param {boolean|string} [options.value] - Current permission (`true`, `false`, or other/unspecified for Ask).
 * @returns {Array} Permission menu items; no side effects.
 */
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

/** Build theme selection rows.
 * @param {Object} [options={}] - Options object.
 * @param {string[]} [options.themes=["default"]] - Available theme names.
 * @param {string} [options.value="default"] - Current theme name.
 * @returns {Array} Theme menu items with preview metadata; no side effects.
 */
export function buildThemeItems({ themes = ["default"], value = "default" } = {}) {
  return [
    { kind: "header", label: "Themes — ↑/↓ preview · Enter apply" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...themes.map((name) => ({ kind: "action", label: `${name}${name === value ? " (current)" : ""}`, value: { type: "theme.set", value: name }, preview: { type: "theme", name } })),
  ];
}

/** Build the keybinding help menu.
 * @returns {Array} Help menu items derived from {@link KEYBINDINGS}; no side effects.
 */
export function buildHelpItems() {
  return [
    { kind: "header", label: "Help — keybindings" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...KEYBINDINGS.map(([key, action]) => ({ kind: "info", label: `${key.padEnd(10)} ${action}` })),
  ];
}

/** Build prompt insertion rows.
 * @param {Object} [options={}] - Options object.
 * @param {string[]} [options.prompts=[]] - Prompt names.
 * @returns {Array} Prompt menu items; no side effects.
 */
export function buildPromptItems({ prompts = [] } = {}) {
  return [
    { kind: "header", label: "Prompts (Enter inserts into the input)" },
    { kind: "action", label: "← back", value: { type: "back" } },
    ...prompts.map((name) => ({ kind: "action", label: `/${name}`, value: { type: "insert", text: `/${name} ` } })),
  ];
}

/** Build tool insertion rows, including an empty-state message.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.tools=[]] - Tools with name and optional description.
 * @returns {Array} Tool menu items; no side effects.
 */
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

/** Build saved-session resume rows.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.sessions=[]] - Sessions with mtime, id, messages, and optional agent/preview.
 * @returns {Array} Resume menu items; date formatting uses the local locale. Invalid session data may throw.
 */
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
      description: [session.agent ? `${session.agent}:` : null, session.preview ? `“${session.preview}”` : null].filter(Boolean).join(" ") || undefined,
      value: { type: "resume", value: session.id },
    });
  }
  return items;
}

/** Build endpoint logout rows.
 * @param {Object} [options={}] - Options object.
 * @param {string[]} [options.endpoints=[]] - Configured endpoint names.
 * @returns {Array} Logout menu items; no side effects.
 */
export function buildLogoutItems({ endpoints = [] } = {}) {
  const items = [{ kind: "header", label: "Logout — choose endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (endpoints.length === 0) return [...items, { kind: "info", label: "(no endpoints configured)" }];
  return [...items, ...endpoints.map((endpoint) => ({ kind: "action", label: `${endpoint} | remove settings + auth`, value: { type: "logout", endpoint } }))];
}

/** Build the session menu using the main-menu schema.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.providers=[]] - Provider data.
 * @param {Object[]} [options.sessions=[]] - Saved sessions.
 * @returns {Array} Main-menu items; behavior/errors match {@link buildMenuItems}.
 */
export function buildSessionMenuItems({ providers = [], sessions = [] } = {}) {
  return buildMenuItems({ providers, sessions });
}
/** Build rows for adding a provider session.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.providers=[]] - Providers with name, models, availability, limit, and excluded fields.
 * @returns {Array} Provider selection items; no side effects.
 */
export function buildSessionAddItems({ providers = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / Add — choose endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (providers.length === 0) return [...items, { kind: "info", label: "(no endpoints configured)" }];
  return [...items, ...providers.map(({ name, models = [], available, limit, excluded }) => ({
    kind: excluded ? "info" : "action",
    label: `${name} | ${available}/${limit} available`,
    value: excluded ? undefined : { type: "session-add-provider", endpoint: name, models },
  }))];
}

/** Build rows for adding a model session at an endpoint.
 * @param {Object} [options={}] - Options object.
 * @param {string} options.endpoint - Endpoint name.
 * @param {Object[]} [options.models=[]] - Models with id, availability, limit, and excluded fields.
 * @returns {Array} Model selection items; no side effects.
 */
export function buildSessionAddModelItems({ endpoint, models = [] } = {}) {
  const items = [{ kind: "header", label: `Sessions / Add — ${endpoint}` }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (models.length === 0) return [...items, { kind: "info", label: "(no models available)" }];
  return [...items, ...models.map(({ id, available, limit, excluded }) => ({
    kind: excluded ? "info" : "action",
    label: `${id} | ${available}/${limit} available`,
    value: excluded ? undefined : { type: "session-add", endpoint, model: id },
  }))];
}

/** Build actions for replacing the current session.
 * @param {Object} [options={}] - Options object; providers is accepted for API compatibility but unused.
 * @param {Object[]} [options.providers=[]] - Provider list (unused).
 * @returns {Array} New-session action items; no side effects.
 */
export function buildSessionNewItems({ providers = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / New — replace this session" }, { kind: "action", label: "← back", value: { type: "back" } },
    { kind: "action", label: "New", value: { type: "new-session" } }, { kind: "action", label: "New, Read Only", value: { type: "new-session", safe: true } },
    { kind: "action", label: "Unlogged", value: { type: "anon-session" } }, { kind: "action", label: "Unlogged, Read Only", value: { type: "anon-session", safe: true } }];
  return items;
}

/** Build actions to close an active session. The agent references in action values
 * preserve the target captured for this menu, so redraws do not change it.
 *
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.agents=[]] - Active-agent records used to identify close targets.
 * @returns {Array} Close-session items; captures agent references in action values and does not mutate input.
 */
export function buildSessionCloseItems({ agents = [] } = {}) {
  const items = [{ kind: "header", label: "Sessions / Close — choose session" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (agents.length === 0) return [...items, { kind: "info", label: "(no active sessions)" }];
  return [...items, ...agents.map(({ agent, name, current, child, busy }) => ({
    kind: "action",
    label: `${child ? "  " : ""}${name ?? agent?.name ?? "__"}${current ? " (current)" : ""}${busy ? " | 🟠 working" : ""}`,
    value: { type: "agent.close", agent },
  }))];
}
/**
 * ^P — the endpoint selection menu: every configured endpoint (Enter
 * drills into its models via buildProviderItems, the same sub-menu the
 * ^X menu's Models section uses) plus a row to add a new one.
 */
/** Build endpoint selection rows for the provider menu.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.providers=[]] - Providers with name, models, and optional loginRequired.
 * @param {string} [options.combo=""] - Current endpoint/model combination shown in heading.
 * @returns {Array} Endpoint and login menu items; no side effects.
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
 * The login wizard's preset picker: env.loginPresets() presets plus a
 * manual fallback. Selecting one runs the login through the TUI: an
 * OAuth preset kicks off the browser sign-in (oauth-login), every other
 * preset fills the tested `/endpoint-login` direct form into the draft
 * so the user only completes/submits ONE command.
 */
/** Build login preset and manual-login rows.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.presets=[]] - Presets containing label, oauth, name, provider, and url.
 * @returns {Array} Login menu items; no authentication is performed here.
 */
export function buildLoginItems({ presets = [], mcp = [] } = {}) {
  const items = [{ kind: "header", label: "Login — choose an endpoint" }, { kind: "action", label: "← back", value: { type: "back" } }];
  for (const preset of presets) {
    const note = preset.oauth ? " (browser sign-in)" : "";
    items.push({
      kind: "action",
      label: `${preset.label}${note}`,
      value: preset.oauth ? { type: "oauth-login", preset } : { type: "insert", text: `/endpoint-login package ${preset.name} ${preset.provider} ${preset.url} ` },
    });
  }
  for (const entry of mcp) items.push({ kind: "action", label: `MCP: ${entry.name}${entry.state === "needs-sign-in" ? " (needs sign-in)" : ""}`,
    value: { type: "insert", text: `/mcp-login ${entry.name}` } });
  items.push({ kind: "action", label: "Manual — enter every field yourself", value: { type: "insert", text: "/endpoint-login " } });
  return items;
}

/** Build model selection rows for a provider.
 * @param {Object} [options={}] - Options object.
 * @param {string} [options.value] - Provider name (used as `name`).
 * @param {string[]} [options.models=[]] - Model identifiers.
 * @returns {Array} Model menu items; no side effects.
 */
export function buildProviderItems({ value: name, models = [] } = {}) {
  const items = [{ kind: "header", label: `Models — ${name}` }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (models.length === 0) items.push({ kind: "action", label: "(no cached models — select the provider's first available)", value: { type: "model", value: name } });
  for (const id of models) items.push({ kind: "action", label: id.startsWith(`${name}/`) ? id.slice(name.length + 1) : id, value: { type: "model", value: `${name}/${id}` } });
  return items;
}

/** Format a configured maxActive value for a menu label.
 * @param {number|false|undefined} value - configured override (undefined inherits)
 * @param {number|undefined} effective - the capacity currently in force, when known
 * @returns {string} "inherit (n)", "excluded", or the number
 */
const maxActiveLabel = (value, effective) => value === undefined ? `inherit${effective === undefined ? "" : ` (${effective})`}` : value === false ? "excluded" : String(value);

/** Preset maxActive choices offered by the TUI menu (settings.json accepts any non-negative integer). */
export const MAX_ACTIVE_CHOICES = Object.freeze([1, 2, 3, 4, 6, 8, 12, 16]);

/** Build the endpoint policy list: one row per endpoint with its state.
 * @param {Object} [options={}] - Options object.
 * @param {Object[]} [options.endpoints=[]] - CLI.endpointPolicies() entries.
 * @returns {Array} Endpoint rows drilling into buildEndpointPolicyItems; no side effects.
 */
export function buildEndpointPoliciesItems({ endpoints = [] } = {}) {
  const items = [{ kind: "header", label: "Endpoints — disable · max active" }, { kind: "action", label: "← back", value: { type: "back" } }];
  if (endpoints.length === 0) return [...items, { kind: "info", label: "(no endpoints configured)" }];
  return [...items, ...endpoints.map(({ name, disabled, maxActive, effective }) => ({
    kind: "action",
    label: `${name} | ${disabled ? "disabled" : "enabled"} · max active: ${maxActiveLabel(maxActive, effective)}`,
    value: { type: "endpoint-policy", endpoint: name },
  }))];
}

/** Build one endpoint's policy rows: the disabled toggle, its maxActive, and each model's maxActive.
 * @param {Object} [options={}] - One CLI.endpointPolicies() entry.
 * @returns {Array} Policy rows; no side effects.
 */
export function buildEndpointPolicyItems({ name, disabled = false, maxActive, effective, models = [] } = {}) {
  const items = [
    { kind: "header", label: `Endpoint — ${name}` },
    { kind: "action", label: "← back", value: { type: "back" } },
    { kind: "action", label: `disabled: ${disabled ? "on (hidden, refuses requests)" : "off"}  (toggle)`, value: { type: "endpoint-policy.set", selector: name, change: { disabled: !disabled } } },
    { kind: "action", label: `max active: ${maxActiveLabel(maxActive, effective)}`, value: { type: "max-active-menu", selector: name, value: maxActive, effective } },
  ];
  if (models.length > 0) items.push({ kind: "header", label: "Models — max active" });
  for (const model of models) {
    items.push({ kind: "action", label: `${model.id} | ${maxActiveLabel(model.maxActive, model.effective)}`, value: { type: "max-active-menu", selector: `${name}/${model.id}`, value: model.maxActive, effective: model.effective } });
  }
  return items;
}

/** Build maxActive choices for an endpoint or endpoint/model selector.
 * @param {Object} [options={}] - Options object.
 * @param {string} options.selector - `<endpoint>` or `<endpoint>/<model>`.
 * @param {number|false|undefined} [options.value] - Current configured value.
 * @param {number|undefined} [options.effective] - Capacity currently in force.
 * @returns {Array} Choice rows; no side effects.
 */
export function buildMaxActiveItems({ selector, value, effective } = {}) {
  /** Build one choice row.
   * @param {string} label - Row label.
   * @param {number|false|undefined} choiceValue - Value the row sets.
   * @returns {object} Menu action row.
   */
  const choice = (label, choiceValue) => ({
    kind: "action",
    label: `${label}${choiceValue === value ? " (current)" : ""}`,
    value: { type: "endpoint-policy.set", selector, change: { maxActive: choiceValue }, pop: true },
  });
  const numbers = Number.isInteger(value) && value > 0 && !MAX_ACTIVE_CHOICES.includes(value) ? [...MAX_ACTIVE_CHOICES, value].sort((a, b) => a - b) : MAX_ACTIVE_CHOICES;
  return [
    { kind: "header", label: `Max active — ${selector}` },
    { kind: "action", label: "← back", value: { type: "back" } },
    choice(maxActiveLabel(undefined, value === undefined ? effective : undefined), undefined),
    choice("excluded (0)", false),
    ...numbers.map((number) => choice(String(number), number)),
  ];
}
