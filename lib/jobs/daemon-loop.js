/** The only wake delay: five minutes AFTER a scan completes. */
export const JOBS_DAEMON_DELAY = 5 * 60 * 1000;

/** One cancellable timer, never polling. */
export function daemonDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Serial fixed-delay loop. Dependencies permit deterministic clocks and scans. */
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
