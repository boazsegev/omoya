/** AI status and usage projection. Formatting, clipping, animation, and width belong to GTUI. */

import { homedir } from "node:os";
import { aggregateState, formatAmount, quotaUsedTotal, resetCountdown, sortedQuotaEntries } from "../shared/format.js";

/** Historical status contract: the working-folder field gets at most 24 display columns. */
export const CWD_COLUMNS = 24;

/** Home-tilde'd working folder (content substitution only — WIDTH-based
 *  clipping is GTUI's row/text `overflow` job, never tui-app's: it
 *  bounds to the box GTUI actually laid out, not a guessed budget). */
export function cwdShortText(path) {
  const home = homedir();
  const s = String(path ?? "");
  return home !== "/" && (s === home || s.startsWith(`${home}/`)) ? `~${s.slice(home.length)}` : s;
}

/** Human-readable token count: 950 -> "950", 4100 -> "4.0K" (1024-based, one decimal). */
export function humanTokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Context window use in percent, or null when the window size is unknown. */
export function contextPercent(agent) {
  const report = agent?.contextUsage;
  return Number.isFinite(report?.total) && report.total > 0 ? (report.used / report.total) * 100 : null;
}

/** The RIGHT-aligned turn readout: `<pct>% · <used>/<total>` (the view
 *  draws the context gauge before it) or `<used> tokens` when the window
 *  size is unknown, then the provider's plan once it reports quotas —
 *  ` · plan (<label>): 5h 2.0K/100K (2.0%) · resets in 2h · …` (see
 *  planText). The plan appears here only, never on a line of its own.
 *  Content policy, not width — GTUI clips the line to fit. */
export function turnReadoutText(agent) {
  const report = agent.contextUsage ?? { used: 0, total: null, approximate: true };
  const usedText = `${report.approximate ? "~" : ""}${humanTokens(report.used)}`;
  const percent = contextPercent(agent);
  const context = percent !== null
    ? `${percent.toFixed(1)}% · ${usedText}/${humanTokens(report.total)}`
    : `${usedText} tokens`;
  const plan = planText(agent.planUsage);
  return `${context}${plan ? ` · ${plan}` : ""}`;
}

/** `mcp: name (connected) · name` — configured servers with the live pool's marked; null when none configured/connected (no line, no noise). */
export function mcpLineText(env) {
  const configured = env?.settings?.mcp;
  const names = configured && typeof configured === "object" && !Array.isArray(configured) ? Object.keys(configured) : [];
  const live = connectedMcp(env);
  const all = [...new Set([...names, ...live])];
  if (all.length === 0) return null;
  return `mcp: ${all.map((name) => (live.includes(name) ? `${name} (connected)` : name)).join(" · ")}`;
}

/** One plan quota line: `weekly 4.0K/131.1K (3.0%) · resets in 2h15m`
 *  (falling back to `· reset <raw>` when the reset string isn't a
 *  parseable timestamp — see resetCountdown). */
export function formatQuotaText(name, quota) {
  const ut = quotaUsedTotal(quota);
  const reset = quota?.reset ? ` · ${resetCountdown(quota.reset) ?? `reset ${quota.reset}`}` : "";
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
]);

/** While the viewed agent works: how to stop it, and that Enter queues. A
 *  hint without an action is informational (not clickable). */
export const BUSY_HINTS = Object.freeze([
  Object.freeze({ key: "Esc", label: "interrupt", action: "escape" }),
  Object.freeze({ key: "⏎", label: "queue" }),
  Object.freeze({ key: "^O", label: "block viewer", action: "ctrl+o" }),
]);

function hintsText(hints) {
  return hints.map(({ key, label }) => `${key} ${label}`).join(" · ");
}

function connectedMcp(env) {
  const value = env?.toolEntry?.("mcp")?.status?.connected;
  return Array.isArray(value) ? [...value] : [];
}

function configuredMcp(env) {
  const value = env?.settings?.mcp;
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

/** Convert live Agent/Env state to stable terminal-neutral status data. */
export function statusData({ agent, env, combo, cwd } = {}) {
  const agents = env?.agents?.() ?? (agent ? [agent] : []);
  const state = aggregateState(agents.map((item) => item?.busy || item?.ioState === "working" ? "working" : item?.ioState));
  const usage = agent?.usage ?? {};
  const viewedWorking = Boolean(agent?.busy || agent?.ioState === "working");
  const mcpConnected = connectedMcp(env);
  return {
    identity: { combo: combo ?? "", cwd: cwd ?? "" },
    safe: agent?.safe === true,
    thinking: agent?.thinking ?? "default",
    state,
    viewedWorking,
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
    turnReadout: agent ? turnReadoutText(agent) : "",
    contextPercent: contextPercent(agent),
    mcpLine: mcpLineText(env),
  };
}

/** `plan (<label>): weekly 4.0K/131.1K (3.0%) · daily ...` — one joined
 *  line, most important quota first (see sortedQuotaEntries), or null
 *  with no quotas (no line, no noise). */
function planText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || Object.keys(quotas).length === 0) return null;
  const parts = sortedQuotaEntries(quotas).map(([name, quota]) => formatQuotaText(name, quota));
  return `plan${plan.label ? ` (${plan.label})` : ""}: ${parts.join(" · ")}`;
}
