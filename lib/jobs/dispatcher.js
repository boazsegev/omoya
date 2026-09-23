import * as fs from "node:fs/promises";
import { join } from "node:path";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { validateJobsOperational } from "./operations.js";
import { parseTask } from "./tasks.js";
import { loadTasks } from "./errors.js";
import { readTaskFile } from "./task-file.js";
import { admitOccurrence, loadAllTaskStates, loadTaskState, newAttemptId, recordAttempt, reconcileAttempt, finalizeAttempt, resolveArchiveReference, saveTaskState } from "./state.js";
import { archiveExists, allocateArchive, snapshotAndArchive } from "./archive.js";
import { runJobAgent } from "./agent-execution.js";
import Env from "../env.js";
import CLI from "../cli.js";

const RUN_LIMIT = 64;
const fail = (code, message) => { throw new JobsError(code, message); };
function localArchiveDate(now) { const date = new Date(now); if (!Number.isFinite(date.getTime())) fail("JOBS_CLOCK", "cycle time must be a valid date"); return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function errorOf(error) { return { code: error?.code ?? "JOBS_DISPATCH_ERROR", message: "jobs operation could not be completed" }; }
async function atomic(path, value, io) { const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`; let handle; try { handle = await io.open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = undefined; await io.rename(temporary, path); } finally { try { await handle?.close(); } catch {} try { await io.unlink(temporary); } catch {} } }
async function taskEntries(root, io) { const directory = jobsPaths(root).tasks; const names = await io.readdir(directory); return Promise.all(names.filter((name) => name.endsWith(".md")).sort().map(async (filename) => ({ filename, source: await readTaskFile(join(directory, filename)) }))); }
async function currentTasks(root, io, result) { const loaded = await loadTasks(root, await taskEntries(root, io), io); for (const diagnostic of loaded.diagnostics) if (!result.errors.some((item) => item.code === diagnostic.code && item.filename === diagnostic.filename)) result.errors.push(diagnostic); return loaded.tasks; }
async function recover(root, io) { for (let state of await loadAllTaskStates(root, io)) { let changed = false; for (const occurrence of state.occurrences) for (const attempt of occurrence.attempts.filter((item) => item.outcome === "prepared")) { state = reconcileAttempt(state, occurrence.id, attempt.id, await archiveExists(resolveArchiveReference(root, attempt.archive), io)); changed = true; } if (changed) await saveTaskState(root, state, io); } }
/** Create the location-neutral public result record for one Jobs scan. */
export function cycleRecord(at) { if (!Number.isSafeInteger(at) || at < 0) fail("JOBS_CLOCK", "cycle time must be a non-negative safe integer"); return { version: 1, at, due: [], running: [], outcomes: [], errors: [] }; }
async function saveDiagnostic(paths, value, io) { await atomic(paths.lastRun, value, io); const name = `${String(value.at).padStart(16, "0")}-${crypto.randomUUID()}.json`; await atomic(join(paths.runs, name), value, io); const names = (await io.readdir(paths.runs)).filter((name) => name.endsWith(".json")).sort(); await Promise.all(names.slice(0, Math.max(0, names.length - RUN_LIMIT)).map((name) => io.unlink(join(paths.runs, name)))); }
async function admit(root, tasks, now, io) { const candidates = []; for (const task of tasks) { const admitted = admitOccurrence(await loadTaskState(root, task, io), task, now); if (admitted.changed) await saveTaskState(root, admitted.state, io); const due = admitted.due ?? (task.enabled ? admitted.state.occurrences.findLast((item) => item.status === "due" && item.scheduledAt <= now) : null); if (due) candidates.push({ task, occurrence: due }); } return candidates.sort((a, b) => a.occurrence.scheduledAt - b.occurrence.scheduledAt || a.task.id.localeCompare(b.task.id)); }
async function execute(root, task, occurrence, options, result) {
  const { io, now, executor } = options, paths = jobsPaths(root); let state = await loadTaskState(root, task, io);
  const archive = task.schedule.kind === "once" ? await allocateArchive(root, localArchiveDate(now), task.filename, io) : join(paths.runs, `${crypto.randomUUID()}.snapshot`);
  const archiveReference = archive.slice(`${paths.root}/`.length);
  const attemptId = newAttemptId(occurrence); state = recordAttempt(state, occurrence.id, { id: attemptId, archive: archiveReference }); await saveTaskState(root, state, io);
  let outcome = "failed", session = null, confirmed = false;
  try { const prompt = task.schedule.kind === "once" ? parseTask(task.filename, await snapshotAndArchive(join(paths.tasks, task.filename), archive, io)).prompt : task.prompt; if (task.schedule.kind !== "once") await atomic(archive, { prompt }, io); confirmed = true; const terminal = await executor({ ...task, prompt, occurrence, attemptId }); session = terminal?.session ?? null; outcome = terminal?.outcome ?? (terminal?.error || terminal?.ok === false ? "failed" : "completed"); if (!['completed','failed','blocked','cancelled','timed-out'].includes(outcome)) outcome = "failed"; if (outcome !== "completed") result.errors.push({ id: task.id, code: terminal?.code ?? "JOBS_EXECUTOR_FAILED", message: "jobs executor reported failure" }); } catch (error) { result.errors.push({ id: task.id, ...errorOf(error) }); }
  try { state = finalizeAttempt(state, occurrence.id, attemptId, outcome, confirmed, session); await saveTaskState(root, state, io); result.outcomes.push({ id: task.id, outcome }); }
  catch (error) { result.errors.push({ id: task.id, code: "JOBS_FINALIZE_UNAVAILABLE", message: "attempt finalization is unavailable" }); }
}
async function runCandidates(root, candidates, options, result) { for (const candidate of candidates) { if (options.execution?.signal?.aborted) break; const latest = await currentTasks(root, options.io, result); const task = latest.find((item) => item.id === candidate.task.id); if (!task || !task.enabled || JSON.stringify(task) !== JSON.stringify(candidate.task)) { result.outcomes.push({ id: candidate.task.id, outcome: "blocked" }); continue; } const state = await loadTaskState(root, task, options.io); const occurrence = state.occurrences.find((item) => item.id === candidate.occurrence.id); if (!occurrence || occurrence.status !== "due") { result.outcomes.push({ id: task.id, outcome: "stale" }); continue; } await execute(root, task, occurrence, options, result); } }
/** Best-effort serial scan. Concurrent scans may duplicate execution or lose state updates. */
export async function dispatchJobs(projectRoot, options = {}) {
  const io = options.io ?? fs, now = (options.clock ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0) fail("JOBS_CLOCK", "jobs clock must return a non-negative safe integer");
  const initial = await (options.validate ?? validateJobsOperational)(projectRoot); const root = initial.projectRoot, paths = jobsPaths(root), result = cycleRecord(now); let sharedEnv;
  const executor = options.executor ?? (async (task) => { sharedEnv ??= await (options.execution?.createEnv ?? Env.create)({ ...(options.execution?.environment ?? {}), cwd: root }); return runJobAgent(task, { env: sharedEnv, projectRoot: root, defaultModel: options.execution?.model, signal: options.execution?.signal, defaultTimeout: options.execution?.timeout, ...(options.execution?.createAgent ? { createAgent: options.execution.createAgent } : {}), ...(options.execution?.selectModel ? { selectModel: options.execution.selectModel } : {}), ...(options.execution?.effectiveTimeout ? { effectiveTimeout: options.execution.effectiveTimeout } : {}), ...(options.execution?.onError ? { onError: options.execution.onError } : {}), ...(options.execution?.onReady ? { onReady: options.execution.onReady } : {}) }); });
  try { await recover(root, io); const candidates = await admit(root, await currentTasks(root, io, result), now, io); result.due = candidates.map(({ task, occurrence }) => ({ id: task.id, scheduledAt: occurrence.scheduledAt })); await runCandidates(root, candidates, { ...options, executor, io, now }, result); } catch (error) { result.errors.push(errorOf(error)); }
  try { await saveDiagnostic(paths, result, io); } catch (error) { result.errors.push(errorOf(error)); }
  if (sharedEnv) (options.execution?.close ?? CLI.close)({ env: sharedEnv }); return Object.freeze(result);
}
