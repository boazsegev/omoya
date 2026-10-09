/**
 * lib/agent/finish.js — crash-safe synchronous finish hooks.
 *
 * onFinish(fn) registers a SYNCHRONOUS cleanup on process exit
 * (process.exit, natural end, uncaught exception) and returns an unregister
 * function. runFinish() invokes registered cleanups synchronously.
 *
 * Cleanups must be synchronous and idempotent — they may run more than
 * once (signal path + exit path). Async work does not belong here; a
 * binding that needs graceful async cancellation arms its own SIGINT/SIGTERM
 * via the App CLI layer and relies on onFinish's exit hook as a backstop.
 */

const cleanups = new Set();
let armedProcs = new WeakSet(); // exit hook arms once PER process object
/**
 * Register `fn` for synchronous execution on the configured process's `exit` event.
 * @param {() => void} fn Cleanup callback; must be synchronous and may run more than once.
 * @param {Object} [options] Registration options.
 * @param {NodeJS.Process} [options.process=process] Process to attach the exit hook to.
 * @returns {() => void} Idempotent function that unregisters `fn` from the shared cleanup set.
 * @throws {TypeError} If `fn` is not a function.
 */
export function onFinish(fn, { process: proc = process } = {}) {
  if (typeof fn !== "function") {
    throw new TypeError("onFinish: fn must be a (synchronous) function");
  }
  cleanups.add(fn);
  armFinishExit(proc);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    cleanups.delete(fn);
  };
}

/**
 * Invoke a snapshot of all registered cleanups synchronously; swallow callback errors.
 * @returns {void}
 */
export function runFinish() {
  for (const fn of [...cleanups]) {
    try {
      fn();
    } catch { /* finish hooks never crash the exit path */ }
  }
}
/** @param {NodeJS.Process} proc Process receiving the `exit` listener. @returns {void} Attach the shared exit hook to `proc` once per process object. */
function armFinishExit(proc) {
  if (armedProcs.has(proc)) return;
  armedProcs.add(proc);
  proc.once("exit", runFinish);
}

/**
 * Test-only reset of the shared cleanup registry and process arming cache.
 * Does not remove already-installed process listeners.
 * @returns {void}
 */
export function _resetFinish() {
  cleanups.clear();
  armedProcs = new WeakSet();
}
