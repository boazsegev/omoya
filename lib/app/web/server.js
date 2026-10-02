/**
 * lib/web-app/server.js — the web front end's Bun host: serves the SPA
 * over HTTP and drives one AgentSession per WebSocket connection.
 *
 * PUBLIC SURFACE of the web app (lib/web.js re-exports it). The web app
 * depends ONLY on public library façades — Agent, Env, CLI, Context — and
 * knows nothing about the TUI/GTUI; the core library knows nothing about
 * the web. Deleting lib/web-app/ plus the `--serve` lines in
 * bin/scripts/app removes the feature entirely.
 *
 * Security model: loopback is the boundary (default 127.0.0.1). The
 * WebSocket endpoint requires a same-host Origin header, caps frames,
 * and serves static assets with a strict CSP. No token: if you can reach
 * the loopback port you already own the agent.
 */

import { randomUUID } from "node:crypto";
import Agent from "../../agent.js";
import Env from "../../env.js";
import IO from "../../io.js";
import CLI from "../../cli.js";
import { parseClientMessage } from "./protocol.js";
import { AgentSession } from "./session.js";
import { adoptEndpoint, catalog, removeEndpoint, runCommand } from "./commands.js";
import { UploadRegistry } from "./upload-registry.js";
import { modelParts } from "../shared/format.js";
import { toolCatalogText } from "../shared/tool-catalog.js";

export const MAX_WS_PAYLOAD_LENGTH = 2 * 1024 * 1024;

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
  "/copy-markdown.js": ["copy-markdown.js", "application/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/themes.css": [null, "text/css; charset=utf-8"],
  "/markdown.js": ["markdown.js", "application/javascript; charset=utf-8"],
  "/markdown/browser.js": ["../../markdown/browser.js", "application/javascript; charset=utf-8"],
  "/markdown/math.js": ["../../markdown/math.js", "application/javascript; charset=utf-8"],
  "/markdown/inline.js": ["../../markdown/inline.js", "application/javascript; charset=utf-8"],
  "/read-preview.js": ["read-preview.js", "application/javascript; charset=utf-8"],
  // The Markdown module's display sanitizer, shared with the TUI — served
  // from its owning private folder (../markdown/) so web and terminal
  // sanitize identically from one source of truth.
  "/text-safe.js": ["../../markdown/text-safe.js", "application/javascript; charset=utf-8"],
  // Presentation text shared with the TUI (tool summaries, durations, quotas).
  "/format.js": ["../../shared/format.js", "application/javascript; charset=utf-8"],
  "/logo.svg": ["logo.svg", "image/svg+xml"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const headers = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
// Asset names resolve against ./public; a "../" segment reaches a sibling
// App area's module the SPA reuses (../../markdown/text-safe.js, ../../shared/format.js).
/** Read a bundled public asset as UTF-8 text.
 * @param {string} name - Asset path relative to this module's `public` directory.
 * @returns {Promise<string>} Asset contents; rejects if the asset cannot be read.
 */
const content = async (name) => await Bun.file(new URL(`./public/${name}`, import.meta.url)).text();

/** Prepare the shared environment and agent-creation options for server startup.
 * @param {object} state - Server launch state; `env` and `model` are optional.
 * @returns {Promise<{env: object, options: object}>} Prepared environment and agent options.
 * @throws Propagates environment creation and endpoint/model selection failures.
 */
async function launch(state) {
  // Optional log callback supplied to endpoint/model selection; writes one line to diagnostics.
  const log = state.diagnostics ? (line) => state.diagnostics.write(`${line}\n`) : () => {};
  const env = state.env ?? await Env.create({ themes: true, ...state.envOptions });
  let selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  if (!selection) {
    selection = CLI.listEndpointModels(env)
      .flatMap(({ name, models }) => models.map((model) => `${name}/${model}`))
      .sort()[0];
  }
  return {
    env,
    options: {
      ...(selection ? { model: selection } : {}),
      url: state.model?.url,
      timeout: state.timeout,
      settings: { ...(state.settings ?? {}), ...(state.model?.token ? { auth: { token: state.model.token } } : {}) },
      tools: state.tools?.names,
      safe: state.safe === true,
      maxTurns: state.limits?.maxTurns,
      maxToolCalls: state.limits?.maxToolCalls,
      toolCall: state.tools?.call,
    },
  };
}

/** Theme role (+ key) -> CSS custom property. Only hex colors are emitted;
 *  256-color indices and adaptive objects stay terminal-only, so the
 *  browser's own light/dark palette remains the fallback for them. */
const THEME_VARS = [
  ["--fg", "text"], ["--muted", "muted"], ["--accent", "accent"], ["--border", "border"], ["--danger", "error"],
  ["--border-active", "input.border.active"],
  ["--user-fg", "message.user"], ["--user-bg", "message.user", "bg"], ["--user-rail", "message.user.border"],
  ["--assistant-fg", "message.text"], ["--assistant-rail", "message.text.border"],
  ["--thinking-fg", "message.thinking"], ["--thinking-rail", "message.thinking.border"],
  ["--system-fg", "message.system"], ["--system-rail", "message.system.border"],
  ["--tool-call", "tool.call"], ["--tool-ok", "tool.result"], ["--tool-err", "tool.error"], ["--tool-display", "tool.display"],
  ["--code-fg", "md.code"], ["--code-bg", "md.code", "bg"], ["--link", "md.link"], ["--heading", "md.heading"],
  ["--strong", "md.strong"], ["--em", "md.em"], ["--quote", "md.quote"], ["--list-marker", "md.list"],
  ["--diff-add", "md.diff.add"], ["--diff-remove", "md.diff.remove"], ["--diff-hunk", "md.diff.hunk"],
  ["--selection-fg", "selection"], ["--selection-bg", "selection", "bg"],
  ["--menu-selected-fg", "menu.selected"], ["--menu-selected-bg", "menu.selected", "bg"],
  ["--status-idle", "status.idle"], ["--status-busy", "status.busy"], ["--queue", "queue"],
  ["--notice", "notice"], ["--notice-action", "notice.action"], ["--cursor", "cursor"],
];
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Merge theme roles, shallow-merging object-valued role tokens.
 * @param {object} base - Inherited role map.
 * @param {object} next - Role overrides.
 * @returns {object} A new merged role map.
 */
function mergeThemeRoles(base, next) {
  const merged = { ...base };
  for (const [role, value] of Object.entries(next)) {
    const previous = merged[role];
    merged[role] = previous && typeof previous === "object" && !Array.isArray(previous)
      && value && typeof value === "object" && !Array.isArray(value) ? { ...previous, ...value } : value;
  }
  return merged;
}
/** Resolve shared/light/dark layers through a cycle-safe theme parent chain.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to resolve.
 * @param {Set<string>} [seen=new Set()] - Names already visited on this traversal.
 * @returns {{shared: object, light: object, dark: object}} Resolved inherited layers; invalid/cyclic names yield empty layers.
 */
function themeLayers(themes, name, seen = new Set()) {
  const value = themes?.[name];
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(name)) return { shared: {}, light: {}, dark: {} };
  seen.add(name);
  const { parent, light, dark, ...tokens } = value;
  const inherited = typeof parent === "string" && parent !== "default" ? themeLayers(themes, parent, seen) : { shared: {}, light: {}, dark: {} };
  return {
    shared: mergeThemeRoles(inherited.shared, tokens),
    light: mergeThemeRoles(inherited.light, light && typeof light === "object" && !Array.isArray(light) ? light : {}),
    dark: mergeThemeRoles(inherited.dark, dark && typeof dark === "object" && !Array.isArray(dark) ? dark : {}),
  };
}
/** Resolve theme tokens, optionally overlaying the selected appearance mode.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to resolve.
 * @param {('light'|'dark'|null)} [mode=null] - Layer to overlay, or null for shared tokens only.
 * @returns {object} Resolved token map.
 */
function resolveThemeTokens(themes, name, mode = null) {
  const layers = themeLayers(themes, name);
  return mode ? mergeThemeRoles(layers.shared, layers[mode]) : layers.shared;
}
/** Test whether a theme or one of its ancestors defines mode-specific tokens.
 * @param {object} themes - Named theme definitions.
 * @param {string} name - Theme to inspect.
 * @param {Set<string>} [seen=new Set()] - Names already visited on this traversal.
 * @returns {boolean} Whether either light or dark tokens are defined.
 */
function isDualTheme(themes, name, seen = new Set()) {
  const value = themes?.[name];
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(name)) return false;
  seen.add(name);
  return (value.light && typeof value.light === "object" && !Array.isArray(value.light))
    || (value.dark && typeof value.dark === "object" && !Array.isArray(value.dark))
    || (typeof value.parent === "string" && isDualTheme(themes, value.parent, seen));
}

