/**
 * lib/agent/reliability.js — which failed provider requests an Agent
 * retries (private to Agent). Only failure classes that can plausibly
 * succeed on a later attempt retry (RETRYABLE_KINDS): transport failures
 * and provider-side statuses — a depleted token budget surfaces as one
 * of those and its refill IS time. A malformed context never heals by
 * waiting; a cancellation is the user's own word. How often and how
 * long is the Agent's policy (lib/agent/policy.js, settings.retry).
 */

/**
 * The classified error kinds an Agent retries after a growing
 * interval (lib/agent/run.js). "network" is transport flakiness;
 * "provider" and "auth" cover provider-side statuses (a token-budget
 * depletion included — its refill is time, so a later attempt may
 * succeed). "malformed" is deterministic and "cancelled" is the
 * user's own word — neither retries.
 */
export const RETRYABLE_KINDS = Object.freeze(["network", "provider", "auth"]);

/**
 * Races the wait created by `wait` against a deadline, resolving `true`
 * on completion or `false` when the deadline wins. The deadline is a
 * fallback, not a polling mechanism; `wait` receives a signal aborted
 * when the race settles so its listeners or resources can be released.
 * @param {number} ms - Deadline in milliseconds; negative values are treated as zero.
 * @param {(signal: AbortSignal) => unknown} wait - Creates the completion wait; its result is awaited.
 * @returns {Promise<boolean>} Resolves to `true` on completion or `false` on timeout; rejects if `wait` throws or its result rejects.
 * @throws {TypeError} If `wait` is not a function.
 * @sideEffects Creates a timer and AbortController; aborts the signal and clears the timer when the race settles.
 */
export function awaitTimeout(ms, wait) {
  if (typeof wait !== "function") throw new TypeError("awaitTimeout: wait must be a function");
  const controller = new AbortController();
  const deadline = Math.max(0, ms);
  let timer;
  let completion;
  try {
    // This is the article's Promise.race pattern, with the completion
    // factory given a signal so its own listener/resource can be released.
    completion = Promise.resolve(wait(controller.signal)).then(/** @returns {true} Maps a fulfilled wait to the completion result. */ () => true);
  } catch (error) {
    completion = Promise.reject(error);
  }
  const timeout = new Promise(/** @param {(value: boolean) => void} resolve - Settles the timeout promise. @returns {void} */ (resolve) => {
    timer = setTimeout(/** @returns {void} Resolves the timeout branch as the race winner. */ () => resolve(false), deadline);
  });
  return Promise.race([completion, timeout]).finally(/** @returns {void} Clears the deadline timer and aborts the wait signal after the race settles. */ () => {
    clearTimeout(timer); // completion won: remove its deadline
    controller.abort(); // deadline won: release completion machinery
  });
}
