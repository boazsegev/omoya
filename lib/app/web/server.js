/** Web server composition and per-server project registry. */
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { stat, realpath } from "node:fs/promises";
import Env from "../../env.js";
import { expandProjectPath, projectUrls } from "./project-urls.js";
import CLI from "../../cli.js";
import { createWorkspace } from "./workspace.js";
import { startWebHost, MAX_WS_PAYLOAD_LENGTH } from "./host.js";
export { MAX_WS_PAYLOAD_LENGTH };

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

/** A project's pin record (settings.projects[path] of its own Env), else undefined. */
const pinOf = (entry) => {
  const pin = entry.env.settings.projects?.[entry.path];
  return pin !== null && typeof pin === "object" ? pin : undefined;
};

/** The group names a pin record lists (`groups: {<name>: true}`). */
const groupsOf = (pin) => Object.keys(pin?.groups ?? {}).filter((group) => pin.groups[group] === true).sort();

/** Pin a project now, remembering the models its top-level agents use. @returns {object} the pin record. */
const pinRecord = (entry) => {
  const now = new Date().toISOString();
  const models = Object.fromEntries(entry.env.agents().filter((agent) => !agent.parent && agent.model).map((agent) => [agent.model, now]));
  entry.env.settings.projects[entry.path] = { models };
  return pinOf(entry);
};

/** Start the initial workspace, the project registry, and every pinned project (user projects.json). */
export async function serve(state = {}) {
  if (state.session?.kind === "resume" && state.session.id !== "latest") CLI.adoptResumeOrigin({ resume: state.session.id, anonymous: false });
  const prepared = await launch(state);
  const entries = [];
  let urls = new Map();
  const pending = new Set();
  const list = (cwd) => entries.map((entry) => {
    const pin = pinOf(entry);
    return { name: entry.env.name, path: entry.path, url: urls.get(entry.path), current: entry.path === cwd, pinned: pin !== undefined, groups: groupsOf(pin) };
  });
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
    /** Move a multi-project socket to another shown project, onto `agentId`, the saved session `resume`, or its first agent (else a new one).
     * @throws {TypeError} For a project the socket's view does not show, an unknown agent, or an unknown session. */
    move: async (ws, path, agentId, { resume } = {}) => {
      if (!registry.visible(path, ws.data.group)) throw new TypeError("unknown project");
      const target = find(path).workspace;
      if (agentId !== undefined && !target.agent(agentId)) throw new TypeError("unknown agent");
      if (resume !== undefined) await target.knownSession(resume);
      ws.data.workspace.close(ws);
      ws.data.workspace = target;
      await target.open(ws, { agentId, moved: true, resume });
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
    /** Store an upload for whichever project issued the key. */
    upload: (key, file) => (entries.find((item) => item.workspace.ownsUpload(key)) ?? entries[0]).workspace.upload(key, file),
    /** Resolve a media capability URL against every project. */
    media: (...args) => entries.reduce((found, item) => found ?? item.workspace.media(...args), null),
    async add(input) {
    const path = expandProjectPath(input, homedir());
    if (!isAbsolute(path)) throw new TypeError("project path must be absolute or start with ~/ (bare ~ is allowed)");
    let canonical;
    try { canonical = await realpath(path); }
    catch { throw new TypeError("project directory does not exist"); }
    if (!(await stat(canonical)).isDirectory()) throw new TypeError("project path must be a directory");
    if (pending.has(canonical) || entries.some((item) => item.canonical === canonical)) throw new TypeError("project is already served");
    pending.add(canonical);
    try {
      const added = await launch({ ...state, env: undefined, envOptions: { ...state.envOptions, cwd: canonical } });
      let workspace;
      try { workspace = await createWorkspace({ ...state, env: undefined, createSession: undefined, session: undefined }, added, registry); }
      catch (error) { added.env.close(); throw error; }
      entries.push({ path: canonical, canonical, workspace, env: added.env, owned: true });
      urls = projectUrls(entries.map((item) => item.path));
      broadcastProjects();
      return { url: urls.get(canonical), path: canonical };
    } finally { pending.delete(canonical); }
  },
    /** Pin (persist in the user projects.json, keeping the project's models in use) or unpin a served project (unpinning leaves its groups). */
    async pin(path, pinned) {
      const entry = find(path);
      if (pinned && !pinOf(entry)) pinRecord(entry);
      else if (!pinned && pinOf(entry)) delete entry.env.settings.projects[path];
      await regrouped(entry);
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
      entry.env.settings.projects[path] = Object.keys(groups).length ? { ...rest, groups } : rest;
      await regrouped(entry);
    },
    /** Stop serving a project: unpin it, close its agents (saved sessions stay), and move or redirect its viewers.
     * @throws {TypeError} For the last served project or one with working agents. */
    async remove(path) {
      const entry = find(path);
      if (entries.length === 1) throw new TypeError("the last served project cannot be removed");
      if (entry.env.agents().some((agent) => agent.busy)) throw new TypeError("the project has working agents; stop them first");
      if (pinOf(entry)) delete entry.env.settings.projects[path];
      entries.splice(entries.indexOf(entry), 1);
      urls = projectUrls(entries.map((item) => item.path));
      for (const viewer of entry.workspace.viewers()) {
        const next = viewer.multi ? shown(viewer.group)[0] : undefined;
        if (next) await registry.move(viewer.ws, next.path);
        else viewer.send({ type: "project.removed", url: "/" });
      }
      for (const agent of entry.env.agents()) if (!agent.parent) agent.close();
      entry.workspace.stop();
      if (entry.owned) entry.env.close();
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
  const workspace = await createWorkspace(state, prepared, registry);
  try {
    entries.push({ path: prepared.env.cwd, canonical: await realpath(prepared.env.cwd), workspace, env: prepared.env, owned: false });
    urls = projectUrls(entries.map((item) => item.path));
    // Pinned projects (user projects.json) are served from the start.
    for (const path of Object.keys(prepared.env.settings.projects ?? {})) {
      if (path === prepared.env.cwd) continue;
      try { await registry.add(path); }
      catch (error) { state.diagnostics?.write(`pinned project ${path} not served: ${error?.message ?? error}\n`); }
    }
    return { ...startWebHost(registry, state), env: prepared.env };
  } catch (error) { for (const item of entries) { item.workspace.stop(); if (item.owned) item.env.close(); } throw error; }
}
export const createWebServer = serve;
