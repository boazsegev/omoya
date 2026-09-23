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
 * Register a synchronous cleanup to run at process finish.
 * @param {() => void} fn
 * @param {Object} [options]
 * @param {NodeJS.Process} [options.process] - injectable for tests
 * @returns {() => void} unregister (idempotent)
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

/** Run every registered cleanup. Errors never propagate. */
export function runFinish() {
  for (const fn of [...cleanups]) {
    try {
      fn();
    } catch { /* finish hooks never crash the exit path */ }
  }
}

function armFinishExit(proc) {
  if (armedProcs.has(proc)) return;
  armedProcs.add(proc);
  proc.once("exit", runFinish);
}

/**
 * Trap termination signals: run cleanups synchronously, then re-raise
 * the signal with our handlers removed so the process dies by the
 * signal itself. Idempotent; returns a disarm function.
 * @param {Object} [options]
 * @param {NodeJS.Process} [options.process] - injectable for tests
 * @param {string[]} [options.signals]
 * @returns {() => void} disarm
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

/** Test-only reset: forget cleanups and arming state. */
export function _resetFinish() {
  cleanups.clear();
  armedProcs = new WeakSet();
  signalDisarm = null;
}
