import { isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { JobsError } from "./errors-base.js";

/** Canonical paths are process-local inputs, never Jobs data. */
export async function canonicalProjectRoot(projectRoot, io = { realpath, stat }) {
  if (typeof projectRoot !== "string" || !projectRoot || !isAbsolute(projectRoot)) throw new JobsError("JOBS_PROJECT_ROOT_TYPE", "project root must be a non-empty absolute path");
  try {
    const root = await io.realpath(projectRoot);
    if (!(await io.stat(root)).isDirectory()) throw new Error("not directory");
    return root;
  } catch { throw new JobsError("JOBS_PROJECT_ROOT_CANONICAL", "project root cannot be canonicalized as a directory"); }
}
export function publicJobsResult(value) {
  if (!value || typeof value !== "object") return value;
  const { projectRoot, paths, root, ...safe } = value;
  return safe;
}
