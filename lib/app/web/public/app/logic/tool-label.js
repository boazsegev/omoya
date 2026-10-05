import { parseArgs, toolSummary } from "../../format.js";
/** Pure tool labels and argument formatting shared by stream and transcript. */
export function toolLabel(call) { return { name: call?.name ?? "tool", summary: toolSummary(call?.arguments ?? call?.args) }; }
export function argsText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") { const parsed = parseArgs(value); return typeof parsed === "string" ? value : JSON.stringify(parsed, null, 2); }
  return JSON.stringify(value, null, 2);
}