/** Collapsed-block preview heights, in rows, per semantic block. The
 *  defaults mirror the TUI's default theme (lib/tui-app/theme-data.js —
 *  not importable here: the web app never depends on tui-app); a theme's
 *  `<role>.preview.maxRows` overrides them, false = uncapped. */
const PREVIEW_DEFAULTS = Object.freeze({ system: 8, thinking: 8, tool: 7 });
const PREVIEW_ROLES = Object.freeze({ system: "message.system.preview", thinking: "message.thinking.preview", tool: "tool.preview" });
/** Calculate collapsed-preview row limits for semantic block kinds.
 * @param {object} [tokens={}] - Theme token map containing preview overrides.
 * @returns {object} Per-kind row limits, with false representing uncapped.
 */
function themePreviewRows(tokens = {}) {
  return Object.fromEntries(Object.entries(PREVIEW_ROLES).map(([kind, role]) => {
    const value = tokens?.[role]?.maxRows;
    return [kind, value === false || (Number.isInteger(value) && value > 0) ? value : PREVIEW_DEFAULTS[kind]];
  }));
}

/** Infer light/dark appearance from a theme canvas color or, as fallback, text color.
 * @param {object} tokens - Theme token map.
 * @returns {('dark'|'light'|null)} Inferred mode, or null without a valid hex color.
 */
function themeMode(tokens) {
  const hex = HEX.test(tokens?.background?.bg ?? "") ? tokens.background.bg : HEX.test(tokens?.text?.fg ?? "") ? tokens.text.fg : null;
  if (!hex) return null;
  const full = hex.length <= 5 ? [...hex.slice(1, 4)].map((c) => c + c).join("") : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fromText = !HEX.test(tokens?.background?.bg ?? "");
  return (luminance < 0.5) !== fromText ? "dark" : "light";
}

/** Convert displayable scalar values to strings, mapping other values to empty text.
 * @param {*} value - Value to convert.
 * @returns {string} String representation or an empty string.
 */
const display = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
/** Serialize supported theme animations as CSS custom-property declarations.
 * @param {object} theme - Resolved theme tokens.
 * @returns {string} CSS declarations, or an empty string when none are supported.
 */
function themeAnimation(theme) {
  const busy = theme?.["status.busy"]?.animation;
  const border = theme?.["input.border.active.bottom"]?.animation ?? theme?.["input.border.active.top"]?.animation;
  // Convert one supported animation descriptor to CSS declarations.
  const value = (animation, prefix) => {
    const data = typeof animation === "string" ? { type: animation } : animation;
    if (!data || typeof data !== "object" || !["wave", "flash", "comet"].includes(data.type)) return "";
    const period = Math.max(100, Math.min(10_000, Number(data.period ?? data.crossing) || (data.type === "wave" ? 850 : 1400)));
    const colors = Array.isArray(data.colors ?? data.head) ? (data.colors ?? data.head).filter((color) => typeof color === "string" && HEX.test(color)).slice(0, 8) : [];
    return `${prefix}-animation-name:web-${data.type};${prefix}-duration:${period}ms${colors.map((color, index) => `;${prefix}-color-${index}:${color}`).join("")}`;
  };
  return [value(busy, "--working"), value(border, "--input-border")].filter(Boolean).join(";");
}

