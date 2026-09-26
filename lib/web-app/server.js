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
import Agent from "../agent.js";
import Env from "../env.js";
import CLI from "../cli.js";
import { parseClientMessage } from "./protocol.js";
import { AgentSession } from "./session.js";
import { adoptEndpoint, catalog, removeEndpoint, runCommand } from "./commands.js";
import { UploadRegistry } from "./upload-registry.js";

const { ENV_EVENT } = Env;
export const MAX_WS_PAYLOAD_LENGTH = 2 * 1024 * 1024;

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/themes.css": [null, "text/css; charset=utf-8"],
  "/markdown.js": ["markdown.js", "application/javascript; charset=utf-8"],
  // The Markdown module's display sanitizer, shared with the TUI — served
  // from its owning private folder (../markdown/) so web and terminal
  // sanitize identically from one source of truth.
  "/text-safe.js": ["../../markdown/text-safe.js", "application/javascript; charset=utf-8"],
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
// private folder's module the SPA reuses (currently ../../markdown/text-safe.js).
const content = async (name) => await Bun.file(new URL(`./public/${name}`, import.meta.url)).text();

/** Resolve the shared Env and endpoint/model selection once at launch. */
async function launch(state) {
  const log = state.diagnostics ? (line) => state.diagnostics.write(`${line}\n`) : () => {};
  const env = state.env ?? await Env.create(state.envOptions);
  env.refreshModels().catch(() => {});
  let selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  if (!selection.endpoint || !selection.model) {
    const first = CLI.listEndpointModels(env)
      .flatMap(({ name, models }) => models.map((model) => ({ endpoint: name, model })))
      .sort((a, b) => `${a.endpoint}/${a.model}`.localeCompare(`${b.endpoint}/${b.model}`))[0];
    if (first) selection = first;
  }
  CLI.writeLastCombo(env, selection);
  return {
    env,
    options: {
      ...(selection.endpoint && selection.model ? { model: `${selection.endpoint}/${selection.model}` } : {}),
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

/** Layer a named theme over its `parent` chain (cycle-safe; "default"
 *  and unknown parents end the chain — the browser palette is the base). */
function resolveThemeTokens(themes, name, seen = new Set()) {
  const value = themes?.[name];
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(name)) return {};
  seen.add(name);
  const { parent, ...tokens } = value;
  return { ...(typeof parent === "string" && parent !== "default" ? resolveThemeTokens(themes, parent, seen) : {}), ...tokens };
}

/** Collapsed-block preview heights, in rows, per semantic block. The
 *  defaults mirror the TUI's default theme (lib/tui-app/theme-data.js —
 *  not importable here: the web app never depends on tui-app); a theme's
 *  `<role>.preview.maxRows` overrides them, false = uncapped. */
const PREVIEW_DEFAULTS = Object.freeze({ system: 8, thinking: 8, tool: 7 });
const PREVIEW_ROLES = Object.freeze({ system: "message.system.preview", thinking: "message.thinking.preview", tool: "tool.preview" });
function themePreviewRows(tokens = {}) {
  return Object.fromEntries(Object.entries(PREVIEW_ROLES).map(([kind, role]) => {
    const value = tokens?.[role]?.maxRows;
    return [kind, value === false || (Number.isInteger(value) && value > 0) ? value : PREVIEW_DEFAULTS[kind]];
  }));
}

/** "dark" | "light" from the theme canvas (else its text color). */
function themeMode(tokens) {
  const hex = HEX.test(tokens?.background?.bg ?? "") ? tokens.background.bg : HEX.test(tokens?.text?.fg ?? "") ? tokens.text.fg : null;
  if (!hex) return null;
  const full = hex.length <= 5 ? [...hex.slice(1, 4)].map((c) => c + c).join("") : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fromText = !HEX.test(tokens?.background?.bg ?? "");
  return (luminance < 0.5) !== fromText ? "dark" : "light";
}

const display = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
function themeAnimation(theme) {
  const busy = theme?.["status.busy"]?.animation;
  const border = theme?.["input.border.active.bottom"]?.animation ?? theme?.["input.border.active.top"]?.animation;
  const value = (animation, prefix) => {
    const data = typeof animation === "string" ? { type: animation } : animation;
    if (!data || typeof data !== "object" || !["wave", "flash", "comet"].includes(data.type)) return "";
    const period = Math.max(100, Math.min(10_000, Number(data.period ?? data.crossing) || (data.type === "wave" ? 850 : 1400)));
    const colors = Array.isArray(data.colors ?? data.head) ? (data.colors ?? data.head).filter((color) => typeof color === "string" && HEX.test(color)).slice(0, 8) : [];
    return `${prefix}-animation-name:web-${data.type};${prefix}-duration:${period}ms${colors.map((color, index) => `;${prefix}-color-${index}:${color}`).join("")}`;
  };
  return [value(busy, "--working"), value(border, "--input-border")].filter(Boolean).join(";");
}

function agentInfo(agent, active) {
  // `state` derives `busy`, never the reverse: a snapshot can be taken in
  // the instant after a disconnect clears (state "idle") but before the
  // run's finally flips `_running`, and the wire must never report the
  // mixed {busy:true, state:"idle"}.
  const state = agent.ioState === "disconnected" ? "disconnected" : agent.busy === true || agent.ioState === "working" ? "working" : "idle";
  return {
    id: display(agent.name),
    name: display(agent.name),
    endpoint: display(agent.endpoint),
    model: display(agent.model),
    busy: state === "working",
    state,
    description: display(agent.description),
    parentId: agent.parent ? display(agent.parent.name) : null,
    session: agent.session ? display(agent.session.id) : null,
    active: agent === active,
    children: agent.children.map((child) => agentInfo(child, active)),
  };
}

/**
 * Start the web server.
 * @param {object} [state] - launch state (model/session/tools/limits/safe/host/port)
 * @returns {Promise<{server, host, port, url, env, stop, done}>}
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
  // (kind "anonymous") or a state.keepGhost opt-in keeps the old Ghost
  // (unpersisted) behavior; a host-supplied state.createSession factory
  // stays authoritative for its own agents.
  const anonymous = state.session?.kind === "anonymous" || state.keepGhost === true;
  const connections = new Map();
  const uploads = new UploadRegistry(state.uploadLimits);
  // A bridge belongs to the Agent, not to the selected sidebar row. It keeps
  // receiving background stream events even when no browser currently views it.
  const agentSessions = new Map();

  const listRecent = async () => Agent.SessionStore.listAsync({ dir: Agent.sessionDir(), cwd: env.cwd });
  // Web display preferences come from settings.web (lib/env/settings-schema.js
  // owns the defaults) — the client honors them, never hardcodes.
  const webPrefs = () => {
    const w = env.settings?.web ?? {};
    return {
      autocomplete: w.autocomplete !== false,
      collapse: { thinking: w.collapse?.thinking !== false, tools: w.collapse?.tools !== false },
      theme: ["system", "light", "dark"].includes(w.theme) ? w.theme : "system",
      thinkingLevels: Env.THINKING_LEVELS,
      themes: ["system", "light", "dark", ...themeNames()],
      // tui.theme is shared with the TUI: a named theme chosen in either
      // front end is the other's default too ("default" = browser palette).
      activeTheme: themeNames().includes(env.settings?.tui?.theme) ? env.settings.tui.theme : null,
      themeModes: Object.fromEntries(themeNames().map((name) => [name, themeMode(resolveThemeTokens(env.settings?.tui?.themes, name))])),
      // Preview rows per named theme (system/light/dark use the defaults).
      previewRows: { default: themePreviewRows(), ...Object.fromEntries(themeNames().map((name) => [name, themePreviewRows(resolveThemeTokens(env.settings?.tui?.themes, name))])) },
    };
  };
  const themeNames = () => Object.keys(env.settings?.tui?.themes ?? {}).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).sort();
  const themeCss = (name) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    if (!env.settings?.tui?.themes?.[name] || typeof env.settings.tui.themes[name] !== "object") return null;
    const theme = resolveThemeTokens(env.settings.tui.themes, name);
    const color = (role, key = "fg") => typeof theme[role]?.[key] === "string" && HEX.test(theme[role][key]) ? theme[role][key] : null;
    // `background.bg` is the theme-wide canvas. When absent, deliberately
    // emit no background variables: the browser's system/light/dark CSS stays
    // authoritative rather than guessing from a foreground token.
    const background = color("background", "bg");
    const values = {
      ...(background ? { "--page": background, "--surface": background, "--surface-2": background } : {}),
      ...Object.fromEntries(THEME_VARS.map(([variable, role, key]) => [variable, color(role, key)])),
    };
    const css = Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(";");
    const animation = themeAnimation(theme);
    const body = `${css}${animation ? `;${animation}` : ""}`;
    // The second rule scopes the same palette to a theme picker card, so
    // every swatch previews its own colors without switching the page.
    return `:root[data-theme="${name}"]{${body}}\n.theme-card[data-theme="${name}"]{${css}}`;
  };
  // The model menu lists CONCRETE endpoint/model combos (deduplicated),
  // never the noisy completion list (endpoints + bare ids + combos).
  const modelChoices = () => {
    const combos = [];
    for (const { name, models } of CLI.listEndpointModels(env)) for (const id of models) combos.push(`${name}/${id}`);
    return [...new Set(combos)].sort();
  };
  const settingsState = (agent) => ({
    ...(agent
      ? {
        safe: agent.safe === true,
        thinking: agent.thinking ?? "default",
        ...(agent.sessionSave === undefined ? {} : { sessionSave: agent.sessionSave === true }),
        spawnPermission: agent.spawnPermission === true ? true : agent.spawnPermission === false ? false : null,
        delegationLocked: Boolean(agent.parent),
        endpoint: agent.endpoint ?? null,
        model: agent.model ?? null,
      }
      : {}),
    models: modelChoices(),
    prefs: webPrefs(),
  });
  const send = (entry, packet) => { if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(packet)); };
  const sendSettings = (entry) => send(entry, { type: "settings", ...settingsState(entry.agent) });
  const sendSessions = async (entry) => {
    if (entry.ws.readyState !== WebSocket.OPEN) return;
    const recent = await listRecent();
    send(entry, { type: "sessions", agents: env.agents().filter((a) => !a.parent).map((a) => agentInfo(a, entry.agent)), recent });
  };
  const broadcast = (fn) => { for (const entry of connections.values()) fn(entry); };
  const broadcastSessions = () => broadcast((entry) => sendSessions(entry).catch(() => {}));
  const broadcastSettings = () => broadcast((entry) => sendSettings(entry));
  const endpointsState = () => ({
    endpoints: CLI.listEndpointModels(env).map(({ name, models = [], loginRequired }) => ({ name, models, loginRequired: loginRequired === true })),
    removable: env.endpointNames?.({ includeSecret: true }) ?? [],
    providers: (env.providerNames?.() ?? []).filter((name) => env.providers?.[name]?.provider?.secret !== true),
    presets: (env.knownEndpoints?.() ?? []).map(({ name, label, provider, url, oauth }) => ({ name, label: label ?? name, provider, url, oauth: Boolean(oauth) })),
  });
  const sendEndpoints = (entry) => send(entry, { type: "endpoints", ...endpointsState() });
  const broadcastEndpoints = () => { broadcast(sendEndpoints); broadcastSettings(); broadcastSessions(); };
  // One browser sign-in at a time (the OAuth paste channel is process-wide).
  let oauthRunning = false;
  const oauth = (packet) => broadcast((entry) => send(entry, { type: "oauth", ...packet }));
  const runOAuth = async (entry, name) => {
    const preset = (env.knownEndpoints?.() ?? []).find((item) => item.name === name && item.oauth);
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
  // AGENT_START/AGENT_DONE also refresh each VIEWED agent snapshot: the
  // composer's Stop button and working animation read that snapshot, and a
  // sessions-only push would leave it stale until an agent switch.
  const sendAgentSnapshot = (changed) => broadcast((entry) => { if (entry.agent === changed) send(entry, { type: "agent", agent: agentInfo(changed, changed) }); });
  const broadcastAgentStates = ({ agent: changed } = {}) => {
    broadcastSessions();
    if (!changed) return;
    sendAgentSnapshot(changed);
    // AGENT_DONE fires before the run's finally flips `_running`, so the
    // fresh snapshot would still read busy — re-send after the settle.
    queueMicrotask(() => sendAgentSnapshot(changed));
  };
  const eventHandles = [ENV_EVENT.AGENT_ADDED, ENV_EVENT.AGENT_START, ENV_EVENT.AGENT_DONE]
    .map((event) => env.onEvent(event, broadcastAgentStates));
  const removedHandle = env.onEvent(ENV_EVENT.AGENT_REMOVED, ({ agent }) => {
    const session = agentSessions.get(agent);
    session?.dispose();
    agentSessions.delete(agent);
    broadcastSessions();
  });
  eventHandles.push(removedHandle);

  /** Attach a connection to an agent-owned bridge without stopping its stream. */
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

  const greet = (entry) => send(entry, { type: "hello", agent: agentInfo(entry.agent, entry.agent), history: entry.session?.historySnapshot() ?? [], queue: entry.session?.pendingSnapshot() ?? [], catalog: catalog(entry.agent), status: entry.session?.statusSnapshot() ?? null, uploadKey: entry.uploadKey });

  const makeSession = async (entry, session, { model, safe } = {}) => {
    let agent;
    if (state.createSession) ({ agent } = await state.createSession());
    else agent = env.createAgent({ ...prepared.options, ...(model ? { model } : {}), ...(session === null ? { session: null } : { session: session ?? randomUUID() }) });
    if (safe === true) agent.setSafe(true);
    attach(entry, agent);
    greet(entry);
    await sendSessions(entry);
    sendSettings(entry);
  };

  /** Replace one viewed agent. Every other browser attached to the old agent
   * receives its own fresh Ghost, so no connection retains a disposed bridge. */
  const replaceViewed = async (entry, session, options = {}) => {
    const previous = entry.agent;
    if (!previous) return makeSession(entry, session, options);
    const viewers = [...connections.values()].filter((candidate) => candidate.agent === previous);
    previous.close();
    await Promise.all(viewers.map((candidate) => makeSession(candidate, candidate === entry ? session : null, candidate === entry ? options : {})));
    broadcastSessions();
  };

  /** Run a /command against the connection's agent, emitting result packets. */
  const handleCommand = async (entry, line) => {
    const agent = entry.agent;
    if (!agent) { send(entry, { type: "command.result", text: "no active session — send a message first" }); return; }
    const result = await runCommand(agent, line, {
      submit: (text) => entry.session.submit(text),
      continue: () => { if (!entry.session.busy) entry.session.continue(); },
      clear: () => entry.session.clear(),
    });
    if (result.cleared || result.renew) entry.session?.refresh();
    if (result.cleared) send(entry, { type: "hello", agent: agentInfo(agent, agent), history: entry.session?.historySnapshot() ?? [], catalog: catalog(agent), status: entry.session?.statusSnapshot() ?? null, uploadKey: entry.uploadKey });
    else if (result.renew) send(entry, { type: "history", history: entry.session?.historySnapshot() ?? [] });
    if (result.text) send(entry, { type: "command.result", text: result.text });
    if (result.open) { if (result.open === "login") sendEndpoints(entry); send(entry, { type: "command.open", view: result.open, ...(Number.isInteger(result.index) ? { index: result.index } : {}) }); }
    if (typeof result.copy === "string") send(entry, { type: "command.copy", text: result.copy });
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
        // agent state (safe/thinking/model), and a null session is Ghost
        // mode — no transcript is persisted.
        const initial = anonymous
          ? null
          : state.session?.kind === "resume"
            ? (state.session.id === "latest" ? Agent.SessionStore.latest({ cwd: env.cwd }) : state.session.id)
            : state.session?.kind === "new" ? state.session.id : undefined;
        await makeSession(entry, initial);
        sendSettings(entry);
        sendEndpoints(entry);
      },
      message: async (ws, message) => {
        const entry = connections.get(ws);
        if (!entry) return;
        try {
          const parsed = parseClientMessage(message);
          if (parsed.type === "session.list") return void await sendSessions(entry);
          if (parsed.type === "session.new") return void await replaceViewed(entry, parsed.anonymous ? null : undefined, { safe: parsed.safe });
          if (parsed.type === "session.add") {
            let model;
            if (parsed.model) {
              const combo = await CLI.resolveModelCombo(parsed.model, env, {});
              if (combo.endpoint === undefined || combo.model === undefined) throw new TypeError(`unknown model "${parsed.model}"`);
              model = `${combo.endpoint}/${combo.model}`;
            }
            return void await makeSession(entry, undefined, { model, safe: parsed.safe });
          }
          if (parsed.type === "session.rename") {
            if (!entry.agent?.session) throw new TypeError("an anonymous session has no file to name — turn logging on first");
            const result = entry.agent.renameSession(parsed.name);
            send(entry, { type: "command.result", text: `session named: ${result.id}` });
            greet(entry); broadcastSessions(); sendSettings(entry);
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
            target.name = parsed.name;
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
            if (entry.agent) entry.agent.setSpawnPermission(parsed.value === null ? undefined : parsed.value);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.theme") {
            if (!["system", "light", "dark", "default"].includes(parsed.name)) env.saveTheme(parsed.name);
            else if (env.settings?.tui?.theme && env.settings.tui.theme !== "default") env.saveTheme("default");
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
            for (const candidate of env.agents()) if (candidate.endpoint === removed.name) { candidate.endpoint = undefined; candidate.model = undefined; }
            send(entry, { type: "command.result", text: `endpoint removed: ${removed.name}${removed.dynamic ? " (environment-defined — it re-detects while the environment provides it)" : ""}` });
            broadcastEndpoints();
            return;
          }
          if (parsed.type === "session.fork") {
            if (!entry.agent) throw new TypeError("no active agent");
            entry.agent.fork(parsed.id);
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
            agent.close();
            // An Agent can be displayed by more than one browser connection.
            // Each gets a fresh Ghost after the closed bridge is released.
            const next = env.agents().find((candidate) => !candidate.parent && candidate !== agent && !candidate.closed);
            await Promise.all([...connections.values()]
              .filter((candidate) => candidate.agent === agent)
              .map(async (candidate) => {
                if (!next) return makeSession(candidate, null);
                attach(candidate, next); greet(candidate); await sendSessions(candidate); sendSettings(candidate);
              }));
            broadcastSessions();
            return;
          }
          if (parsed.type === "session.resume") {
            const recent = await listRecent();
            if (!recent.some((item) => item.id === parsed.id)) throw new TypeError("unknown session");
            return void await replaceViewed(entry, parsed.id);
          }
          if (parsed.type === "settings.safe") {
            if (entry.agent) entry.agent.setSafe(parsed.on);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.thinking") {
            if (!Env.THINKING_LEVELS.includes(parsed.level)) throw new TypeError(`unknown thinking level "${parsed.level}" (use ${Env.THINKING_LEVELS.join("/")})`);
            if (entry.agent) entry.agent.setThinking(parsed.level === "default" ? undefined : parsed.level);
            sendSettings(entry);
            return;
          }
          if (parsed.type === "settings.session-save") {
            if (!entry.agent) throw new TypeError("no active agent");
            if (entry.agent.session?.saveSet) entry.agent.sessionSaveSet(parsed.on);
            else if (parsed.on === true) entry.agent.newSession(randomUUID()); // opting in on an anonymous agent starts a saved session (an explicit id — /session-new keeps anonymous anonymous)
            sendSettings(entry);
            await sendSessions(entry);
            return;
          }
          if (parsed.type === "settings.model") {
            if (entry.agent) {
              const combo = await CLI.resolveModelCombo(parsed.model, env, { url: entry.agent.url });
              if (combo.endpoint === undefined || combo.model === undefined) throw new TypeError(`unknown model "${parsed.model}" (pick one from the settings list)`);
              entry.agent.endpoint = combo.endpoint;
              entry.agent.model = combo.model;
              CLI.writeLastCombo(env, { endpoint: entry.agent.endpoint, model: entry.agent.model });
            }
            sendSettings(entry);
            broadcastSessions();
            return;
          }
          if (parsed.type === "context.inspect") { send(entry, { type: "context", blocks: entry.session?.contextSnapshot() ?? [] }); return; }
          if (parsed.type === "context.edit-text") { send(entry, { type: "context", blocks: entry.session.editText(parsed.messageIndex, parsed.blockIndex, parsed.text) }); return; }
          if (parsed.type === "context.rollback") { send(entry, { type: "context", blocks: entry.session.rollback(parsed.messageIndex) }); return; }
          if (parsed.type === "context.pop") { send(entry, { type: "context", blocks: entry.session.pop() }); return; }
          if (parsed.type === "context.delete") { send(entry, { type: "context", blocks: entry.session.deleteMessages(parsed.messageIndexes), history: entry.session.historySnapshot() }); return; }
          if (parsed.type === "tool.call") { await entry.session.callTool(parsed.name, parsed.args); return; }
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
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const handle of eventHandles) env.offEvent(handle);
    for (const ws of [...connections.keys()]) close(ws);
    for (const session of agentSessions.values()) session.dispose();
    agentSessions.clear();
    server.stop(true);
    resolveDone();
  };
  return { server, host, port: server.port, url, env, stop, done };
}
export const createWebServer = serve;
