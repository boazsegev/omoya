/**
 * lib/cli/resume.js — resume-anywhere (private to CLI): an EXPLICIT
 * --resume <id> continues the session in ITS recorded origin folder.
 * The chdir must happen BEFORE the environment is built — settings
 * layers, the project AGENTS.md, and every cwd-rooted path guard all
 * resolve from the process cwd, so adopting the origin first makes
 * the whole session run exactly where it was created. "latest"/"true"
 * and anonymous sessions never move (latest is origin-filtered to the
 * current folder already; an anonymous session resumes nothing).
 */

import { existsSync } from "node:fs";
import Agent from "../agent.js";
const { SessionStore } = Agent;

/**
 * Adopt an explicitly resumed session's origin folder as the cwd.
 * @param {Object} options
 * @param {string} [options.resume] - the --resume flag value
 * @param {boolean} [options.anonymous] - an anonymous session resumes nothing
 * @returns {string|null} the origin folder chdir'd into, or null
 * @throws {Error} when the session (or its origin folder) doesn't exist
 */
export function adoptResumeOrigin({ resume, anonymous = false } = {}) {
  if (anonymous || resume === undefined || resume === "true" || resume === "latest") return null;
  const origin = SessionStore.originOf({ id: resume });
  if (origin === undefined) {
    throw new Error(`--resume ${resume}: no such session`);
  }
  if (!existsSync(origin)) {
    throw new Error(`--resume ${resume}: the session's folder no longer exists: ${origin}`);
  }
  process.chdir(origin);
  return origin;
}
