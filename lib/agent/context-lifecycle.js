/**
 * lib/agent/context-lifecycle.js — the agent's context lifecycle (private
 * to Agent): contextNew/contextFork/contextResume swap the agent's
 * Context; the settings snapshot a logged context carries; and the seeded
 * system prompt every NEW context starts with. Contexts are named from an
 * id (the CLI's --session/--resume) and logged in env.settings.sessions.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import Context from "../context.js";
const { messageSystem, messageAppend } = Context;
import { setThinking } from "./thinking.js";
import { clearToolMessages, detectToolMessages } from "./tool-messages.js";

/** Two folder paths are the same place (realpath when it exists). */
function sameFolder(a, b) {
  const identity = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return identity(a) === identity(b);
}

/**
 * Apply a resumed session's stored AGENT SETTINGS snapshot to the agent
 * (the resume contract: a session reloads its configuration with its
 * context). AGENT-LOCAL ONLY: nothing here touches the environment
 * (settings layers, registries, env.cwd) — safe mode toggles through
 * setSafe (env/platform/parent enforcement still applies), thinking
 * through setThinking, and the stored endpoint/model is merely validated
 * against the env's live registry (a vanished endpoint keeps the
 * caller's selection). Caller-supplied configuration wins for endpoint/
 * model/url/timeout: a launch's --model (or a host's explicit option)
 * overrides the stored selection; the stored one fills in only when
 * nothing was asked for. A stored agent name restores only while the
 * agent still carries its DEFAULT `agent-N` name (an explicitly given
 * name wins) — and only a NON-default name is ever stored (see
 * agentSettingsSnapshot).
 * @param {object} agent
 * @param {object} [s] - the store's settings snapshot (undefined: none recorded)
 */
export function applyContextSettings(agent, s) {
  if (!s || typeof s !== "object") return;
  if (agent.endpoint === undefined && typeof s.endpoint === "string" && typeof s.model === "string") {
    try { agent.modelSet(`${s.endpoint}/${s.model}`); } catch { /* the recorded endpoint is gone from the env — keep the caller's selection */ }
  }
  if (agent.url === undefined && typeof s.url === "string") agent.url = s.url;
  if (agent.timeout === undefined && s.timeout !== undefined) agent.timeout = s.timeout;
  if (s.safe === true) agent.safeSet(true);
  else if (s.safe === false) agent.safeSet(false);
  setThinking(agent, s.thinking);
  if (typeof s.name === "string" && /^agent-\d+$/.test(agent.name)) agent.nameSet(s.name);
  if (typeof s.description === "string") agent.descriptionSet(s.description);
  if (s.spawnPermission === true || s.spawnPermission === false) agent.spawnPermissionSet(s.spawnPermission);
}

/**
 * The session-owned AGENT SETTINGS snapshot the store persists (Agent's
 * own session record): only values worth restoring on resume. Read
 * live from the agent at record time. The DEFAULT `agent-N` name is
 * meaningless and never rides the file (resume regenerates it, and
 * listing already suppresses it) — only an explicitly chosen name is
 * stored.
 * @param {object} agent
 * @returns {object}
 */
export function agentSettingsSnapshot(agent) {
  const s = {
    endpoint: agent.endpoint,
    model: agent.model,
    url: agent.url,
    timeout: agent.timeout,
    safe: agent._safe,
    thinking: agent.thinking,
    name: /^agent-\d+$/.test(agent.name ?? "") ? undefined : agent.name,
    description: agent.description,
    spawnPermission: agent._spawnPermission,
  };
  for (const key of Object.keys(s)) if (s[key] === undefined) delete s[key];
  return s;
}

/**
 * The replacement Context for fork/new: the env's sessions folder, the
 * old context's origin, a fresh id (`id`, else a random UUID). Logging is
 * ONE switch (context.saveSet), orthogonal to ids: the new context keeps the
 * old one's setting — an anonymous spelling (`false`/"0"/"false"/"anon")
 * always selects a memory-only context.
 */
function nextContext(agent, id, messages) {
  const old = agent.context;
  const anonymous = Context.idAnonymous(id);
  return new Context({
    ...(anonymous || id === undefined ? {} : { id }),
    dir: agent._sessionsDir,
    origin: old?.origin ?? agent.env?.cwd,
    messages,
    save: anonymous ? false : old?.save !== false,
  });
}

/** What fork/new report: the new context's id, file, and whether it logs. */
const contextResult = (context) => ({ id: context.id, file: context.file, save: context.save });

