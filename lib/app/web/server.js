/** Web server composition and per-server project registry. */
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { stat, realpath } from "node:fs/promises";
import Env from "../../env.js";
import { expandProjectPath, projectUrls } from "./project-urls.js";
import CLI from "../cli.js";
import { listEndpointModels } from "../shared/catalog.js";
import { createWorkspace } from "./workspace.js";
import { startWebHost } from "./host.js";
import { createExitController } from "./exit.js";

async function launch(state) {
  // Optional log callback supplied to endpoint/model selection; writes one line to diagnostics.
  const log = state.diagnostics ? (line) => state.diagnostics.write(`${line}\n`) : () => {};
  if (state.settings !== undefined) throw new TypeError("provider settings must be configured on Env, not Agent");
  const { cwd = state.projectPath ?? process.cwd(), ...envOptions } = state.envOptions ?? {};
  // A pinned project uses its own provider configuration, never the root's CLI overrides.
  const hasOverride = state.projectPath === undefined && (state.model?.url !== undefined || state.model?.token !== undefined || state.timeout !== undefined);
  const endpoint = hasOverride && typeof state.model?.model === "string" ? state.model.model.split("/")[0] : undefined;
  if (hasOverride && (!endpoint || !state.model.model.includes("/") || ["__proto__", "constructor", "prototype"].includes(endpoint))) {
    throw new TypeError("provider URL, token, and timeout require a qualified endpoint/model selector");
  }
  if (hasOverride && state.env !== undefined) throw new TypeError("provider overrides require an owned Env; pass envOptions instead of env");
  let provider;
  if (hasOverride) {
    const probe = await Env.open(cwd, { ...envOptions, init: { providers: false, tools: false, detect: false, models: false } });
    try {
      const known = probe.settings.providers?.[endpoint];
      provider = known?.provider ?? (known?.url ? "openai" : undefined);
    } finally { await probe.close(); }
    if (!provider && state.model.url === undefined) throw new TypeError(`unknown endpoint "${endpoint}": URL required for provider overrides`);
    provider ??= endpoint;
  }
  const overrides = hasOverride ? { ...envOptions.settings, providers: {
    ...envOptions.settings?.providers, [endpoint]: {
      ...envOptions.settings?.providers?.[endpoint],
      ...(state.model.url === undefined ? {} : { provider, url: state.model.url }),
      ...(state.model.token === undefined ? {} : { auth: { ...envOptions.settings?.providers?.[endpoint]?.auth, token: state.model.token } }),
      ...(state.timeout === undefined ? {} : { timeout: state.timeout }),
    },
  } } : undefined;
  const owned = state.env === undefined && (hasOverride || state.envOptions !== undefined || Env.envs[cwd] === undefined);
  const env = state.env ?? await Env.open(cwd, hasOverride ? { ...envOptions, settings: overrides } : state.envOptions === undefined ? undefined : envOptions);
  try {
  await env.ready();
  let selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  if (!selection) {
    selection = listEndpointModels(env)
      .flatMap(({ name, models }) => models.map((model) => `${name}/${model}`))
      .sort()[0];
  }
  return {
    env,
    owned,
    options: {
      ...(selection ? { model: selection } : {}),
      tools: state.tools?.names,
      can: { write: state.can?.write !== false },
      toolCall: state.tools?.call,
    },
  };
  } catch (error) {
    if (owned) await env.close();
    throw error;
  }
}

/** A project's scoped pin record, else undefined. */
const pinOf = (entry) => {
  const pin = entry.env.constructor.settings.projects[entry.path];
  return pin !== null && typeof pin === "object" ? pin : undefined;
};

/** The group names a pin record lists (`groups: {<name>: true}`). */
const groupsOf = (pin) => Object.keys(pin?.groups ?? {}).filter((group) => pin.groups[group] === true).sort();

/** Pin a project now, remembering the models its top-level agents use. @returns {object} the pin record. */
const pinRecord = (entry) => {
  const now = new Date().toISOString();
  const models = Object.fromEntries(entry.env.agents().filter((agent) => !agent.parent && agent.model).map((agent) => [agent.model, now]));
  entry.env.constructor.settings.projects[entry.path] = { models };
  return pinOf(entry);
};

