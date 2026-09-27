import { validateJobsOperational } from "./operations.js";
import { dispatchJobs } from "./dispatcher.js";
import { daemonLoop } from "./daemon-loop.js";

/**
 * Run a foreground, cwd-bound best-effort daemon: one in-process scan
 * (dispatchJobs) per wake. Each scan logs its own record under ai-jobs/;
 * stopping the daemon (options.signal) cancels the running job. No daemon
 * identity or control record is persisted; multiple foreground daemons may
 * run concurrently. Resolves when stopped or when ai-jobs becomes unusable.
 * @param {string} projectRoot
 * @param {{signal?: AbortSignal, state?: (state: "running"|"waiting") => void,
 *   execution?: object, scan?: Function, delay?: Function}} [options] -
 *   `execution` passes through to dispatchJobs; `scan`/`delay` replace the
 *   scan and the wake timer (tests)
 */
export async function foregroundJobsDaemon(projectRoot, options = {}) {
  const root = (await validateJobsOperational(projectRoot)).projectRoot;
  const signal = options.signal ?? new AbortController().signal;
  await daemonLoop({
    signal,
    state: options.state ?? (() => {}),
    admit: async () => {
      try { await validateJobsOperational(root); return true; }
      catch { return false; }
    },
    scan: () => (options.scan ?? dispatchJobs)(root, { execution: { ...options.execution, signal } }),
    ...(options.delay ? { delay: options.delay } : {}),
  });
}
