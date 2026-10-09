/** Per-Env connections, bridges, catalogs, and dispatch. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Agent from "../../agent.js";
import Env from "../../env.js";
import IO from "../../io.js";
import CLI from "../cli.js";
import { runOAuthFlow, tokensToAuth } from "../host/oauth.js";
import { listEndpoints, listEndpointModels } from "../shared/catalog.js";
import { endpointPolicies } from "../shared/endpoint-policy.js";
import { parseClientMessage } from "./protocol.js";
import { AgentSession } from "./session.js";
import { conversationCreate, conversationActivate } from "../host/conversation.js";
import { catalog, runCommand } from "./commands.js";
import { UploadRegistry } from "./upload-registry.js";
import { modelParts } from "../shared/format.js";
import { toolCatalogText } from "../shared/tool-catalog.js";
import { agentInfo as agentInfoOf } from "./agent-info.js";
import { resolveThemeTokens, themeMode, isDualTheme, themePreviewRows, themeCss } from "./theme-tokens.js";
import { createPacketHandlers } from "./handlers.js";
import { settingsSnapshot } from "./settings-snapshot.js";

const SNAPSHOT_PACKETS = new Set(["settings", "endpoints", "projects", "agent"]);

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
  let stopped = false;
  // Async opens/listings can settle after stop(), close(), or a project move.
  // Check ownership before building readouts, not merely before sending them.
  const active = (entry) => !stopped && connections.get(entry.ws) === entry && entry.ws?.readyState === WebSocket.OPEN;
  const uploads = new UploadRegistry(state.uploadLimits);
  // A bridge belongs to the Agent, not to the selected sidebar row. It keeps
  // receiving background stream events even when no browser currently views it.
  const agentSessions = new Map();

  // The tool catalog snapshot (Env.tools(): ToolInfo values) every hello
  // carries; refreshed after each tool run (live status may move).
  let tools = await env.tools();
  let themeStylesVersion = 0;
  let themeData = settingsSnapshot(env.settings.themes);
  // Render before the host starts accepting requests; each workspace owns its
  // own CSS, including when a project is added after the server starts.
  const renderThemeCss = () => Object.keys(env.settings?.themes ?? {}).map((name) => themeCss(env, name)).filter(Boolean).join("\n");
  let cachedThemeCss = renderThemeCss();
  const updateThemeRevision = () => {
    const next = settingsSnapshot(env.settings.themes);
    if (!isDeepStrictEqual(themeData, next)) {
      themeData = next;
      cachedThemeCss = renderThemeCss();
      themeStylesVersion++;
    }
  };
  /** Refresh the hello-packet tool snapshot; failures leave the last good snapshot intact.
   * @returns {Promise<void>} Resolves after refresh attempt.
   */
  const refreshTools = () => env.tools().then((next) => { tools = next; }, () => {});
  // `scope` "all": the root URL's all-projects view; "group": a group view (`group` names it); "project": this project's URL only.
  const projectState = (entry) => ({ projects: registry?.list(env.folder) ?? [{ name: env.name, path: env.folder, url: "/", current: true }], scope: entry.multi ? (entry.group === undefined ? "all" : "group") : "project", group: entry.group ?? null, canManageProjects: entry.local === true });
  // Agent names are unique per Env only; `project` (this Env's folder) completes the identity.
  const agentInfo = (agent, active) => agentInfoOf(agent, active, env.folder);
  /** Snapshot this project's top-level agents. */
  const topAgents = (active) => env.agents().filter((a) => !a.parent).map((a) => agentInfo(a, active));
  /** List persisted sessions for the current environment and working directory.
   * @returns {Promise<Array<object>>} Recent session records.
   */
  const listRecent = async () => Agent.Context.listAsync({ dir: env.settings.sessions, cwd: env.folder, limit: Infinity });
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
   * @param {object} settings Public effective Env snapshot (auth omitted).
   * @returns {object} Web preferences plus normalized display/theme readouts.
   */
  const webPrefs = (settings) => {
    const w = settings.web ?? {};
    const names = themeNames(settings.themes);
    return {
      ...w,
      autocomplete: w.autocomplete !== false,
      collapse: { ...w.collapse, thinking: w.collapse?.thinking !== false, tools: w.collapse?.tools !== false },
      theme: ["system", "light", "dark"].includes(w.theme) ? w.theme : "system",
      thinkingLevels: ["default", ...IO.THINKING_LEVELS],
      themes: ["dark", "light", ...names].sort((a, b) => a.localeCompare(b)),
      activeTheme: names.includes(w.theme) ? w.theme : null,
      themeStylesVersion,
      themeStylesUrl: `${registry?.list(env.folder).find((item) => item.path === env.folder)?.url ?? "/"}themes.css`,
      themeModes: Object.fromEntries(names.map((name) => [name, themeMode(resolveThemeTokens(settings.themes, name))])),
      dualThemes: names.filter((name) => isDualTheme(settings.themes, name)),
      // Preview rows per named theme (system/light/dark use the defaults).
      previewRows: { default: themePreviewRows(), ...Object.fromEntries(names.map((name) => [name, themePreviewRows(resolveThemeTokens(settings.themes, name))])) },
    };
  };
  /** Return valid configured theme names in locale-sorted order.
   * @returns {string[]} Theme names.
   */
  const themeNames = (themes) => Object.keys(themes ?? {}).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).sort();
  // The model menu lists CONCRETE endpoint/model combos (deduplicated),
  // never the noisy completion list (endpoints + bare ids + combos).
  /** List unique concrete endpoint/model choices.
   * @returns {string[]} Sorted endpoint/model identifiers.
   */
  const modelChoices = () => {
    const combos = [];
    for (const { name, models } of listEndpointModels(env)) for (const id of models) combos.push(`${name}/${id}`);
    return [...new Set(combos)].sort();
  };
  /** Build agent-specific settings and shared model/preferences state.
   * @param {object|null} agent - Agent whose settings are projected, if any.
   * @returns {object} Client settings packet fields.
   */
  const settingsState = (agent) => {
    updateThemeRevision();
    const settings = settingsSnapshot(env.settings);
    return {
      ...(agent
        ? {
          safe: agent.can.write === false,
          thinking: agent.thinking ?? "default",
          sessionSave: agent.context.save,
          can: { write: agent.can.write === true, delegate: agent.can.delegate === true ? true : agent.can.delegate === false ? false : null, request: agent.can.request === true ? true : agent.can.request === false ? false : null },
          delegationLocked: Boolean(agent.parent),
          requestLocked: Boolean(agent.parent),
          endpoint: modelParts(agent.model).endpoint ?? null,
          model: modelParts(agent.model).model ?? null,
        }
        : {}),
      models: modelChoices(),
      exitRequested: registry?.exitRequested?.() === true,
      restarts: registry?.restarts === true,
      settings,
      prefs: webPrefs(settings),
    };
  };
  /** Send a JSON packet only while the connection is open.
   * @param {object} entry - Connection state.
   * @param {object} packet - Packet to serialize.
   * @returns {void}
   */
  const send = (entry, packet) => {
    if (!active(entry)) return;
    const text = JSON.stringify(packet);
    if (SNAPSHOT_PACKETS.has(packet.type)) {
      const snapshots = entry.snapshots ??= new Map();
      const snapshot = JSON.parse(text);
      if (isDeepStrictEqual(snapshots.get(packet.type), snapshot)) return;
      snapshots.set(packet.type, snapshot);
    }
    entry.ws.send(text);
  };
  /** Send the current settings packet to a connection.
   * @param {object} entry - Connection state.
   * @returns {void}
   */
  const sendSettings = (entry) => { if (active(entry)) send(entry, { type: "settings", ...settingsState(entry.agent) }); };
  /** Send virtual publication data separately so real context indexes never shift. */
  async function sendContext(entry, { history = false } = {}) {
    const request = entry.contextRequest = (entry.contextRequest ?? 0) + 1;
    const session = entry.session;
    const agent = entry.agent;
    const selector = agent?.model;
    const safe = agent?.can.write === false;
    let text;
    try { text = toolCatalogText(await agent?.tools ?? new Map()); }
    catch (error) { text = `Unable to load published tools: ${error?.message ?? error}`; }
    if (entry.contextRequest !== request || entry.session !== session || agent?.model !== selector || (agent?.can.write === false) !== safe) return;
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
    return recent.map((item) => ({ ...item, project: env.folder, ...(live.has(item.id) ? { live: true } : {}) }));
  };
  const sendSessions = async (entry) => {
    if (!active(entry)) return;
    // A multi-project view lists the agents and saved sessions of every project it shows.
    const multi = entry.multi && registry;
    const recent = multi ? await registry.recent(entry.group) : await recentSessions();
    if (!active(entry)) return;
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
    if (stopped) return;
    broadcast((entry) => { if (!remote || entry.multi) sendSessions(entry).catch(() => {}); });
    if (!remote) registry?.sessionsChanged?.(env.folder);
  };
  /** Broadcast settings to all connections.
   * @returns {void}
   */
  const broadcastSettings = () => broadcast((entry) => sendSettings(entry));
  /** Snapshot endpoint, provider, and login-preset catalogs.
   * @returns {object} Serializable endpoint catalog.
   */
  const endpointsState = () => ({
    endpoints: listEndpointModels(env).map(({ name, models = [], loginRequired }) => ({ name, models, loginRequired: loginRequired === true })),
    mcp: env.mcpStatus(),
    removable: listEndpoints(env),
    policies: endpointPolicies(env),
    providers: [...new Set(env.loginPresets().map(({ provider }) => provider))],
    presets: env.loginPresets().map(({ name, label, provider, url, oauth }) => ({ name, label: label ?? name, provider, url, oauth: Boolean(oauth) })),
  });
  /** Send endpoint catalog to a connection.
   * @param {object} entry - Connection state.
   * @returns {void}
   */
  const sendEndpoints = (entry) => { if (active(entry)) send(entry, { type: "endpoints", ...endpointsState() }); };
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
      const tokens = await runOAuthFlow(preset.oauth, {
        open: () => false,
        onAuthUrl: (url) => oauth({ state: "url", url, name: preset.name }),
        onLog: (text) => oauth({ state: "log", text }),
      });
      const result = await env.login(preset.name, { provider: preset.provider, url: preset.url, auth: tokensToAuth(tokens),
        ...(preset.oauth?.projectId ? { oauth: preset.oauth } : {}) });
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
    // Endpoint policies and visibility are catalog readouts too. A handler
    // can broadcast before settings invalidation; publish the settled catalog
    // without waiting for another user packet or a polling interval.
    sendEndpoints(entry);
  }));
  // Project records carry each project's model choices (the add-agent picker).
  const projectModelsHandle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => registry?.modelsChanged?.());
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
    // Completion is not a value change. Only changed settings publish snapshots;
    // theme CSS revisions follow theme tokens, not unrelated settings writes.
    env.onEvent(Env.EVENT.SETTINGS_CHANGED, () => { updateThemeRevision(); broadcastEndpoints(); }),
    env.onEvent(Env.EVENT.SETTINGS_LOADED, updateThemeRevision),
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
  const greet = (entry) => { if (active(entry)) send(entry, { type: "hello", agent: agentInfo(entry.agent, entry.agent), history: entry.session?.historySnapshot() ?? [], queue: entry.session?.pendingSnapshot() ?? [], catalog: catalog(entry.agent, tools), status: entry.session?.statusSnapshot() ?? null, throttledUntil: entry.agent?.throttledUntil ?? null, uploadKey: entry.uploadKey, ...projectState(entry) }); };

  /** Create or host-provide an agent, attach it, and send initial snapshots.
   * @param {object} entry - Connection receiving the session.
   * @param {string|false|null|undefined} session - Context id, false for unlogged, or nullish for a new id.
   * @param {{model?: string, safe?: boolean}} [options={}] - Optional model and safe-mode overrides.
   * @returns {Promise<void>} Resolves after session and settings snapshots are sent.
   */
  const makeSession = async (entry, session, { model, safe } = {}) => {
    if (!active(entry)) return;
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
      agent = await env.agentCreate({ ...options, ...(model ? { model } : {}), contextId: session === false ? false : session ?? randomUUID() }); // false: not logged
      if (agent.model === undefined && inherited) {
        try { (agent.model = inherited); } catch { /* the endpoint is gone — the agent starts model-less */ }
      }
    }
    if (!active(entry)) { await agent.close(); return; }
    if (safe === true) (agent.can.write = false);
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
    if (previous.busy) throw new TypeError("stop the running turn before replacing this session");
    const kind = options.kind ?? (options.fork ? "fork" : session !== undefined && session !== null && session !== false ? "resume" : "new");
    const fresh = await conversationCreate(previous, { kind, id: session });
    try { if (options.safe === true) fresh.can.write = false; }
    catch (error) { await fresh.close(); throw error; }
    if (!active(entry)) { await fresh.close(); return; }
    const extra = [];
    try {
      for (const candidate of viewers) if (candidate !== entry && active(candidate)) {
        extra.push([candidate, await conversationCreate(previous, { kind: "new", id: false })]);
      }
    } catch (error) { await fresh.close(); for (const [, agent] of extra) await agent.close(); throw error; }
    attach(entry, fresh);
    for (const [candidate, agent] of extra) {
      if (!active(candidate)) { await agent.close(); continue; }
      attach(candidate, agent);
    }
    await previous.close();
    conversationActivate(fresh);
    greet(entry); sendSettings(entry);
    for (const [candidate, agent] of extra) if (candidate.agent === agent) {
      greet(candidate); sendSettings(candidate);
    }
    await sendSessions(entry);
    broadcastSessions();
  };

  /** Branch a selected agent into a new agent without closing the source. */
  const forkAgent = async (entry, source, { id, through } = {}) => {
    const fresh = await source.fork({ id, through });
    if (!active(entry)) { await fresh.close(); return; }
    attach(entry, fresh);
    greet(entry); sendSettings(entry);
    await sendSessions(entry);
    broadcastSessions();
  };

  /** Close an agent and move its viewers to another agent or a new one.
   * @param {object} agent - Agent to close.
   * @returns {Promise<void>} Resolves after all viewers are reassigned.
   */
  const closeAgent = async (agent) => {
    await agent.close();
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
      replace: async (kind, id) => {
        await replaceViewed(entry, id, { kind });
        return entry.agent.context;
      },
    });
    if (result.cleared || result.renew) entry.session?.refresh();
    if (result.cleared) greet(entry);
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

  const handlers = createPacketHandlers({ registry, env, uploads, send, sendSessions, replaceViewed, forkAgent, makeSession, knownSession, closeAgent, broadcastSessions, broadcast, greet, sendSettings, attach, sendEndpoints, runOAuth, runMcpOAuth, oauth, broadcastEndpoints, broadcastSettings, sendContext, refreshTools, handleCommand, agentInfo, listRecent });
  /** Accept a socket: attach `agentId`, else the first top-level agent, else a new one.
   * @param {WebSocket} ws - Socket (`data.local`, `data.multi`, `data.group` from the host).
   * @param {{agentId?: string, moved?: boolean, resume?: string, add?: {model?: string, safe?: boolean, anonymous?: boolean}, fork?: {agentId: string, id?: string}}} [options={}] - `moved`: arrived from another project, so never reopens the launch session; `resume`: a saved session id to view (its running agent, else a new agent resuming it); `add`: view a new agent (session.add fields; a failure reports and falls back to the default attach).
   * @returns {Promise<void>}
   */
  const open = async (ws, { agentId, moved = false, resume, add, fork } = {}) => {
    if (stopped) return;
    const entry = { ws, local: ws.data?.local === true, multi: ws.data?.multi === true, group: ws.data?.group, agent: null, session: null, send: null, uploadKey: uploads.open() };
    entry.send = (packet) => send(entry, packet);
    connections.set(ws, entry);
    if (fork !== undefined) {
      try {
        await handlers["session.fork"](entry, fork);
        sendEndpoints(entry);
        return;
      } catch (error) { send(entry, { type: "error", message: error?.message ?? "could not fork an agent" }); }
    }
    if (add !== undefined) {
      try {
        await handlers["session.add"](entry, add);
        sendEndpoints(entry);
        broadcastSessions();
        return;
      } catch (error) { send(entry, { type: "error", message: error?.message ?? "could not add an agent" }); }
    }
    const resumed = resume !== undefined && (await listRecent()).some((item) => item.id === resume);
    if (!active(entry)) return;
    if (resumed) {
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
        ? (state.session.id === "latest" ? Agent.Context.latest({ dir: env.settings.sessions, cwd: env.folder }) : state.session.id)
        : state.session?.kind === "new" ? state.session.id : undefined;
    await makeSession(entry, initial);
    sendSettings(entry);
    sendEndpoints(entry);
  };
  const message = async (ws, data) => {
    const entry = connections.get(ws);
    if (!entry || !active(entry)) return;
    try {
      const { project, ...packet } = parseClientMessage(data);
      // The all-projects view names agents of other projects: switching moves
      // this socket there; managing them runs in their owning project.
      if (project !== undefined && project !== env.folder) {
        if (!entry.multi || !registry || !registry.visible(project, entry.group)) throw new TypeError("unknown agent");
        if (packet.type === "session.switch") await registry.move(ws, project, packet.agentId);
        else if (packet.type === "session.resume") await registry.move(ws, project, undefined, { resume: packet.id });
        else if (packet.type === "session.add") await registry.move(ws, project, undefined, { add: packet });
        else if (packet.type === "session.fork") await registry.move(ws, project, undefined, { fork: packet });
        else await registry.forward(project, packet);
        return;
      }
      await handlers[packet.type]?.(entry, packet);
    } catch (error) { send(entry, { type: "error", message: error?.message ?? "invalid message" }); }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const handle of eventHandles) env.offEvent(handle);
    env.offEvent(modelsHandle);
    env.offEvent(projectModelsHandle);
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
    models: modelChoices,
    lastModel: () => {
      const choices = modelChoices();
      let remembered;
      let newest = "";
      for (const info of env.models().values()) {
        if (info.projectLastUsed != null && info.projectLastUsed > newest) {
          newest = info.projectLastUsed;
          remembered = `${info.endpoint}/${info.model}`;
        }
      }
      const live = env.agents().filter((agent) => !agent.parent && agent.model).at(-1)?.model;
      return [remembered, live, prepared.options.model, choices[0]].find((model) => choices.includes(model));
    },
    /** Connected viewers (socket, multi-project flag, group, packet sender). */
    viewers: () => [...connections.values()].map((entry) => ({ ws: entry.ws, multi: entry.multi, group: entry.group, send: (packet) => send(entry, packet) })),
    agent: findAgent,
    agents: topAgents,
    recent: recentSessions,
    knownSession,
    ownsUpload: (key) => uploads.owns(key),
    broadcastProjects: () => broadcast((entry) => send(entry, { type: "projects", ...projectState(entry) })),
    broadcastSettings, upload: (key, file) => uploads.add(key, file),
    themeCss: () => cachedThemeCss, stop };
}
