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

/** The epoch range an absolute reset can plausibly fall in: 2001-09-09
 *  (1e12 ms — anything smaller can't be epoch MILLISECONDS) through
 *  2286-11-20 (1e13 ms — anything larger can't be epoch SECONDS). */
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;

/** A reset value's absolute moment in epoch ms, or null. Accepts the two
 *  published shapes — an RFC 3339 timestamp (Anthropic's documented
 *  anthropic-ratelimit-*-reset family, Codex's reset_at) — and the
 *  unpublished numeric one (the subscription
 *  anthropic-ratelimit-unified-<window>-reset headers: bare Unix epoch
 *  values, SECONDS in observed captures like 1774933200, milliseconds on
 *  some deployments — the ~1000x gap lets magnitude pick the unit; only
 *  the plausible-epoch range converts, so a RELATIVE bare number — the
 *  IETF RateLimit-Reset convention's "seconds until reset" — stays a
 *  non-timestamp). Duration-shaped resets (OpenAI's "6m0s") and anything
 *  else return null. */
export function resetAtMs(reset) {
  if (typeof reset !== "string" || reset === "") return null;
  const text = reset.trim();
  // Bare numbers first (epoch s/ms — the branches below convert only the
  // plausible-epoch range, so a RELATIVE bare number — the IETF
  // RateLimit-Reset convention's "seconds until reset" — stays a
  // non-timestamp). Date.parse must NOT see them: it accepts a bare
  // 4+-digit run as a YEAR ("60" -> 0060 AD).
  if (text !== "" && !Number.isNaN(Number(text))) {
    const numeric = Number(text);
    if (numeric >= EPOCH_MS_MIN && numeric < EPOCH_MS_MAX) return numeric; // epoch ms
    if (numeric >= EPOCH_MS_MIN / 1000 && numeric < EPOCH_MS_MAX / 1000) return numeric * 1000; // epoch s
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "resets in <human>" — derived from a reset's absolute moment (see
 *  resetAtMs for the accepted shapes), never from windowSeconds alone
 *  (that's the window's full length, not when THIS cycle ends). null
 *  when there is no absolute moment (a duration-shaped reset — OpenAI's
 *  own "6m0s", say — already IS the answer in the provider's own words)
 *  or when the moment is already past: "resets now" says nothing the
 *  user can act on, so the countdown is simply omitted (see resetText).
 *  `minSeconds` raises that noise floor: a countdown closer than that
 *  many seconds away is omitted too (a "resets in 2s" flash just burns
 *  status-bar space). */
export function resetCountdown(reset, minSeconds = 0) {
  const at = resetAtMs(reset);
  if (at === null) return null;
  const seconds = (at - Date.now()) / 1000;
  return seconds <= minSeconds ? null : `resets in ${humanDuration(seconds)}`;
}

/** A duration-shaped reset's length in MILLISECONDS, or null. OpenAI's
 *  own `x-ratelimit-reset-*` values are Go-style durations ("120ms",
 *  "6m0s", "1h30m") — the provider's own answer to "how long until
 *  reset", never an absolute moment. The check is on the NUMERIC value
 *  (ms), never the printed text: a "120ms" is a sub-second blip that
 *  burns status-bar space, so resetText's `minSeconds` floor drops it
 *  just like a sub-floor countdown. */
export function resetDurationMs(reset) {
  if (typeof reset !== "string" || reset === "") return null;
  const text = reset.trim();
  // One or more <number><unit> segments, whole string consumed — no
  // partial matches ("6m0s" is 360000; "6m0x" is not a duration at all).
  const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  let total = 0, rest = text, matched = false;
  while (rest !== "") {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * UNITS[m[2]];
    rest = rest.slice(m[0].length);
    matched = true;
  }
  return matched ? total : null;
}

/** The display text for a quota's reset: the countdown for a parseable
 *  timestamp (ISO or epoch — see resetAtMs), `reset <raw>` verbatim for
 *  a duration-shaped one, or null when there is nothing meaningful to
 *  show (no reset, or a timestamp already past — "resets now" is
 *  noise). `minSeconds` is the noise floor in seconds: a countdown —
 *  AND a duration-shaped reset — closer than that shows nothing, since
 *  the space is better spent on the quota than on a blip that flashes
 *  by. The duration check reads the value's milliseconds, never the
 *  printed string. */
export function resetText(reset, minSeconds = 0) {
  if (typeof reset !== "string" || reset === "") return null;
  const countdown = resetCountdown(reset, minSeconds);
  if (countdown !== null) return countdown;
  if (resetAtMs(reset) !== null) return null; // a real timestamp, just past/too close
  const durationMs = resetDurationMs(reset);
  if (durationMs !== null && durationMs <= minSeconds * 1000) return null; // a sub-floor blip
  return `reset ${reset}`;
}

/** Sort key for "most important first": an actual time-to-reset wins —
 *  soonest first — over a mere window SIZE (smallest first), which wins
 *  over neither. Two-tier so the tiers never interleave by number (a
 *  30-day window's raw windowSeconds must still sort AFTER a
 *  5-minute-away reset). */
function quotaImportance(quota) {
  const resetAt = resetAtMs(quota?.reset) ?? NaN;
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

/** The per-agent setting chips both front ends show by the composer, in
 *  display order: endpoint, model, thinking, safe mode, session logging. Each chip is
 *  `{key, icon, label, title, action, active, warn, pressed?}`: `title`
 *  states the setting, `action` names what activating the chip does (the
 *  front end supplies the gesture — "click to …", "⏎ …" — and runs it),
 *  `active`/`warn` ask for emphasis, and toggles carry `pressed` (their on
 *  state). `sessionSave`: whether the session is logged (turning logging on
 *  writes the whole conversation so far). */
export function settingChips({ endpoint, model, thinking = "default", safe = false, sessionSave = false } = {}) {
  const logging = sessionSave === true;
  return [
    {
      key: "endpoint", icon: "◎", label: endpoint ? String(endpoint) : "Choose endpoint",
      title: endpoint ? `Endpoint: ${endpoint}` : "No endpoint selected",
      action: endpoint ? "switch endpoint" : "choose an endpoint", active: false, warn: false,
    },
    {
      key: "model", icon: "◇", label: endpoint ? String(model ?? "?") : "Choose model",
      title: endpoint ? `Model: ${endpoint}/${model ?? "?"}` : "No model selected",
      action: endpoint ? "switch model" : "choose a model", active: false, warn: false,
    },
    {
      key: "thinking", icon: "✦", label: thinking === "default" ? "Think: auto" : `Think: ${thinking}`,
      title: thinking === "default" ? "Thinking level: provider default" : `Thinking level: ${thinking}`,
      action: "change the thinking level", active: thinking !== "default" && thinking !== "none", warn: false,
    },
    {
      key: "safe", icon: safe ? "🔒" : "🔓", label: safe ? "Read-only" : "Read/write",
      title: safe ? "Safe mode on: only read-only tools run" : "Tools may write",
      action: safe ? "allow writes" : "switch to read-only safe mode", active: safe, warn: safe, pressed: safe,
    },
    {
      key: "logging", icon: "📝", label: logging ? "Logging" : "No-log",
      title: logging ? "Session is saved to disk" : "Not logged: nothing is written to disk",
      action: logging ? "pause logging" : "log this conversation",
      active: !logging, warn: !logging, pressed: logging,
    },
  ];
}
