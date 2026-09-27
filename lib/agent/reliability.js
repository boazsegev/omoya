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
 * awaitTimeout — race a completion event against a deadline (the
 * Promise.race pattern), resolving true for completion and false for
 * the deadline. `wait` receives an AbortSignal which is aborted on
 * EITHER outcome, so an event listener registered by the caller with
 * that signal cannot outlive the race. A deadline is a fallback,
 * never a polling/sleep mechanism.
 * @param {number} ms - the deadline in milliseconds
 * @param {(signal: AbortSignal) => Promise<unknown>} wait - creates the completion wait
 * @returns {Promise<boolean>} true = completion; false = deadline
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
    completion = Promise.resolve(wait(controller.signal)).then(() => true);
  } catch (error) {
    completion = Promise.reject(error);
  }
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), deadline);
  });
  return Promise.race([completion, timeout]).finally(() => {
    clearTimeout(timer); // completion won: remove its deadline
    controller.abort(); // deadline won: release completion machinery
  });
}
