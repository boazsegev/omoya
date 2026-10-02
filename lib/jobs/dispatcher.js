import * as fs from "node:fs/promises";
import { join } from "node:path";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { validateJobsOperational } from "./operations.js";
import { parseTask, parseTasks } from "./tasks.js";
import { errorsLog, localStamp, messageLocal } from "./errors.js";
import { readTaskFile } from "./task-file.js";
import { admitOccurrence, loadAllTaskStates, loadTaskState, newAttemptId, recordAttempt, reconcileAttempt, finalizeAttempt, resolveArchiveReference, saveTaskState } from "./state.js";
import { archiveExists, allocateArchive, snapshotAndArchive } from "./archive.js";
import { runJobAgent } from "./agent-execution.js";
import Env from "../env.js";
import CLI from "../cli.js";

const RUN_LIMIT = 64;
/** Throw a JobsError with the supplied code and message.
 * @param {string} code Error code.
 * @param {string} message Human-readable error message.
 * @returns {never} Never returns; always throws.
 */
const fail = (code, message) => { throw new JobsError(code, message); };
/** Convert a cycle timestamp to the local archive date.
 * @param {number|string|Date} now Timestamp accepted by Date.
 * @returns {string} Local date string.
 * @throws {JobsError} Throws JOBS_CLOCK when `now` is not a valid date.
 */
function localArchiveDate(now) { if (!Number.isFinite(new Date(now).getTime())) fail("JOBS_CLOCK", "cycle time must be a valid date"); return localStamp(now).date; }
/** Normalize an arbitrary error to a dispatch error record.
 * @param {*} error Error-like value.
 * @returns {{code: string, message: string}} Code and string message, with dispatch defaults.
 */
function errorOf(error) { return { code: error?.code ?? "JOBS_DISPATCH_ERROR", message: String(error?.message ?? error) }; }
/** Atomically serialize a value to a file using the supplied filesystem adapter.
 * @param {string} path Destination path.
 * @param {*} value JSON-serializable value to write.
 * @param {object} io Filesystem adapter providing open, rename, and unlink.
 * @returns {Promise<void>} Resolves after rename; closes and removes the temporary file on cleanup.
 * @throws Rejects if writing, syncing, closing, or renaming fails.
 */
