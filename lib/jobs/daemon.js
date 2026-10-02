import { validateJobsOperational } from "./operations.js";
import { dispatchJobs } from "./dispatcher.js";
import { daemonLoop } from "./daemon-loop.js";

/**
 * Run a foreground, cwd-bound best-effort daemon, performing one in-process
 * scan per wake. Each scan logs its own record under ai-jobs/. Stopping via
 * `options.signal` cancels the running job. No daemon identity or control
 * record is persisted, so multiple foreground daemons may run concurrently.
 * Resolves when stopped or when ai-jobs becomes unusable.
 * @param {string} projectRoot Project root used for operational validation and scans.
 * @param {{signal?: AbortSignal, state?: (state: "running"|"waiting") => void,
 *   execution?: object, scan?: Function, delay?: Function}} [options={}] Options
 *   passed to the daemon. `signal` aborts it; `state` receives running/waiting
 *   notifications; `execution` passes through to dispatchJobs; `scan` and
 *   `delay` replace scanning and the wake timer (primarily for tests).
 * @returns {Promise<void>} Resolves after daemonLoop stops; does not return scan results.
 * @throws {Error} Rejects if initial validateJobsOperational validation fails.
 * @throws {unknown} Propagates errors rejected by daemonLoop or a scan unless
 *   handled by those dependencies. Later validation failures make the daemon stop.
 * @effects Validates the project root, repeatedly scans and dispatches jobs,
 *   reports state, and runs scans with the daemon's abort signal. Persists no
 *   daemon control record; scan logging/other execution effects are delegated.
 */
export async function foregroundJobsDaemon(projectRoot, options = {}) {
  const root = (await validateJobsOperational(projectRoot)).projectRoot;
  const signal = options.signal ?? new AbortController().signal;
  await daemonLoop({
    signal,
    state: options.state ?? (/** No-op state callback when none is supplied. */ () => {}),
    /** Validate continued operational eligibility before admitting a scan. */
    admit: async () => {
      try { await validateJobsOperational(root); return true; }
      catch { return false; }
    },
    /** Run one scan using the configured scanner and daemon abort signal. */
    scan: () => (options.scan ?? dispatchJobs)(root, { execution: { ...options.execution, signal } }),
    ...(options.delay ? { delay: options.delay } : {}),
  });
}
