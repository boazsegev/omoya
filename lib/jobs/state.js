import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { JobsError } from "./errors-base.js";
import { jobsPaths } from "./paths.js";
import { taskStateKey } from "./tasks.js";
import { calendarDayStart, calendarOccurrences, nextCalendarOccurrence, checkOccurrenceCount, scheduleAllowsDay } from "./calendar.js";

/** Persisted occurrence schema version; unsupported versions are refused. */
export const JOBS_STATE_VERSION = 2;
const MAX_DATE = 8_640_000_000_000_000;
const fs = { mkdir, open, readFile, readdir, rename, unlink };
const OCCURRENCE_STATUSES = new Set(["due", "coalesced", "attempted", "consumed"]);
const ATTEMPT_OUTCOMES = new Set(["prepared", "interrupted", "archive-unconfirmed", "completed", "failed", "blocked", "cancelled", "timed-out"]);
function fail(code, message, details = {}) { throw new JobsError(code, message, details); }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("JOBS_STATE_SHAPE", `${name} must be an object`); return value; }
function exactKeys(value, name, keys) { object(value, name); if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail("JOBS_STATE_SHAPE", `${name} has unsupported fields`); }
function text(value, name) { if (typeof value !== "string" || !value) fail("JOBS_STATE_SHAPE", `${name} must be a non-empty string`); return value; }
function timestamp(value, name) { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE) fail("JOBS_STATE_SHAPE", `${name} must be a non-negative valid epoch`); return value; }
function period(value) { if (!Number.isSafeInteger(value) || value <= 0) fail("JOBS_STATE_SHAPE", "schedule.milliseconds must be a positive safe integer"); return value; }
/** A durable archive location is portable project-local data, never a host path. */
export function validateArchiveReference(value) {
  const reference = text(value, "attempt.archive");
  if (reference.includes("\\") || reference.startsWith("/") || /^[A-Za-z]:/.test(reference)) fail("JOBS_STATE_SHAPE", "attempt.archive must be a relative completed/ or runs/ reference");
  const parts = reference.split("/");
  if (parts.length !== 2 || !["completed", "runs"].includes(parts[0]) || !parts[1] || parts.some((part) => part === "." || part === "..")) fail("JOBS_STATE_SHAPE", "attempt.archive must be inside completed/ or runs/");
  return reference;
}
/** Resolve only a previously validated relative reference against this active Jobs root. */
export function resolveArchiveReference(projectRoot, reference) {
  const valid = validateArchiveReference(reference), paths = jobsPaths(projectRoot);
  return valid.startsWith("completed/") ? `${paths.completed}/${valid.slice("completed/".length)}` : `${paths.runs}/${valid.slice("runs/".length)}`;
}
function scheduleOf(task) {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || !task.id || !task.schedule || typeof task.schedule !== "object") fail("JOBS_STATE_TASK", "task must have an id and parsed schedule");
  const source = task.schedule;
  if (source.kind === "once") return { kind: "once" };
  if (source.kind === "at") return { kind: "at", minutes: sortedIntegers(source.minutes, 1439, "schedule.minutes"), ...calendarFields(source) };
  if (source.kind !== "every") fail("JOBS_STATE_TASK", "task schedule is invalid");
  const schedule = { kind: "every", milliseconds: period(source.milliseconds) };
  if (source.days !== undefined || source.timeZone !== undefined) Object.assign(schedule, calendarFields(source));
  if (schedule.timeZone && schedule.timeZone !== "local") fail("JOBS_STATE_SHAPE", "elapsed day filters must be local");
  return schedule;
}
function sortedIntegers(value, maximum, name) {
  if (!Array.isArray(value) || !value.length || value.some((entry, index) => !Number.isInteger(entry) || entry < 0 || entry > maximum || (index && value[index - 1] >= entry))) fail("JOBS_STATE_SHAPE", `${name} must be a sorted unique non-empty integer array`);
  return [...value];
}
function calendarFields(source) {
  if (!["local", "gmt"].includes(source.timeZone)) fail("JOBS_STATE_SHAPE", "schedule.timeZone must be local or gmt");
  return { days: sortedIntegers(source.days, 6, "schedule.days"), timeZone: source.timeZone };
}
function sameSchedule(left, right) { return JSON.stringify(scheduleOf({ id: "compare", schedule: left })) === JSON.stringify(scheduleOf({ id: "compare", schedule: right })); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function freeze(value) { return Object.freeze(value); }
function occurrenceAt(anchor, cursor, milliseconds) {
  const scheduledAt = anchor + cursor * milliseconds;
  return timestamp(scheduledAt, "recurrence scheduled time");
}

/** Create the durable, task-local occurrence ledger. */
export function createTaskState(task) {
  return freeze({ version: JOBS_STATE_VERSION, taskId: text(task?.id, "task.id"), schedule: scheduleOf(task), anchor: null, cursor: null, occurrences: [] });
}
/** Resolve a task ledger path through the domain-owned safe ID mapping. */
export function statePath(projectRoot, taskId) { return `${jobsPaths(projectRoot).state}/${taskStateKey(taskId)}.json`; }
/** Validate the complete persisted v2 schema before it is used for admission. */
export function validateTaskState(value, taskId) {
  exactKeys(value, "task state", ["version", "taskId", "schedule", "anchor", "cursor", "occurrences"]);
  if (value.version !== JOBS_STATE_VERSION) fail("JOBS_STATE_SHAPE", "task state version is unsupported");
  text(value.taskId, "taskId");
  if (taskId !== undefined && value.taskId !== taskId) fail("JOBS_STATE_TASK_MISMATCH", "task state belongs to another task");
  const schedule = scheduleOf({ id: value.taskId, schedule: value.schedule });
  exactKeys(value.schedule, "schedule", Object.keys(schedule));
  if (value.anchor !== null) timestamp(value.anchor, "anchor");
  if (value.cursor !== null) timestamp(value.cursor, "cursor");
  if (schedule.kind === "at") {
    if (value.cursor !== null && (value.anchor === null || value.cursor < value.anchor)) fail("JOBS_STATE_SHAPE", "calendar cursor requires an earlier anchor");
  } else if ((value.anchor === null) !== (value.cursor === null)) fail("JOBS_STATE_SHAPE", "anchor and cursor must be set together");
  if (schedule.kind === "once" && (value.anchor !== null || value.cursor !== null)) fail("JOBS_STATE_SHAPE", "one-shot state cannot have recurrence fields");
  if (schedule.kind === "every" && value.anchor !== null) occurrenceAt(value.anchor, value.cursor, schedule.milliseconds);
  if (!Array.isArray(value.occurrences)) fail("JOBS_STATE_SHAPE", "occurrences must be an array");
  const occurrenceIds = new Set(), attemptIds = new Set();
  for (const occurrence of value.occurrences) {
    exactKeys(occurrence, "occurrence", ["id", "scheduledAt", "status", "attempts"]);
    const id = text(occurrence.id, "occurrence.id"); const scheduledAt = timestamp(occurrence.scheduledAt, "occurrence.scheduledAt");
    if (id !== `${value.taskId}@${scheduledAt}` || occurrenceIds.has(id)) fail("JOBS_STATE_SHAPE", "occurrences must have unique canonical ids");
    occurrenceIds.add(id);
    if (!OCCURRENCE_STATUSES.has(occurrence.status) || !Array.isArray(occurrence.attempts)) fail("JOBS_STATE_SHAPE", "occurrence status or attempts is invalid");
    let prepared = false;
    for (const attempt of occurrence.attempts) {
      exactKeys(attempt, "attempt", ["id", "archive", "session", "outcome", "unconfirmed"]);
      const attemptId = text(attempt.id, "attempt.id"); validateArchiveReference(attempt.archive);
      if (attemptIds.has(attemptId)) fail("JOBS_STATE_SHAPE", "attempt ids must be unique");
      attemptIds.add(attemptId);
      if (attempt.session !== null) text(attempt.session, "attempt.session");
      if (!ATTEMPT_OUTCOMES.has(attempt.outcome) || typeof attempt.unconfirmed !== "boolean") fail("JOBS_STATE_SHAPE", "attempt outcome or confirmation is invalid");
      if ((attempt.outcome === "prepared" && !attempt.unconfirmed) || (attempt.outcome === "interrupted" && attempt.unconfirmed) || (attempt.outcome === "archive-unconfirmed" && !attempt.unconfirmed)) fail("JOBS_STATE_SHAPE", "attempt outcome conflicts with confirmation");
      prepared ||= attempt.outcome === "prepared";
    }
    if ((occurrence.status === "due" || occurrence.status === "coalesced") && occurrence.attempts.length) fail("JOBS_STATE_SHAPE", "unattempted occurrences cannot have attempts");
    if (occurrence.status === "attempted" && (!occurrence.attempts.length || !prepared)) fail("JOBS_STATE_SHAPE", "attempted occurrence needs a prepared attempt");
    if (occurrence.status === "consumed" && (!occurrence.attempts.length || prepared)) fail("JOBS_STATE_SHAPE", "consumed occurrence needs only reconciled attempts");
  }
  if (schedule.kind === "at" && value.cursor !== null && !value.occurrences.some((item) => item.scheduledAt === value.cursor)) fail("JOBS_STATE_SHAPE", "calendar cursor must reference an admitted occurrence");
  return freeze(clone(value));
}
/** Read and validate a ledger, or return a fresh state when absent; does not persist. */
export async function loadTaskState(projectRoot, task, io = fs) {
  const path = statePath(projectRoot, task.id);
  try { return validateTaskState(JSON.parse(await io.readFile(path, "utf8")), task.id); }
  catch (cause) { if (cause?.code === "ENOENT") return createTaskState(task); if (cause instanceof JobsError) throw cause; fail("JOBS_STATE_READ", "task state cannot be read", { path, cause }); }
}
/** Read all ledgers, including removed one-shots, for crash reconciliation. */
export async function loadAllTaskStates(projectRoot, io = fs) {
  const directory = jobsPaths(projectRoot).state;
  let names;
  try { names = await io.readdir(directory); } catch (cause) { if (cause?.code === "ENOENT") return []; throw cause; }
  return Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    try { return validateTaskState(JSON.parse(await io.readFile(`${directory}/${name}`, "utf8"))); }
    catch (cause) { if (cause instanceof JobsError) throw cause; fail("JOBS_STATE_READ", "task state cannot be read", { cause }); }
  }));
}
/** Atomic replace of one task ledger; callers own cross-file reconciliation. */
export async function saveTaskState(projectRoot, state, io = fs) {
  const valid = validateTaskState(state); const path = statePath(projectRoot, valid.taskId); const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`; let handle;
  try { handle = await io.open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(valid)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await io.rename(temporary, path); }
  catch (cause) { try { await handle?.close(); } catch {} try { await io.unlink(temporary); } catch {} fail("JOBS_STATE_WRITE", "task state cannot be atomically written", { path, cause }); }
  return path;
}
function occurrence(taskId, scheduledAt) { return { id: `${taskId}@${scheduledAt}`, scheduledAt, status: "due", attempts: [] }; }
function coalescePending(state) {
  for (const item of state.occurrences) if (item.status === "due") item.status = "coalesced";
}
function admissionResult(prior, next, due = null) {
  return freeze({ state: freeze(next), due: due ? freeze(clone(due)) : null, changed: JSON.stringify(prior) !== JSON.stringify(next) });
}
function admitEpochs(next, epochs, canExecute) {
  if (!epochs.length) return null;
  coalescePending(next);
  const known = new Set(next.occurrences.map((item) => item.id)); let due = null;
  for (const scheduledAt of epochs) {
    const item = occurrence(next.taskId, scheduledAt);
    if (known.has(item.id)) continue;
    item.status = "coalesced"; next.occurrences.push(item); known.add(item.id);
    if (canExecute && scheduleAllowsDay(next.schedule, scheduledAt)) due = item;
  }
  if (due) due.status = "due";
  return due;
}
function admitCalendar(next, now) {
  if (next.anchor === null) next.anchor = calendarDayStart(next.schedule, now);
  const from = next.cursor === null ? next.anchor : next.cursor + 1;
  const epochs = calendarOccurrences(next.schedule, from, now);
  if (epochs.length) next.cursor = epochs.at(-1);
  return admitEpochs(next, epochs, true);
}
function admitElapsed(next, now) {
  if (next.anchor === null) next.anchor = now;
  const ordinal = Math.floor((now - next.anchor) / next.schedule.milliseconds);
  if (!Number.isSafeInteger(ordinal)) fail("JOBS_STATE_SHAPE", "recurrence cursor is unsafe");
  if (ordinal < 0 || (next.cursor !== null && ordinal <= next.cursor)) return null;
  const first = next.cursor === null ? 0 : next.cursor + 1;
  checkOccurrenceCount(ordinal - first + 1);
  const epochs = Array.from({ length: ordinal - first + 1 }, (_, index) => occurrenceAt(next.anchor, first + index, next.schedule.milliseconds));
  next.cursor = ordinal;
  // Elapsed recurrence keeps its latest ordinal, never substitutes stale eligible work.
  return admitEpochs(next, epochs, scheduleAllowsDay(next.schedule, now) && scheduleAllowsDay(next.schedule, epochs.at(-1)));
}
/** Admit one execution per scan, coalescing earlier eligible and excluded history. */
export function admitOccurrence(state, task, now) {
  timestamp(now, "now"); const prior = validateTaskState(state, task.id), next = clone(prior), schedule = scheduleOf(task);
  if (!task.enabled) return admissionResult(prior, next);
  if (!sameSchedule(next.schedule, schedule)) { coalescePending(next); next.schedule = schedule; next.anchor = null; next.cursor = null; }
  if (schedule.kind === "once") {
    if (next.occurrences.length) return admissionResult(prior, next);
    const due = occurrence(task.id, now); next.occurrences.push(due); return admissionResult(prior, next, due);
  }
  if (schedule.kind === "every" && !scheduleAllowsDay(schedule, now)) coalescePending(next);
  const due = schedule.kind === "at" ? admitCalendar(next, now) : admitElapsed(next, now);
  return admissionResult(prior, next, due);
}
/**
 * Read-only schedule projection using the identical admission transition as the
 * dispatcher.  A current due occurrence wins; otherwise return the next
 * eligible instant without persisting or admitting it.
 */
export function projectOccurrence(state, task, now) {
  if (!task.enabled) return null;
  const admitted = admitOccurrence(state ?? createTaskState(task), task, now);
  const due = admitted.due ?? admitted.state.occurrences.findLast((item) => item.status === "due" && item.scheduledAt <= now);
  if (due) return due.scheduledAt;
  const schedule = admitted.state.schedule;
  if (schedule.kind === "once") return null;
  if (schedule.kind === "at") return nextCalendarOccurrence(schedule, Math.max(now, admitted.state.cursor ?? now));
  let ordinal = Math.max(0, (admitted.state.cursor ?? -1) + 1, Math.floor((now - admitted.state.anchor) / schedule.milliseconds) + 1);
  while (true) {
    const scheduledAt = occurrenceAt(admitted.state.anchor, ordinal++, schedule.milliseconds);
    if (scheduleAllowsDay(schedule, scheduledAt)) return scheduledAt;
  }
}
/** Persist a new attempt before any irreversible source move. */
export function recordAttempt(state, occurrenceId, attempt) {
  const next = clone(validateTaskState(state)); const occurrence = next.occurrences.find((item) => item.id === occurrenceId);
  if (!occurrence) fail("JOBS_OCCURRENCE_UNKNOWN", "occurrence is not in task state", { occurrenceId });
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt) || Object.keys(attempt).some((key) => !["id", "archive", "session"].includes(key))) fail("JOBS_ATTEMPT_SHAPE", "attempt has unsupported fields");
  try { text(attempt.id, "attempt.id"); validateArchiveReference(attempt.archive); if (attempt.session !== undefined && attempt.session !== null) text(attempt.session, "attempt.session"); } catch { fail("JOBS_ATTEMPT_SHAPE", "attempt needs id and a relative archive reference"); }
  if (next.occurrences.some((item) => item.attempts.some((entry) => entry.id === attempt.id))) fail("JOBS_ATTEMPT_DUPLICATE", "attempt id already exists");
  occurrence.attempts.push({ id: attempt.id, archive: attempt.archive, session: attempt.session ?? null, outcome: "prepared", unconfirmed: true }); occurrence.status = "attempted";
  return validateTaskState(next);
}
/** Reconciliation is visible: an interrupted archive is consumed, never due again. */
export function reconcileAttempt(state, occurrenceId, attemptId, archivePresent) {
  if (typeof archivePresent !== "boolean") fail("JOBS_ATTEMPT_SHAPE", "archive presence must be boolean");
  const next = clone(validateTaskState(state)); const occurrence = next.occurrences.find((item) => item.id === occurrenceId); const attempt = occurrence?.attempts.find((item) => item.id === attemptId);
  if (!attempt) fail("JOBS_ATTEMPT_UNKNOWN", "attempt is not in task state", { occurrenceId, attemptId });
  attempt.unconfirmed = !archivePresent; attempt.outcome = archivePresent ? "interrupted" : "archive-unconfirmed";
  occurrence.status = occurrence.attempts.some((item) => item.outcome === "prepared") ? "attempted" : "consumed";
  return validateTaskState(next);
}
/** Finalize the current attempt in the same dispatch cycle, without crash reconciliation. */
export function finalizeAttempt(state, occurrenceId, attemptId, outcome, archivePresent, session = null) {
  if (!["completed", "failed", "blocked", "cancelled", "timed-out"].includes(outcome) || typeof archivePresent !== "boolean") fail("JOBS_ATTEMPT_SHAPE", "final outcome and archive presence are required");
  const next = clone(validateTaskState(state));
  const occurrence = next.occurrences.find((item) => item.id === occurrenceId);
  const attempt = occurrence?.attempts.find((item) => item.id === attemptId);
  if (!attempt || attempt.outcome !== "prepared") fail("JOBS_ATTEMPT_UNKNOWN", "only a prepared attempt can be finalized");
  Object.assign(attempt, { outcome, unconfirmed: !archivePresent, session });
  occurrence.status = occurrence.attempts.some((item) => item.outcome === "prepared") ? "attempted" : "consumed";
  return validateTaskState(next);
}
/** Derive an occurrence-local attempt ID; callers persist it before archival. */
export function newAttemptId(occurrence, sequence = occurrence.attempts.length) { return `${occurrence.id}#${sequence}`; }
export { sameSchedule as sameTaskSchedule };