/** Produce the client-facing recursive snapshot of an agent and its state.
 * @param {object} agent - Agent to describe.
 * @param {object|null} active - Currently active agent for the connection.
 * @returns {object} Serializable agent information, including descendants.
 */
function agentInfo(agent, active) {
  // `state` derives `busy`, never the reverse: a snapshot can be taken in
  // the instant after a disconnect clears (state "idle") but before the
  // run's finally flips `_running`, and the wire must never report the
  // mixed {busy:true, state:"idle"}.
  const state = agent.ioState === "disconnected" ? "disconnected" : agent.busy === true || agent.ioState === "working" ? "working" : "idle";
  const { endpoint, model } = modelParts(agent.model);
  return {
    id: display(agent.name),
    name: display(agent.name),
    endpoint: display(endpoint),
    model: display(model),
    busy: state === "working",
    state,
    description: display(agent.description),
    parentId: agent.parent ? display(agent.parent.name) : null,
    session: display(agent.context.id),
    logged: agent.context.save,
    active: agent === active,
    children: agent.children.map((child) => agentInfo(child, active)),
  };
}

/** Start the web server and prepare its shared environment and per-connection sessions.
 * @param {object} [state={}] - Launch options: optional `env`, `envOptions`, `model`, `session`, `tools`, `limits`, `settings`, `timeout`, `safe`, `keepGhost`, `uploadLimits`, `host` (default `127.0.0.1`), `port` (default `9900`), `diagnostics`, and `createSession` factory.
 * @returns {Promise<{server: object, host: string, port: number, url: string, env: object, stop: Function, done: Promise<void>}>} Running server handle and shutdown controls.
 * @throws Propagates environment/setup and non-port-collision server startup failures.
 */
