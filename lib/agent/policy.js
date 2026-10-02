/**
 * lib/agent/policy.js — the Agent POLICY (private to Agent): the
 * settings an Agent runs by, resolved when the Agent is built and again
 * only when it selects another model (agent.policy) — a settings edit
 * applies to the next Agent or model selection, never mid-run.
 *
 * `context` keys resolve down a TREE, each level overriding the one
 * above per key: the global `settings.context`, then the endpoint's
 * `<endpoint>.context`, then the model's
 * `<endpoint>.models.<model>.context`.
 *
 *   settings.context  context-window limits, as fractions of the model's
 *                     context window (a value > 1 reads as a percentage):
 *     cap               the overall ceiling (default 0.9 — always leaves
 *                       room for /compact); crossing it ends the turn
 *     turn              the growth ceiling for ONE turn alone (default 0.4)
 *     autocompact       compact before the next request once usage
 *                       reaches it: 0 (the default), false, or 1
 *                       (100% — the whole window) never; true = 0.65;
 *                       or a fraction/percentage below 100%
 *                       (lib/agent/compact.js)
 *   settings.retry    failed provider requests:
 *     attempts          attempts per turn, the first write included (default 3)
 *     base              the first retry's delay (default 2s); each next
 *                       retry waits twice as long
 *     max               the delay ceiling (default 30s)
 *   settings.tools    tool dispatch (core schema; `folders` is Env's):
 *     timeout           the default per-call timeout (default 120s)
 *     timeoutLimit      the cap on any call's timeout (default 20m)
 *     concurrency       the read-only batch size (default 3)
 *
 * Durations accept milliseconds or unit strings ("30s", "5m").
 */

import { durationParse, durationTry } from "../util.js";
import { DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT, DEFAULT_TOOL_CONCURRENCY } from "../tool-runtime.js";

/** The settings keys Agent owns (its Env.extend schema entries). */
export const POLICY_SETTINGS = Object.freeze({
  context: {
    default: Object.freeze({ cap: 0.9, turn: 0.4, autocompact: 0 }),
    description: "Context-window limits as fractions of the window (> 1 reads as a percentage): cap = the runaway guard's overall ceiling that ends the turn (default 0.9, leaves /compact room); turn = the most ONE turn may grow it (default 0.4); autocompact = compact before the next request once usage reaches it (0, false or 1 = 100% = never, 0 is the default; true = 0.65; or a fraction/percentage below 100%). An endpoint (<endpoint>.context) and a model (<endpoint>.models.<model>.context) override these per key. Read when an Agent is created or selects a model.",
  },
  retry: {
    default: Object.freeze({ attempts: 3, base: 2_000, max: 30_000 }),
    description: "Failed provider requests: attempts per turn including the first (default 3), base = the first retry delay (default 2s, doubling per retry), max = the delay ceiling (default 30s). Durations accept ms or unit strings. Read when an Agent is created.",
  },
});

/** settings.context.autocompact's threshold for `true`. */
const AUTOCOMPACT_DEFAULT = 0.65;

/**
 * Normalize a positive fraction, interpreting values above 1 as percentages.
 * @param {*} value - input value; absent, invalid, or nonpositive values use the fallback
 * @param {*} fallback - value returned when input is unusable
 * @returns {*} The fallback or a number clamped to (0, 1].
 */
function fraction(value, fallback) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n > 1 ? n / 100 : n, 1);
}

/**
 * Resolve the auto-compaction threshold; true means 0.65 and a threshold
 * at the whole window or greater means never.
 * @param {*} value - configured threshold: a fraction/percentage, boolean, or invalid/absent value
 * @returns {number|false} Threshold fraction, or false when compaction is disabled.
 */
function autocompactOf(value) {
  if (value === true) return AUTOCOMPACT_DEFAULT;
  const threshold = fraction(value, false);
  return threshold === false || threshold >= 1 ? false : threshold;
}

/**
 * Parse a configured duration, using a fallback only when the value is absent.
 * @param {*} value - duration in milliseconds or a supported unit string
 * @param {number} fallback - milliseconds to use for null or undefined input
 * @returns {number} Parsed duration in milliseconds.
 * @throws {Error} If a provided duration is malformed.
 */
function duration(value, fallback) {
  return value === undefined || value === null ? fallback : durationParse(value);
}

/**
 * Return an object value unchanged, or an empty object for non-objects and arrays.
 * @param {*} value - value to check
 * @returns {object} The plain object-like value, or a new empty object.
 */
const plain = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

/**
 * Resolve the policy from a settings tree (env.settings) and, for the
 * `context` keys, the selected pair's overrides.
 * @param {object} [settings={}] - global settings, including `context`, `retry`, and `tools`
 * @param {object} [endpoint={}] - endpoint settings; its context and selected model context override global context per key
 * @param {object} [model={}] - selected model metadata containing context overrides
 * @returns {Readonly<{context: {cap: number, turn: number, autocompact: number|false}, retry: {attempts: number, base: number, max: number}, tools: {timeout: number, timeoutLimit: number, concurrency: number}}>} Frozen resolved policy.
 * @throws {TypeError} If tool concurrency is not a positive safe integer.
 * @throws {Error} If a configured tool timeout duration is malformed.
 */
export function agentPolicy(settings = {}, endpoint = {}, model = {}) {
  const { context: contextDefaults, retry: retryDefaults } = POLICY_SETTINGS;
  const context = {
    ...plain(settings.context),
    ...plain(endpoint?.context),
    ...plain(model?.context),
  };
  const retry = settings.retry ?? {};
  const tools = settings.tools ?? {};
  const attempts = Number(retry.attempts);
  const concurrency = tools.concurrency ?? DEFAULT_TOOL_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("tools.concurrency must be a positive integer");
  return Object.freeze({
    context: Object.freeze({
      cap: fraction(context.cap, contextDefaults.default.cap),
      turn: fraction(context.turn, contextDefaults.default.turn),
      autocompact: autocompactOf(context.autocompact),
    }),
    retry: Object.freeze({
      attempts: Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : retryDefaults.default.attempts,
      base: durationTry(retry.base) ?? retryDefaults.default.base,
      max: durationTry(retry.max) ?? retryDefaults.default.max,
    }),
    tools: Object.freeze({
      timeout: duration(tools.timeout, DEFAULT_TOOL_TIMEOUT),
      timeoutLimit: duration(tools.timeoutLimit, DEFAULT_TOOL_TIMEOUT_LIMIT),
      concurrency,
    }),
  });
}

/**
 * One retry's delay: `base` doubling per retry (attempt 0 is the first
 * RETRY), bounded by `max`, spread by up to a quarter of the base so
 * simultaneous retries do not land in lockstep.
 * @param {{base: number, max: number}} retry - policy retry delays in milliseconds
 * @param {number} attempt - zero-based retry index; values below zero are treated as zero
 * @returns {number} Delay in milliseconds, including random jitter and capped at `max`.
 * @remarks Uses `Math.random()` to spread simultaneous retries.
 */
export function retryDelay({ base, max }, attempt) {
  const grown = base * 2 ** Math.max(0, Math.floor(attempt));
  const jitter = Math.floor(Math.random() * (base / 4));
  return Math.min(grown + jitter, max);
}
