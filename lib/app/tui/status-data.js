/** AI status and usage projection. Formatting, clipping, animation, and width belong to GTUI. */

import { homedir } from "node:os";
import { aggregateState, formatAmount, modelParts, quotaUsedTotal, resetText, settingChips, sortedQuotaEntries } from "../shared/format.js";

/** Historical status contract: the working-folder field gets at most 24 display columns. */
export const CWD_COLUMNS = 24;

/** Replace the home-directory prefix with `~` without clipping the path.
 * @param {*} path Path-like value; nullish values become an empty string and other values are stringified.
 * @returns {string} The home-shortened path, unchanged when outside the home directory.
 * @throws No errors are intentionally thrown; string conversion may invoke user-defined coercion.
 */
export function cwdShortText(path) {
  const home = homedir();
  const s = String(path ?? "");
  return home !== "/" && (s === home || s.startsWith(`${home}/`)) ? `~${s.slice(home.length)}` : s;
}

/** Format a token count using 1024-based K/M suffixes and one decimal.
 * @param {number} n Token count; non-finite values render as `?`.
 * @returns {string} Formatted count.
 */
export function humanTokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Calculate context-window use as a percentage.
 * @param {object|null|undefined} agent Agent-like object whose `contextUsage` contains `used` and `total`.
 * @returns {number|null} Percentage, or null when total is absent, non-finite, or not positive.
 */
export function contextPercent(agent) {
  const report = agent?.contextUsage;
  return Number.isFinite(report?.total) && report.total > 0 ? (report.used / report.total) * 100 : null;
}

/** The RIGHT-aligned turn readout, split around where the view draws the
 *  context gauge: `<used>/<total>` before it, `<pct>%` after — or, when
 *  the window size is unknown (no gauge to draw), `<used> tokens` alone
 *  in `before` and an empty `after`. The provider's plan once it reports
 *  quotas rides in `after` too — `<pct>% · <label>: 5h 2.0K/100K
 *  (2.0%) · resets in 2h · …`, or unlabeled quotas alone (see
 *  planText) — never on a line of its own, and never behind a bare
 *  "plan:" prefix (noise). Content policy, not width — GTUI clips the
 *  line to fit.
 * @param {object} agent Agent-like object with optional `contextUsage` and `planUsage`.
 * @returns {{before: string, after: string}} Readout text split around the context gauge.
 */
export function turnReadoutParts(agent) {
  const report = agent.contextUsage ?? { used: 0, total: null, approximate: true };
  const usedText = `${report.approximate ? "~" : ""}${humanTokens(report.used)}`;
  const percent = contextPercent(agent);
  const plan = planText(agent.planUsage);
  if (percent === null) return { before: `${usedText} tokens${plan ? ` · ${plan}` : ""}`, after: "" };
  return { before: `${usedText}/${humanTokens(report.total)}`, after: `${percent.toFixed(1)}%${plan ? ` · ${plan}` : ""}` };
}

/** Build the MCP status line from configured and live-connected server names.
 * @param {object|null|undefined} env Environment-like object; configured names come from `settings.mcp`.
 * @param {object|null|undefined} catalog Tool catalog snapshot used to identify connected MCP servers.
 * @returns {string|null} Formatted line, or null when there are no names.
 */
export function mcpLineText(env, catalog) {
  const configured = env?.settings?.mcp;
  const names = configured && typeof configured === "object" && !Array.isArray(configured) ? Object.keys(configured) : [];
  const live = connectedMcp(catalog);
  const all = [...new Set([...names, ...live])];
  if (all.length === 0) return null;
  return `mcp: ${all.map((name) => (live.includes(name) ? `${name} (connected)` : name)).join(" · ")}`;
}

/** One plan quota line: `weekly 4.0K/131.1K (3.0%) · resets in 2h15m`
 *  (falling back to `· reset <raw>` for a duration-shaped reset, and
 *  omitting the reset entirely when its timestamp is already past —
 *  "resets now" is noise; see resetText). A countdown closer than
 *  RESET_MIN_SECONDS away is likewise noise on a crowded status bar:
 *  "resets in 2s" flashes by and just burns the space, so it's skipped. */
const RESET_MIN_SECONDS = 4;

/** Format one quota record for the status readout.
 * @param {string} name Quota label.
 * @param {object|null|undefined} quota Quota record, potentially containing usage, unit, and reset data.
 * @returns {string} Formatted quota text; malformed or incomplete data falls back to the name.
 */
export function formatQuotaText(name, quota) {
  const ut = quotaUsedTotal(quota);
  const text = resetText(quota?.reset, RESET_MIN_SECONDS);
  const reset = text ? ` · ${text}` : "";
  if (ut) return `${name} ${humanTokens(ut.used)}/${humanTokens(ut.total)} (${((ut.used / ut.total) * 100).toFixed(1)}%)${reset}`;
  if (Number.isFinite(quota?.remaining)) return `${name} ${formatAmount(quota.remaining, quota?.unit, humanTokens)} left${reset}`;
  if (Number.isFinite(quota?.used)) return `${name} ${formatAmount(quota.used, quota?.unit, humanTokens)}${reset}`;
  return `${name}${reset}`;
}

