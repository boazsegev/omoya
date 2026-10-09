/**
 * Private App workspace controller over the public Agent/Env/Context facades.
 * Borrowed Envs and Agents are never adopted implicitly. Only acquisitions made
 * here and Agents created here are released by close(); closing an owned project
 * explicitly closes every Agent in that Env. Project pins are process-global.
 */
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import Agent from "../../agent.js";
import { readLastCombo } from "../shared/catalog.js";

const { Env, Context } = Agent;
const isLive = (agent) => !agent.closed && !agent.closeMarked && !agent.env.closed;

/** Canonicalize existing paths, retaining a stable identity for absent session directories. */
async function identity(path) {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

/** Attempt every release and report failures only after all resources were visited. */
async function releaseAll(releases, message) {
  const results = await Promise.allSettled(releases.map(async (release) => release()));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, message);
}

/** Choose only this project's remembered or published model, never launch overrides. */
function defaultModel(env) {
  return readLastCombo(env) ?? [...env.models().values()]
    .filter((info) => info.listed)
    .map((info) => `${info.endpoint}/${info.model}`)
    .sort()[0];
}

/**
 * Create a synchronous workspace handle. Inputs are retained, not mutated or
 * owned. The initial Agent is always first in agents() while live. Commands
 * serialize to prevent duplicate session writers; failures reject without
 * replacing or closing the viewed Agent. After close(), mutations reject.
 *
 * @param {Agent} initialAgent Open, borrowed Agent initially being viewed.
 * @param {{env?: Env}} [options={}] Additional borrowed project Env; defaults to initialAgent.env.
 * @returns {{projects: Function, agents: Function, open: Function, enroll: Function,
 * select: Function, remember: Function, own: Function, add: Function, pin: Function, describe: Function,
 * group: Function, closeProject: Function, sessions: Function, resume: Function,
 * renameSession: Function, deleteSession: Function, close: Function}} Private App API.
 * @throws {TypeError} Invalid or closed initial Agent/Env; fix inputs before retrying.
 * @example
 * const workspace = createWorkspace(agent);
 * const project = await workspace.open("../other");
 * const other = await workspace.add({ env: project, safe: true });
 * workspace.remember(other);
 * // Invalid paths reject; the current Agent keeps running.
 * try { await workspace.open("missing"); } catch (error) { console.error(error.message); }
 * await workspace.close(); // leaves the original borrowed Agent and Env alive
 */
