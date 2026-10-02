import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { JobsError } from "./errors-base.js";

/**
 * Resolve a project root to its canonical absolute directory path.
 *
 * @param {string} projectRoot - Non-empty absolute path to the project directory.
 * @param {{realpath: Function, stat: Function}} [io={ realpath, stat }] - Filesystem operations used to resolve and inspect the path.
 * @returns {Promise<string>} The canonical project directory path.
 * @throws {JobsError} With code `JOBS_PROJECT_ROOT_TYPE` when `projectRoot` is not a non-empty absolute string; otherwise with code `JOBS_PROJECT_ROOT_CANONICAL` if it cannot be resolved as a directory. Filesystem and directory-check failures are normalized to the latter error.
 * @effects Calls `io.realpath(projectRoot)` and `io.stat` on the resolved path.
 */
export async function canonicalProjectRoot(projectRoot, io = { realpath, stat }) {
  if (typeof projectRoot !== "string" || !projectRoot || !isAbsolute(projectRoot)) throw new JobsError("JOBS_PROJECT_ROOT_TYPE", "project root must be a non-empty absolute path");
  try {
    const root = await io.realpath(projectRoot);
    if (!(await io.stat(root)).isDirectory()) throw new Error("not directory");
    return root;
  } catch { throw new JobsError("JOBS_PROJECT_ROOT_CANONICAL", "project root cannot be canonicalized as a directory"); }
}
/**
 * Remove internal project path fields from a Jobs result before exposing it publicly.
 *
 * @param {*} value - Result value to sanitize.
 * @returns {*} The original value unchanged when it is falsy or not an object; otherwise a shallow copy without `projectRoot`, `paths`, or `root`.
 */
export function publicJobsResult(value) {
  if (!value || typeof value !== "object") return value;
  const { projectRoot, paths, root, ...safe } = value;
  return safe;
}
