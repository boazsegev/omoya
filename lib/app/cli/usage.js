/** CLI diagnostic formatting; Context owns usage data, never presentation. */
import { formatCost } from "../shared/format.js";

/** Format one terminal usage envelope for CLI diagnostics without mutating it.
 * @param {{inputTokens: number, outputTokens: number, source: string, cost?: number}|null|undefined} usage - Final request usage; absent values return an unknown-usage label.
 * @returns {string} One-line token summary with finite provider cost when supplied.
 */
export function usageSummary(usage) {
  if (!usage) return "usage: unknown";
  const amount = formatCost(usage.cost, 4);
  const cost = amount ? ` ${amount}` : "";
  return `usage: in=${usage.inputTokens} out=${usage.outputTokens} (${usage.source})${cost}`;
}