/**
 * Fork the current session into a NEW session id: the live context
 * continues under a fresh store (flushed immediately when it logs), and
 * the old session file is left behind untouched — a snapshot of the
 * conversation so far. See nextStore for the id and logging rules.
 * @param {object} agent
 * @param {string|false} [id]
 * @returns {{id: string, file: string, save: boolean}}
 */
export function contextFork(agent, id) {
  const context = nextContext(agent, id, agent.context.messages());
  agent.context.close();
  agent.context = context;
  context.flush();
  return contextResult(context);
}

/**
 * Start a NEW context with the seeded system prompt (Agent-owned,
 * always the FIRST message(s) of the context array — the contract is
 * "an agent is created with its system prompt already in place,
 * awaiting further input"). Called by the constructor (non-resumed)
 * and contextNew(); never by contextResume() — a resumed context
 * replaces the seeded one wholesale. env.systemPrompt() reads
 * its sources fresh every call, so editing them before the agent (or
 * the /new session) is created is honored.
 */
export function seedSystemPrompt(agent) {
  const texts = agent.env?.systemPrompt?.() ?? [];
  if (texts.length === 0) return;
  // the same append-merge as the live context: multiple sources fold
  // into one system message before they take the front position
  const seeded = [];
  for (const text of texts) messageAppend(seeded, messageSystem(text));
  if (seeded.length === 0) return;
  agent.context.prepend(seeded);
}

/**
 * Start a NEW session with an EMPTY context: the old session file is
 * closed (its flushed content stays on disk — fork() first to keep a
 * snapshot) and the live context is replaced with a fresh one under
 * a new store. See nextStore for the id and logging rules (a session
 * that is not logged stays not logged).
 * @param {object} agent
 * @param {string|false} [id]
 * @returns {{id: string, file: string, save: boolean}}
 */
export function contextNew(agent, id) {
  const context = nextContext(agent, id, []);
  agent.context.close();
  // the sticky tool displays are context-derived: the fresh context
  // invalidates them (the tools refresh on their next call)
  clearToolMessages(agent);
  agent.context = context;
  seedSystemPrompt(agent); // freshly read (see seedSystemPrompt)
  return contextResult(context);
}

/**
 * Resume an EXISTING session: the live context is replaced with the
 * session's stored context under its store; the old session file is
 * closed (its flushed content stays on disk).
 *
 * RESUME ANYWHERE: the session file's recorded ORIGIN folder becomes
 * the agent's folder when it differs from the current one. The
 * PROCESS chdirs only when the environment actually tracks it
 * (env.cwd is the process cwd — the bins' shape); an embedded host
 * (env.cwd elsewhere) gets the env-side adoption only, its process
 * untouched. A "latest" resume never triggers this (latest is
 * origin-filtered to the current folder already). A vanished origin
 * folder is reported in the result and the current folder stays.
 * @param {object} agent
 * @param {string} id - session id (see Context.latest for "latest")
 * @returns {{id: string, file: string, cwd: string|undefined, originMissing: boolean}}
 * @throws {Error} when no such session exists
 */
export function contextResume(agent, id) {
  // flush, then load: resuming the open id reads its latest content; an
  // unknown id throws before the current context closes
  agent.context.flush();
  const resumed = Context.resume({ id, dir: agent._sessionsDir, save: true });
  agent.context.close();
  clearToolMessages(agent); // context-derived displays: the resumed context invalidates them
  // a resumed file logs (a paused context never flushes, so its file
  // always recorded a logging one)
  agent.context = resumed; // the stored context REPLACES the seeded one
  agent._toolMessagesDetected = detectToolMessages(agent).catch(() => []); // rebuild context-derived TUI information
  applyContextSettings(agent, agent.context.settings); // the session's configuration rides with its context
  const origin = agent.context.origin;
  const base = agent.env?.cwd ?? process.cwd();
  let cwd;
  let originMissing = false;
  if (origin && !sameFolder(origin, base)) {
    if (existsSync(origin)) {
      cwd = origin;
      // the bins' shape (the environment IS the process folder): move
      // the process itself; an embedded host keeps its process put
      if (sameFolder(base, process.cwd())) process.chdir(origin);
      if (agent.env) {
        agent.env.cwd = origin; // env.folders' project folder follows
      }
    } else {
      originMissing = true; // the session's folder is gone — stay put
    }
  }
  return { id: agent.context.id, file: agent.context.file, cwd, originMissing };
}

