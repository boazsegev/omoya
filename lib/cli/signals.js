/**
 * lib/signals.js — cancellation primitives for CLI bindings.
 *
 * Per the frozen Decisions, cancellation splits into:
 *   - binding side (this module): arm SIGINT/SIGTERM for CLI processes;
 *   - engine side: `aiio.close()` (built in AI-IO on top of these) cancels
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
 * @param {Object} options - configuration object
 * @param {(signal: string) => void} options.onCancel - invoked once, with
 *   "SIGINT" or "SIGTERM", on the first caught signal
 * @param {NodeJS.Process} [options.process=process] - process-like signal
 *   emitter; defaults to the global Node.js `process` and can be injected
 *   for tests
 * @returns {() => void} disarm function; removes both listeners, and is
 *   safe to call repeatedly
 * @throws {TypeError} if `onCancel` is not a function
 * @throws {*} if registering either signal listener throws; the error
 *   propagates, and a SIGINT listener already registered is not rolled back
 *   if SIGTERM registration fails
 * @effects Registers SIGINT and SIGTERM listeners on the selected process.
 *   The first signal invokes `onCancel` once; any exception from it
 *   propagates from the signal handler and does not allow a later retry.
 *   Calling the returned function removes both listeners; if removal throws,
 *   the error propagates and the disarm function remains marked as used.
 */
export function armCancelSignals({ onCancel, process: proc = process }) {
  if (typeof onCancel !== "function") {
    throw new TypeError("armCancelSignals: onCancel must be a function");
  }
  let fired = false;
  /**
   * Record and dispatch the first received signal.
   * @param {string} signal - signal name, either "SIGINT" or "SIGTERM"
   * @returns {void}
   * @effects Sets the shared fired flag before invoking `onCancel`; invokes
   *   it at most once. Exceptions from `onCancel` propagate to the caller.
   */
  const handler = (signal) => {
    if (fired) return;
    fired = true;
    onCancel(signal);
  };
  /** @returns {void} Dispatches the SIGINT signal through `handler`. */
  const onSigint = () => handler("SIGINT");
  /** @returns {void} Dispatches the SIGTERM signal through `handler`. */
  const onSigterm = () => handler("SIGTERM");
  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);

  let disarmed = false;
  /**
   * Disarm cancellation by removing both installed signal listeners.
   * @returns {void}
   * @effects Removes this function's SIGINT and SIGTERM listeners from
   *   `proc` on its first call; subsequent calls have no effect.
   */
  return () => {
    if (disarmed) return;
    disarmed = true;
    proc.off("SIGINT", onSigint);
    proc.off("SIGTERM", onSigterm);
  };
}
