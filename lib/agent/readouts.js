/**
 * lib/agent/readouts.js — the status readouts (private to Agent): the
 * cumulative usage total, the context-window readout, the plan/quota
 * readout, and the connection/work state. All in-memory, never
 * persisted — bindings (the TUI footer, a one-shot CLI's final line)
 * read them fresh from the Agent rather than tracking their own copy.
 */

import Context from "../context.js";
const { tokensEstimateMessages, fallbackContextWindow } = Context;

/**
 * Add finite usage values from a terminal event to the Agent's cumulative totals.
 * @param {object} agent Agent whose `_usage` totals are updated.
 * @param {object|null|undefined} usage Terminal event usage envelope; non-finite or absent fields are ignored.
 * @returns {void}
 */
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
 *     else the live-context estimate. If the live context has grown
 *     beyond the previous report, show its projected estimate instead
 *     (marked `approximate`);
 *   total — the provider's report, else the pair's catalog window
 *     (env.models() caps.contextWindow: endpoint override / cached model
 *     metadata / the models.dev registry once Env's background collection
 *     landed it — a synchronous read, never a fetch), else the curated current-tier table
 *     (Context.fallbackContextWindow), else null (consumers hide the
 *     window then rather than show a guess).
 * @param {object} agent Agent providing the context, qualified model, and optional reports.
 * @returns {{used: number, total: number|null, approximate: boolean}} Context tokens used, available window (or null), and whether usage is estimated.
 */
export function contextUsageOf(agent) {
  const report = agent._contextReport ?? {};
  const model = agent.model;
  let used;
  let approximate = false;
  if (Number.isFinite(report.used)) {
    used = report.used;
  } else if (Number.isFinite(agent._lastUsage?.inputTokens) && agent._lastUsage?.source === "provider") {
    used = agent._lastUsage.inputTokens;
  }
  const estimate = tokensEstimateMessages(agent.context.messages());
  if (used === undefined || estimate > used) {
    used = estimate;
    approximate = true;
  }
  let total = Number.isFinite(report.total) && report.total > 0
    ? report.total
    : agent.env?.models?.(true).get(model)?.caps.contextWindow ?? null;
  // The curated tier table covers reads before the registry lands (and
  // every offline one).
  if (total === null && typeof model === "string") {
    try {
      total = fallbackContextWindow(agent.env?.connection?.(model, { remember: false }).model);
    } catch { /* removed endpoints have no model window */ }
  }
  return { used, total, approximate };
}

/**
 * The provider-reported PLAN/QUOTA readout (rate limits, subscription
 * allowances) of the current endpoint: `{label?, quotas}` with each
 * quota `{total?, remaining?, used?, reset?}` — exactly what the
 * provider published (see IO.planUsage). In-memory only, never
 * persisted: a fresh Agent has none (null) until a request reports
 * one; local endpoints (Ollama, LM Studio) publish nothing.
 * @param {object} agent Agent whose optional plan-usage report is read.
 * @returns {{label?: string, quotas: Object}|null} The provider report, or null when none has been received.
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
 * @param {object} agent Agent whose busy and disconnection flags determine the state.
 * @returns {"idle"|"working"|"disconnected"} Current connection/work state; `working` takes precedence over `disconnected`.
 */
export function ioStateOf(agent) {
  if (agent.busy) return "working";
  if (agent._disconnected) return "disconnected";
  return "idle";
}
