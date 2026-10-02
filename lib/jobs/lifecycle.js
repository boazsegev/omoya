import * as fs from "node:fs/promises";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { canonicalProjectRoot } from "./project.js";

const LAYOUT = ["tasks", "completed", "state", "runs", "errors"];
/** Throw a JobsError with the supplied code and message.
 * @param {string} code Error code.
 * @param {string} message Human-readable error message.
 * @returns {never}
 * @throws {JobsError} Always.
 */
const fail = (code, message) => { throw new JobsError(code, message); };
/** Classify a filesystem path without following symbolic links.
 * @param {string} path Path to inspect.
 * @param {object} io Filesystem API providing `lstat`.
 * @returns {Promise<"symlink"|"directory"|"other"|"missing">} Entry kind; ENOENT maps to `missing`.
 * @throws {Error} Propagates filesystem errors other than ENOENT.
 */
async function kind(path, io) {
  try {
    const entry = await io.lstat(path);
    return entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}
/** Check the Jobs directory layout and optionally create missing child directories.
 * @param {object} paths Jobs paths, including `root` and each LAYOUT key.
 * @param {object} io Filesystem API providing `lstat` and, when creating, `mkdir`.
 * @param {boolean} [create=false] Create missing layout directories when true.
 * @returns {Promise<object>} The same paths object after validation.
 * @throws {JobsError} With code JOBS_LAYOUT when the root or any existing child is not a real directory.
 * @throws {Error} Propagates filesystem errors; creation can also fail if mkdir fails.
 */
async function assertLayout(paths, io, create = false) {
  if (await kind(paths.root, io) !== "directory") fail("JOBS_LAYOUT", "jobs root must be a real directory");
  for (const key of LAYOUT) {
    const state = await kind(paths[key], io);
    if (state === "missing" && create) await io.mkdir(paths[key]);
    else if (state !== "directory") fail("JOBS_LAYOUT", "jobs layout must contain real tasks, completed, state, runs, and errors directories");
  }
  return paths;
}

/** Ensure the standard active layout. Call only from explicit initialization.
 * @param {string} projectRoot Project root to canonicalize.
 * @param {object} [io=fs] Filesystem API used for inspection and directory creation.
 * @returns {Promise<object>} Resolved Jobs paths for the validated layout.
 * @throws {JobsError} With code JOBS_LAYOUT if the existing root or layout is invalid.
 * @throws {Error} Propagates canonicalization and filesystem errors.
 */
export async function ensureJobsLayout(projectRoot, io = fs) {
  const root = await canonicalProjectRoot(projectRoot, io);
  const paths = jobsPaths(root);
  if (await kind(paths.root, io) === "missing") await io.mkdir(paths.root);
  return assertLayout(paths, io, true);
}

/** Enable folder-only Jobs, restoring a disabled directory without changing bytes.
 * @param {string} projectRoot Project root to canonicalize.
 * @param {object} [settings={}] Reserved settings argument; currently unused.
 * @param {object} [options={}] Options object; may provide `fs` filesystem API.
 * @returns {Promise<{enabled: true}>} Frozen enabled status.
 * @throws {JobsError} JOBS_LAYOUT for non-directory roots/layout entries; JOBS_COLLISION when active and disabled roots both exist.
 * @throws {Error} Propagates canonicalization, filesystem inspection, rename, mkdir, and layout errors.
 */
export async function initializeJobs(projectRoot, settings = {}, options = {}) {
  const io = options.fs ?? fs;
  const root = await canonicalProjectRoot(projectRoot, io);
  const paths = jobsPaths(root);
  const active = await kind(paths.root, io);
  const disabled = await kind(paths.disabled, io);
  if (active !== "missing" && active !== "directory") fail("JOBS_LAYOUT", "jobs root must be a real directory");
  if (disabled !== "missing" && disabled !== "directory") fail("JOBS_LAYOUT", "disabled jobs root must be a real directory");
  if (active !== "missing" && disabled !== "missing") fail("JOBS_COLLISION", "both ai-jobs and ai-jobs-disabled exist; resolve the collision without merging");
  if (active === "missing" && disabled === "directory") await io.rename(paths.disabled, paths.root);
  if (active === "missing" && disabled === "missing") await io.mkdir(paths.root);
  await assertLayout(paths, io, true);
  return Object.freeze({ enabled: true });
}

/** Validate active folder state without writing or coordinating with other processes.
 * @param {string} projectRoot Project root to canonicalize.
 * @param {object} [settings={}] Reserved settings argument; currently unused.
 * @param {object} [options={}] Options object; may provide `fs` filesystem API.
 * @returns {Promise<{projectRoot: string, paths: object}>} Frozen canonical root and Jobs paths.
 * @throws {JobsError} JOBS_LAYOUT for malformed directories, JOBS_COLLISION for both roots, JOBS_DISABLED for disabled-only state, or JOBS_INACTIVE when uninitialized.
 * @throws {Error} Propagates canonicalization and filesystem errors.
 */
export async function validateJobsActivation(projectRoot, settings = {}, options = {}) {
  const io = options.fs ?? fs;
  const root = await canonicalProjectRoot(projectRoot, io);
  const paths = jobsPaths(root);
  const active = await kind(paths.root, io);
  const disabled = await kind(paths.disabled, io);
  if ((active !== "missing" && active !== "directory") || (disabled !== "missing" && disabled !== "directory")) fail("JOBS_LAYOUT", "jobs roots must be real directories");
  if (active !== "missing" && disabled !== "missing") fail("JOBS_COLLISION", "both ai-jobs and ai-jobs-disabled exist; resolve the collision without merging");
  if (active === "missing") fail(disabled === "directory" ? "JOBS_DISABLED" : "JOBS_INACTIVE", disabled === "directory" ? "jobs is disabled; run jobs init to restore" : "jobs is not initialized; run jobs init");
  await assertLayout(paths, io);
  return Object.freeze({ projectRoot: root, paths });
}

/** Disable by renaming the active directory. Concurrent work is best effort.
 * @param {string} projectRoot Project root to canonicalize.
 * @param {object} [options={}] Options object; may provide `fs` filesystem API.
 * @returns {Promise<{enabled: false, state?: "disabled"|"absent"}>} Frozen disabled status; state is included when the active root was missing.
 * @throws {JobsError} JOBS_LAYOUT for malformed roots/layout entries; JOBS_COLLISION when both roots exist.
 * @throws {Error} Propagates canonicalization, filesystem inspection, validation, and rename errors.
 */
export async function disableJobs(projectRoot, options = {}) {
  const io = options.fs ?? fs;
  const root = await canonicalProjectRoot(projectRoot, io);
  const paths = jobsPaths(root);
  const active = await kind(paths.root, io);
  const disabled = await kind(paths.disabled, io);
  if ((active !== "missing" && active !== "directory") || (disabled !== "missing" && disabled !== "directory")) fail("JOBS_LAYOUT", "jobs roots must be real directories");
  if (active !== "missing" && disabled !== "missing") fail("JOBS_COLLISION", "both ai-jobs and ai-jobs-disabled exist; resolve the collision without merging");
  if (active === "directory") {
    await assertLayout(paths, io);
    await io.rename(paths.root, paths.disabled);
  }
  return Object.freeze({ enabled: false, ...(active === "missing" ? { state: disabled === "directory" ? "disabled" : "absent" } : {}) });
}
