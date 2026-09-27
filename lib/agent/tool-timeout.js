/**
 * Agent-owned deadlines and cancellation for each dispatch. Tool-declared
 * timeout is extracted before invocation. onTimeout is a bounded final-result
 * hook, not a process-cleanup policy; dispatch always tears down its sandbox.
 */
import { durationParse } from "../util.js";
import { TOOL_ON_TIMEOUT_LIMIT } from "./tool-timeout-settings.js";

const TIMEOUT = Symbol("tool-timeout");
const CALLBACK_TIMEOUT = Symbol("tool-on-timeout-limit");
/** Agent-owned timeout marker: dispatch uses it to clean retained resources. */
export class ToolTimeoutError extends Error {}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Resolve a call's duration and strip a declared timeout from tool arguments. */
export function prepareToolTimeout(agent, entry, args) {
  const properties = entry?.schema?.inputSchema?.properties;
  const declaresTimeout = plainObject(properties) && own(properties, "timeout");
  let forwarded = args;
  let requested;
  if (declaresTimeout && plainObject(args)) {
    if (own(args, "timeout") && args.timeout !== undefined) requested = durationParse(args.timeout);
    forwarded = { ...args };
    delete forwarded.timeout;
  }
  const { timeout, timeoutLimit: limit } = agent.policy.tools;
  const fallback = agent._toolCall.timeout ?? (typeof agent._question?.ask === "function"
    ? Math.min(Math.max(timeout, 300_000), limit) : timeout);
  return { args: forwarded, timeout: Math.min(requested ?? fallback, limit), requested };
}

function normalized(invoke) {
  return Promise.resolve().then(invoke).then(
    (value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }),
  );
}

/** One abort subscription shared by every wait in this dispatch. */
function cancellation(signal) {
  let abort;
  const promise = new Promise((resolve) => {
    abort = () => resolve({ kind: "cancelled", error: signal.reason });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return { promise, close: () => signal.removeEventListener("abort", abort) };
}

async function bounded(promise, cancelled, ms, token) {
  let timer;
  try {
    return await Promise.race([promise, cancelled, new Promise((resolve) => {
      timer = setTimeout(() => resolve(token), ms);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

async function waitExecution(execution, cancelled, timeout, bindReset, setTimer, clearTimer) {
  let deadline = Date.now() + timeout;
  let wake;
  bindReset(() => { deadline = Date.now() + timeout; wake?.(); });
  for (;;) {
    let timer;
    const tick = new Promise((resolve) => {
      timer = setTimer(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now()));
      timer.unref?.();
      wake = () => { clearTimer(timer); resolve(null); };
    });
    const winner = await Promise.race([execution, tick, cancelled]);
    clearTimer(timer);
    wake = null;
    if (winner !== null) return winner;
  }
}

function resultOf(winner, name) {
  if (winner.kind === "cancelled") throw new Error(`tool "${name}" cancelled`);
  if (winner.kind === "error") throw winner.error;
  return winner.value;
}

async function timeoutOutcome({ agent, entry, name, args, call, timeout, requested, controller, sandbox }, cancelled) {
  agent._question?.timeout?.();
  let outcome;
  if (typeof entry?.onTimeout === "function") {
    const context = { ...agent._toolContext(call), timeout, requestedTimeout: requested,
      tool: name, signal: controller.signal, sandbox };
    const callback = normalized(() => { controller.signal.throwIfAborted(); return entry.onTimeout(args, context); });
    outcome = await bounded(callback, cancelled, TOOL_ON_TIMEOUT_LIMIT, CALLBACK_TIMEOUT);
  }
  if (outcome?.kind === "cancelled") return resultOf(outcome, name);
  if (outcome?.kind === "value" && outcome.value !== undefined) return outcome.value;
  let detail = `tool "${name}" timed out after ${timeout}ms`;
  if (outcome === CALLBACK_TIMEOUT) detail += `; onTimeout exceeded ${TOOL_ON_TIMEOUT_LIMIT}ms`;
  else if (outcome?.kind === "error") detail += `; onTimeout failed: ${outcome.error?.message ?? outcome.error}`;
  throw new ToolTimeoutError(detail);
}

/** Race all call phases against cancellation; dispatch owns final teardown. */
export async function runWithToolTimeout({
  agent, entry, name, args, call, timeout, requested, invoke,
  controller = new AbortController(), sandbox, onResetTimeout,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const { signal } = controller;
  const cancelled = cancellation(signal);
  const previous = agent._resetToolTimeout;
  const bindReset = (reset) => { agent._resetToolTimeout = reset; onResetTimeout?.(reset); };
  try {
    const execution = normalized(() => { signal.throwIfAborted(); return invoke(); });
    const winner = await waitExecution(execution, cancelled.promise, timeout, bindReset, setTimer, clearTimer);
    if (winner !== TIMEOUT) return resultOf(signal.aborted ? { kind: "cancelled" } : winner, name);
    agent._resetToolTimeout = previous;
    const outcome = await timeoutOutcome({ agent, entry, name, args, call, timeout, requested, controller, sandbox }, cancelled.promise);
    if (signal.aborted) return resultOf({ kind: "cancelled" }, name);
    return outcome;
  } finally {
    agent._resetToolTimeout = previous;
    onResetTimeout?.(previous);
    cancelled.close();
  }
}
