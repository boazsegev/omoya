/**
 * lib/finish.js — crash-safe synchronous finish hooks.
 *
 * Reimplementation of the onFinish/armFinishSignals pattern (ground-up;
 * no import from scripts/core or core/lib). Two surfaces:
 *
 *   onFinish(fn)         — register a SYNCHRONOUS cleanup; it runs when
 *                          the process exits (process.exit, natural end,
 *                          uncaught exception). Returns an unregister fn.
 *   armFinishSignals()   — additionally trap SIGINT/SIGTERM/SIGHUP: run
 *                          the cleanups synchronously, then re-raise the
 *                          signal so the process dies BY the signal
 *                          (correct exit semantics). Returns a disarm fn.
 *
 * Cleanups must be synchronous and idempotent — they may run more than
 * once (signal path + exit path). Async work does not belong here; a
 * binding that needs graceful async cancellation (ai-agent CLI) arms its
 * own SIGINT/SIGTERM via lib/signals.js and relies on onFinish's exit
 * hook as the crash backstop — it never arms finish signals.
 */

const cleanups = new Set();
let armedProcs = new WeakSet(); // exit hook arms once PER process object
let signalDisarm = null;

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
 * Attach handlers that run cleanups and re-raise a termination signal after removing those handlers.
 * If already armed, returns the existing disarm function without applying new options.
 * @param {Object} [options] Signal-arming options.
 * @param {NodeJS.Process} [options.process=process] Process on which to install handlers and call `kill`.
 * @param {string[]} [options.signals=["SIGINT", "SIGTERM", "SIGHUP"]] Signals to handle.
 * @returns {() => void} Idempotent function that removes these signal handlers and clears the armed state.
 */
export function armFinishSignals({
  process: proc = process,
  signals = ["SIGINT", "SIGTERM", "SIGHUP"],
} = {}) {
  if (signalDisarm) return signalDisarm;
  armFinishExit(proc);
  const handlers = signals.map((sig) => {
    const handler = () => {
      runFinish();
      disarm();
      proc.kill(proc.pid, sig); // re-raise: die by the signal
    };
    proc.on(sig, handler);
    return [sig, handler];
  });
  let armed = true;
  function disarm() {
    if (!armed) return;
    armed = false;
    for (const [sig, handler] of handlers) proc.off(sig, handler);
    signalDisarm = null;
  }
  signalDisarm = disarm;
  return disarm;
}

/**
 * Test-only reset of the shared cleanup registry, process arming cache, and signal disarm state.
 * Does not remove already-installed process listeners.
 * @returns {void}
 */
export function _resetFinish() {
  cleanups.clear();
  armedProcs = new WeakSet();
  signalDisarm = null;
}
