/** Shared usage schema, bounded extension snapshots, and counter arithmetic (private to Context). */
const COUNTERS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "uncachedInputTokens", "reasoningTokens", "cost"];
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype", "attribution"]);
const ALIASES = {
  inputTokens: ["input_tokens", "prompt_tokens", "total_input_tokens", "prompt_eval_count"],
  outputTokens: ["output_tokens", "completion_tokens", "total_output_tokens", "eval_count"],
  cacheReadTokens: ["input_tokens_details.cached_tokens", "prompt_tokens_details.cached_tokens", "cache_read_input_tokens", "cached_tokens"],
  cacheWriteTokens: ["input_tokens_details.cache_write_tokens", "prompt_tokens_details.cache_write_tokens", "cache_creation_input_tokens"],
  cacheWrite5mTokens: ["cache_creation.ephemeral_5m_input_tokens"],
  cacheWrite1hTokens: ["cache_creation.ephemeral_1h_input_tokens"],
  uncachedInputTokens: [],
  reasoningTokens: ["output_tokens_details.reasoning_tokens", "completion_tokens_details.reasoning_tokens", "output_tokens_details.thinking_tokens", "completion_tokens_details.thinking_tokens", "reasoning_tokens", "thinking_tokens", "total_thought_tokens"],
  serviceTier: ["service_tier"],
  inferenceGeo: ["inference_geo"],
};
const CONTAINERS = new Set(Object.values(ALIASES).flat().filter((path) => path.includes(".")).map((path) => path.split(".")[0]));
const CONSUMED = new Set([...COUNTERS, "totalTokens", "total_tokens", "source", "details", ...Object.keys(ALIASES), ...Object.values(ALIASES).flat().filter((path) => !path.includes(".")), ...CONTAINERS]);

/**
 * Copy bounded JSON-safe usage/plan extensions, omitting invalid values, cycles,
 * attribution and prototype keys. Limits: 256 nodes, depth 6, 16 array entries,
 * 1024 characters/string, 128/key and 16K total text. Truncation adds no counters.
 * @param {*} value Untrusted details; neither mutated nor retained.
 * @returns {*} Independent bounded JSON value, or undefined for unsupported input.
 * @effects None. Idempotent; no failures for JSON data. Work is bounded by these limits.
 */
export function usageDetails(value) {
  const seen = new WeakSet();
  let nodes = 256;
  let characters = 16384;
  function copy(item, depth) {
    if (nodes-- <= 0 || depth > 6 || characters <= 0) return undefined;
    if (item === null || typeof item === "boolean" || Number.isFinite(item)) return item;
    if (typeof item === "string") {
      const text = item.slice(0, Math.min(1024, characters));
      characters -= text.length;
      return text;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      const result = [];
      for (let index = 0; index < Math.min(item.length, 16) && nodes > 0 && characters > 0; index++) {
        const child = copy(item[index], depth + 1);
        if (child !== undefined) result.push(child);
      }
      return result;
    }
    const result = {};
    let scanned = 0;
    for (const key in item) {
      if (++scanned > 256 || nodes <= 0 || characters <= 0) break;
      if (!Object.hasOwn(item, key) || FORBIDDEN.has(key) || key.length > 128) continue;
      characters -= key.length;
      const child = copy(item[key], depth + 1);
      if (child !== undefined) result[key] = child;
    }
    return result;
  }
  return copy(value, 0);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pathValue(value, path) {
  for (const key of path.split(".")) value = record(value)[key];
  return value;
}

/**
 * Normalize a request's usage without estimating tokens. Canonical fields outrank
 * aliases; cache/reasoning detail fields outrank legacy root fields, reasoning
 * outranks thinking. All token counts include cached/reasoning subsets, not extras.
 * Unknown extensions become bounded latest-report `details`; consumed aliases disappear.
 * @param {*} reported Provider data; neither mutated nor retained. Invalid fields are omitted.
 * @returns {object} Independent snapshot with nonnegative counters, finite reported cost,
 * derived totalTokens, optional serviceTier/inferenceGeo and bounded details. Idempotent.
 * @effects None. No failures for JSON input; detail processing is bounded.
 */
export function usageNormalize(reported) {
  const input = record(reported);
  const result = {};
  for (const [key, paths] of Object.entries(ALIASES)) {
    const metadata = key === "serviceTier" || key === "inferenceGeo";
    for (const path of [key, ...paths]) {
      const value = pathValue(input, path);
      if (metadata ? typeof value === "string" && value !== "" : Number.isFinite(value) && value >= 0) {
        result[key] = metadata ? value.slice(0, 1024) : value;
        break;
      }
    }
  }
  if (Number.isFinite(input.cost)) result.cost = input.cost;
  if (result.cacheWriteTokens === undefined && (result.cacheWrite5mTokens !== undefined || result.cacheWrite1hTokens !== undefined)) {
    result.cacheWriteTokens = (result.cacheWrite5mTokens ?? 0) + (result.cacheWrite1hTokens ?? 0);
  }
  if (Number.isFinite(result.inputTokens) && Number.isFinite(result.outputTokens)) result.totalTokens = result.inputTokens + result.outputTokens;
  if (input.source === "provider" || input.source === "estimate") result.source = input.source;
  // Select extensions without enumerating or visiting attribution contents. Bound
  // traversal before copying large objects; known nested siblings survive once.
  const extensions = {};
  const rawDetails = usageDetails(record(input.details));
  Object.assign(extensions, rawDetails);
  let scanned = 0;
  for (const key in input) {
    if (++scanned > 256) break;
    if (!Object.hasOwn(input, key) || CONSUMED.has(key) || FORBIDDEN.has(key) || key.length > 128) continue;
    extensions[key] = input[key];
  }
  for (const container of CONTAINERS) {
    const extra = {};
    const consumed = new Set(Object.values(ALIASES).flat().filter((path) => path.startsWith(`${container}.`)).map((path) => path.split(".")[1]));
    let scanned = 0;
    for (const key in record(input[container])) {
      if (++scanned > 256) break;
      if (!Object.hasOwn(input[container], key) || consumed.has(key) || FORBIDDEN.has(key)) continue;
      extra[key] = input[container][key];
    }
    if (Object.keys(extra).length > 0) extensions[container] = extra;
  }
  const details = usageDetails(extensions);
  if (Object.keys(details).length > 0) result.details = details;
  return result;
}

/**
 * Add one request report to lifetime usage. Sum only schema counters; recompute
 * totalTokens; replace (and clear absent) metadata/details with the latest report.
 * @param {object} total Previous totals; neither mutated nor retained.
 * @param {*} reported Request usage, normalized or wire-shaped; never retained.
 * @returns {object} New independent totals. Non-idempotent: call once per billed attempt.
 * @effects None. Invalid reports are ignored; no failures for JSON input.
 */
export function usageAdd(total, reported) {
  if (reported === null || typeof reported !== "object" || Array.isArray(reported)) return usageDetails(total);
  const next = usageNormalize(total);
  const report = usageNormalize(reported);
  for (const key of COUNTERS) {
    if (Number.isFinite(report[key])) next[key] = (next[key] ?? 0) + report[key];
  }
  next.totalTokens = (next.inputTokens ?? 0) + (next.outputTokens ?? 0);
  for (const key of ["serviceTier", "inferenceGeo", "details"]) {
    delete next[key];
    if (report[key] !== undefined) next[key] = report[key];
  }
  delete next.source;
  return next;
}
