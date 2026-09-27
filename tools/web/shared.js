/** Firefox-flavored headers shared by web-search and web-fetch to minimize anti-bot friction. */
export const BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.5",
  "upgrade-insecure-requests": "1",
});

/**
 * fetch that fails fast when the backend cannot be reached.
 *
 * Rejects with a connect-timeout error if the response head has not arrived
 * within `connectTimeoutMs`, and aborts the in-flight connection attempt so
 * the underlying socket is torn down. Once the head arrives the caller's own
 * deadline/abort signal governs the remainder of the response.
 *
 * @param {Function} fetchImpl fetch-compatible implementation
 * @param {string|URL} url request target
 * @param {object} init fetch init; may carry the caller's abort signal
 * @param {{connectTimeoutMs?: number, message?: string}} options
 * @returns {Promise<Response>}
 */
export async function fetchWithConnectTimeout(fetchImpl, url, init, { connectTimeoutMs = 3_000, message = "connection timed out" } = {}) {
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer;
  const connectLimit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "connect_timeout";
      controller.abort(error); // AbortSignal itself has no abort method; only the owned controller can close the connection.
      reject(error);
    }, connectTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error("request cancelled");
      return fetchImpl(url, { ...init, signal });
    }), connectLimit]);
  } finally {
    clearTimeout(timer); // cancel the timer itself; a merely unref'd timer still lives until it fires
  }
}

/** One process-wide network-attempt ledger shared by fetch and search.
 * Parallelism belongs to Agent's dispatcher, not this burst policy. */
import { WEB_LIMIT_DEFAULTS, WEB_THROTTLE_DEFAULTS, DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT } from "../../lib/tool-runtime.js";
import { durationParse } from "../../lib/util.js";

/** Actual agent deadline wins; direct calls resolve the same adjustable defaults. */
export function webBudgetMs(context = {}) {
  if (Number.isFinite(context.deadline)) return Math.max(0, context.deadline - Date.now());
  const settings = context.env?.settings ?? {};
  const timeout = durationParse(settings.tools?.timeout ?? DEFAULT_TOOL_TIMEOUT);
  const limit = durationParse(settings.tools?.timeoutLimit ?? DEFAULT_TOOL_TIMEOUT_LIMIT);
  return Math.min(timeout, limit);
}

/** Resolve and validate settings.web's shared network pacing policy. */
export function webRateSettings(web = {}) {
  for (const [name, value] of Object.entries({ web, "web.limit": web?.limit, "web.throttle": web?.throttle })) {
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new TypeError(`${name} must be an object`);
    }
  }
  const limit = { ...WEB_LIMIT_DEFAULTS, ...web.limit };
  const throttle = { ...WEB_THROTTLE_DEFAULTS, ...web.throttle };
  for (const [name, value] of Object.entries(limit)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`web.limit.${name} must be a positive integer`);
  }
  if (!Number.isFinite(throttle.startAt) || throttle.startAt < 0 || throttle.startAt > 1) {
    throw new TypeError("web.throttle.startAt must be a fraction from 0 through 1");
  }
  if (!Number.isFinite(throttle.step) || throttle.step <= 0 || throttle.step > 1) {
    throw new TypeError("web.throttle.step must be a fraction greater than 0 and at most 1");
  }
  if (!Number.isSafeInteger(throttle.stepMs) || throttle.stepMs < 0) {
    throw new TypeError("web.throttle.stepMs must be a non-negative integer");
  }
  return { ...limit, ...throttle };
}

const rateState = { calls: [] };

export function __resetWebRateForTests() {
  rateState.calls = [];
}

/** Fraction of the burst window used; active requests are not a constraint. */
export function ratePressure(limits, now) {
  return rateState.calls.filter((time) => now - time < limits.windowMs).length / limits.calls;
}

/** One delay increment at startAt, then another per occupancy step. */
export function throttlePause(pressure, limits) {
  if (pressure < limits.startAt) return 0;
  const steps = Math.floor((Math.min(1, pressure) - limits.startAt) / limits.step + 1e-9) + 1;
  return steps * limits.stepMs;
}

function busyError(message, delay) {
  const error = new Error(`${message} busy for ${delay} ms, please wait`);
  error.code = "rate_limit";
  error.retryable = true;
  error.retryAfterMs = delay;
  return error;
}

/** Count a network attempt; wait at a full window only below half the
 * remaining caller deadline. Returned leave(successful) pauses only success.
 * Calls stay counted until expiry, so only an exact expiry timer is needed. */
export async function rateEnter(limits, clock, signal, sleep = sleepAbortable, budgetMs = DEFAULT_TOOL_TIMEOUT, busyMessage = "web request") {
  const began = clockTime(clock);
  const wallBegan = Date.now();
  const remaining = () => budgetMs - Math.max(0, clockTime(clock) - began, Date.now() - wallBegan);
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("web request cancelled");
    const now = clockTime(clock);
    rateState.calls = rateState.calls.filter((time) => now - time < limits.windowMs);
    if (rateState.calls.length >= limits.calls) {
      const delay = Math.max(1, rateState.calls[rateState.calls.length - limits.calls] + limits.windowMs - now);
      if (delay >= remaining() / 2) throw busyError(busyMessage, delay);
      await sleep(delay, signal);
      continue;
    }
    rateState.calls.push(now);
    return rateLeave(limits, clock, signal, sleep, remaining);
  }
}

function rateLeave(limits, clock, signal, sleep, remaining) {
  let released = false;
  return async (successful) => {
    if (released) return;
    released = true;
    if (successful !== true) return;
    const pause = Math.min(throttlePause(ratePressure(limits, clockTime(clock)), limits), Math.max(0, Math.floor(remaining() / 2)));
    if (pause > 0) await sleep(pause, signal);
  };
}

/** Sleep that still stops promptly when the caller's signal aborts. */
export function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("web request cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("web request cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function clockTime(clock) {
  const value = typeof clock.now === "function" ? clock.now() : clock();
  return value instanceof Date ? value.getTime() : Number(value);
}
