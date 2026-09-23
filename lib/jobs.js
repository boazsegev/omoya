/**
 * Portable, folder-only project Jobs. ai-jobs enables, ai-jobs-disabled disables.
 * Operations are best effort: there are no locks, daemon identity records, or
 * cross-process coordination. Concurrent scans/mutations may duplicate work,
 * lose updates, or race archives. Atomic single-file replacement remains used.
 */
import { taskFilename, validateJobsLayout, validateJobsOperational, readTaskEntries, scheduleJobs } from "./jobs/operations.js";
import { jobsStatus } from "./jobs/status.js";
import { normalizeDays } from "./jobs/days.js";
import { JobsError } from "./jobs/errors-base.js";
import { JOBS_DATA_DIRECTORY, JOBS_DISABLED_DIRECTORY, JOBS_PATH_NAMES, jobsPaths } from "./jobs/paths.js";
import { canonicalProjectRoot } from "./jobs/project.js";
import { parseTask, parseTasks, taskId, taskStateKey } from "./jobs/tasks.js";
import { loadTasks, reportTaskDiagnostic, taskDiagnosticKey } from "./jobs/errors.js";
import { JOBS_STATE_VERSION, createTaskState, statePath, validateTaskState, validateArchiveReference, resolveArchiveReference, loadTaskState, saveTaskState, admitOccurrence, recordAttempt, reconcileAttempt, finalizeAttempt, loadAllTaskStates, newAttemptId } from "./jobs/state.js";
import { allocateArchive, moveToArchive, snapshotAndArchive, archiveExists } from "./jobs/archive.js";
import { ensureJobsLayout, initializeJobs, validateJobsActivation, disableJobs } from "./jobs/lifecycle.js";
import { runJobAgent } from "./jobs/agent-execution.js";
import { cycleRecord, dispatchJobs } from "./jobs/dispatcher.js";
import { foregroundJobsDaemon } from "./jobs/daemon.js";

export { taskFilename, validateJobsLayout, validateJobsOperational, readTaskEntries, scheduleJobs, jobsStatus, normalizeDays, JobsError, JOBS_DATA_DIRECTORY, JOBS_DISABLED_DIRECTORY, JOBS_PATH_NAMES, jobsPaths, canonicalProjectRoot, parseTask, parseTasks, taskId, taskStateKey, loadTasks, reportTaskDiagnostic, taskDiagnosticKey, JOBS_STATE_VERSION, createTaskState, statePath, validateTaskState, validateArchiveReference, resolveArchiveReference, loadTaskState, saveTaskState, admitOccurrence, recordAttempt, reconcileAttempt, finalizeAttempt, loadAllTaskStates, newAttemptId, allocateArchive, moveToArchive, snapshotAndArchive, archiveExists, ensureJobsLayout, initializeJobs, validateJobsActivation, disableJobs, cycleRecord, dispatchJobs, runJobAgent, foregroundJobsDaemon };

/** Frozen static namespace for folder-only Jobs operations. */
export class Jobs {}
Object.assign(Jobs, { taskFilename, validateJobsLayout, validateJobsOperational, readTaskEntries, scheduleJobs, jobsStatus, normalizeDays, JobsError, JOBS_DATA_DIRECTORY, JOBS_DISABLED_DIRECTORY, JOBS_PATH_NAMES, jobsPaths, canonicalProjectRoot, parseTask, parseTasks, taskId, taskStateKey, loadTasks, reportTaskDiagnostic, taskDiagnosticKey, JOBS_STATE_VERSION, createTaskState, statePath, validateTaskState, validateArchiveReference, resolveArchiveReference, loadTaskState, saveTaskState, admitOccurrence, recordAttempt, reconcileAttempt, finalizeAttempt, loadAllTaskStates, newAttemptId, allocateArchive, moveToArchive, snapshotAndArchive, archiveExists, ensureJobsLayout, initializeJobs, validateJobsActivation, disableJobs, cycleRecord, dispatchJobs, runJobAgent, foregroundJobsDaemon });
Object.freeze(Jobs);
export default Jobs;
