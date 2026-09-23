/** AI status and usage projection. Formatting, clipping, animation, and width belong to GTUI. */

import { homedir } from "node:os";

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

/** The RIGHT-aligned turn readout every legacy footer shows: `context: <used>/<total> (<pct>)` plus ` · plan: <pct>` once the provider reports a quota. Content policy, not width — GTUI clips the line to fit. */
export function turnReadoutText(agent) {
  const report = agent.contextUsage ?? { used: 0, total: null, approximate: true };
  const usedText = `${report.approximate ? "~" : ""}${humanTokens(report.used)}`;
  const context = Number.isFinite(report.total) && report.total > 0
    ? `context: ${usedText}/${humanTokens(report.total)} (${((report.used / report.total) * 100).toFixed(1)}%)`
    : `context: ${usedText} tokens`;
  const plan = planPercentText(agent.planUsage);
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

/** `{used, total}` for a quota that has both, or null (not enough to size a percentage). */
function quotaUsedTotal(quota) {
  const total = Number.isFinite(quota?.total) && quota.total > 0 ? quota.total : null;
  if (total === null) return null;
  const used = Number.isFinite(quota?.used) ? quota.used : Number.isFinite(quota?.remaining) ? total - quota.remaining : null;
  return used === null ? null : { used, total };
}

/** A quota amount as currency when `unit` names one (a prepaid wallet
 *  balance, e.g. Kimi's — no token total to divide by, so it never
 *  reaches the percentage branch below), else the usual token count. */
function formatAmount(value, unit) {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  if (unit === "cny") return `¥${value.toFixed(2)}`;
  return humanTokens(value);
}

/** Sort key for "most important first": an actual time-to-reset wins —
 *  sorted soonest-first — over a mere window SIZE (smallest first),
 *  which wins over neither (kept in original/insertion order last).
 *  Two-tier so the tiers themselves never interleave by number
 *  (a 30-day window's raw windowSeconds is a huge number that must
 *  still sort AFTER a 5-minute-away reset, not before it). */
function quotaImportance(quota) {
  const resetAt = typeof quota?.reset === "string" ? Date.parse(quota.reset) : NaN;
  if (Number.isFinite(resetAt)) return [0, resetAt];
  if (Number.isFinite(quota?.windowSeconds)) return [1, quota.windowSeconds];
  return [2, 0];
}

/** `[[name, quota], ...]` ordered by quotaImportance — stable: entries
 *  tied on both tiers (most commonly, both tier 2: no reset, no
 *  window) keep their original/insertion order rather than being
 *  shuffled by an arbitrary tiebreak. */
export function sortedQuotaEntries(quotas) {
  return Object.entries(quotas ?? {})
    .map((entry, index) => ({ entry, index, key: quotaImportance(entry[1]) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ entry }) => entry);
}

/** 18000 -> "5h", 90 -> "1m30s", 3661 -> "1h1m" — coarse-to-fine, at most
 *  two units (finer ones are noise once a coarser one is shown). */
function humanDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const units = d ? [[d, "d"], [h, "h"]] : h ? [[h, "h"], [m, "m"]] : m ? [[m, "m"], [s % 60, "s"]] : [[s, "s"]];
  return units.filter(([n], i) => n > 0 || i === 0).map(([n, suffix]) => `${n}${suffix}`).join("");
}

/** "resets in <human>" — derived from a reset TIMESTAMP (an absolute
 *  Date-parseable string, e.g. Anthropic/Codex's own ISO reset), never
 *  from windowSeconds alone (that's the window's full length, not when
 *  THIS cycle ends). null when it doesn't parse as a date: a
 *  duration-shaped reset (OpenAI's own "6m0s", say) already IS the
 *  answer in the provider's own words — the caller falls back to
 *  showing it verbatim rather than risk misreading an unfamiliar
 *  format. */
export function resetCountdown(reset) {
  if (typeof reset !== "string" || reset === "") return null;
  const at = Date.parse(reset);
  if (!Number.isFinite(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  return seconds <= 0 ? "resets now" : `resets in ${humanDuration(seconds)}`;
}

/** One plan quota line: `weekly 4.0K/131.1K (3.0%) · resets in 2h15m`
 *  (falling back to `· reset <raw>` when the reset string isn't a
 *  parseable timestamp — see resetCountdown). */
export function formatQuotaText(name, quota) {
  const ut = quotaUsedTotal(quota);
  const reset = quota?.reset ? ` · ${resetCountdown(quota.reset) ?? `reset ${quota.reset}`}` : "";
  if (ut) return `${name} ${humanTokens(ut.used)}/${humanTokens(ut.total)} (${((ut.used / ut.total) * 100).toFixed(1)}%)${reset}`;
  if (Number.isFinite(quota?.remaining)) return `${name} ${formatAmount(quota.remaining, quota?.unit)} left${reset}`;
  if (Number.isFinite(quota?.used)) return `${name} ${formatAmount(quota.used, quota?.unit)}${reset}`;
  return `${name}${reset}`;
}

/** Compact percentage-only plan readout for the turn line, most
 *  important quota first (see sortedQuotaEntries): `plan: 5h 3.0% ·
 *  tokens 12.1%`; null when no quota can size a percentage (no total —
 *  e.g. a currency balance — no line, no noise). */
function planPercentText(plan) {
  const quotas = plan?.quotas;
  if (!quotas) return null;
  const parts = sortedQuotaEntries(quotas)
    .map(([name, quota]) => {
      const ut = quotaUsedTotal(quota);
      return ut ? `${name} ${((ut.used / ut.total) * 100).toFixed(1)}%` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? `plan: ${parts.join(" · ")}` : null;
}

/** The key-hints line: semantic key/action data; views decide presentation. */
export const SHORTCUT_HINTS = Object.freeze([
  Object.freeze({ key: "^X", label: "menu", action: "ctrl+x" }),
  Object.freeze({ key: "^O", label: "block viewer", action: "ctrl+o" }),
  Object.freeze({ key: "^P", label: "provider", action: "ctrl+p" }),
  Object.freeze({ key: "^M", label: "models", action: "ctrl+m" }),
]);

function hintsText() {
  return SHORTCUT_HINTS.map(({ key, label }) => `${key} ${label}`).join(" · ");
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
  const state = agents.some((item) => item?.ioState === "disconnected")
    ? "disconnected"
    : agents.some((item) => item?.busy || item?.ioState === "working") ? "working" : "idle";
  const usage = agent?.usage ?? {};
  const mcpConnected = connectedMcp(env);
  return {
    identity: { combo: combo ?? "", cwd: cwd ?? "" },
    safe: agent?.safe === true,
    thinking: agent?.thinking ?? "default",
    state,
    viewedWorking: Boolean(agent?.busy || agent?.ioState === "working"),
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
    hints: hintsText(),
    shortcutHints: SHORTCUT_HINTS,
    turnReadout: agent ? turnReadoutText(agent) : "",
    mcpLine: mcpLineText(env),
    planLine: planLineText(agent?.planUsage),
  };
}

/** `plan (<label>): weekly 4.0K/131.1K (3.0%) · daily ...` — one joined
 *  line, most important quota first (see sortedQuotaEntries), or null
 *  with no quotas (no line, no noise). */
function planLineText(plan) {
  const quotas = plan?.quotas;
  if (!quotas || Object.keys(quotas).length === 0) return null;
  const parts = sortedQuotaEntries(quotas).map(([name, quota]) => formatQuotaText(name, quota));
  return `plan${plan.label ? ` (${plan.label})` : ""}: ${parts.join(" · ")}`;
}
