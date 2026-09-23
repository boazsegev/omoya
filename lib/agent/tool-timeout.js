/**
 * lib/agent/tool-timeout.js — the Agent-owned timeout boundary around
 * every tool invocation (private to Agent). A tool may declare a
 * top-level model-facing `timeout` property; the Agent extracts it,
 * parses it, caps it at Env.toolTimeoutLimit, and never passes it to
 * the tool. With no request the default is the explicit host
 * `Agent.toolCall.timeout` override, else Env.toolTimeout.
 *
 * A registry entry may carry schema.onTimeout (stripped from the
 * provider catalog). When the main duration expires, the callback gets
 * at most TOOL_ON_TIMEOUT_LIMIT to clean up or return a FINAL result;
 * afterward the Agent kills the forked worker (or abandons an
 * in-process promise) unconditionally. Undefined means cleanup-only
 * and the ordinary timeout error is returned to the model.
 */

import Env from "../env.js";
const { parseDuration, TOOL_ON_TIMEOUT_LIMIT } = Env;

const TIMEOUT = Symbol("tool-timeout");
const CALLBACK_TIMEOUT = Symbol("tool-on-timeout-limit");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Resolve a call's effective timeout and strip a declared timeout from
 * the arguments handed to the tool.
 * @returns {{args: any, timeout: number, requested: number|undefined}}
 */
export function prepareToolTimeout(agent, entry, args) {
  const properties = entry?.schema?.inputSchema?.properties;
  const declaresTimeout = plainObject(properties) && own(properties, "timeout");
  let forwarded = args;
  let requested;
  if (declaresTimeout && plainObject(args)) {
    if (own(args, "timeout") && args.timeout !== undefined) requested = parseDuration(args.timeout);
    forwarded = { ...args };
    delete forwarded.timeout; // extraction: the tool never owns or races this timer
  }
  // Every tool may use the harness question bridge. Its user-input activity
  // renews this deadline through resetTimeout(); ordinary calls keep Env's
  // default while question-capable calls receive a realistic first window.
  const fallback = agent._toolCall.timeout ?? (typeof agent._question?.ask === "function"
    ? Math.max(agent.env.toolTimeout, 300_000)
    : agent.env.toolTimeout);
  const limit = agent.env.toolTimeoutLimit;
  return {
    args: forwarded,
    timeout: Math.min(requested ?? fallback, limit),
    requested,
  };
}

/** Race one normalized promise against a timer and clear a losing timer. */
async function bounded(promise, ms, token) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(token), ms); });
  const result = await Promise.race([promise, limit]);
  clearTimeout(timer);
  return result;
}

/**
 * Run an invocation under the Agent timeout. `terminate` MUST be
 * idempotent and unconditional (forked calls use SIGKILL). The
 * onTimeout callback receives the forwarded tool args and an enriched
 * Agent tool context ({timeout, requestedTimeout, tool}).
 */
export async function runWithToolTimeout({
  agent, entry, name, args, call, timeout, requested, invoke, terminate = () => {}, onResetTimeout, onInterrupt,
  // Private test seam. Every deadline must be cleared when execution wins;
  // unref only permits process exit, it does not release a timer's closure.
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const execution = Promise.resolve()
    .then(invoke)
    .then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
  // Interactive bindings renew the inactivity deadline on user input. The
  // original five-minute window still expires if nobody starts answering.
  let deadline = Date.now() + timeout;
  let wake;
  // Cancellation is distinct from a timeout: it must settle the caller now,
  // rather than waiting for a child process to acknowledge its signal (or an
  // in-process promise that cannot be forcibly stopped).
  let interrupt;
  const cancelled = new Promise((resolve) => { interrupt = () => resolve({ kind: "cancelled" }); });
  onInterrupt?.(interrupt);
  const resetTimeout = () => {
    deadline = Date.now() + timeout;
    wake?.();
  };
  const previousResetTimeout = agent._resetToolTimeout;
  agent._resetToolTimeout = resetTimeout;
  onResetTimeout?.(resetTimeout);
  let winner;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    let timer;
    const tick = new Promise((resolve) => {
      timer = setTimer(() => resolve(TIMEOUT), remaining);
      // A pure inactivity watchdog: an abandoned tool call whose run
      // already resolved must not hold the event loop on this timer.
      timer.unref?.();
      wake = () => { clearTimer(timer); resolve(null); };
    });
    winner = await Promise.race([execution, tick, cancelled]);
    // The former implementation only cleared on timeout reset. A normal
    // fast tool left its 120-second deadline alive, retaining Promise.race's
    // execution closure (and therefore Agent/call/context) until it fired.
    clearTimer(timer);
    wake = null;
    if (winner !== null) break;
  }
  if (winner !== TIMEOUT) {
    agent._resetToolTimeout = previousResetTimeout;
    if (winner.kind === "cancelled") {
      try { terminate(); } catch { /* already gone / not killable in-process */ }
      throw new Error(`tool "${name}" cancelled`);
    }
    if (winner.kind === "error") throw winner.error;
    return winner.value;
  }
  agent._resetToolTimeout = previousResetTimeout;
  // Let an interactive bridge remove its modal before the model receives
  // the ordinary timeout result.
  agent._question?.timeout?.();

  // The normalized execution promise never rejects unobserved; it may
  // still settle after an in-process timeout, but its value is ignored.
  let callbackResult;
  try {
    if (typeof entry?.onTimeout === "function") {
      const context = {
        ...agent._toolContext(call),
        timeout,
        requestedTimeout: requested,
        tool: name,
      };
      const callback = Promise.resolve()
        .then(() => entry.onTimeout(args, context))
        .then(
          (value) => ({ kind: "value", value }),
          (error) => ({ kind: "error", error }),
        );
      callbackResult = await bounded(callback, TOOL_ON_TIMEOUT_LIMIT, CALLBACK_TIMEOUT);
    }
  } finally {
    // Callback returned, failed, or exceeded its one-minute grace: the
    // original call is over, regardless of any late promise settlement.
    try { terminate(); } catch { /* already gone / not killable in-process */ }
  }

  if (callbackResult !== CALLBACK_TIMEOUT && callbackResult?.kind === "value" && callbackResult.value !== undefined) {
    return callbackResult.value; // the callback supplied a final tool result
  }
  let detail = `tool "${name}" timed out after ${timeout}ms`;
  if (callbackResult === CALLBACK_TIMEOUT) detail += `; onTimeout exceeded ${TOOL_ON_TIMEOUT_LIMIT}ms`;
  else if (callbackResult?.kind === "error") detail += `; onTimeout failed: ${callbackResult.error?.message ?? callbackResult.error}`;
  throw new Error(detail);
}
