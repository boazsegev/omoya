/**
 * lib/signals.js — cancellation primitives for CLI bindings.
 *
 * Per the frozen Decisions, cancellation splits into:
 *   - binding side (this module): arm SIGINT/SIGTERM for CLI processes;
 *   - engine side: `aiio.kill()` (built in AI-IO on top of these) cancels
 *     the active request and emits a terminal partial assistant response;
 *   - partial-assembly contract: `Context`'s assembler (lib/context.js)
 *     holds the partial assistant message; `Agent` persists it.
 *
 * This module owns ONLY the signal arming: it invokes the binding's
 * onCancel exactly once on the first SIGINT/SIGTERM and returns a disarm
 * function. What onCancel does (kill the IO, persist the partial, exit
 * with a nonzero code) is the binding's decision.
 */

/**
 * Arm SIGINT/SIGTERM cancellation for a CLI binding.
 *
 * @param {Object} options
 * @param {(signal: string) => void} options.onCancel - invoked once, with
 *   "SIGINT" or "SIGTERM", on the first caught signal
 * @param {NodeJS.Process} [options.process] - injectable for tests
 * @returns {() => void} disarm — remove the listeners (idempotent)
 */
export function armCancelSignals({ onCancel, process: proc = process }) {
  if (typeof onCancel !== "function") {
    throw new TypeError("armCancelSignals: onCancel must be a function");
  }
  let fired = false;
  const handler = (signal) => {
    if (fired) return;
    fired = true;
    onCancel(signal);
  };
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);

  let disarmed = false;
  return () => {
    if (disarmed) return;
    disarmed = true;
    proc.off("SIGINT", onSigint);
    proc.off("SIGTERM", onSigterm);
  };
}
