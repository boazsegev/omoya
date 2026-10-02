/** The only wake delay: five minutes AFTER a scan completes. */
export const JOBS_DAEMON_DELAY = 5 * 60 * 1000;

/**
 * Wait for a timeout, resolving early if the abort signal fires.
 *
 * @param {number} milliseconds - Timeout duration in milliseconds.
 * @param {AbortSignal} signal - Signal used to cancel the wait; if already aborted, resolves immediately.
 * @returns {Promise<void>} Resolves when the timeout expires or the signal aborts.
 * @throws Rejects if timer setup fails, for example because the signal is invalid; timer handling of out-of-range durations is runtime-dependent.
 * @effects Schedules one timer and installs a one-time abort listener; either completion path clears the timer and removes the listener.
 */
export function daemonDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Run serial scans with a fixed delay after each completed or failed scan.
 *
 * @param {object} options - Loop dependencies.
 * @param {AbortSignal} options.signal - Signal that stops the loop and is passed to `delay`.
 * @param {() => boolean | Promise<boolean>} options.admit - Async-capable predicate; a false result prevents the scan and ends the loop.
 * @param {() => unknown | Promise<unknown>} options.scan - Async-capable scan operation; its failures are swallowed before the post-scan delay.
 * @param {(status: "running" | "waiting") => void} options.state - Callback notified before a scan and before waiting.
 * @param {(milliseconds: number, signal: AbortSignal) => unknown | Promise<unknown>} [options.delay=daemonDelay] - Wait operation after each scan, including a failed scan.
 * @returns {Promise<void>} Resolves when aborted or when admission is denied; rejects if admission, state notification, or delay throws/rejects.
 * @effects Calls `admit`, `state`, `scan`, and `delay` serially; scan errors are caught, and no further delay begins after an observed abort.
 */
export async function daemonLoop({ signal, admit, scan, state, delay = daemonDelay }) {
  while (!signal.aborted) {
    if (!await admit() || signal.aborted) break;
    state("running");
    try { await scan(); }
    catch { /* A failed wake gets the same post-completion delay, never an immediate retry. */ }
    if (signal.aborted) break;
    state("waiting");
    await delay(JOBS_DAEMON_DELAY, signal);
  }
}
