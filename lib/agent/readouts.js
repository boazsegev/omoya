/**
 * lib/agent/readouts.js — the status readouts (private to Agent): the
 * cumulative usage total, the context-window readout, the plan/quota
 * readout, and the connection/work state. All in-memory, never
 * persisted — bindings (the TUI footer, a one-shot CLI's final line)
 * read them fresh from the Agent rather than tracking their own copy.
 */

import Context from "../context.js";
const { estimateContextTokens } = Context;

/** Accumulate one terminal event's usage envelope (called from run()). */
export function accumulateUsage(agent, usage) {
  if (Number.isFinite(usage?.inputTokens)) agent._usage.inputTokens += usage.inputTokens;
  if (Number.isFinite(usage?.outputTokens)) agent._usage.outputTokens += usage.outputTokens;
  if (Number.isFinite(usage?.cost)) agent._usage.cost += usage.cost;
}

/**
 * The context-window readout for the status surface: how much context
 * the LAST request actually consumed and how much the model offers.
 * Resolution order (most exact first):
 *   used  — the provider's own report through IO (setContextUsage),
 *     else the last terminal envelope's provider-reported input count,
 *     else the word-count estimate of the live context (marked
 *     `approximate` — the only approximation in the chain);
 *   total — the provider's report, else the known context window
 *     (endpoint settings override / cached model metadata), else null
 *     (consumers hide the window then rather than show a guess).
 * @returns {{used: number, total: number|null, approximate: boolean}}
 */
export function contextUsageOf(agent) {
  const report = agent._contextReport ?? {};
  let used;
  let approximate = false;
  if (Number.isFinite(report.used)) {
    used = report.used;
  } else if (Number.isFinite(agent._lastUsage?.inputTokens) && agent._lastUsage?.source === "provider") {
    used = agent._lastUsage.inputTokens;
  } else {
    used = estimateContextTokens(agent.context);
    approximate = true;
  }
  const total = Number.isFinite(report.total) && report.total > 0
    ? report.total
    : agent.env?.contextWindow?.(agent.endpoint, agent.model) ?? null;
  return { used, total, approximate };
}

/**
 * The provider-reported PLAN/QUOTA readout (rate limits, subscription
 * allowances) of the current endpoint: `{label?, quotas}` with each
 * quota `{total?, remaining?, used?, reset?}` — exactly what the
 * provider published (see IO.setPlanUsage). In-memory only, never
 * persisted: a fresh Agent has none (null) until a request reports
 * one; local endpoints (Ollama, LM Studio) publish nothing.
 * @returns {{label?: string, quotas: Object}|null}
 */
export function planUsageOf(agent) {
  return agent._planUsage ?? null;
}

/**
 * The connection/work state for the TUI's status indicator:
 *   - "working"      — a run is in flight (waiting on provider IO
 *     or executing tools; IO's exposed state powers the nuance:
 *     the active request sits in sending/reading underneath);
 *   - "disconnected" — the last turn failed with a connection-class
 *     error (network/auth/provider) and nothing succeeded since;
 *   - "idle"         — otherwise (including a fresh start: no
 *     connection yet is not a failure).
 * @returns {"idle"|"working"|"disconnected"}
 */
export function ioStateOf(agent) {
  if (agent.busy) return "working";
  if (agent._disconnected) return "disconnected";
  return "idle";
}
