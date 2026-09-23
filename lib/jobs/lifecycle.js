import * as fs from "node:fs/promises";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { canonicalProjectRoot } from "./project.js";

const LAYOUT = ["tasks", "completed", "state", "runs", "errors"];
const fail = (code, message) => { throw new JobsError(code, message); };
async function kind(path, io) {
  try {
    const entry = await io.lstat(path);
    return entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}
async function assertLayout(paths, io, create = false) {
  if (await kind(paths.root, io) !== "directory") fail("JOBS_LAYOUT", "jobs root must be a real directory");
  for (const key of LAYOUT) {
    const state = await kind(paths[key], io);
    if (state === "missing" && create) await io.mkdir(paths[key]);
    else if (state !== "directory") fail("JOBS_LAYOUT", "jobs layout must contain real tasks, completed, state, runs, and errors directories");
  }
  return paths;
}

/** Ensure the standard active layout. Call only from explicit initialization. */
export async function ensureJobsLayout(projectRoot, io = fs) {
  const root = await canonicalProjectRoot(projectRoot, io);
  const paths = jobsPaths(root);
  if (await kind(paths.root, io) === "missing") await io.mkdir(paths.root);
  return assertLayout(paths, io, true);
}

/** Enable folder-only Jobs, restoring a disabled directory without changing bytes. */
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

/** Validate active folder state without writing or coordinating with other processes. */
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

/** Disable by renaming the active directory. Concurrent work is best effort. */
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
