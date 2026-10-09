/**
 * lib/agent/readouts.js — the status readouts (private to Agent): the
 * cumulative usage total, the context-window readout, and the connection/work state. All in-memory, never
 * persisted — bindings (the TUI footer, a one-shot CLI's final line)
 * read them fresh from the Agent rather than tracking their own copy.
 */

import Context from "../context.js";
const { tokensEstimateMessages, fallbackContextWindow } = Context;

/**
 * Add finite usage counters from a terminal event to the Agent's cumulative totals.
 * Only shared schema counters sum; bounded extensions and metadata replace the latest report.
 * @param {object} agent Agent whose `_usage` totals are updated.
 * @param {object|null|undefined} usage Terminal event usage envelope; non-finite or absent fields are ignored.
 * @returns {void}
 */
export function accumulateUsage(agent, usage) {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return;
  agent._usage = Context.usageAdd(agent._usage, usage);
}

/**
 * The context-window readout for the status surface: how much context
 * the LAST request actually consumed and how much the model offers.
 * Resolution order (most exact first):
 *   used  — the provider's own report through Context.contextUsage
 *     (including a provider-reported terminal input count), else the live-context estimate. If the live context has grown
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
  const report = agent.context?.contextUsage ?? {};
  const model = agent.model;
  let used;
  let approximate = false;
  if (Number.isFinite(report.used)) {
    used = report.used;
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
