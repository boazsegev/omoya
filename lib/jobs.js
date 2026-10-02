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

/**
 * Run a foreground best-effort daemon bound to the project root.
 * @function daemonRun
 * @param {string} projectRoot Project root directory.
 * @param {object} [options={}] Daemon options; supports `signal`, `state`, `execution`, `scan`, and `delay`.
 * @returns {Promise<void>} Resolves when stopped or Jobs becomes unusable; rejects on initial validation or daemon errors.
 * @throws {JobsError} If the project is not operational when starting.
 */
export { foregroundJobsDaemon as daemonRun } from "./jobs/daemon.js";
/**
 * Dispatch one best-effort serial scan of due Jobs.
 * @function run
 * @param {string} projectRoot Project root directory.
 * @param {object} [options={}] Scan options, including injected clock, filesystem, validation, executor, and execution settings.
 * @returns {Promise<object>} Frozen scan result containing outcomes, errors, warnings, and optional error-log path.
 * @throws {JobsError} For invalid clock values; scan and persistence failures are generally returned as errors.
 */
export { dispatchJobs as run } from "./jobs/dispatcher.js";
/** @class JobsError
 * Error type used for actionable Jobs failures.
 */
export { JobsError } from "./jobs/errors-base.js";
/**
 * Initialize or restore folder-only Jobs.
 * @function init
 * @param {string} projectRoot Project root directory.
 * @param {object} [settings={}] Settings argument retained by the lifecycle API.
 * @param {object} [options={}] Options; `fs` may inject filesystem operations.
 * @returns {Promise<{enabled: boolean}>} Enabled status.
 * @throws {JobsError} If layout is invalid or active and disabled roots collide.
 */
export { initializeJobs as init, disableJobs as disable } from "./jobs/lifecycle.js";
/**
 * Disable Jobs by renaming its active directory.
 * @function disable
 * @param {string} projectRoot Project root directory.
 * @param {object} [options={}] Options; `fs` may inject filesystem operations.
 * @returns {Promise<{enabled: boolean, state?: string}>} Disabled status, with state when already inactive.
 * @throws {JobsError} If layout is invalid or active and disabled roots collide.
 */
/**
 * Apply a task list/read/create/update/remove command.
 * @function schedule
 * @param {string} root Project root directory.
 * @param {object} command Command with action; non-list actions require a filename, and create/update require Markdown `source`.
 * @param {object} [options={}] Options including `readOnly`, folder validation context, and settings.
 * @returns {Promise<object>} Task listing, task source/read result, or mutation result.
 * @throws {JobsError} For invalid commands, read-only mutation, ineligible Jobs, or invalid task metadata; filesystem errors may also reject.
 */
export { scheduleJobs as schedule, validateJobsOperational as validate } from "./jobs/operations.js";
/**
 * Validate that Jobs is operational in the project folder.
 * @function validate
 * @param {string} root Project root directory.
 * @param {object} [options={}] Validation options including settings, filesystem adapter, and optional `folder`.
 * @returns {Promise<object>} Activation data containing canonical `projectRoot` and Jobs paths.
 * @throws {JobsError} If Jobs is inactive, disabled, damaged, colliding, or invoked from a mismatched folder.
 */
/**
 * Read a non-mutating projection of Jobs eligibility, tasks, schedule, attempts, and last scan.
 * @function status
 * @param {string} projectRoot Project root directory.
 * @param {object} [options={}] Options such as clock, defaults, and validation context.
 * @returns {Promise<object>} Status projection with diagnostics; does not create folders or start a daemon.
 */
export { jobsStatus as status } from "./jobs/status.js";

/**
 * Frozen static namespace for the folder-only Jobs operations exported by this
 * module. Instances have no API; use the static methods/properties instead.
 *
 * @class
 * @param {never} ...args - No constructor arguments are accepted.
 * @returns {Jobs} A Jobs namespace instance (normally unused; use static members).
 */
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