export function createWorkspace(initialAgent, { env = initialAgent.env } = {}) {
  if (!(initialAgent instanceof Agent) || !isLive(initialAgent)) throw new TypeError("workspace requires an open initial Agent");
  const enrolled = new Set();
  const tracked = new Set();
  const acquired = new Set();
  const created = new Set();
  const selected = new Map();
  const aliases = new Map();
  const hidden = new Set();
  const baseFolder = initialAgent.folder;
  let viewed = initialAgent;
  let closing = false;
  let closePromise;
  let pending = Promise.resolve();

  function assertOpen() {
    if (closing) throw new Error("workspace is closed");
  }

  function envValidate(target) {
    if (!(target instanceof Env) || target.closed) throw new TypeError("workspace requires an open Env");
    return target;
  }

  /** Expand paths relative to the original Agent, independent of later selections. */
  function pathResolve(input) {
    if (typeof input !== "string" || input.trim() === "") throw new TypeError("project path must be a non-empty string");
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
    const path = resolve(baseFolder, expanded);
    return aliases.get(path) ?? path;
  }

  function envPath(target) {
    return aliases.get(resolve(target.folder)) ?? resolve(target.folder);
  }

  /** Registry reads include isolated, enrolled Envs before canonical ones. */
  function allEnvironments() {
    return [...new Set([...enrolled, ...tracked, ...Object.values(Env.envs)])].filter((target) => !target.closed);
  }

  /** A closed borrowed project stays hidden locally even while its Env remains registered. */
  function environments() {
    return allEnvironments().filter((target) => !hidden.has(envPath(target)));
  }

  function agentValidate(agent) {
    if (!(agent instanceof Agent) || !isLive(agent)) throw new TypeError("cannot select a closed or invalid Agent");
    return agent;
  }

  /** Serialize commands, retaining neither a failed result nor its rejection. */
  function command(run) {
    if (closing) return Promise.reject(new Error("workspace is closed"));
    const result = pending.then(() => { assertOpen(); return run(); });
    pending = result.catch(() => {});
    return result;
  }

  /**
   * Track a borrowed Env without opening or pinning it. Idempotent.
   * @param {Env} target Open Env retained until closeProject()/close().
   * @returns {Env} The same Env. @throws {TypeError|Error} Closed/invalid Env or workspace.
   */
  function enroll(target) {
    assertOpen();
    enrolled.add(envValidate(target));
    tracked.add(target);
    hidden.delete(envPath(target));
    return target;
  }

  /**
   * Remember a borrowed or owned live Agent as the viewed selection. Does not
   * stop the previous Agent. Also enrolls its Env without taking ownership.
   * @param {Agent} agent Open Agent; retained, never mutated.
   * @returns {Agent} The same Agent. @throws {TypeError|Error} Invalid/closed Agent or workspace.
   */
  function remember(agent) {
    assertOpen();
    agentValidate(agent);
    enroll(agent.env);
    selected.delete(agent.env);
    selected.set(agent.env, agent);
    viewed = agent;
    return agent;
  }

  /**
   * Adopt an App-created Agent for workspace cleanup, without enrolling its Env
   * or changing the viewed selection. Idempotent; only the Agent is adopted.
   * @param {Agent} agent Open Agent; retained until close()/closeProject().
   * @returns {Agent} The same Agent. @throws {TypeError|Error} Invalid/closed Agent or workspace.
   */
  function own(agent) {
    assertOpen();
    created.add(agentValidate(agent));
    return agent;
  }

  enroll(env);
  remember(initialAgent);

  /**
   * Snapshot all global pins and open/enrolled projects. No I/O or mutations.
   * Multiple Envs of one folder produce one row, preferring an enrolled Env.
   * @returns {Array<{path: string, name: string, description: string, groups: string[], pinned: boolean, open: boolean, current: false, env?: Env}>}
   */
  function projects() {
    const rows = new Map();
    for (const target of environments()) {
      const path = envPath(target);
      if (!rows.has(path)) rows.set(path, { path, env: target });
    }
    const pins = Env.settings.projects;
    for (const [path, pin] of Object.entries(pins)) {
      if (isAbsolute(path) && pin?.folder === path && !rows.has(path) && !hidden.has(aliases.get(path) ?? path)) rows.set(path, { path });
    }
    return [...rows.values()].map(({ path, env: target }) => {
      const pin = pins[path];
      return {
        path, name: pin?.name ?? target?.name ?? (basename(path) || path),
        description: pin?.description ?? "",
        groups: Object.keys(pin?.groups ?? {}).filter((name) => pin.groups[name] === true).sort(),
        pinned: pin !== undefined, open: target !== undefined, current: false,
        ...(target ? { env: target } : {}),
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  /** @returns {Agent[]} Deduplicated live Agents, initial first, then enrolled and canonical Env order. No ownership change. */
  function agents() {
    return [...new Set([initialAgent, ...environments().flatMap((target) => target.agents())])]
      .filter((agent) => isLive(agent) && !hidden.has(envPath(agent.env)));
  }

  async function openProject(input) {
    const requested = pathResolve(input);
    let canonical;
    try { canonical = await realpath(requested); }
    catch { throw new TypeError(`project directory does not exist: ${input}`); }
    if (!(await stat(canonical)).isDirectory()) throw new TypeError("project path must be a directory");
    aliases.set(requested, canonical);
    aliases.set(canonical, canonical);
    hidden.delete(canonical);
    for (const target of allEnvironments()) {
      const path = await identity(target.folder);
      aliases.set(resolve(target.folder), path);
      if (path === canonical) {
        enrolled.add(target);
        tracked.add(target);
        return target;
      }
    }
    // Never copy initial-project settings, credentials, sessions or startup options.
    const target = await Env.open(canonical);
    acquired.add(target); // every actual acquisition has exactly one release path
    enrolled.add(target);
    tracked.add(target);
    return target;
  }

  /**
   * Open an existing directory (relative to initialAgent.folder, absolute, or ~/).
   * Reuses enrolled/canonical Envs as borrowed; owns each new Env.open acquisition.
   * Does not pin or create an Agent. Repeated calls reuse the existing enrollment.
   * @param {string} path Directory path; symlinks resolve to the same project.
   * @returns {Promise<Env>} Ready Env. @throws {TypeError|Error} Invalid/non-directory path or startup failure; retry after repair.
   */
  function open(path) { return command(() => openProject(path)); }

  async function agentCreate(target, options, thinking) {
    const agent = await target.agentCreate(options);
    created.add(agent);
    try {
      if (thinking !== undefined) agent.thinking = thinking;
      enrolled.add(target);
      tracked.add(target);
      return agent;
    } catch (error) {
      try { await agent.close(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Agent setup and cleanup failed"); }
      finally { created.delete(agent); }
      throw error;
    }
  }

  async function projectAgent(target) {
    for (const candidate of environments()) aliases.set(resolve(candidate.folder), await identity(candidate.folder));
    const path = envPath(target);
    const previous = [...selected.values()].reverse().find((agent) => isLive(agent) && envPath(agent.env) === path);
    if (previous) return previous;
    const projectEnvs = environments().filter((candidate) => envPath(candidate) === path);
    const root = projectEnvs.flatMap((candidate) => candidate.agents()).find((agent) => isLive(agent) && !agent.parent);
    return root ?? agentCreate(target, { model: defaultModel(target), contextId: randomUUID() });
  }

  /**
   * Select the last live selection in a project, else its first root Agent,
   * else a workspace-owned independent Agent with that project's default model.
   * @param {string} path Project directory; opened/enrolled when necessary.
   * @returns {Promise<Agent>} Selected Agent; the old one keeps running.
   * @throws {TypeError|Error} Path, startup or Agent creation failure; retry after repair.
   */
  function select(path) {
    return command(async () => remember(await projectAgent(await openProject(path))));
  }

  /**
   * Create and remember an independent workspace-owned Agent. In the viewed
   * Agent's Env, inherit effective capabilities, model and thinking. Else use
   * the target project's own defaults. safe:true only narrows write permission;
   * false never broadens inherited permissions. anonymous:true disables logging;
   * omitted inherits same-Env viewed logging state, while another Env logs by default.
   * @param {{env?: Env, model?: string, safe?: boolean, anonymous?: boolean}} [options={}]
   * @returns {Promise<Agent>} New selected Agent, closed by workspace.close().
   * @throws {TypeError|Error} Invalid options, closed Env or rejected model; no partial Agent remains registered.
   */
  function add(options = {}) {
    return command(async () => {
      if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("add options must be an object");
      const { env: targetEnv, model, safe, anonymous } = options;
      for (const [key, value] of [["safe", safe], ["anonymous", anonymous]]) {
        if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
      }
      const target = envValidate(targetEnv ?? viewed.env);
      const source = viewed.env === target && isLive(viewed) ? viewed : undefined;
      const can = source ? { ...source.can } : {};
      if (safe === true) can.write = false;
      const agent = await agentCreate(target, {
        model: model !== undefined ? model : source ? source.model : defaultModel(target), can,
        contextId: (anonymous ?? (source?.context.save === false)) ? false : randomUUID(),
      }, source?.thinking);
      return remember(agent);
    });
  }

  function pinGet(path, create = false) {
    const pins = Env.settings.projects;
    if (!pins[path] && create) pins[path] = { models: {} };
    return pins[path];
  }

  /**
   * Pin/unpin a project globally, without opening it. Existing metadata is
   * untouched when pinning; unpinning removes the complete metadata record.
   * @param {string} input Project path. @param {boolean} pinned Desired pin state.
   * @returns {void} @throws {TypeError|Error} Invalid path/state or closed workspace.
   */
  function pin(input, pinned) {
    assertOpen();
    if (typeof pinned !== "boolean") throw new TypeError("pinned must be a boolean");
    const path = pathResolve(input);
    if (pinned) pinGet(path, true);
    else delete Env.settings.projects[path];
  }

  /**
   * Set only a pin's description; nonempty text pins, clearing never unpins.
   * @param {string} input Project path. @param {string} text At most 2048 characters.
   * @returns {void} @throws {TypeError|RangeError|Error} Invalid text/path or closed workspace; no partial edit.
   */
  function describe(input, text) {
    assertOpen();
    if (typeof text !== "string") throw new TypeError("description must be a string");
    if (text.length > 2048) throw new RangeError("description must not exceed 2048 characters");
    const record = pinGet(pathResolve(input), text.length > 0);
    if (!record) return;
    if (text) record.description = text;
    else delete record.description;
  }

  /**
   * Edit one group membership only. Joining pins, leaving preserves the pin.
   * @param {string} input Project path. @param {string} name Nonblank group without '/'.
   * @param {boolean} member Desired membership.
   * @returns {void} @throws {TypeError|Error} Invalid group/membership/path or closed workspace; no partial edit.
   */
  function group(input, name, member) {
    assertOpen();
    if (typeof name !== "string" || name.trim() === "" || name.includes("/") || ["__proto__", "constructor", "prototype"].includes(name.trim())) throw new TypeError("group must be nonblank and contain no '/' or reserved object key");
    if (typeof member !== "boolean") throw new TypeError("group membership must be a boolean");
    const record = pinGet(pathResolve(input), member);
    if (!record) return;
    const key = name.trim();
    if (member) {
      if (record.groups === undefined) record.groups = {};
      record.groups[key] = true;
    } else if (record.groups?.[key] !== undefined) {
      delete record.groups[key];
    }
  }

  /**
   * Leave an enrolled or visible canonical project without unpinning. Refuses the last project and
   * any busy Agent in the project. Borrowed Envs lose only workspace-created
   * Agents; acquired Envs lose all Agents and their acquisition is released.
   * A replacement selection is obtained before teardown, so creation failure
   * leaves this project intact. Cleanup errors report after all releases.
   * @param {string} input Enrolled or visible open project path; hidden projects stay closed.
   * @returns {Promise<Agent>} Current viewed Agent if it survives, else a replacement in another enrolled project.
   * @throws {TypeError|AggregateError|Error} Unknown/last/busy project, creation or cleanup failure.
   */
  function closeProject(input) {
    return command(async () => {
      const path = await identity(pathResolve(input));
      for (const target of environments()) aliases.set(resolve(target.folder), await identity(target.folder));
      const projectEnvs = environments().filter((target) => envPath(target) === path);
      if (!projectEnvs.length) throw new TypeError("unknown enrolled or open project");
      // Visible canonical Envs are valid project-menu targets even before viewing.
      // Resolve only through the visible registry so hidden projects stay hidden.
      for (const target of projectEnvs) enroll(target);
      const targets = [...enrolled].filter((target) => !target.closed && envPath(target) === path);
      const others = [...enrolled].filter((target) => !target.closed && envPath(target) !== path);
      if (!others.length) throw new TypeError("the last enrolled project cannot be closed");
      if (projectEnvs.some((target) => target.agents().some((agent) => !agent.closed && agent.busy))) throw new TypeError("the project has busy Agents; stop them first");
      const before = new Set(created);
      const replacement = isLive(viewed) && others.includes(viewed.env) ? viewed : await projectAgent(others[0]);
      const victims = new Set(projectEnvs.flatMap((target) => target.agents().filter((agent) => acquired.has(target) || created.has(agent))));
      let failure;
      try { await releaseAll([...victims].map((agent) => () => agent.close()), "project Agent cleanup failed"); }
      catch (error) { failure = error; }
      for (const agent of victims) created.delete(agent);
      const owned = targets.filter((target) => acquired.has(target));
      try { await releaseAll(owned.map((target) => () => target.close()), "project Env cleanup failed"); }
      catch (error) { failure = failure ? new AggregateError([failure, error], "project cleanup failed") : error; }
      for (const target of targets) { enrolled.delete(target); selected.delete(target); acquired.delete(target); }
      hidden.add(path);
      if (failure) {
        if (!before.has(replacement) && created.has(replacement)) {
          created.delete(replacement);
          try { await replacement.close(); } catch (error) { throw new AggregateError([failure, error], "project cleanup failed"); }
        }
        throw failure;
      }
      return remember(replacement);
    });
  }

  /** Find all live/closing writers, including borrowed canonical Agents. */
  async function sessionOwners(id, dir) {
    const folder = await identity(dir);
    const candidates = [...new Set([...created, ...allEnvironments().flatMap((target) => target.agents())])];
    const owners = await Promise.all(candidates.map(async (agent) => {
      if (agent.closed || agent.context.id !== id || !agent.context.dir) return undefined;
      return await identity(agent.context.dir) === folder ? agent : undefined;
    }));
    return owners.filter(Boolean);
  }

  async function sessionList() {
    const seen = new Set();
    const records = [];
    for (const target of environments()) {
      const dir = target.settings.sessions;
      const project = await identity(target.folder);
      const key = JSON.stringify([await identity(dir), project]);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const record of await Context.listAsync({ dir, cwd: target.folder, limit: Infinity })) {
        const owners = await sessionOwners(record.id, dir);
        records.push({ ...record, dir, env: target, project, projectName: target.name, name: owners[0]?.context.name ?? record.id, live: owners[0] ?? null });
      }
    }
    return records.sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Read saved sessions across enrolled/registered open projects, once per
   * canonical session-directory + origin pair. Records are detached and carry
   * env, project path, projectName, session name, dir and live (Agent or null); no Env is acquired.
   * @returns {Promise<object[]>} Newest-first saved session records.
   * @throws {Error} Closed workspace or settings/list failure; retry is safe.
   */
  function sessions() { return command(sessionList); }

  /** Revalidate untrusted/stale records against a known Env's origin-filtered list. */
  async function sessionValidate(record) {
    if (!record || typeof record.id !== "string" || !record.id) throw new TypeError("unknown session");
    const known = environments();
    const target = record.env ?? known.find((candidate) => envPath(candidate) === record.project);
    if (!known.includes(target)) throw new TypeError("unknown session project");
    const dir = target.settings.sessions;
    if (record.dir !== undefined && await identity(record.dir) !== await identity(dir)) throw new TypeError("unknown session directory");
    if (record.project !== undefined && await identity(record.project) !== await identity(target.folder)) throw new TypeError("foreign session project");
    const found = (await Context.listAsync({ dir, cwd: target.folder, limit: Infinity })).find((entry) => entry.id === record.id);
    if (!found) throw new TypeError("unknown or foreign session");
    return { env: target, dir, id: found.id };
  }

  /**
   * Resume a verified saved session without replacing the current running Agent.
   * Returns an existing writer of the same context id + canonical session dir,
   * including borrowed Agents. Otherwise creates and owns one independent Agent.
   * @param {object} record A sessions() record (revalidated; never mutated).
   * @returns {Promise<Agent>} Selected live session owner.
   * @throws {TypeError|Error} Unknown/foreign/stale session, startup or creation failure; no saved data is replaced.
   */
  function resume(record) {
    return command(async () => {
      const session = await sessionValidate(record);
      const owners = await sessionOwners(session.id, session.dir);
      const owner = owners.find(isLive);
      if (owner) return remember(owner);
      for (const closingOwner of owners) await closingOwner.close();
      const agent = await agentCreate(session.env, { contextId: session.id });
      return remember(agent);
    });
  }

  /**
   * Rename a verified session through its live Context or the offline facade.
   * The record is not mutated. Multiple existing writers must be closed first.
   * @param {object} record sessions() record. @param {string} name New unique session id/name.
   * @returns {Promise<{id: string, file: string}>} New saved identity.
   * @throws {TypeError|Error} Unknown/foreign session, invalid/taken name, multiple writers, or persistence failure.
   */
  function renameSession(record, name) {
    return command(async () => {
      const { id, dir } = await sessionValidate(record);
      const owners = await sessionOwners(id, dir);
      if (owners.length > 1) throw new Error("session has multiple live owners; close duplicate Agents before renaming");
      const owner = owners[0];
      if (owner?.closeMarked) { await owner.close(); return Context.renameById({ id, name, dir }); }
      return owner ? owner.context.rename(name) : Context.renameById({ id, name, dir });
    });
  }

  /**
   * Delete a verified session after closing all idle owners, including borrowed
   * owners, so no writer can resurrect it. Any busy owner refuses the operation
   * before closing anyone. Never trusts a caller's arbitrary dir/file/id.
   * @param {object} record sessions() record; retained only for this operation.
   * @returns {Promise<{deleted: number}>} Context deletion result.
   * @throws {TypeError|AggregateError|Error} Unknown/foreign session, busy owner or cleanup/persistence failure.
   */
  function deleteSession(record) {
    return command(async () => {
      const { id, dir } = await sessionValidate(record);
      const owners = await sessionOwners(id, dir);
      if (owners.some((agent) => agent.busy)) throw new TypeError("session has a busy Agent; stop it before deleting");
      await releaseAll(owners.map((agent) => () => agent.close()), "session owner cleanup failed");
      for (const owner of owners) created.delete(owner);
      return Context.deleteById({ id, dir });
    });
  }

  /**
   * Idempotently cancel and close owned Agents, then release owned Env acquisitions.
   * Borrowed unrelated Agents/Envs, including busy Agents, survive. Admitted commands settle
   * before cleanup; queued commands reject. Every release is attempted even
   * when another fails. Repeated calls share the final outcome.
   * @returns {Promise<void>} Owned cleanup completion; active owned turns are cancelled.
   * @throws {AggregateError} Release failures, after all releases are attempted.
   */
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await pending;
      const errors = [];
      try { await releaseAll([...created].filter((agent) => !agent.closed).map((agent) => () => agent.cancel()), "workspace Agent cancellation failed"); }
      catch (error) { errors.push(error); }
      try { await releaseAll([...created].map((agent) => () => agent.close()), "workspace Agent cleanup failed"); }
      catch (error) { errors.push(error); }
      try { await releaseAll([...acquired].map((target) => () => target.close()), "workspace Env cleanup failed"); }
      catch (error) { errors.push(error); }
      created.clear(); acquired.clear(); enrolled.clear(); tracked.clear(); selected.clear(); aliases.clear(); hidden.clear();
      if (errors.length) throw new AggregateError(errors, "workspace cleanup failed");
    })();
    return closePromise;
  }

  return { projects, agents, open, enroll, select, remember, own, add, pin, describe, group, closeProject, sessions, resume, renameSession, deleteSession, close };
}
