/** Canonical quota snapshots (private to Context); provider wire translation stays in IO. */
import { usageDetails } from "./usage-data.js";

const UNITS = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
const FIELDS = {
  total: ["limit"], used: [], remaining: [], unit: [], reset: ["reset_at", "resetAt", "reset_time", "resetTime"],
  windowSeconds: ["window_seconds", "limit_window_seconds"], status: [], allowed: [], limitReached: ["limit_reached"],
};
const PERCENT_FIELDS = ["used_percent", "usedPercent", "used_ratio", "usedRatio", "utilization"];
const CONSUMED = new Set([...Object.keys(FIELDS), ...Object.values(FIELDS).flat(), ...PERCENT_FIELDS]);
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function number(value) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function windowSecondsOf(name) {
  const match = /^(\d+)([dhms])$/i.exec(name);
  const value = match ? Number(match[1]) * UNITS.find(([unit]) => unit === match[2].toLowerCase())[1] : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resetOf(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const epoch = number(value);
  if (epoch >= 1e9 && epoch < 1e10) return new Date(epoch * 1000).toISOString();
  if (epoch >= 1e12 && epoch < 1e13) return new Date(epoch).toISOString();
  return typeof value === "string" ? value : undefined;
}

function fieldOf(key, value) {
  if (["total", "used", "remaining"].includes(key)) return number(value);
  if (key === "windowSeconds") {
    const seconds = number(value);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
  }
  if (key === "reset") return resetOf(value);
  if (["allowed", "limitReached"].includes(key)) return typeof value === "boolean" ? value : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function quotaNormalize(input, name = "") {
  const quota = record(input);
  const result = {};
  for (const [key, aliases] of Object.entries(FIELDS)) {
    for (const field of [key, ...aliases]) {
      const value = fieldOf(key, quota[field]);
      if (value !== undefined) { result[key] = value; break; }
    }
  }
  if (result.windowSeconds === undefined) {
    const seconds = windowSecondsOf(name);
    if (seconds !== undefined) result.windowSeconds = seconds;
  }
  // Explicit used/remaining counts win. A ratio may fill absent counts against
  // a reported total; a ratio with no total is a percentage, not a token count.
  if (result.used === undefined && result.remaining === undefined) {
    for (const field of PERCENT_FIELDS) {
      const value = number(quota[field]);
      if (value === undefined) continue;
      const fraction = Math.min(1, ["used_percent", "usedPercent"].includes(field) ? value / 100 : value);
      const total = result.total ?? 100;
      const used = total * fraction;
      if (result.total === undefined) result.unit ??= "percent";
      Object.assign(result, { total, used, remaining: total - used });
      break;
    }
  }
  for (const [key, value] of Object.entries(quota)) {
    if (!CONSUMED.has(key) && !FORBIDDEN.has(key)) result[key] = value;
  }
  return result;
}

function headersNormalize(details, plan) {
  for (const [key, value] of Object.entries(details)) {
    const match = /^anthropic-ratelimit-unified-(?:(.+)-)?(utilization|status|reset|representative-claim|fallback-percentage)$/i.exec(key);
    if (!match) continue;
    const scope = match[1]?.toLowerCase();
    const field = match[2].toLowerCase();
    const seconds = windowSecondsOf(scope ?? "");
    // Overage is account policy, not a third rolling-window quota.
    if (scope && scope !== "overage" && seconds === undefined) continue;
    let name;
    let parsed;
    if (field === "utilization" && scope) {
      const ratio = number(value);
      if (ratio !== undefined) {
        name = "utilization";
        parsed = ratio;
      }
    } else if (field === "status" || field === "reset") {
      name = field;
      parsed = fieldOf(field, value);
    } else if (!scope && field === "representative-claim") {
      name = "representativeClaim";
      parsed = fieldOf("status", value);
    } else if (!scope && field === "fallback-percentage") {
      name = "fallbackPercentage";
      parsed = number(value);
    }
    if (parsed === undefined) continue;
    if (seconds !== undefined && !Object.hasOwn(plan.quotas, scope) && Object.keys(plan.quotas).length >= 32) continue;
    if (scope === "overage" && plan.overage !== undefined && (plan.overage === null || typeof plan.overage !== "object" || Array.isArray(plan.overage))) continue;
    const target = seconds !== undefined ? (plan.quotas[scope] ??= {}) : scope === "overage" ? (plan.overage ??= {}) : plan;
    // Explicit canonical values outrank the raw header alias. A missing/invalid
    // canonical field may still be filled from a valid provider alias.
    const canonicalField = name === "representativeClaim" ? "status" : name === "fallbackPercentage" ? "used" : name;
    if (target[name] === undefined || name !== "utilization" && fieldOf(canonicalField, target[name]) === undefined) target[name] = parsed;
    delete details[key];
  }
}

/**
 * Normalize a complete provider plan report into an independent bounded snapshot.
 * Accept canonical quotas and common snake-case/count/percentage aliases; explicit
 * canonical fields win. Durations use positive whole seconds; resets are separate
 * epoch/ISO/duration values, never inferred from window size. Consume understood
 * Anthropic unified headers from details, retaining unknown/invalid header values.
 * Preserve bounded unknown extensions and false/zero/null; do not mutate or retain
 * input. Idempotent, no side effects, no failures for JSON data. Snapshot work is
 * bounded by usageDetails (256 nodes, depth 6) and 32 quota entries.
 * @param {*} reported Complete quota/metadata report, not lifetime token usage.
 * @returns {object} Canonical plan with quotas, optional label/account state/details.
 */
export function planUsageNormalize(reported) {
  const input = record(reported);
  // Bound the entire quota map at once, not 32 independently large subtrees.
  const quotas = {};
  let count = 0;
  for (const name in record(input.quotas)) {
    if (++count > 32) break;
    if (Object.hasOwn(input.quotas, name) && !FORBIDDEN.has(name) && name.length <= 128 && input.quotas[name] !== null && typeof input.quotas[name] === "object" && !Array.isArray(input.quotas[name])) quotas[name] = input.quotas[name];
  }
  const fields = {};
  let scanned = 0;
  for (const key in input) {
    if (++scanned > 256) break;
    if (Object.hasOwn(input, key) && key !== "quotas" && !FORBIDDEN.has(key)) fields[key] = input[key];
  }
  const result = usageDetails(fields) ?? {};
  if (typeof result.label !== "string" || result.label === "") delete result.label;
  result.quotas = usageDetails(quotas) ?? {};
  result.details = record(result.details);
  headersNormalize(result.details, result);
  for (const [name, quota] of Object.entries(result.quotas)) result.quotas[name] = quotaNormalize(quota, name);
  result.quotas = usageDetails(result.quotas);
  for (const key of ["status", "allowed", "limitReached", "reset"]) {
    const value = fieldOf(key, result[key]);
    delete result[key];
    if (value !== undefined) result[key] = value;
  }
  if (result.overage !== null && typeof result.overage === "object" && !Array.isArray(result.overage)) result.overage = quotaNormalize(result.overage);
  // Preserve an explicitly supplied empty details map for compatibility.
  if (Object.keys(result.details).length === 0 && input.details === undefined) delete result.details;
  return result;
}
