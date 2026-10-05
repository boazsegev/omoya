/** Per-Env connections, bridges, catalogs, and dispatch. */
import { randomUUID } from "node:crypto";
import Agent from "../../agent.js";
import Env from "../../env.js";
import IO from "../../io.js";
import CLI from "../../cli.js";
import { parseClientMessage } from "./protocol.js";
import { AgentSession } from "./session.js";
import { catalog, runCommand } from "./commands.js";
import { UploadRegistry } from "./upload-registry.js";
import { modelParts } from "../shared/format.js";
import { toolCatalogText } from "../shared/tool-catalog.js";
import { agentInfo as agentInfoOf } from "./agent-info.js";
import { resolveThemeTokens, themeMode, isDualTheme, themePreviewRows, themeCss } from "./theme-tokens.js";
import { createPacketHandlers } from "./handlers.js";

export async function createWorkspace(state, prepared, registry) {
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
  // `scope` "all": the root URL's all-projects view; "group": a group view (`group` names it); "project": this project's URL only.
  const projectState = (entry) => ({ projects: registry?.list(env.cwd) ?? [{ name: env.name, path: env.cwd, url: "/", current: true }], scope: entry.multi ? (entry.group === undefined ? "all" : "group") : "project", group: entry.group ?? null, canManageProjects: entry.local === true });
  // Agent names are unique per Env only; `project` (this Env's cwd) completes the identity.
  const agentInfo = (agent, active) => agentInfoOf(agent, active, env.cwd);
  /** Snapshot this project's top-level agents. */
  const topAgents = (active) => env.agents().filter((a) => !a.parent).map((a) => agentInfo(a, active));
  /** List persisted sessions for the current environment and working directory.
   * @returns {Promise<Array<object>>} Recent session records.
   */
  const listRecent = async () => Agent.Context.listAsync({ dir: env.settings.sessions, cwd: env.cwd, limit: Infinity });
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
  const send = (entry, packet) => { if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(packet)); };
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
  /** This project's saved sessions for the client: each names its `project`;
   * `live`: a running agent holds it open (it renames through that agent and
   * cannot be deleted from under it).
   * @returns {Promise<Array<object>>} Session records.
   */
  const recentSessions = async () => {
    const recent = await listRecent();
    const live = liveSessionIds();
    return recent.map((item) => ({ ...item, project: env.cwd, ...(live.has(item.id) ? { live: true } : {}) }));
  };
  const sendSessions = async (entry) => {
    if (entry.ws?.readyState !== WebSocket.OPEN) return;
    // A multi-project view lists the agents and saved sessions of every project it shows.
    const multi = entry.multi && registry;
    const recent = multi ? await registry.recent(entry.group) : await recentSessions();
    send(entry, { type: "sessions", agents: multi ? registry.agents(entry.agent, entry.group) : topAgents(entry.agent), recent });
  };
  /** Invoke a callback for every current connection.
   * @param {Function} fn - Per-connection action.
   * @returns {void}
   */
  const broadcast = (fn) => { for (const entry of connections.values()) fn(entry); };
  /** Broadcast session lists, suppressing individual lookup failures. Local
   * changes also refresh all-projects viewers attached to other projects;
   * `remote` is that refresh (all-projects viewers only, never re-propagated).
   * @param {{remote?: boolean}} [options={}]
   * @returns {void}
   */
  const broadcastSessions = ({ remote = false } = {}) => {
    broadcast((entry) => { if (!remote || entry.multi) sendSessions(entry).catch(() => {}); });
    if (!remote) registry?.sessionsChanged?.(env.cwd);
  };
  /** Broadcast settings to all connections.
   * @returns {void}
   */
  const broadcastSettings = () => broadcast((entry) => sendSettings(entry));
  /** Snapshot endpoint, provider, and login-preset catalogs.
   * @returns {object} Serializable endpoint catalog.
   */
  const endpointsState = () => ({
    endpoints: CLI.listEndpointModels(env).map(({ name, models = [], loginRequired }) => ({ name, models, loginRequired: loginRequired === true })),
    mcp: env.mcpStatus(),
    removable: CLI.listEndpoints(env),
    policies: CLI.endpointPolicies(env),
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
  const runMcpOAuth = async (name) => {
    if (oauthRunning) throw new TypeError("a sign-in is already in progress");
    oauthRunning = true;
    try {
      await env.mcpLogin(name, { open: () => false,
        onAuthUrl: (url) => oauth({ state: "url", url, name }),
        onLog: (text) => oauth({ state: "log", text }) });
      oauth({ state: "done", text: `MCP signed in: ${name}` });
    } catch (error) { oauth({ state: "error", text: `MCP sign-in failed: ${error.message}` }); }
    finally { oauthRunning = false; broadcastEndpoints(); }
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
  const greet = (entry) => send(entry, { type: "hello", agent: agentInfo(entry.agent, entry.agent), history: entry.session?.historySnapshot() ?? [], queue: entry.session?.pendingSnapshot() ?? [], catalog: catalog(entry.agent, tools), status: entry.session?.statusSnapshot() ?? null, throttledUntil: entry.agent?.throttledUntil ?? null, uploadKey: entry.uploadKey, ...projectState(entry) });

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

  /** `/session-resume <id>` of another open project's saved session: a multi-project
   * view showing that project moves there; any other view navigates to the project's URL.
   * @param {object} entry - Connection issuing the command.
   * @param {string} line - Command line.
   * @returns {Promise<boolean>} true when handled here (otherwise the command runs in this project).
   */
  const resumeElsewhere = async (entry, line) => {
    const id = /^\/session-resume\s+(\S+)$/.exec(line.trim())?.[1];
    if (!registry || id === undefined || id === "latest" || id === "true" || (await listRecent()).some((item) => item.id === id)) return false;
    const owner = await registry.sessionOwner(id);
    if (owner === undefined) return false;
    if (entry.multi && registry.visible(owner, entry.group)) await registry.move(entry.ws, owner, undefined, { resume: id });
    else send(entry, { type: "navigate", url: `${registry.url(owner)}?resume=${encodeURIComponent(id)}` });
    return true;
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
    if (await resumeElsewhere(entry, line)) return;
    const result = await runCommand(agent, line, {
      continue: () => { if (!entry.session.busy) entry.session.continue(); },
      clear: () => entry.session.clear(),
    });
    if (result.cleared || result.renew) entry.session?.refresh();
    if (result.cleared) send(entry, { type: "hello", agent: agentInfo(agent, agent), history: entry.session?.historySnapshot() ?? [], catalog: catalog(agent, tools), status: entry.session?.statusSnapshot() ?? null, throttledUntil: entry.agent?.throttledUntil ?? null, uploadKey: entry.uploadKey, ...projectState(entry) });
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

  const handlers = createPacketHandlers({ registry, env, uploads, send, sendSessions, replaceViewed, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, runMcpOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent });
  /** Accept a socket: attach `agentId`, else the first top-level agent, else a new one.
   * @param {WebSocket} ws - Socket (`data.local`, `data.multi`, `data.group` from the host).
   * @param {{agentId?: string, moved?: boolean, resume?: string}} [options={}] - `moved`: arrived from another project, so never reopens the launch session; `resume`: a saved session id to view (its running agent, else a new agent resuming it).
   * @returns {Promise<void>}
   */
  const open = async (ws, { agentId, moved = false, resume } = {}) => {
    const entry = { ws, local: ws.data?.local === true, multi: ws.data?.multi === true, group: ws.data?.group, agent: null, session: null, send: null, uploadKey: uploads.open() };
    entry.send = (packet) => send(entry, packet);
    connections.set(ws, entry);
    if (resume !== undefined && (await listRecent()).some((item) => item.id === resume)) {
      const holder = env.agents().find((agent) => !agent.parent && agent.context.id === resume);
      if (holder) { attach(entry, holder); greet(entry); await sendSessions(entry); }
      else await makeSession(entry, resume);
      sendSettings(entry);
      sendEndpoints(entry);
      broadcastSessions();
      return;
    }
    // On a page reload, reconnect to the first existing top-level agent
    // before creating a Ghost or opening an explicitly requested session.
    // Agent registration preserves creation order, which is also the
    // running-agent order shown by the sidebar.
    const running = agentId === undefined ? env.agents().find((agent) => !agent.parent) : findAgent(agentId);
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
      : moved ? undefined
      : state.session?.kind === "resume"
        ? (state.session.id === "latest" ? Agent.Context.latest({ dir: env.settings.sessions, cwd: env.cwd }) : state.session.id)
        : state.session?.kind === "new" ? state.session.id : undefined;
    await makeSession(entry, initial);
    sendSettings(entry);
    sendEndpoints(entry);
  };
  const message = async (ws, data) => {
    const entry = connections.get(ws);
    if (!entry) return;
    try {
      const { project, ...packet } = parseClientMessage(data);
      // The all-projects view names agents of other projects: switching moves
      // this socket there; managing them runs in their owning project.
      if (project !== undefined && project !== env.cwd) {
        if (!entry.multi || !registry || !registry.visible(project, entry.group)) throw new TypeError("unknown agent");
        if (packet.type === "session.switch") await registry.move(ws, project, packet.agentId);
        else if (packet.type === "session.resume") await registry.move(ws, project, undefined, { resume: packet.id });
        else await registry.forward(project, packet);
        return;
      }
      await handlers[packet.type]?.(entry, packet);
    } catch (error) { send(entry, { type: "error", message: error?.message ?? "invalid message" }); }
  };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const handle of eventHandles) env.offEvent(handle);
    env.offEvent(modelsHandle);
    for (const agent of [...requestHandles.keys()]) unwatchAgent(agent);
    for (const ws of [...connections.keys()]) close(ws);
    for (const session of agentSessions.values()) session.dispose();
    agentSessions.clear();
  };
  /** Find an inline image by a media URL some Agent session issued.
   * @param {string} key - Session media capability from the URL.
   * @param {number} messageIndex - Context message index.
   * @param {number} blockIndex - Block index within that message.
   * @param {string} version - Content version from the URL.
   * @returns {{mime: string, bytes: Uint8Array}|null} Image bytes, or null for unknown or stale URLs.
   */
  const media = (key, messageIndex, blockIndex, version) => {
    for (const session of agentSessions.values()) {
      const image = session.media(key, messageIndex, blockIndex, version);
      if (image) return image;
    }
    return null;
  };
  const findAgent = (name) => env.agents().find((a) => a.name === name);
  // Packets another project's all-projects viewer may run here (no viewer entry).
  // Each names its target: an agent (`agentId`) or a saved session (`id`).
  const REMOTE = new Set(["session.close", "agent.rename", "session.rename", "session.delete"]);
  /** Run a forwarded agent- or session-management packet without a local connection.
   * @param {object} packet - Validated packet naming its agent or saved session.
   * @returns {Promise<void>}
   * @throws {TypeError} For packet types that need a viewing connection.
   */
  const remote = async (packet) => {
    if (!REMOTE.has(packet.type) || (packet.agentId ?? packet.id) === undefined) throw new TypeError(`${packet.type} needs the agent's project view`);
    await handlers[packet.type]({ ws: null, local: false, multi: false, agent: null, session: null, send: () => {}, uploadKey: null }, packet);
  };
  return { open, message, close, media, remote, broadcastSessions,
    running: () => env.agents().some((a) => !a.parent),
    /** Connected viewers (socket, multi-project flag, group, packet sender). */
    viewers: () => [...connections.values()].map((entry) => ({ ws: entry.ws, multi: entry.multi, group: entry.group, send: (packet) => send(entry, packet) })),
    agent: findAgent,
    agents: topAgents,
    recent: recentSessions,
    knownSession,
    ownsUpload: (key) => uploads.owns(key),
    broadcastProjects: () => broadcast((entry) => send(entry, { type: "projects", ...projectState(entry) })), upload: (key, file) => uploads.add(key, file),
    themeCss: () => Object.keys(env.settings?.tui?.themes ?? {}).map((name) => themeCss(env, name)).filter(Boolean).join("\n"), stop };
}
