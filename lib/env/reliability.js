/**
 * lib/env/reliability.js — the IO RETRY policy (private to Env): how
 * the Agent answers a failed provider request. Three settings, each
 * accepting a millisecond numeral or a unit string for the durations
 * (lib/env/duration.js), each with a default — no magic numbers at
 * the call sites:
 *
 *   settings.maxAttempts  request attempts per IO turn (default 3):
 *                         the first write plus its retries
 *   settings.retryBase    the FIRST retry's delay (default 2s) —
 *                         each next attempt waits twice as long
 *   settings.retryMax     the delay ceiling (default 30s)
 *
 * Only failure classes that can plausibly succeed on a later attempt
 * retry (RETRYABLE_KINDS): transport failures and provider-side
 * statuses — a depleted token budget surfaces as one of those and
 * its refill IS time. A malformed context never heals by waiting; a
 * cancellation is the user's own word.
 */

import { tryDuration } from "./duration.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE = 2_000;
export const DEFAULT_RETRY_MAX = 30_000;

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

/** The configured attempt count (>= 1 — one write always happens). */
export function configuredMaxAttempts(settings) {
  const value = Number(settings?.maxAttempts);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_ATTEMPTS;
}

/**
 * One attempt's delay: retryBase doubling per retry (attempt 0 is the
 * first RETRY — the write before it already happened), bounded by
 * retryMax, spread by up to a quarter of the base so simultaneous
 * retries do not land in lockstep.
 * @param {object} settings
 * @param {number} attempt - 0 for the first retry
 * @returns {number} milliseconds
 */
export function retryDelay(settings, attempt) {
  const base = tryDuration(settings?.retryBase) ?? DEFAULT_RETRY_BASE;
  const max = tryDuration(settings?.retryMax) ?? DEFAULT_RETRY_MAX;
  const grown = base * 2 ** Math.max(0, Math.floor(attempt));
  const jitter = Math.floor(Math.random() * (base / 4));
  return Math.min(grown + jitter, max);
}