/** Start the initial workspace, the project registry, and every pinned project (user projects.json). */
export async function serve(state = {}) {
  if (state.session?.kind === "resume" && state.session.id !== "latest") await CLI.adoptResumeOrigin({ resume: state.session.id, anonymous: false });
  const prepared = await launch(state);
  const entries = [];
  let urls = new Map();
  const pending = new Set();
  let exitController;
  let offSettings;
  let reloading = Promise.resolve();
  let stopped = false;
  let stopPromise;
  const list = (cwd) => entries.map((entry) => {
    const pin = pinOf(entry);
    return { name: entry.env.name, description: pin?.description ?? "", path: entry.path, url: urls.get(entry.path), current: entry.path === cwd, pinned: pin !== undefined, groups: groupsOf(pin), models: entry.workspace.models(), lastModel: entry.workspace.lastModel() };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  /** Refresh every viewer's project list. */
  const broadcastProjects = () => { for (const item of entries) item.workspace.broadcastProjects(); };
  /** @returns {object} the registry entry serving `path`. @throws {TypeError} for unserved paths. */
  const find = (path) => {
    const entry = entries.find((item) => item.path === path);
    if (!entry) throw new TypeError("unknown project");
    return entry;
  };
  /** Served projects belonging to `group`. */
  const members = (group) => entries.filter((item) => groupsOf(pinOf(item)).includes(group));
  /** The projects a multi-project view shows: a group's members, or every served project. */
  const shown = (group) => group === undefined ? entries : members(group);
  /** Move a group's viewers off `entry` once it no longer belongs to their group: onto another member, else to the root URL. */
  const evict = async (entry) => {
    const groups = groupsOf(pinOf(entry));
    for (const viewer of entry.workspace.viewers()) {
      if (!viewer.multi || viewer.group === undefined || groups.includes(viewer.group)) continue;
      const next = members(viewer.group)[0];
      if (next) await registry.move(viewer.ws, next.path);
      else viewer.send({ type: "project.removed", url: "/" });
    }
  };
  // Multi-project views — the all-projects view (root URL) and group views
  // (`/group:<group>/`): one socket moves between the shown projects'
  // workspaces; each workspace keeps owning its Env, agents, and uploads.
  const registry = { entries, list, members,
    /** Refresh project lists after a project's model catalog changed. */
    modelsChanged: () => broadcastProjects(),
    exit: () => { const first = exitController?.request(); if (first) for (const item of entries) item.workspace.broadcastSettings(); },
    exitRequested: () => exitController?.requested === true,
    /** A supervisor (bin/scripts/daemon.js) restarts every Web exit, so the exit control reads Restart app. */
    restarts: process.env.AI_DAEMON === "1",
    /** Whether a multi-project view of `group` (undefined: every project) shows the project at `path`. */
    visible: (path, group) => shown(group).some((item) => item.path === path),
    /** Attach a multi-project socket (`ws.data.group`, `ws.data.resume`) to the first shown project running an agent (else the first shown).
     * A saved session to resume opens in its own project when that one is shown. */
    open: async (ws) => {
      const view = shown(ws.data.group);
      if (!view.length) { ws.send(JSON.stringify({ type: "project.removed", url: "/" })); ws.close(); return; }
      const { resume } = ws.data;
      const owner = resume === undefined ? undefined : await registry.sessionOwner(resume);
      const entry = view.find((item) => item.path === owner) ?? view.find((item) => item.workspace.running()) ?? view[0];
      ws.data.workspace = entry.workspace;
      return entry.workspace.open(ws, { resume: entry.path === owner ? resume : undefined });
    },
    /** Move a multi-project socket to another shown project, onto `agentId`, the saved session `resume`, a new agent (`add`: session.add fields), or its first agent (else a new one).
     * @throws {TypeError} For a project the socket's view does not show, an unknown agent, or an unknown session. */
    move: async (ws, path, agentId, { resume, add, fork } = {}) => {
      if (!registry.visible(path, ws.data.group)) throw new TypeError("unknown project");
      const target = find(path).workspace;
      if (agentId !== undefined && !target.agent(agentId)) throw new TypeError("unknown agent");
      if (resume !== undefined) await target.knownSession(resume);
      ws.data.workspace.close(ws);
      ws.data.workspace = target;
      await target.open(ws, { agentId, moved: true, resume, add, fork });
    },
    /** Run an agent-management packet in the project that owns the agent. */
    forward: (path, packet) => find(path).workspace.remote(packet),
    /** Top-level agent snapshots across the shown projects (`group`; undefined: every project), in project order. */
    agents: (active, group) => shown(group).flatMap((item) => item.workspace.agents(active)),
    /** Saved sessions across the shown projects (each names its `project`). */
    recent: async (group) => (await Promise.all(shown(group).map((item) => item.workspace.recent()))).flat(),
    /** The path of the served project owning saved session `id`, or undefined. */
    sessionOwner: async (id) => {
      for (const item of entries) if ((await item.workspace.recent()).some((session) => session.id === id)) return item.path;
      return undefined;
    },
    /** A project's URL. */
    url: (path) => urls.get(path),
    /** Refresh all-projects viewers elsewhere after `path`'s agents changed. */
    sessionsChanged: (path) => { for (const item of entries) if (item.path !== path) item.workspace.broadcastSessions({ remote: true }); },
    /** Publish agent state elsewhere without reading saved-session storage. */
    agentsChanged: (path) => { for (const item of entries) if (item.path !== path) item.workspace.broadcastAgents({ remote: true }); },
    /** Store an upload for whichever project issued the key. */
    upload: (key, file) => (entries.find((item) => item.workspace.ownsUpload(key)) ?? entries[0]).workspace.upload(key, file),
    /** Resolve a media capability URL against every project. */
    media: (...args) => entries.reduce((found, item) => found ?? item.workspace.media(...args), null),
    async add(input, { quiet = false } = {}) {
    const path = expandProjectPath(input, homedir());
    if (!isAbsolute(path)) throw new TypeError("project path must be absolute or start with ~/ (bare ~ is allowed)");
    let canonical;
    try { canonical = await realpath(path); }
    catch { throw new TypeError("project directory does not exist"); }
    if (!(await stat(canonical)).isDirectory()) throw new TypeError("project path must be a directory");
    if (pending.has(canonical) || entries.some((item) => item.canonical === canonical)) throw new TypeError("project is already served");
    pending.add(canonical);
    try {
      // Without explicit embedding options, registry entries are path-owned
      // Envs; explicit options create an isolated project Env, owned here.
      const existing = Env.envs[canonical];
      const projectOptions = state.envOptions === undefined ? undefined : { ...state.envOptions };
      if (projectOptions) delete projectOptions.cwd;
      const projectEnv = existing ?? (projectOptions === undefined ? await Env.open(canonical)
        : await Env.open(canonical, projectOptions));
      let added;
      let workspace;
      try {
        added = await launch({ ...state, env: projectEnv, model: state.model ? { model: state.model.model } : undefined, projectPath: canonical });
        workspace = await createWorkspace({ ...state, env: undefined, createSession: undefined, session: undefined }, added, registry);
      } catch (error) { if (!existing) await projectEnv.close(); throw error; }
      entries.push({ path: canonical, canonical, workspace, env: added.env, owned: !existing });
      exitController?.watchEnv(added.env);
      urls = projectUrls(entries.map((item) => item.path));
      if (!quiet) broadcastProjects();
      return { url: urls.get(canonical), path: canonical };
    } finally { pending.delete(canonical); }
  },
    /** Pin (persist in the user projects.json, keeping the project's models in use) or unpin a served project (unpinning leaves its groups). */
    async pin(path, pinned) {
      const entry = find(path);
      if (pinned && !pinOf(entry)) pinRecord(entry);
      else if (!pinned && pinOf(entry)) delete entry.env.constructor.settings.projects[path];
      await regrouped(entry);
    },
    /** Edit a project's description in its user-owned pin. A nonempty description pins it; clearing leaves the pin in place. */
    async describe(path, description) {
      const entry = find(path);
      const pin = pinOf(entry) ?? (description ? pinRecord(entry) : undefined);
      if (!pin) return;
      const { description: _old, ...rest } = pin;
      entry.env.constructor.settings.projects[path] = description ? { ...rest, description } : rest;
      broadcastProjects();
    },
    /** Add a served project to a group (pinning it: groups live in the pin record) or remove it from one. */
    async group(path, group, member) {
      const entry = find(path);
      const pin = pinOf(entry) ?? (member ? pinRecord(entry) : undefined);
      if (!pin) return;
      const groups = { ...(pin.groups ?? {}) };
      if (member) groups[group] = true;
      else delete groups[group];
      const { groups: _old, ...rest } = pin;
      entry.env.constructor.settings.projects[path] = Object.keys(groups).length ? { ...rest, groups } : rest;
      await regrouped(entry);
    },
    /** Stop serving a project: unpin it, close its agents (saved sessions stay), and move or redirect its viewers.
     * @throws {TypeError} For the last served project or one with working agents. */
    async remove(path) {
      const entry = find(path);
      if (entries.length === 1) throw new TypeError("the last served project cannot be removed");
      if (entry.env.agents().some((agent) => agent.busy)) throw new TypeError("the project has working agents; stop them first");
      if (pinOf(entry)) delete entry.env.constructor.settings.projects[path];
      entries.splice(entries.indexOf(entry), 1);
      urls = projectUrls(entries.map((item) => item.path));
      for (const viewer of entry.workspace.viewers()) {
        const next = viewer.multi ? shown(viewer.group)[0] : undefined;
        if (next) await registry.move(viewer.ws, next.path);
        else viewer.send({ type: "project.removed", url: "/" });
      }
      exitController?.forgetEnv(entry.env);
      entry.workspace.stop();
      const results = await Promise.allSettled(entry.env.agents().map((agent) => Promise.resolve().then(() => agent.close())));
      if (entry.owned) results.push(...await Promise.allSettled([entry.env.close()]));
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "project cleanup failed");
      broadcastProjects();
      for (const item of entries) item.workspace.broadcastSessions({ remote: true });
    },
  };
  /** After a membership change: move group viewers off `entry` when it left their group, refresh project lists and multi-project sidebars. */
  async function regrouped(entry) {
    await evict(entry);
    broadcastProjects();
    for (const item of entries) item.workspace.broadcastSessions({ remote: true });
  }
  let workspace;
  try {
    workspace = await createWorkspace(state, prepared, registry);
    entries.push({ path: prepared.env.folder, canonical: await realpath(prepared.env.folder), workspace, env: prepared.env, owned: prepared.owned });
    urls = projectUrls(entries.map((item) => item.path));
    // The settings view also exposes name aliases; only folder keys are pins.
    for (const [path, pin] of Object.entries(prepared.env.constructor.settings.projects)) {
      if (path !== pin.folder) continue;
      if (path === prepared.env.folder) continue;
      try { await registry.add(path); }
      catch (error) { state.diagnostics?.write(`pinned project ${path} not served: ${error?.message ?? error}\n`); }
    }
    const host = startWebHost(registry, state);
    const signals = state.signals;
    const requestExit = () => registry.exit();
    const disarm = () => { signals?.off?.("SIGINT", requestExit); signals?.off?.("SIGTERM", requestExit); };
    // A changed settings file finishes loading as part of a poll round.
    // Newly pinned projects join the live registry; unpinning never evicts.
    offSettings = prepared.env.onEvent(Env.EVENT.SETTINGS_LOADED, () => {
      reloading = reloading.then(async () => {
        if (stopped) return;
        for (const [path, pin] of Object.entries(prepared.env.constructor.settings.projects)) {
          if (path !== pin.folder || entries.some((item) => item.path === path)) continue;
          try { await registry.add(path, { quiet: true }); }
          catch (error) { state.diagnostics?.write(`pinned project ${path} not served: ${error?.message ?? error}\n`); }
        }
        if (!stopped) broadcastProjects();
      });
    });
    const stop = () => {
      if (stopped) return stopPromise;
      if (offSettings !== undefined) prepared.env.offEvent(offSettings);
      disarm();
      exitController?.dispose();
      stopped = true;
      return stopPromise = host.stop();
    };
    exitController = createExitController(registry, { stop, clock: state.exitClock, proc: state.exitProcess });
    for (const entry of entries) exitController.watchEnv(entry.env);
    signals?.on?.("SIGINT", requestExit);
    signals?.on?.("SIGTERM", requestExit);
    return { ...host, stop, requestExit, env: prepared.env };
  } catch (error) {
    exitController?.dispose();
    const cleanup = entries.length ? entries : [{ workspace, env: prepared.env, owned: prepared.owned }];
    for (const item of cleanup) {
      try { item.workspace?.stop(); } catch { /* preserve startup failure */ }
      await Promise.allSettled(item.env.agents().map((agent) => agent.close()));
      if (item.owned) try { await item.env.close(); } catch { /* preserve startup failure */ }
    }
    throw error;
  }
}