export async function serve(state = {}) {
  const host = state.host ?? "127.0.0.1";
  const diagnostics = state.diagnostics ?? process.stderr;
  if (state.session?.kind === "resume" && state.session.id !== "latest") {
    CLI.adoptResumeOrigin({ resume: state.session.id, anonymous: false });
  }
  const prepared = await launch(state);
  const { env } = prepared;
  // Sessions are saved by default: agents created THROUGH the server's own
  // factory start persisted (a fresh UUID id), and the user opts OUT through
  // the session-save toggle (sessionSaveSet). `--session 0|false|anon`
  // (kind "anonymous") or a state.keepGhost opt-in starts them not logged
  // (a memory-only store, `session: false`); a host-supplied
  // state.createSession factory stays authoritative for its own agents.
  const anonymous = state.session?.kind === "anonymous" || state.keepGhost === true;
  const connections = new Map();
  const uploads = new UploadRegistry(state.uploadLimits);
  // A bridge belongs to the Agent, not to the selected sidebar row. It keeps
  // receiving background stream events even when no browser currently views it.
  const agentSessions = new Map();

  // The tool catalog snapshot (Env.tools(): ToolInfo values) every hello
  // carries; refreshed after each tool run (live status may move).
  let tools = await env.tools();
  /** Refresh the hello-packet tool snapshot; failures leave the last good snapshot intact.
   * @returns {Promise<void>} Resolves after refresh attempt.
   */
  const refreshTools = () => env.tools().then((next) => { tools = next; }, () => {});
  /** List persisted sessions for the current environment and working directory.
   * @returns {Promise<Array<object>>} Recent session records.
   */
  const listRecent = async () => Agent.Context.listAsync({ dir: env.settings.sessions, cwd: env.cwd });
  /** Get ids held by currently registered agents.
   * @returns {Set<string>} Live context ids.
   */
  const liveSessionIds = () => new Set(env.agents().map((a) => a.context.id).filter((id) => id !== undefined));
  /** Validate that a persisted session id exists.
   * @param {string} id - Session id to check.
   * @returns {Promise<void>} Resolves when present; rejects with TypeError otherwise.
   */
  const knownSession = async (id) => { if (!(await listRecent()).some((item) => item.id === id)) throw new TypeError("unknown session"); };
  // Web display preferences come from settings.web (lib/env/settings-schema.js
  // owns the defaults) — the client honors them, never hardcodes.
  /** Build client preferences from environment web/theme settings.
   * @returns {object} Serializable web preferences and theme metadata.
   */
  const webPrefs = () => {
    const w = env.settings?.web ?? {};
    return {
      autocomplete: w.autocomplete !== false,
      collapse: { thinking: w.collapse?.thinking !== false, tools: w.collapse?.tools !== false },
      theme: ["system", "light", "dark"].includes(w.theme) ? w.theme : "system",
      thinkingLevels: ["default", ...IO.THINKING_LEVELS],
      themes: ["dark", "light", ...themeNames()].sort((a, b) => a.localeCompare(b)),
      activeTheme: themeNames().includes(w.theme) ? w.theme : null,
      themeModes: Object.fromEntries(themeNames().map((name) => [name, themeMode(resolveThemeTokens(env.settings?.tui?.themes, name))])),
      dualThemes: themeNames().filter((name) => isDualTheme(env.settings?.tui?.themes, name)),
      // Preview rows per named theme (system/light/dark use the defaults).
      previewRows: { default: themePreviewRows(), ...Object.fromEntries(themeNames().map((name) => [name, themePreviewRows(resolveThemeTokens(env.settings?.tui?.themes, name))])) },
    };
  };
  /** Return valid configured theme names in locale-sorted order.
   * @returns {string[]} Theme names.
   */
  const themeNames = () => Object.keys(env.settings?.tui?.themes ?? {}).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).sort();
  /** Generate browser CSS for a configured theme.
   * @param {string} name - Theme name.
   * @returns {string|null} CSS rules, or null for invalid/missing themes.
   */
  const themeCss = (name) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    if (!env.settings?.tui?.themes?.[name] || typeof env.settings.tui.themes[name] !== "object") return null;
    // Build the CSS rule for shared tokens or one appearance mode.
    const rule = (mode) => {
      const theme = resolveThemeTokens(env.settings.tui.themes, name, mode);
      // Return a valid hex token color for a role/key pair.
      const color = (role, key = "fg") => typeof theme[role]?.[key] === "string" && HEX.test(theme[role][key]) ? theme[role][key] : null;
      // No canvas token means the browser's light/dark palette remains the base.
      const background = color("background", "bg");
      const values = {
        ...(background ? { "--page": background, "--surface": background, "--surface-2": background } : {}),
        ...Object.fromEntries(THEME_VARS.map(([variable, role, key]) => [variable, color(role, key)])),
      };
      const css = Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(";");
      const animation = themeAnimation(theme);
      const suffix = mode ? `[data-mode="${mode}"]` : "";
      return `:root[data-theme="${name}"]${suffix}{${css}${animation ? `;${animation}` : ""}}\n.theme-card[data-theme="${name}"]${suffix}{${css}}`;
    };
    return isDualTheme(env.settings.tui.themes, name) ? [rule("light"), rule("dark")].join("\n") : rule(null);
  };
  // The model menu lists CONCRETE endpoint/model combos (deduplicated),
  // never the noisy completion list (endpoints + bare ids + combos).
  /** List unique concrete endpoint/model choices.
   * @returns {string[]} Sorted endpoint/model identifiers.
   */
  const modelChoices = () => {
    const combos = [];
    for (const { name, models } of CLI.listEndpointModels(env)) for (const id of models) combos.push(`${name}/${id}`);
    return [...new Set(combos)].sort();
  };
  /** Build agent-specific settings and shared model/preferences state.
   * @param {object|null} agent - Agent whose settings are projected, if any.
   * @returns {object} Client settings packet fields.
   */
  const settingsState = (agent) => ({
    ...(agent
      ? {
        safe: agent.safe === true,
        thinking: agent.thinking ?? "default",
        sessionSave: agent.context.save,
        spawnPermission: agent.spawnPermission === true ? true : agent.spawnPermission === false ? false : null,
        delegationLocked: Boolean(agent.parent),
        endpoint: modelParts(agent.model).endpoint ?? null,
        model: modelParts(agent.model).model ?? null,
      }
      : {}),
    models: modelChoices(),
    prefs: webPrefs(),
  });
  /** Send a JSON packet only while the connection is open.
   * @param {object} entry - Connection state.
   * @param {object} packet - Packet to serialize.
   * @returns {void}
   */
  const send = (entry, packet) => { if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(packet)); };
  /** Send the current settings packet to a connection.
   * @param {object} entry - Connection state.
   * @returns {void}
   */
  const sendSettings = (entry) => send(entry, { type: "settings", ...settingsState(entry.agent) });
  /** Send virtual publication data separately so real context indexes never shift. */
  async function sendContext(entry, { history = false } = {}) {
    const request = entry.contextRequest = (entry.contextRequest ?? 0) + 1;
    const session = entry.session;
    const agent = entry.agent;
    const selector = agent?.model;
    const safe = agent?.safe;
    let text;
    try { text = toolCatalogText(await agent?.tools ?? new Map()); }
    catch (error) { text = `Unable to load published tools: ${error?.message ?? error}`; }
    if (entry.contextRequest !== request || entry.session !== session || agent?.model !== selector || agent?.safe !== safe) return;
    const tools = { messageIndex: -1, blockIndex: 0, viewerType: "system", name: "Tools", virtual: true, text };
    send(entry, { type: "context", blocks: session?.contextSnapshot() ?? [], tools, ...(history ? { history: session?.historySnapshot() ?? [] } : {}) });
  }
  /** Send live agents and persisted sessions to an open connection.
   * @param {object} entry - Connection state.
   * @returns {Promise<void>} Resolves after session lookup and send.
   */
  const sendSessions = async (entry) => {
    if (entry.ws.readyState !== WebSocket.OPEN) return;
    const recent = await listRecent();
    // `live`: a running agent holds the session open (it renames through
    // that agent and cannot be deleted from under it)
    const live = liveSessionIds();
    send(entry, { type: "sessions", agents: env.agents().filter((a) => !a.parent).map((a) => agentInfo(a, entry.agent)), recent: recent.map((item) => live.has(item.id) ? { ...item, live: true } : item) });
  };
  /** Invoke a callback for every current connection.
   * @param {Function} fn - Per-connection action.
   * @returns {void}
   */
  const broadcast = (fn) => { for (const entry of connections.values()) fn(entry); };
  /** Broadcast session lists, suppressing individual lookup failures.
   * @returns {void}
   */
  const broadcastSessions = () => broadcast((entry) => sendSessions(entry).catch(() => {}));
  /** Broadcast settings to all connections.
   * @returns {void}
   */
  const broadcastSettings = () => broadcast((entry) => sendSettings(entry));
  /** Snapshot endpoint, provider, and login-preset catalogs.
   * @returns {object} Serializable endpoint catalog.
   */
  const endpointsState = () => ({
    endpoints: CLI.listEndpointModels(env).map(({ name, models = [], loginRequired }) => ({ name, models, loginRequired: loginRequired === true })),
    removable: CLI.listEndpoints(env),
    providers: [...new Set(env.loginPresets().map(({ provider }) => provider))],
    presets: env.loginPresets().map(({ name, label, provider, url, oauth }) => ({ name, label: label ?? name, provider, url, oauth: Boolean(oauth) })),
  });
  /** Send endpoint catalog to a connection.
   * @param {object} entry - Connection state.
   * @returns {void}
   */
  const sendEndpoints = (entry) => send(entry, { type: "endpoints", ...endpointsState() });
  /** Broadcast endpoint, settings, and session snapshots.
   * @returns {void}
   */
  const broadcastEndpoints = () => { broadcast(sendEndpoints); broadcastSettings(); broadcastSessions(); };
  // One browser sign-in at a time (the OAuth paste channel is process-wide).
  let oauthRunning = false;
  /** Broadcast an OAuth progress packet.
   * @param {object} packet - OAuth state and payload fields.
   * @returns {void}
   */
  const oauth = (packet) => broadcast((entry) => send(entry, { type: "oauth", ...packet }));
  /** Run browser-mediated OAuth sign-in and broadcast progress/results.
   * @param {object} entry - Initiating connection, used to select its agent endpoint.
   * @param {string} name - Login preset name.
   * @returns {Promise<void>} Resolves after completion; flow errors are reported to clients.
   * @throws {TypeError} If the preset is unavailable or another OAuth flow is active.
   */
  const runOAuth = async (entry, name) => {
    const preset = env.loginPresets().find((item) => item.name === name && item.oauth);
    if (!preset) throw new TypeError(`no browser sign-in for "${name}"`);
    if (oauthRunning) throw new TypeError("a sign-in is already in progress — finish or paste its redirect");
    oauthRunning = true;
    try {
      oauth({ state: "log", text: `starting ${preset.label ?? preset.name} sign-in` });
      // The browser IS the client: hand it the URL (a user click opens it)
      // instead of spawning a second system browser from the server.
      const tokens = await CLI.runOAuthFlow(preset.oauth, {
        open: () => false,
        onAuthUrl: (url) => oauth({ state: "url", url, name: preset.name }),
        onLog: (text) => oauth({ state: "log", text }),
      });
      const result = await CLI.loginEndpoint(env, { name: preset.name, provider: preset.provider, url: preset.url, auth: CLI.tokensToAuth(tokens) });
      const selected = entry.agent ? adoptEndpoint(entry.agent, result.name) : result.name;
      oauth({ state: "done", text: `signed in: ${result.name} — model: ${selected}` });
    } catch (error) {
      oauth({ state: "error", text: `sign-in failed: ${error?.message ?? error}` });
    } finally {
      oauthRunning = false;
      broadcastEndpoints();
    }
  };
  // Request boundaries also refresh each VIEWED agent snapshot: the
  // composer's Stop button and working animation read that snapshot, and a
  // sessions-only push would leave it stale until an agent switch.
  /** Push a changed agent snapshot to connections viewing that agent.
   * @param {object} changed - Agent whose state changed.
   * @returns {void}
   */
  const sendAgentSnapshot = (changed) => broadcast((entry) => { if (entry.agent === changed) send(entry, { type: "agent", agent: agentInfo(changed, changed) }); });
  // Env collects the model catalog in the background (context windows,
  // live model lists); statusSnapshot() and the settings lists read it
  // synchronously, so every viewer gets a fresh status and settings
  // snapshot on each Env.EVENT.MODELS_CHANGED.
  const modelsHandle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => broadcast((entry) => {
    if (!entry.agent) return; // not attached yet: its hello carries the fresh state
    send(entry, { type: "agent", agent: agentInfo(entry.agent, entry.agent), status: entry.session?.statusSnapshot() ?? null });
    sendSettings(entry);
  }));
  /** Broadcast session membership and, when specified, refreshed agent state.
   * @param {{agent?: object}} [options={}] - Changed agent, if any.
   * @returns {void}
   */
  const broadcastAgentStates = ({ agent: changed } = {}) => {
    broadcastSessions();
    if (!changed) return;
    sendAgentSnapshot(changed);
    // REQUEST_DONE fires before the run's finally flips `_running`, so the
    // fresh snapshot would still read busy — re-send after the settle.
    queueMicrotask(() => sendAgentSnapshot(changed));
  };
  // Env reports membership; each Agent reports its own requests. Every
  // agent's request boundaries are watched from the moment it joins.
  const requestHandles = new Map(); // agent -> its onEvent handles
  /** Subscribe to request-boundary events for an agent once.
   * @param {object} agent - Agent to observe.
   * @returns {void}
   */
  const watchAgent = (agent) => {
    if (requestHandles.has(agent)) return;
    requestHandles.set(agent, [Agent.EVENT.REQUEST_START, Agent.EVENT.REQUEST_DONE, Agent.EVENT.REQUEST_ERROR]
      .map((event) => agent.onEvent(event, () => broadcastAgentStates({ agent }))));
  };
  /** Remove request-event subscriptions for an agent.
   * @param {object} agent - Agent to stop observing.
   * @returns {void}
   */
  const unwatchAgent = (agent) => {
    for (const handle of requestHandles.get(agent) ?? []) agent.offEvent(handle);
    requestHandles.delete(agent);
  };
  for (const agent of env.agents()) watchAgent(agent);
  const eventHandles = [
    env.onEvent(Env.EVENT.AGENT_ADDED, ({ agent }) => {
      watchAgent(agent);
      broadcastAgentStates({ agent });
    }),
    env.onEvent(Env.EVENT.AGENT_REMOVED, ({ agent }) => {
      unwatchAgent(agent);
      const session = agentSessions.get(agent);
      session?.dispose();
      agentSessions.delete(agent);
      broadcastSessions();
    }),
  ];

  /** Attach a connection to an agent-owned bridge without stopping its stream.
   * @param {object} entry - Connection state.
   * @param {object} agent - Agent to attach.
   * @returns {void}
   */
  const attach = (entry, agent) => {
    entry.session?.removeSink(entry.send);
    entry.agent = agent;
    entry.session = agentSessions.get(agent);
    if (!entry.session) {
      entry.session = new AgentSession(agent);
      agentSessions.set(agent, entry.session);
    }
    entry.session.addSink(entry.send);
  };

  /** Send the initial hello snapshot for a connection.
   * @param {object} entry - Connection state.
   * @returns {void}
   */
  const greet = (entry) => send(entry, { type: "hello", agent: agentInfo(entry.agent, entry.agent), history: entry.session?.historySnapshot() ?? [], queue: entry.session?.pendingSnapshot() ?? [], catalog: catalog(entry.agent, tools), status: entry.session?.statusSnapshot() ?? null, throttledUntil: entry.agent?.throttledUntil ?? null, uploadKey: entry.uploadKey });

  /** Create or host-provide an agent, attach it, and send initial snapshots.
   * @param {object} entry - Connection receiving the session.
   * @param {string|false|null|undefined} session - Context id, false for unlogged, or nullish for a new id.
   * @param {{model?: string, safe?: boolean}} [options={}] - Optional model and safe-mode overrides.
   * @returns {Promise<void>} Resolves after session and settings snapshots are sent.
   */
  const makeSession = async (entry, session, { model, safe } = {}) => {
    let agent;
    if (state.createSession) ({ agent } = await state.createSession());
    else {
      // Model precedence: an explicit pick, then the session's own stored
      // model (a resume), then the model of the agent being switched away
      // from — never a reload of the launch-time last-model selection
      // (that is only the first agent's default).
      const { model: launchModel, ...options } = prepared.options;
      const current = entry.agent;
      const inherited = current?.model ?? launchModel;
      agent = env.agentCreate({ ...options, ...(model ? { model } : {}), contextId: session ?? randomUUID() }); // false: not logged
      if (agent.model === undefined && inherited) {
        try { (agent.model = inherited); } catch { /* the endpoint is gone — the agent starts model-less */ }
      }
    }
    if (safe === true) (agent.safe = true);
    attach(entry, agent);
    greet(entry);
    await sendSessions(entry);
    sendSettings(entry);
  };

  /** Replace the viewed agent and give its other viewers fresh agents.
   * @param {object} entry - Connection requesting replacement.
   * @param {string|false|null|undefined} session - Context selection for the requesting connection.
   * @param {object} [options={}] - Session creation options.
   * @returns {Promise<void>} Resolves after affected viewers are reattached.
   */
  const replaceViewed = async (entry, session, options = {}) => {
    const previous = entry.agent;
    if (!previous) return makeSession(entry, session, options);
    const viewers = [...connections.values()].filter((candidate) => candidate.agent === previous);
    previous.close();
    await Promise.all(viewers.map((candidate) => makeSession(candidate, candidate === entry ? session : false, candidate === entry ? options : {})));
    broadcastSessions();
  };

  /** Close an agent and move its viewers to another agent or a new one.
   * @param {object} agent - Agent to close.
   * @returns {Promise<void>} Resolves after all viewers are reassigned.
   */
  const closeAgent = async (agent) => {
    agent.close();
    const next = env.agents().find((candidate) => !candidate.parent && !candidate.closed);
    await Promise.all([...connections.values()]
      .filter((candidate) => candidate.agent === agent)
      .map(async (candidate) => {
        if (!next) return makeSession(candidate, null);
        attach(candidate, next); greet(candidate); await sendSessions(candidate); sendSettings(candidate);
      }));
    broadcastSessions();
  };

  /** Run a slash command and emit its result/actions to the client.
   * @param {object} entry - Connection issuing the command.
   * @param {string} line - Command line.
   * @returns {Promise<void>} Resolves after command handling and broadcasts.
   * @throws Propagates command execution errors to the message handler.
   */
  const handleCommand = async (entry, line) => {
    const agent = entry.agent;
    if (!agent) { send(entry, { type: "command.result", text: "no active session — send a message first" }); return; }
    const result = await runCommand(agent, line, {
      continue: () => { if (!entry.session.busy) entry.session.continue(); },
      clear: () => entry.session.clear(),
    });
    if (result.cleared || result.renew) entry.session?.refresh();
    if (result.cleared) send(entry, { type: "hello", agent: agentInfo(agent, agent), history: entry.session?.historySnapshot() ?? [], catalog: catalog(agent, tools), status: entry.session?.statusSnapshot() ?? null, throttledUntil: entry.agent?.throttledUntil ?? null, uploadKey: entry.uploadKey });
    else if (result.renew) send(entry, { type: "history", history: entry.session?.historySnapshot() ?? [] });
    if (result.text) send(entry, { type: "command.result", text: result.text });
    if (result.open) { if (result.open === "login") sendEndpoints(entry); send(entry, { type: "command.open", view: result.open, ...(Number.isInteger(result.index) ? { index: result.index } : {}) }); }
    if (typeof result.copy === "string") send(entry, { type: "command.copy", text: result.copy });
    if (typeof result.fill === "string") send(entry, { type: "command.fill", text: result.fill });
    if (result.exit) {
      send(entry, { type: "command.exit" });
      // The closed agent's view moves to another running agent when one exists.
      const next = env.agents().find((candidate) => !candidate.parent && candidate !== agent && !candidate.closed);
      if (next) { attach(entry, next); greet(entry); }
    }
    broadcastSessions();
    sendSettings(entry);
    if (/^\/(endpoint-login|endpoint-logout)\b/.test(line.trim())) broadcastEndpoints();
  };

  /** Release connection sink and upload state when a socket closes.
   * @param {WebSocket} ws - Closed socket.
   * @returns {void}
   */
  const close = (ws) => {
    const entry = connections.get(ws);
    if (!entry) return;
    entry.session?.removeSink(entry.send);
    uploads.close(entry.uploadKey);
    connections.delete(ws);
  };

  let server;
  let port = Number(state.port ?? 9900);
  for (;;) {
    try {
      server = Bun.serve({
    hostname: host,
    port,
    /** Serve WebSocket upgrades, uploads, and public static assets.
     * @param {Request} request - Incoming HTTP request.
     * @param {object} bunServer - Bun server used for WebSocket upgrades.
     * @returns {Promise<Response|undefined>} HTTP response, or undefined after a successful upgrade.
     * @throws {Error} Asset-read failures propagate to Bun's request handler.
     */
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      const origin = `http://${url.host}`;
      if (url.pathname === "/ws") {
        if (request.headers.get("origin") !== origin) return new Response("forbidden", { status: 403 });
        return bunServer.upgrade(request, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/upload") {
        if (request.method !== "POST" || request.headers.get("origin") !== origin) return new Response("forbidden", { status: 403, headers });
        try {
          const key = request.headers.get("x-omoya-upload");
          const form = await request.formData();
          const file = form.get("file");
          const upload = uploads.add(key, file);
          return Response.json(upload, { headers });
        } catch (error) { return Response.json({ error: error?.message ?? "upload failed" }, { status: 400, headers }); }
      }
      const asset = assets[url.pathname];
      if (!asset || request.method !== "GET") return new Response("not found", { status: 404, headers });
      const body = url.pathname === "/themes.css"
        ? Object.keys(env.settings?.tui?.themes ?? {}).map(themeCss).filter(Boolean).join("\n")
        : await content(asset[0]);
      return new Response(body, { headers: { ...headers, "Content-Type": asset[1] } });
    },
    websocket: {
      maxPayloadLength: MAX_WS_PAYLOAD_LENGTH,
      /** Initialize a websocket connection and attach/create its agent session.
       * @param {WebSocket} ws - Newly opened socket.
       * @returns {Promise<void>} Resolves after initial snapshots are sent.
       */
      open: async (ws) => {
        const entry = { ws, agent: null, session: null, send: null, uploadKey: uploads.open() };
        entry.send = (packet) => send(entry, packet);
        connections.set(ws, entry);
        // On a page reload, reconnect to the first existing top-level agent
        // before creating a Ghost or opening an explicitly requested session.
        // Agent registration preserves creation order, which is also the
        // running-agent order shown by the sidebar.
        const running = env.agents().find((agent) => !agent.parent);
        if (running) {
          attach(entry, running);
          greet(entry);
          await sendSessions(entry);
          sendSettings(entry);
          sendEndpoints(entry);
          return;
        }
        // A usable agent must exist before the first message: settings are
        // agent state (safe/thinking/model); `false` starts it not logged.
        const initial = anonymous
          ? false
          : state.session?.kind === "resume"
            ? (state.session.id === "latest" ? Agent.Context.latest({ dir: env.settings.sessions, cwd: env.cwd }) : state.session.id)
            : state.session?.kind === "new" ? state.session.id : undefined;
        await makeSession(entry, initial);
        sendSettings(entry);
        sendEndpoints(entry);
      },
      /** Parse and dispatch a client packet; report handler errors over the socket.
       * @param {WebSocket} ws - Sending socket.
       * @param {string|ArrayBuffer|Uint8Array} message - Client frame payload.
       * @returns {Promise<void>} Resolves after dispatch and any awaited operations.
       */
      message: async (ws, message) => {
        const entry = connections.get(ws);
        if (!entry) return;
        try {
          const parsed = parseClientMessage(message);
          if (parsed.type === "session.list") return void await sendSessions(entry);
          if (parsed.type === "session.new") return void await replaceViewed(entry, parsed.anonymous ? false : undefined, { safe: parsed.safe });
          if (parsed.type === "session.add") {
            let model;
            if (parsed.model) {
              const combo = await CLI.resolveModelCombo(parsed.model, env, {});
              if (!combo || !modelParts(combo).model) throw new TypeError(`unknown model "${parsed.model}"`);
              model = combo;
            }
            return void await makeSession(entry, undefined, { model, safe: parsed.safe });
          }
          if (parsed.type === "session.rename") {
            // no id: the viewed agent's session; an id: that saved session —
            // through the running agent holding it, else on disk directly
            const owner = parsed.id === undefined ? entry.agent : env.agents().find((a) => a.context.id === parsed.id);
            if (parsed.id !== undefined && !owner) {
              await knownSession(parsed.id);
              const result = Agent.Context.renameById({ id: parsed.id, name: parsed.name, dir: env.settings.sessions });
              send(entry, { type: "command.result", text: `session named: ${result.id}` });
              broadcastSessions();
              return;
            }
            if (!owner) throw new TypeError("no active agent");
            const result = owner.context.rename(parsed.name);
            send(entry, { type: "command.result", text: `session named: ${result.id}` });
            broadcast((candidate) => { if (candidate.agent === owner) { greet(candidate); sendSettings(candidate); } });
            broadcastSessions();
            return;
          }
          if (parsed.type === "session.delete") {
            await knownSession(parsed.id);
            const owners = env.agents().filter((agent) => agent.context.id === parsed.id);
            if (owners.some((agent) => agent.busy)) throw new TypeError("stop the running turn before deleting this session");
            for (const owner of owners) await closeAgent(owner);
            const { deleted } = Agent.Context.deleteById({ id: parsed.id, dir: env.settings.sessions });
            send(entry, { type: "command.result", text: `session deleted: ${parsed.id}${deleted > 1 ? ` (${deleted} files)` : ""}` });
            broadcastSessions();
            return;
          }
          if (parsed.type === "session.clear") {
            if (!entry.agent) throw new TypeError("no active agent");
            if (entry.agent.busy) throw new TypeError("stop the running turn first");
            entry.session.clear();
            greet(entry); broadcastSessions();
            return;
          }
          if (parsed.type === "agent.rename") {
            const target = parsed.agentId === undefined ? entry.agent : env.agents().find((a) => a.name === parsed.agentId);
            if (!target) throw new TypeError("unknown agent");
            if (env.agents().some((a) => a !== target && a.name === parsed.name)) throw new TypeError(`another agent is already named "${parsed.name}"`);
            (target.name = parsed.name);
            broadcast((candidate) => { if (candidate.agent === target) send(candidate, { type: "agent", agent: agentInfo(target, target) }); });
            broadcastSessions();
            return;
          }
          if (parsed.type === "chat.continue") {
            if (!entry.session) throw new TypeError("no active agent");
            if (!entry.session.busy) entry.session.continue();
            return;
          }
          if (parsed.type === "settings.spawn") {
            if (entry.agent) (entry.agent.spawnPermission = parsed.value === null ? undefined : parsed.value);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.theme") {
            if (!["system", "light", "dark", "default"].includes(parsed.name)) {
              if (!env.settings.tui.themes?.[parsed.name]) throw new TypeError(`unknown web theme: ${parsed.name}`);
            }
            const name = parsed.name === "default" ? "system" : parsed.name;
            env.settings.web.theme = name;
            broadcastSettings();
            return;
          }
          if (parsed.type === "endpoint.list") { sendEndpoints(entry); return; }
          if (parsed.type === "endpoint.login") {
            const result = await CLI.loginEndpoint(env, { scope: parsed.scope, name: parsed.name, provider: parsed.provider, url: parsed.url, token: parsed.token });
            const selected = entry.agent ? adoptEndpoint(entry.agent, result.name) : result.name;
            send(entry, { type: "command.result", text: `endpoint saved: ${result.name} (${parsed.provider} at ${parsed.url}, ${parsed.scope}) — model: ${selected}` });
            broadcastEndpoints();
            return;
          }
          if (parsed.type === "endpoint.oauth") { void runOAuth(entry, parsed.name).catch((error) => send(entry, { type: "error", message: error?.message ?? String(error) })); return; }
          if (parsed.type === "endpoint.oauth-paste") {
            const accepted = CLI.completeOAuthPaste(parsed.input);
            oauth({ state: "log", text: accepted ? "sign-in redirect received — completing the login" : "no browser sign-in is in progress" });
            return;
          }
          if (parsed.type === "endpoint.logout") {
            const removed = removeEndpoint(entry.agent ?? { env }, parsed.name);
            for (const candidate of env.agents()) if (modelParts(candidate.model).endpoint === removed.name) (candidate.model = undefined);
            send(entry, { type: "command.result", text: `endpoint removed: ${removed.name}${removed.dynamic ? " (environment-defined — it re-detects while the environment provides it)" : ""}` });
            broadcastEndpoints();
            return;
          }
          if (parsed.type === "session.fork") {
            if (!entry.agent) throw new TypeError("no active agent");
            entry.agent.contextFork(parsed.id);
            greet(entry);
            await sendSessions(entry);
            return;
          }
          if (parsed.type === "session.switch") {
            const agent = env.agents().find((a) => a.name === parsed.agentId);
            if (!agent) throw new TypeError("unknown agent");
            attach(entry, agent);
            greet(entry);
            await sendSessions(entry);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "session.close") {
            const agent = env.agents().find((a) => a.name === parsed.agentId);
            if (!agent) throw new TypeError("unknown agent");
            await closeAgent(agent);
            return;
          }
          if (parsed.type === "session.resume") {
            const recent = await listRecent();
            if (!recent.some((item) => item.id === parsed.id)) throw new TypeError("unknown session");
            return void await replaceViewed(entry, parsed.id);
          }
          if (parsed.type === "settings.safe") {
            if (entry.agent) (entry.agent.safe = parsed.on);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.thinking") {
            if (!["default", ...IO.THINKING_LEVELS].includes(parsed.level)) throw new TypeError(`unknown thinking level "${parsed.level}" (use default/${IO.THINKING_LEVELS.join("/")})`);
            if (entry.agent) (entry.agent.thinking = parsed.level === "default" ? undefined : parsed.level);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.session-save") {
            if (!entry.agent) throw new TypeError("no active agent");
            (entry.agent.context.save = parsed.on); // on writes the whole conversation so far
            sendSettings(entry);
            await sendSessions(entry);
            return;
          }
          if (parsed.type === "settings.model") {
            if (entry.agent) {
              const combo = await CLI.resolveModelCombo(parsed.model, env);
              if (!combo || !modelParts(combo).model) throw new TypeError(`unknown model "${parsed.model}" (pick one from the settings list)`);
              (entry.agent.model = combo);
            }
            sendSettings(entry);
            broadcastSessions();
            return;
          }
          if (parsed.type === "context.inspect") { await sendContext(entry); return; }
          if (parsed.type === "context.edit-text") { entry.session.editText(parsed.messageIndex, parsed.blockIndex, parsed.text); await sendContext(entry); return; }
          if (parsed.type === "context.rollback") { entry.session.rollback(parsed.messageIndex); await sendContext(entry); return; }
          if (parsed.type === "context.pop") { entry.session.pop(); await sendContext(entry); return; }
          if (parsed.type === "context.delete") { entry.session.deleteMessages(parsed.messageIndexes); await sendContext(entry, { history: true }); return; }
          if (parsed.type === "tool.call") { await entry.session.callTool(parsed.name, parsed.args); await refreshTools(); return; }
          // Everything below needs a live session. Connection setup normally
          // attaches or creates one, but retain this guard for a future
          // transport that permits a message before its open hook settles.
          if (parsed.type === "chat.submit") {
            if (!entry.agent) await makeSession(entry, null);
            const attachments = parsed.attachments?.length ? await uploads.take(entry.uploadKey, parsed.attachments) : [];
            if (parsed.text.trimStart().startsWith("/")) {
              if (attachments.length) throw new TypeError("commands cannot include attachments");
              await handleCommand(entry, parsed.text);
            } else entry.session.submit(parsed.text, attachments);
            broadcastSessions();
            return;
          }
          if (parsed.type === "chat.cancel") { entry.session?.cancel(); return; }
          if (parsed.type === "chat.unqueue") {
            const queue = entry.session?.unqueue() ?? { text: "", messages: [] };
            send(entry, { type: "chat.unqueued", ...queue });
            return;
          }
          if (parsed.type === "question.answer") { entry.session?.answerQuestion(parsed.requestId, parsed.answers); return; }
        } catch (error) {
          send(entry, { type: "error", message: error?.message ?? "invalid message" });
        }
      },
      close,
    },
  });
      break;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || port >= 9999) throw error;
      port++;
    }
  }

  const url = `http://${host}:${server.port}/`;
  let resolveDone;
  // Capture the resolver used by stop() to signal server completion.
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let stopped = false;
  /** Stop the server, detach listeners, dispose bridges, and settle `done` once.
   * @returns {void}
   */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const handle of eventHandles) env.offEvent(handle);
    env.offEvent(modelsHandle);
    for (const agent of [...requestHandles.keys()]) unwatchAgent(agent);
    for (const ws of [...connections.keys()]) close(ws);
    for (const session of agentSessions.values()) session.dispose();
    agentSessions.clear();
    server.stop(true);
    resolveDone();
  };
  return { server, host, port: server.port, url, env, stop, done };
}
export const createWebServer = serve;
