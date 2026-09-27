/**
 * Portable, folder-only project Jobs. ai-jobs enables, ai-jobs-disabled disables.
 * Operations are best effort: there are no locks, daemon identity records, or
 * cross-process coordination. Concurrent scans/mutations may duplicate work,
 * lose updates, or race archives. Atomic single-file replacement remains used.
 *
 * PUBLIC MODULE (owner of lib/jobs/). The façade publishes the operations a
 * host or tool needs; task parsing, occurrence state, attempts, and archives
 * stay private to lib/jobs/.
 */
import { foregroundJobsDaemon } from "./jobs/daemon.js";
import { dispatchJobs } from "./jobs/dispatcher.js";
import { JobsError } from "./jobs/errors-base.js";
import { initializeJobs, disableJobs } from "./jobs/lifecycle.js";
import { scheduleJobs, validateJobsOperational } from "./jobs/operations.js";
import { jobsStatus } from "./jobs/status.js";

export { foregroundJobsDaemon as daemonRun } from "./jobs/daemon.js";
export { dispatchJobs as run } from "./jobs/dispatcher.js";
export { JobsError } from "./jobs/errors-base.js";
export { initializeJobs as init, disableJobs as disable } from "./jobs/lifecycle.js";
export { scheduleJobs as schedule, validateJobsOperational as validate } from "./jobs/operations.js";
export { jobsStatus as status } from "./jobs/status.js";

/** Frozen static namespace for folder-only Jobs operations. */
export class Jobs {}
Object.assign(Jobs, {
  daemonRun: foregroundJobsDaemon,
  disable: disableJobs,
  init: initializeJobs,
  JobsError,
  run: dispatchJobs,
  schedule: scheduleJobs,
  status: jobsStatus,
  validate: validateJobsOperational,
});
Object.freeze(Jobs);
export default Jobs;
