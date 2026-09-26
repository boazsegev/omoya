/**
 * lib/app/shared/format.js — presentation text both front ends share.
 *
 * Browser-safe and import-free: App.TUI imports it, and App.Web serves this
 * same file to the SPA at /format.js. Content policy only — never width,
 * color, or layout (each front end owns those).
 */

/** Argument keys that name what a tool call is ABOUT, most telling first. */
const SUMMARY_KEYS = ["command", "cmd", "path", "file", "file_path", "query", "url", "pattern", "name", "prompt", "question"];

/** Parse a JSON object/array string; anything else comes back unchanged. */
export function parseArgs(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return JSON.parse(text); } catch { return value; }
}

/**
 * A tool call's one-line human summary: the first string field that names
 * its subject (a command, path, query …) rather than a JSON dump —
 * preferred keys first, then the first string anywhere (depth-first).
 * Whitespace collapses; the result is clipped to `max` characters.
 * @param {unknown} args - arguments object or its JSON text
 * @param {number} [max]
 * @returns {string}
 */
export function toolSummary(args, max = 96) {
  const value = parseArgs(args);
  const find = (item, depth) => {
    if (typeof item === "string" || typeof item === "number") return String(item);
    if (!item || typeof item !== "object" || depth > 3) return "";
    const key = Array.isArray(item) ? null : SUMMARY_KEYS.find((k) => typeof item[k] === "string");
    if (key) return item[key];
    for (const entry of Object.values(item)) { const found = find(entry, depth + 1); if (found) return found; }
    return "";
  };
  const summary = find(value, 0).replace(/\s+/g, " ").trim();
  return summary.length > max ? `${summary.slice(0, max - 1)}…` : summary;
}

/** 12 -> "12ms", 4200 -> "4.2s", 95000 -> "1m35s". */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/** 512 -> "512 B", 12000 -> "12 KB", 3500000 -> "3.3 MB". */
export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

/** 18000 -> "5h", 90 -> "1m30s", 3661 -> "1h1m" — coarse-to-fine, at most
 *  two units (finer ones are noise once a coarser one is shown). */
export function humanDuration(seconds) {
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
 *  answer in the provider's own words — callers show it verbatim. */
export function resetCountdown(reset) {
  if (typeof reset !== "string" || reset === "") return null;
  const at = Date.parse(reset);
  if (!Number.isFinite(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  return seconds <= 0 ? "resets now" : `resets in ${humanDuration(seconds)}`;
}

/** Sort key for "most important first": an actual time-to-reset wins —
 *  soonest first — over a mere window SIZE (smallest first), which wins
 *  over neither. Two-tier so the tiers never interleave by number (a
 *  30-day window's raw windowSeconds must still sort AFTER a
 *  5-minute-away reset). */
function quotaImportance(quota) {
  const resetAt = typeof quota?.reset === "string" ? Date.parse(quota.reset) : NaN;
  if (Number.isFinite(resetAt)) return [0, resetAt];
  if (Number.isFinite(quota?.windowSeconds)) return [1, quota.windowSeconds];
  return [2, 0];
}

/** `[[name, quota], ...]` ordered by importance — stable: ties keep their
 *  insertion order rather than an arbitrary tiebreak. */
export function sortedQuotaEntries(quotas) {
  return Object.entries(quotas ?? {})
    .map((entry, index) => ({ entry, index, key: quotaImportance(entry[1]) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map(({ entry }) => entry);
}

/** `{used, total}` for a quota that has both, or null (not enough to size a percentage). */
export function quotaUsedTotal(quota) {
  const total = Number.isFinite(quota?.total) && quota.total > 0 ? quota.total : null;
  if (total === null) return null;
  const used = Number.isFinite(quota?.used) ? quota.used : Number.isFinite(quota?.remaining) ? total - quota.remaining : null;
  return used === null ? null : { used, total };
}

/** A quota amount as currency when `unit` names one (a prepaid wallet
 *  balance, e.g. Kimi's — no token total to divide by), else
 *  `formatNumber(value)`. */
export function formatAmount(value, unit, formatNumber = String) {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  if (unit === "cny") return `¥${value.toFixed(2)}`;
  return formatNumber(value);
}

/** One global state for many agents' "idle" | "working" | "disconnected":
 *  any working agent wins, then any disconnected one, else idle — so a stale
 *  disconnect never hides live work elsewhere. */
export function aggregateState(states) {
  const list = [...states];
  if (list.includes("working")) return "working";
  return list.includes("disconnected") ? "disconnected" : "idle";
}
