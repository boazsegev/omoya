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
const { Context, Env } = Agent;

/**
 * Move the process to the recorded origin folder for an explicit session resume.
 * Skips cwd changes for anonymous, absent, `"true"`, and `"latest"` resume values.
 * Resolves the session origin (using `dir` or the configured sessions folder),
 * verifies that folder exists, then changes `process.cwd()` before environment setup.
 * @param {Object} [options={}] Resume selection and session lookup options.
 * @param {string} [options.resume] The `--resume` value; values other than
 *   `"true"` and `"latest"` are treated as explicit session IDs.
 * @param {boolean} [options.anonymous=false] Whether this is an anonymous session.
 * @param {string} [options.dir] Session directory passed to origin lookup; defaults
 *   to `new Env().settings.sessions` when omitted or nullish.
 * @returns {string|null} The origin folder after changing cwd, or `null` when
 *   no explicit origin should be adopted.
 * @throws {Error} If the session has no recorded origin or its origin folder
 *   no longer exists. `process.chdir()` errors also propagate.
 */
export function adoptResumeOrigin({ resume, anonymous = false, dir } = {}) {
  if (anonymous || resume === undefined || resume === "true" || resume === "latest") return null;
  // No Env exists yet (it is built in the adopted folder); the sessions
  // folder comes from package/user settings only, so any cwd resolves it.
  const origin = Context.originOf({ id: resume, dir: dir ?? new Env().settings.sessions });
  if (origin === undefined) {
    throw new Error(`--resume ${resume}: no such session`);
  }
  if (!existsSync(origin)) {
    throw new Error(`--resume ${resume}: the session's folder no longer exists: ${origin}`);
  }
  process.chdir(origin);
  return origin;
}