/** The key-hints line: semantic key/action data; views decide presentation. */
export const SHORTCUT_HINTS = Object.freeze([
  Object.freeze({ key: "^X", label: "menu", action: "ctrl+x" }),
  Object.freeze({ key: "^O", label: "block viewer", action: "ctrl+o" }),
  Object.freeze({ key: "^P", label: "provider", action: "ctrl+p" }),
  Object.freeze({ key: "^M", label: "models", action: "ctrl+m" }),
  // Down from the input's last row focuses the status toolbar; the hint is
  // that same key, so a click behaves exactly like pressing it.
  Object.freeze({ key: "↓", label: "settings", action: "down" }),
]);

/** While the viewed agent works: how to stop it, and that Enter queues. A
 *  hint without an action is informational (not clickable). */
export const BUSY_HINTS = Object.freeze([
  Object.freeze({ key: "Esc", label: "interrupt", action: "escape" }),
  Object.freeze({ key: "⏎", label: "queue" }),
  Object.freeze({ key: "^O", label: "block viewer", action: "ctrl+o" }),
]);

/** Render semantic key hints as a compact textual line.
 * @param {Array<{key: string, label: string}>} hints Hint records to display.
 * @returns {string} Hints joined with ` · `.
 */
function hintsText(hints) {
  return hints.map(({ key, label }) => `${key} ${label}`).join(" · ");
}

/** Read connected server names from the MCP tool in a catalog snapshot.
 * @param {object|null|undefined} catalog Catalog with an optional `tools` array.
 * @returns {string[]} Copy of connected names, or an empty array when unavailable.
 */
function connectedMcp(catalog) {
  const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
  const value = tools.find(({ name }) => name === "mcp")?.status?.connected;
  return Array.isArray(value) ? [...value] : [];
}

/** List configured MCP server names from environment settings.
 * @param {object|null|undefined} env Environment-like object with optional `settings.mcp` mapping.
 * @returns {string[]} Configured names, or an empty array when the mapping is absent or invalid.
 */
function configuredMcp(env) {
  const value = env?.settings?.mcp;
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

/** Convert live Agent/Env state to stable terminal-neutral status data.
 * @param {object} [options={}] Inputs for projection.
 * @param {object} [options.agent] Currently viewed agent, if any.
 * @param {object} [options.env] Environment providing agents and MCP settings.
 * @param {string} [options.cwd] Working-directory identity value; defaults to an empty string.
 * @param {object} [options.catalog] Tool catalog snapshot for MCP connection status.
 * @returns {object} Terminal-neutral status projection, including state, usage, hints, and plan data.
 */
export function statusData({ agent, env, cwd, catalog } = {}) {
  const agents = env?.agents?.() ?? (agent ? [agent] : []);
  const state = aggregateState(agents.map((item) => item?.busy || item?.ioState === "working" ? "working" : item?.ioState));
  const usage = agent?.usage ?? {};
  const viewedWorking = Boolean(agent?.busy || agent?.ioState === "working");
  const mcpConnected = connectedMcp(env);
  return {
    identity: { cwd: cwd ?? "" },
    // The per-agent setting chips (shared with App.Web's composer toolbar).
    chips: settingChips({
      ...modelParts(agent?.model), thinking: agent?.thinking ?? "default",
      safe: agent?.safe === true, sessionSave: agent?.context?.save,
    }),
    state,
    viewedWorking,
    throttledUntil: agent?.throttledUntil ?? null,
    backgroundIO: Boolean(agents.find((item) => item?.backgroundIOActive)?.backgroundIOActive),
    usage: {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cost: usage.cost ?? 0,
      context: agent?.contextUsage ?? { used: 0, total: null, approximate: true },
    },
    mcp: [...new Set([...configuredMcp(env), ...mcpConnected])].map((name) => ({ name, connected: mcpConnected.includes(name) })),
    plan: agent?.planUsage ?? null,
    error: null,
    keys: "default",
    hints: hintsText(viewedWorking ? BUSY_HINTS : SHORTCUT_HINTS),
    shortcutHints: viewedWorking ? BUSY_HINTS : SHORTCUT_HINTS,
    turnReadout: agent ? turnReadoutParts(agent) : { before: "", after: "" },
    contextPercent: contextPercent(agent),
    mcpLine: mcpLineText(env, catalog),
  };
}

/** `<label>: weekly 4.0K/131.1K (3.0%) · daily ...`, or just the quotas
 *  with no label — either way, no bare "plan:" prefix; the readout sits
 *  right beside the context counters, so that word is noise, not
 *  information. Most important quotas first (see sortedQuotaEntries),
 *  or null with no quotas (no line, no noise). The readout caps at
 *  PLAN_MAX_QUOTAS data points — past that the extra ones collapse into
 *  a `+N more` hint (the readout shares one line with the context
 *  gauge; a long plan dump would drown it). */
const PLAN_MAX_QUOTAS = 3;

/** Render the plan quotas as a compact status readout, showing at most three.
 * @param {object|null|undefined} plan Plan usage record with optional `label` and `quotas` mapping.
 * @returns {string|null} Compact quota readout, or null when no quotas are present.
 */
function planText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || Object.keys(quotas).length === 0) return null;
  const sorted = sortedQuotaEntries(quotas);
  const shown = sorted.slice(0, PLAN_MAX_QUOTAS);
  const parts = shown.map(([name, quota]) => formatQuotaText(name, quota));
  const more = sorted.length - shown.length;
  if (more > 0) parts.push(`+${more} more`);
  return `${plan.label ? `${plan.label}: ` : ""}${parts.join(" · ")}`;
}
