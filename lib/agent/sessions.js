/**
 * lib/agent/sessions.js — session lifecycle (private to Agent):
 * fork/new/resume/list over the wired store, and the seeded system
 * prompt a NEW context always starts with. Session wiring
 * (--session/--resume) lives wholly inside Agent; bindings pass an
 * id, nothing more.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Context from "../context.js";
const { systemMessage, appendMessage } = Context;
import { SessionStore, sameFolder } from "./session.js";
import { clearToolMessages, detectToolMessages } from "./tool-messages.js";

/** The anonymous-session id spellings: "0", "false", "anon". */
const isAnonymousId = (id) => id === "0" || id === "false" || id === "anon";

/**
 * Fork the current session into a NEW session id: the live context
 * continues under a fresh store (flushed immediately), and the old
 * session file is left behind untouched — a snapshot of the
 * conversation so far. With no id a random UUID is chosen; "0" /
 * "false" / "anon" forks into an ANONYMOUS (hidden, unpersisted)
 * session.
 * @param {object} agent
 * @param {string} [id]
 * @returns {{id: string|null, file?: string, anonymous?: boolean}}
 */
export function forkSession(agent, id) {
  const old = agent.session;
  old?.close?.();
  if (isAnonymousId(id)) {
    agent.session = null;
    return { id: null, anonymous: true };
  }
  agent.session = new SessionStore({
    id: id ?? randomUUID(),
    dir: old?.dir,
    origin: old?.origin ?? agent.env?.cwd,
    context: agent.context,
    save: old?.save,
  });
  agent.session.flush();
  return { id: agent.session.id, file: agent.session.file };
}

/**
 * Start a NEW context with the seeded system prompt (Agent-owned,
 * always the FIRST message(s) of the context array — the contract is
 * "an agent is created with its system prompt already in place,
 * awaiting further input"). Called by the constructor (non-resumed)
 * and newSession(); never by resumeSession() — a resumed context
 * replaces the seeded one wholesale. env.resolveSystemPrompt() reads
 * its sources fresh every call, so editing them before the agent (or
 * the /new session) is created is honored.
 */
export function seedSystemPrompt(agent) {
  const texts = agent.env?.resolveSystemPrompt?.() ?? [];
  if (texts.length === 0) return;
  // the same append-merge as the live context: multiple sources fold
  // into one system message before they take the front position
  const seeded = [];
  for (const text of texts) appendMessage(seeded, systemMessage(text));
  if (seeded.length === 0) return;
  if (agent.session) agent.session.prepend(seeded);
  else agent.context.unshift(...seeded);
}

/**
 * Start a NEW session with an EMPTY context: the old session file is
 * closed (its flushed content stays on disk — fork() first to keep a
 * snapshot) and the live context is replaced with a fresh one under
 * a new store. With no id a random UUID is chosen — UNLESS the
 * current session is already anonymous: anonymous stays anonymous.
 * "0" / "false" / "anon" always selects an ANONYMOUS (unpersisted)
 * session.
 * @param {object} agent
 * @param {string} [id]
 * @returns {{id: string|null, file?: string, anonymous?: boolean}}
 */
export function newSession(agent, id) {
  const old = agent.session;
  old?.close?.();
  // the sticky tool displays are context-derived: the fresh context
  // invalidates them (the tools refresh on their next call)
  clearToolMessages(agent);
  // anonymous STAYS anonymous: /session-new from an anonymous session
  // (or an explicit 0/false/anon) starts a fresh unpersisted one —
  // opting INTO persistence takes an explicit id
  if (isAnonymousId(id) || (id === undefined && old == null)) {
    agent.session = null;
    agent.context = [];
    seedSystemPrompt(agent); // a fresh context starts with the system prompt
    return { id: null, anonymous: true };
  }
  agent.session = new SessionStore({
    id: id ?? randomUUID(),
    dir: old?.dir,
    origin: old?.origin ?? agent.env?.cwd,
    context: [],
    save: old?.save,
  });
  agent.context = agent.session.context;
  seedSystemPrompt(agent); // freshly read (see seedSystemPrompt)
  return { id: agent.session.id, file: agent.session.file };
}

/**
 * Rename the current session: the session FILE takes the proper name
 * (`session-<name>.jsonl` — the old name's file is gone) and the id
 * follows. An anonymous session has no file to name.
 * @param {object} agent
 * @param {string} name
 * @returns {{id: string, file: string}}
 */
export function renameSession(agent, name) {
  if (!agent.session) {
    throw new Error("an anonymous session has no file to name — start a logged one first (/session-new <name>)");
  }
  return agent.session.rename(name);
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
 * @param {string} id - session id (see latestSessionId for "latest")
 * @returns {{id: string, file: string, cwd: string|undefined, originMissing: boolean}}
 * @throws {Error} when no such session exists
 */
export function resumeSession(agent, id) {
  const old = agent.session;
  old?.close?.();
  clearToolMessages(agent); // context-derived displays: the resumed context invalidates them
  agent.session = SessionStore.resume({ id, dir: old?.dir ?? agent._sessionDir, save: old?.save });
  agent.context = agent.session.context; // the stored context REPLACES the seeded one
  detectToolMessages(agent); // rebuild context-derived TUI information before the next paint
  const origin = agent.session.origin;
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
        agent.env.cwd = origin;
        const project = agent.env.environment?.folders?.find((f) => f.title === "project folder");
        if (project) project.path = origin;
      }
    } else {
      originMissing = true; // the session's folder is gone — stay put
    }
  }
  return { id: agent.session.id, file: agent.session.file, cwd, originMissing };
}

/**
 * Every session OF THIS AGENT'S ORIGIN FOLDER in the store's folder,
 * latest first, each with a first-user-message preview (the ^X menu's
 * Resume sub-menu, /resume's Tab completion) — sessions that ran in
 * other folders never list here (the metadata's origin record).
 * @returns {Array<{id: string, file: string, mtime: number, messages: number, preview: string}>}
 */
export function listSessions(agent) {
  return SessionStore.list({
    dir: agent.session?.dir ?? agent._sessionDir,
    cwd: agent.env?.cwd ?? process.cwd(),
  });
}

/** Nonblocking counterpart of listSessions(). */
export function listSessionsAsync(agent) {
  return SessionStore.listAsync({
    dir: agent.session?.dir ?? agent._sessionDir,
    cwd: agent.env?.cwd ?? process.cwd(),
  });
}

/** @returns {string|undefined} the latest session's id OF THIS
 *  AGENT'S ORIGIN FOLDER (undefined: no sessions) */
export function latestSessionId(agent) {
  return SessionStore.latest({
    dir: agent.session?.dir ?? agent._sessionDir,
    cwd: agent.env?.cwd ?? process.cwd(),
  });
}