async function atomic(path, value, io) { const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`; let handle; try { handle = await io.open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = undefined; await io.rename(temporary, path); } finally { try { await handle?.close(); } catch {} try { await io.unlink(temporary); } catch {} } }
/** Read and return task Markdown sources in filename order.
 * @param {string} root Project root.
 * @param {object} io Filesystem adapter providing readdir.
 * @returns {Promise<{filename: string, source: string}[]>} Task files and their contents.
 * @throws Rejects on directory enumeration or task-file read failures.
 */
async function taskEntries(root, io) { const directory = jobsPaths(root).tasks; const names = await io.readdir(directory); return Promise.all(names.filter((name) => name.endsWith(".md")).sort().map(async (filename) => ({ filename, source: await readTaskFile(join(directory, filename)) }))); }
/** Load current tasks and append previously unreported parse diagnostics.
 * @param {string} root Project root.
 * @param {object} io Filesystem adapter.
 * @param {{errors: object[]}} result Scan record whose errors may be updated.
 * @returns {Promise<object[]>} Parsed tasks.
 * @throws Rejects on task enumeration or reading failures.
 */
async function currentTasks(root, io, result) { const loaded = parseTasks(await taskEntries(root, io)); for (const diagnostic of loaded.diagnostics) if (!result.errors.some((item) => item.code === diagnostic.code && item.filename === diagnostic.filename)) result.errors.push(diagnostic); return loaded.tasks; }
/** Reconcile every prepared attempt against its archive and persist changed states.
 * @param {string} root Project root.
 * @param {object} io Filesystem adapter.
 * @returns {Promise<void>} Resolves after recovery and any required state saves.
 * @throws Rejects if state/archive access or persistence fails.
 */
async function recover(root, io) { for (let state of await loadAllTaskStates(root, io)) { let changed = false; for (const occurrence of state.occurrences) for (const attempt of occurrence.attempts.filter((item) => item.outcome === "prepared")) { state = reconcileAttempt(state, occurrence.id, attempt.id, await archiveExists(resolveArchiveReference(root, attempt.archive), io)); changed = true; } if (changed) await saveTaskState(root, state, io); } }
/** Create the location-neutral run-log record for one Jobs scan (ai-jobs/last-run.json, runs/).
 * @param {number} at Non-negative safe-integer cycle timestamp in milliseconds.
 * @returns {{version: number, at: number, due: object[], running: object[], outcomes: object[], errors: object[], warnings: object[]}} Empty scan record.
 * @throws {JobsError} Throws JOBS_CLOCK if `at` is not a non-negative safe integer.
 */
export function cycleRecord(at) { if (!Number.isSafeInteger(at) || at < 0) fail("JOBS_CLOCK", "cycle time must be a non-negative safe integer"); return { version: 1, at, due: [], running: [], outcomes: [], errors: [], warnings: [] }; }
/** Save the latest scan record, append its run history, and prune history to RUN_LIMIT.
 * @param {object} paths Jobs paths containing lastRun and runs.
 * @param {object} value Scan record to persist.
 * @param {object} io Filesystem adapter.
 * @returns {Promise<void>} Resolves when saves and pruning complete.
 * @throws Rejects on write, listing, or deletion failures.
 */
async function saveDiagnostic(paths, value, io) { await atomic(paths.lastRun, value, io); const name = `${String(value.at).padStart(16, "0")}-${crypto.randomUUID()}.json`; await atomic(join(paths.runs, name), value, io); const names = (await io.readdir(paths.runs)).filter((name) => name.endsWith(".json")).sort(); await Promise.all(names.slice(0, Math.max(0, names.length - RUN_LIMIT)).map((name) => io.unlink(join(paths.runs, name)))); }
/** Admit due occurrences for enabled tasks and sort them by schedule then task id.
 * @param {string} root Project root.
 * @param {object[]} tasks Parsed task definitions.
 * @param {number} now Current epoch time in milliseconds.
 * @param {object} io Filesystem adapter.
 * @returns {Promise<{task: object, occurrence: object}[]>} Due task occurrences.
 * @throws Rejects on state loading or persistence failures.
 */
async function admit(root, tasks, now, io) { const candidates = []; for (const task of tasks) { const admitted = admitOccurrence(await loadTaskState(root, task, io), task, now); if (admitted.changed) await saveTaskState(root, admitted.state, io); const due = admitted.due ?? (task.enabled ? admitted.state.occurrences.findLast((item) => item.status === "due" && item.scheduledAt <= now) : null); if (due) candidates.push({ task, occurrence: due }); } return candidates.sort((a, b) => a.occurrence.scheduledAt - b.occurrence.scheduledAt || a.task.id.localeCompare(b.task.id)); }
/** Snapshot a due task, run its executor, and record the terminal attempt outcome.
 * @param {string} root Project root.
 * @param {object} task Current parsed task.
 * @param {object} occurrence Due task occurrence.
 * @param {{io: object, now: number, executor: Function}} options Execution options with filesystem, clock value, and executor.
 * @param {object} result Mutable scan record; receives warnings, errors, and outcomes.
 * @returns {Promise<void>} Resolves after attempting execution and finalization; operational failures are recorded in `result`.
 */
async function execute(root, task, occurrence, options, result) {
  const { io, now, executor } = options, paths = jobsPaths(root); let state = await loadTaskState(root, task, io);
  const archive = task.schedule.kind === "once" ? await allocateArchive(root, localArchiveDate(now), task.filename, io) : join(paths.runs, `${crypto.randomUUID()}.snapshot`);
  const archiveReference = archive.slice(`${paths.root}/`.length);
  const attemptId = newAttemptId(occurrence); state = recordAttempt(state, occurrence.id, { id: attemptId, archive: archiveReference }); await saveTaskState(root, state, io);
  let outcome = "failed", session = null, confirmed = false;
  try { const prompt = task.schedule.kind === "once" ? parseTask(task.filename, await snapshotAndArchive(join(paths.tasks, task.filename), archive, io)).prompt : task.prompt; if (task.schedule.kind !== "once") await atomic(archive, { prompt }, io); confirmed = true; const terminal = await executor({ ...task, prompt, occurrence, attemptId }); session = terminal?.session ?? null; outcome = terminal?.outcome ?? (terminal?.error || terminal?.ok === false ? "failed" : "completed"); if (!['completed','failed','blocked','cancelled','timed-out'].includes(outcome)) outcome = "failed"; if (terminal?.warning && terminal.warning.code !== terminal.code) result.warnings.push({ id: task.id, filename: task.filename, code: terminal.warning.code, message: terminal.warning.message, outcome, ...(session ? { session } : {}) }); if (outcome !== "completed") result.errors.push({ id: task.id, filename: task.filename, code: terminal?.code ?? "JOBS_EXECUTOR_FAILED", message: terminal?.message ?? `the job ended ${outcome}`, outcome, ...(session ? { session } : {}) }); } catch (error) { result.errors.push({ id: task.id, filename: task.filename, ...errorOf(error), outcome }); }
  try { state = finalizeAttempt(state, occurrence.id, attemptId, outcome, confirmed, session); await saveTaskState(root, state, io); result.outcomes.push({ id: task.id, outcome }); }
  catch (error) { result.errors.push({ id: task.id, filename: task.filename, code: "JOBS_FINALIZE_UNAVAILABLE", message: `the attempt could not be recorded as ${outcome}: ${error?.message ?? error}` }); }
}
/** Revalidate and execute due candidates in order, recording blocked or stale outcomes.
 * @param {string} root Project root.
 * @param {{task: object, occurrence: object}[]} candidates Admitted candidates.
 * @param {{io: object, executor: Function, execution?: object}} options Execution and filesystem options.
 * @param {object} result Mutable scan record updated with outcomes and errors.
 * @returns {Promise<void>} Resolves after candidate processing or an aborted signal.
 * @throws Rejects if candidate revalidation or state access fails.
 */
async function runCandidates(root, candidates, options, result) { for (const candidate of candidates) { if (options.execution?.signal?.aborted) break; const latest = await currentTasks(root, options.io, result); const task = latest.find((item) => item.id === candidate.task.id); if (!task || !task.enabled || JSON.stringify(task) !== JSON.stringify(candidate.task)) { result.outcomes.push({ id: candidate.task.id, outcome: "blocked" }); continue; } const state = await loadTaskState(root, task, options.io); const occurrence = state.occurrences.find((item) => item.id === candidate.occurrence.id); if (!occurrence || occurrence.status !== "due") { result.outcomes.push({ id: task.id, outcome: "stale" }); continue; } await execute(root, task, occurrence, options, result); } }
/** Best-effort serial scan. Concurrent scans may duplicate execution or lose state updates.
 * Problems and warnings are appended to the readable error log (ai-jobs/errors/YYYY-MM-DD.md);
 * the scan record (due, outcomes, errors, warnings) is kept in ai-jobs/last-run.json and runs/.
 * No error names anything outside the project (messageLocal).
 * @param {string} projectRoot Project root to validate and scan.
 * @param {object} [options={}] Optional adapters and execution configuration: `io` filesystem; `clock` returning epoch milliseconds; `validate` validator; `executor` custom job runner; `execution` agent/environment options.
 * @returns {Promise<{outcomes: {id: string, outcome: string}[], errors: object[], warnings: object[], log?: string}>} Scan outcomes, errors and warnings (warnings do not fail the scan), and optional project-relative error-log path.
 * @throws {JobsError} Throws JOBS_CLOCK if the clock does not return a non-negative safe integer.
 * @throws Rejects if operational validation fails. Scan/recovery failures are generally included in returned errors; log and diagnostic persistence failures are also reported there. Closes a created shared environment after the scan.
 */
export async function dispatchJobs(projectRoot, options = {}) {
  const io = options.io ?? fs, now = (options.clock ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0) fail("JOBS_CLOCK", "jobs clock must return a non-negative safe integer");
  const initial = await (options.validate ?? validateJobsOperational)(projectRoot); const root = initial.projectRoot, paths = jobsPaths(root), result = cycleRecord(now); let sharedEnv;
  const executor = options.executor ?? (async (task) => { sharedEnv ??= await (options.execution?.createEnv ?? Env.create)({ ...(options.execution?.environment ?? {}), cwd: root }); return runJobAgent(task, { env: sharedEnv, projectRoot: root, defaultModel: options.execution?.model, signal: options.execution?.signal, defaultTimeout: options.execution?.timeout, ...(options.execution?.createAgent ? { createAgent: options.execution.createAgent } : {}), ...(options.execution?.selectModel ? { selectModel: options.execution.selectModel } : {}), ...(options.execution?.effectiveTimeout ? { effectiveTimeout: options.execution.effectiveTimeout } : {}), ...(options.execution?.onError ? { onError: options.execution.onError } : {}), ...(options.execution?.onReady ? { onReady: options.execution.onReady } : {}) }); });
  try { await recover(root, io); const candidates = await admit(root, await currentTasks(root, io, result), now, io); result.due = candidates.map(({ task, occurrence }) => ({ id: task.id, scheduledAt: occurrence.scheduledAt })); await runCandidates(root, candidates, { ...options, executor, io, now }, result); } catch (error) { result.errors.push(errorOf(error)); }
  for (const list of [result.errors, result.warnings]) for (const [index, problem] of list.entries()) list[index] = { ...problem, message: messageLocal(root, problem.message) };
  try { await saveDiagnostic(paths, result, io); } catch (error) { result.errors.push({ ...errorOf(error), message: messageLocal(root, `the scan record could not be saved: ${error?.message ?? error}`) }); }
  let log; try { log = await errorsLog(root, [...result.errors, ...result.warnings.map((warning) => ({ ...warning, level: "warning" }))], now); } catch (error) { result.errors.push({ ...errorOf(error), message: messageLocal(root, `the error log could not be written: ${error?.message ?? error}`) }); }
  if (sharedEnv) (options.execution?.close ?? CLI.close)({ env: sharedEnv });
  return Object.freeze({ outcomes: result.outcomes, errors: result.errors, warnings: result.warnings, ...(log ? { log } : {}) });
}
