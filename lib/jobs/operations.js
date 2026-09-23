import { lstat, readdir, open, rename, link, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { validateJobsActivation } from "./lifecycle.js";
import { parseTask, parseTasks } from "./tasks.js";
import { reportTaskDiagnostic } from "./errors.js";
import { readTaskFile } from "./task-file.js";

function fail(code, message) { throw new JobsError(code, message); }

/** File selectors are leaf Markdown names, not task IDs or paths. IDs remain opaque parser values. */
export function taskFilename(value) {
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*\.md$/.test(value)) {
    fail("JOBS_TASK_FILENAME", "filename must be an ASCII leaf .md name, begin with a letter/digit, and be at most 120 characters");
  }
  return value;
}

/** Refuse missing/redirected durable directories; this query never repairs layout. */
export async function validateJobsLayout(root) {
  const paths = jobsPaths(root);
  for (const key of ["root", "tasks", "completed", "state", "runs", "errors"]) {
    let entry;
    try { entry = await lstat(paths[key]); } catch { fail("JOBS_LAYOUT", "jobs layout is missing or unreadable; run jobs init"); }
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail("JOBS_LAYOUT", "jobs directories must be real project directories, not symlinks");
  }
  return paths;
}

/** Operational eligibility is checked at publication and invocation from folder state. */
export async function validateJobsOperational(root, options = {}) {
  const activation = await validateJobsActivation(root, options.settings ?? {}, options);
  await validateJobsLayout(activation.projectRoot);
  if (options.folder !== undefined && await realpath(options.folder) !== activation.projectRoot) {
    fail("JOBS_PROJECT_FOLDER", "job-schedule requires the Agent folder to equal the project root");
  }
  return activation;
}

async function sourceAt(path) {
  return readTaskFile(path);
}

export { readTaskFile } from "./task-file.js";

/** Pure filesystem snapshot: no admission, error reporting, state writes, or symlink following. */
export async function readTaskEntries(root) {
  const directory = jobsPaths(root).tasks;
  const names = await readdir(directory, { withFileTypes: true });
  const entries = [], diagnostics = [];
  for (const entry of names.filter((item) => item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      if (!entry.isFile()) fail("JOBS_TASK_FILE", "task must be a regular file");
      entries.push({ filename: entry.name, source: await sourceAt(join(directory, entry.name)) });
    } catch (error) { diagnostics.push({ filename: entry.name, code: error.code ?? "JOBS_TASK_READ" }); }
  }
  return { entries, diagnostics };
}

async function atomicTask(path, source, action) {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(source, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    if (action === "create") await link(temporary, path); // atomic no-clobber publication
    else await rename(temporary, path);
  } finally { await handle?.close(); try { await unlink(temporary); } catch {} }
}

function validateCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) fail("JOBS_COMMAND", "a command object is required");
  const allowed = ["action", "filename", "source"];
  if (Object.keys(command).some((key) => !allowed.includes(key))) fail("JOBS_COMMAND", "unsupported command field");
  if (!["list", "read", "create", "update", "remove"].includes(command.action)) fail("JOBS_COMMAND", "action must be list, read, create, update, or remove");
  if (command.action !== "list") taskFilename(command.filename);
  if (["create", "update"].includes(command.action) && typeof command.source !== "string") fail("JOBS_TASK_SOURCE", "create/update requires complete Markdown source");
}

async function mutate(root, command) {
  const { action, filename, source } = command, path = join(jobsPaths(root).tasks, filename);
  if (action !== "create") await sourceAt(path); // never replace/follow a symlink
  if (action === "remove") { await unlink(path); return { filename, removed: true, cancelsRunning: false }; }
  const task = parseTask(filename, source);
  if (task.diagnostics.length) fail("JOBS_TASK_METADATA", "task metadata must validate before publication");
  const { entries } = await readTaskEntries(root);
  const parsed = parseTasks([...entries.filter((entry) => entry.filename !== filename), { filename, source }]);
  const selfDiagnostic = parsed.diagnostics.find((item) => item.filename === filename);
  if (selfDiagnostic?.code === "JOBS_TASK_DUPLICATE_ID") fail("JOBS_TASK_DUPLICATE_ID", "task id already exists");
  if (selfDiagnostic) fail(selfDiagnostic.code, "task must validate before publication");
  await atomicTask(path, source, action);
  return { task, waitsForNextScan: true };
}

/** Shared task command boundary. Throws actionable JobsError or filesystem errors; never runs tasks.
 * Create refuses existing files; update replaces whole source (last writer wins); remove does not cancel.
 * Calls validate the current folder before operating. Concurrent mutations are best effort:
 * atomic create refuses an existing file and updates may be last-writer-wins.
 */
export async function scheduleJobs(root, command, options = {}) {
  validateCommand(command);
  if (options.readOnly && !["list", "read"].includes(command.action)) fail("JOBS_READ_ONLY", "read-only callers cannot mutate jobs");
  const activation = await validateJobsOperational(root, options);
  root = activation.projectRoot;
  if (command.action === "read") {
    const source = await sourceAt(join(jobsPaths(root).tasks, command.filename));
    return { source, task: parseTask(command.filename, source) };
  }
  if (command.action === "list") {
    const { entries, diagnostics } = await readTaskEntries(root), parsed = parseTasks(entries);
    return { tasks: parsed.tasks, diagnostics: [...diagnostics, ...parsed.diagnostics] };
  }
  await validateJobsOperational(root, options);
  return mutate(root, command);
}
