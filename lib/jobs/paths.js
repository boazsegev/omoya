import { isAbsolute, resolve } from "node:path";
import { JobsError } from "./errors-base.js";

/** Active portable Jobs directory name. */
export const JOBS_DATA_DIRECTORY = "ai-jobs";
/** Disabled portable Jobs directory name. */
export const JOBS_DISABLED_DIRECTORY = "ai-jobs-disabled";
/** Names inside the portable Jobs directory. */
export const JOBS_PATH_NAMES = Object.freeze({ tasks: "tasks", completed: "completed", state: "state", runs: "runs", errors: "errors", lastRun: "last-run.json" });

/**
 * Build the active and disabled Jobs paths beneath a project root.
 *
 * @param {string} projectRoot - Non-empty absolute project-root path; no default.
 * @returns {Readonly<{root: string, disabled: string, tasks: string, completed: string, state: string, runs: string, errors: string, lastRun: string}>} Frozen paths for the Jobs directories and last-run file.
 * @throws {JobsError} If `projectRoot` is not a non-empty absolute string.
 */
export function jobsPaths(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot || !isAbsolute(projectRoot)) throw new JobsError("JOBS_PROJECT_ROOT_TYPE", "project root must be a non-empty absolute path");
  const root = resolve(projectRoot, JOBS_DATA_DIRECTORY);
  return Object.freeze({
    root,
    disabled: resolve(projectRoot, JOBS_DISABLED_DIRECTORY),
    tasks: resolve(root, "tasks"),
    completed: resolve(root, "completed"),
    state: resolve(root, "state"),
    runs: resolve(root, "runs"),
    errors: resolve(root, "errors"),
    lastRun: resolve(root, "last-run.json"),
  });
}
