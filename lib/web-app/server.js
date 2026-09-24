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

import Agent from "../agent.js";
import Env from "../env.js";
import CLI from "../cli.js";
import { parseClientMessage } from "./protocol.js";
import { AgentSession } from "./session.js";
import { catalog, runCommand } from "./commands.js";
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
  "/logo.svg": ["logo.svg", "image/svg+xml"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const headers = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const content = async (name) => await Bun.file(new URL(`./public/${name}`, import.meta.url)).text();

/** Resolve the shared Env and endpoint/model selection once at launch. */
async function launch(state) {
  const log = state.diagnostics ? (line) => state.diagnostics.write(`${line}\n`) : () => {};
  const env = state.env ?? await Env.create(state.envOptions);
  env.refreshModels().catch(() => {});
  const selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  CLI.writeLastCombo(env, selection);
  return {
    env,
    options: {
      model: `${selection.endpoint}/${selection.model}`,
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

const display = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
function themeAnimation(theme) {
  const busy = theme?.["status.busy"]?.animation;
  const border = theme?.["input.border.active.bottom"]?.animation ?? theme?.["input.border.active.top"]?.animation;
  const value = (animation, prefix) => {
    const data = typeof animation === "string" ? { type: animation } : animation;
    if (!data || typeof data !== "object" || !["wave", "flash", "comet"].includes(data.type)) return "";
    const period = Math.max(100, Math.min(10_000, Number(data.period ?? data.crossing) || (data.type === "wave" ? 850 : 1400)));
    const colors = Array.isArray(data.colors ?? data.head) ? (data.colors ?? data.head).filter((color) => typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color)).slice(0, 8) : [];
    return `${prefix}-animation-name:web-${data.type};${prefix}-duration:${period}ms${colors.map((color, index) => `;${prefix}-color-${index}:${color}`).join("")}`;
  };
  return [value(busy, "--working"), value(border, "--input-border")].filter(Boolean).join(";");
}

function agentInfo(agent, active) {
  return {
    id: display(agent.name),
    name: display(agent.name),
    endpoint: display(agent.endpoint),
    model: display(agent.model),
    busy: agent.busy === true,
    state: agent.ioState === "disconnected" ? "disconnected" : agent.busy === true || agent.ioState === "working" ? "working" : "idle",
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
  const connections = new Map();
  const uploads = new UploadRegistry(state.uploadLimits);
  // A bridge belongs to the Agent, not to the selected sidebar row. It keeps
  // receiving background stream events even when no browser currently views it.
  const agentSessions = new Map();
  let claimedDefault = false;

  const listRecent = async () => Agent.SessionStore.listAsync({ dir: Agent.sessionDir(), cwd: env.cwd });
  // Web display preferences come from settings.web (lib/env/settings-schema.js
  // owns the defaults) — the client honors them, never hardcodes.
  const webPrefs = () => {
    const w = env.settings?.web ?? {};
    return {
      autocomplete: w.autocomplete !== false,
      collapse: { thinking: w.collapse?.thinking !== false, tools: w.collapse?.tools !== false },
      toolLines: Number.isInteger(w.toolLines) && w.toolLines > 0 ? w.toolLines : 6,
      theme: ["system", "light", "dark"].includes(w.theme) ? w.theme : "system",
      thinkingLevels: Env.THINKING_LEVELS,
      themes: ["system", "light", "dark", ...Object.keys(env.settings?.tui?.themes ?? {}).sort()],
    };
  };
  const themeCss = (name) => {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) return null;
    const theme = env.settings?.tui?.themes?.[name];
    if (!theme || typeof theme !== "object") return null;
    const color = (role, key = "fg") => typeof theme[role]?.[key] === "string" && /^#[0-9a-f]{3,8}$/i.test(theme[role][key]) ? theme[role][key] : null;
    // `background.bg` is the theme-wide canvas. When absent, deliberately
    // emit no background variables: the browser's system/light/dark CSS stays
    // authoritative rather than guessing from a foreground token.
    const background = color("background", "bg");
    const values = {
      ...(background ? { "--page": background, "--surface": background, "--surface-2": background } : {}),
      "--fg": color("text"), "--muted": color("muted"), "--accent": color("accent"),
      "--border": color("border"), "--danger": color("error"),
    };
    const css = Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}:${value}`).join(";");
    const animation = themeAnimation(theme);
    return `:root[data-theme="${name}"]{${css}${animation ? `;${animation}` : ""}}`;
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
      ? { safe: agent.safe === true, thinking: agent.thinking ?? "default", endpoint: agent.endpoint ?? null, model: agent.model ?? null }
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
  const eventHandles = [ENV_EVENT.AGENT_ADDED, ENV_EVENT.AGENT_START, ENV_EVENT.AGENT_DONE]
    .map((event) => env.onEvent(event, broadcastSessions));
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

  const makeSession = async (entry, session) => {
    let agent;
    if (state.createSession) ({ agent } = await state.createSession());
    else agent = env.createAgent({ ...prepared.options, ...(session === null ? { session: null } : session ? { session } : {}) });
    attach(entry, agent);
    greet(entry);
    await sendSessions(entry);
    sendSettings(entry);
  };

  /** Replace one viewed agent. Every other browser attached to the old agent
   * receives its own fresh Ghost, so no connection retains a disposed bridge. */
  const replaceViewed = async (entry, session) => {
    const previous = entry.agent;
    if (!previous) return makeSession(entry, session);
    const viewers = [...connections.values()].filter((candidate) => candidate.agent === previous);
    previous.close();
    await Promise.all(viewers.map((candidate) => makeSession(candidate, candidate === entry ? session : null)));
    broadcastSessions();
  };

  /** Run a /command against the connection's agent, emitting result packets. */
  const handleCommand = async (entry, line) => {
    const agent = entry.agent;
    if (!agent) { send(entry, { type: "command.result", text: "no active session — send a message first" }); return; }
    const result = await runCommand(agent, line, {
      submit: (text) => entry.session.submit(text),
      continue: () => { if (!entry.session.busy) entry.session.continue(); },
    });
    if (result.cleared) send(entry, { type: "hello", agent: agentInfo(agent, agent), history: entry.session?.historySnapshot() ?? [], catalog: catalog(agent) });
    else if (result.renew) send(entry, { type: "history", history: entry.session?.historySnapshot() ?? [] });
    if (result.text) send(entry, { type: "command.result", text: result.text });
    if (result.exit) send(entry, { type: "command.exit" });
    await sendSessions(entry);
    sendSettings(entry);
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
        // A usable agent must exist before the first message: settings are
        // agent state (safe/thinking/model), and the default null session is
        // intentionally Ghost mode — no transcript is persisted.
        const initial = state.session?.kind === "resume"
          ? (state.session.id === "latest" ? Agent.SessionStore.latest({ cwd: env.cwd }) : state.session.id)
          : state.session?.kind === "new" ? state.session.id : null;
        claimedDefault = true;
        await makeSession(entry, initial);
        sendSettings(entry);
      },
      message: async (ws, message) => {
        const entry = connections.get(ws);
        if (!entry) return;
        try {
          const parsed = parseClientMessage(message);
          if (parsed.type === "session.list") return void await sendSessions(entry);
          if (parsed.type === "session.new") return void await replaceViewed(entry, null);
          if (parsed.type === "session.add") return void await makeSession(entry, undefined);
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
            await Promise.all([...connections.values()]
              .filter((candidate) => candidate.agent === agent)
              .map((candidate) => makeSession(candidate, null)));
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
          if (parsed.type === "settings.model") {
            if (entry.agent) {
              const combo = await CLI.resolveModelCombo(parsed.model, env, { url: entry.agent.url });
              if (combo.endpoint === undefined || combo.model === undefined) throw new TypeError(`unknown model "${parsed.model}" (pick one from the settings list)`);
              entry.agent.endpoint = combo.endpoint;
              entry.agent.model = combo.model;
              CLI.writeLastCombo(env, { endpoint: entry.agent.endpoint, model: entry.agent.model });
            }
            sendSettings(entry);
            return;
          }
          if (parsed.type === "context.inspect") { send(entry, { type: "context", blocks: entry.session?.contextSnapshot() ?? [] }); return; }
          if (parsed.type === "context.edit-text") { send(entry, { type: "context", blocks: entry.session.editText(parsed.messageIndex, parsed.blockIndex, parsed.text) }); return; }
          if (parsed.type === "context.rollback") { send(entry, { type: "context", blocks: entry.session.rollback(parsed.messageIndex) }); return; }
          if (parsed.type === "context.pop") { send(entry, { type: "context", blocks: entry.session.pop() }); return; }
          if (parsed.type === "context.delete") { send(entry, { type: "context", blocks: entry.session.deleteMessages(parsed.messageIndexes), history: entry.session.historySnapshot() }); return; }
          if (parsed.type === "tool.call") { await entry.session.callTool(parsed.name, parsed.args); return; }
          // Everything below needs a live session; the first chat message
          // lazily creates the agent (claiming a launch-time resume once).
          if (parsed.type === "chat.submit") {
            if (!entry.agent) {
              let resume;
              if (!claimedDefault && state.session?.kind === "resume") {
                resume = state.session.id === "latest" ? Agent.SessionStore.latest({ cwd: env.cwd }) : state.session.id;
                claimedDefault = true;
              }
              await makeSession(entry, resume || null);
            }
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
