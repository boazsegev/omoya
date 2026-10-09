/**
 * lib/usage.js — usage accounting.
 *
 * Trust provider-reported usage numbers; when absent, estimate from
 * the larger of word count × token-per-word likelihood ratio and
 * characters / 4 (unspaced JSON/code cannot count as a single token).
 *
 * Normalized usage envelope (rides in the terminal done/error event):
 *   { inputTokens, outputTokens, totalTokens, source: "provider" | "estimate", cost?,
 *     cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, serviceTier?, inferenceGeo?, details? }
 * Connectors attach provider-reported numbers (cost rides along when
 * the provider reports one); IO fills the fallback via finalizeUsage
 * — this is the whole of IO's job, PER TURN. Agent sums that
 * envelope across every request it makes (lib/agent.js's `usage`
 * getter) — nothing here or in Env persists it (no usage.json).
 * Human-facing diagnostic formatting belongs to the App layer.
 */

import { usageNormalize, usageDetails } from "./usage-data.js";

/** tokens ≈ words × 4/3 (token-per-word likelihood ratio) */
export const TOKENS_PER_WORD = 4 / 3;

/**
 * Test whether a UTF-16 code unit is one of the whitespace characters used
 * by the estimator. Includes common ASCII whitespace and selected Unicode
 * separators; this intentionally is not a complete JavaScript `\\s` test.
 * @param {number} code - UTF-16 code unit value to test
 * @returns {boolean} whether `code` is treated as whitespace
 */
function isSpace(code) {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/**
 * Count runs of non-whitespace characters without allocating a split array.
 * Non-string and empty inputs produce zero.
 * @param {*} text - value to count when it is a string
 * @returns {number} number of whitespace-separated words
 */
export function wordCount(text) {
  if (typeof text !== "string" || text === "") return 0;
  // Transition counting never materializes the split() word array — a
  // 1MB context message costs a scan, not ~200k throwaway strings.
  let words = 0;
  let inWord = false;
  for (let index = 0; index < text.length; index++) {
    if (isSpace(text.charCodeAt(index))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

/**
 * Estimate tokens for text, accounting for long unbroken strings such as JSON,
 * code, base64, and CJK. This is a conservative budget heuristic, not a
 * provider tokenizer. Non-string inputs produce zero.
 * @param {*} text - value to estimate when it is a string
 * @returns {number} unrounded token estimate
 */
function estimatedTextTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.max(wordCount(text) * TOKENS_PER_WORD, text.length / 4);
}

/**
 * Estimate a token count for text, rounding the heuristic up to a whole token.
 * Non-string inputs produce zero.
 * @param {*} text - value to estimate when it is a string
 * @returns {number} estimated whole-token count
 */
export function estimateTokens(text) {
  return Math.ceil(estimatedTextTokens(text));
}

/**
 * Concatenate string `text` and `arguments` fields from a message's content
 * blocks, separating included fields with spaces. Invalid/missing content
 * yields an empty string; other block fields are ignored.
 * @param {*} msg - message-like value whose `content` may be an array
 * @returns {string} concatenated text from supported content-block fields
 */
function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return "";
  let out = "";
  for (const block of msg.content) {
    if (block && typeof block.text === "string") out += block.text + " ";
    if (block && typeof block.arguments === "string") out += block.arguments + " ";
  }
  return out;
}

/**
 * Sum unrounded token estimates for string `text` and `arguments` fields in
 * a message's content blocks without constructing a combined string.
 * Invalid/missing content yields zero; other block fields are ignored.
 * @param {*} msg - message-like value whose `content` may be an array
 * @returns {number} unrounded estimated token total
 */
function messageTokens(msg) {
  if (!msg || !Array.isArray(msg.content)) return 0;
  let tokens = 0;
  for (const block of msg.content) tokens += blockTokensMemo(block);
  return tokens;
}

// Context message/block reads are LIVE: callers may edit fields or push blocks
// in place. Only string values are immutable, not their containing arrays.
const blockEstimates = new WeakMap();

/** Estimate one block, validating current string values before reusing scans. */
function blockTokensMemo(block) {
  if (!block || typeof block !== "object") return 0;
  const text = block.text;
  const argumentsText = block.arguments;
  const cached = blockEstimates.get(block);
  if (cached && cached.text === text && cached.argumentsText === argumentsText) return cached.tokens;
  const tokens = estimatedTextTokens(text) + estimatedTextTokens(argumentsText);
  blockEstimates.set(block, { text, argumentsText, tokens });
  return tokens;
}

/**
 * Estimated token count of a whole context (the input side of a
 * request — also the live "window consumption" readout when no
 * provider-reported count exists yet). Counts words per block: the
 * historical one-giant-string + word-array version allocated several
 * full copies of the context per call, per frame. Reuses per-block scans only
 * while the current text/argument string values are unchanged; live in-place
 * field and content-array edits are observed on the next call.
 * @param {Array} [context=[]] - context messages; each message's supported
 *   content-block text and arguments are counted
 * @returns {number} estimated input tokens, rounded up to a whole token
 * @throws {TypeError} if `context` is not iterable
 */
export function estimateContextTokens(context = []) {
  let estimate = 0;
  for (const msg of context) estimate += messageTokens(msg);
  return Math.ceil(estimate);
}

/**
 * Estimate usage from the request context and the assembled response.
 * @param {Array} [context=[]] - request messages used for input estimation
 * @param {object} [message=undefined] - assembled assistant message used for
 *   output estimation; its content text/arguments are concatenated before estimating
 * @returns {{inputTokens:number, outputTokens:number, source:"estimate"}} estimated usage
 * @throws {TypeError} if `context` is not iterable
 */
export function estimateUsage(context = [], message) {
  return {
    inputTokens: estimateContextTokens(context),
    outputTokens: estimateTokens(messageText(message)),
    source: "estimate",
  };
}

/**
 * Normalize provider-reported usage, or fall back to estimation.
 * Provider token counts win only as a complete pair: partial/invalid
 * counts use estimation (no mixed token sources), retaining normalized counters,
 * finite reported cost and bounded extensions. Input is neither mutated nor retained.
 * Repeated calls with the same report/context/message are idempotent; no side effects.
 * @param {*} reported - connector-extracted usage; accepted only when both
 *   inputTokens and outputTokens (or known aliases) are nonnegative finite numbers.
 *   Known aliases are consumed; unknown fields become bounded latest-report details
 * @param {Array} [context=undefined] - request context for fallback input
 *   estimation; when omitted, the estimator's empty-array default applies
 * @param {object} [message=undefined] - assembled message for fallback output estimation
 * @returns {{inputTokens:number, outputTokens:number, totalTokens:number, source:string, cost?:number, [key: string]: *}} independent canonical snapshot with reported or estimated token counts
 * @throws {TypeError} if fallback estimation is needed and `context` is not iterable
 */
export function finalizeUsage(reported, context, message) {
  const fields = usageNormalize(reported);
  // Token fallback must not discard independently reported costs or details.
  // Costs are never estimated, and invalid cost values are not displayable.
  if (!Number.isFinite(fields.cost)) delete fields.cost;
  if (Number.isFinite(fields.inputTokens) && Number.isFinite(fields.outputTokens)) {
    return { ...fields, source: fields.source ?? "provider" };
  }
  const estimate = estimateUsage(context, message);
  return { ...fields, ...estimate, totalTokens: estimate.inputTokens + estimate.outputTokens };
}

/** Capture bounded unrepresented rate-limit header extensions, excluding unrelated headers.
 * @param {Headers|object} headers Response headers exposing forEach; neither retained nor mutated; absent input returns an empty map.
 * @param {object} [options={}] Header filtering options.
 * @param {string[]} [options.exclude=[]] Header names already represented as quotas, case-insensitive.
 * @returns {Object<string, string>} Independent bounded header map. Idempotent, no side effects.
 * @throws {TypeError} If exclude is not an array of strings; correct options before retrying.
 */
export function usageHeaders(headers, { exclude = [] } = {}) {
  const fields = {};
  const represented = new Set(exclude.map((name) => name.toLowerCase()));
  headers?.forEach?.((value, name) => {
    if (/^(?:x|anthropic)-ratelimit-/i.test(name) && !represented.has(name.toLowerCase())) fields[name] = value;
  });
  return usageDetails(fields);
}

/**
 * Curated context windows for the CURRENT OpenAI tier, from the models
 * docs (developers.openai.com/api/docs/models, reviewed 2026-09-28 —
 * the gpt-6 family lists 1.05M; o-series 200K). OpenAI's API-key
 * surface publishes NO window anywhere (/models, /models/{id}, and the
 * response envelope are all bare — probed with
 * ai-tmp/probe-openai-models.js), so the status gauge reads this table
 * while a lazy registry lookup (lib/env/model-windows.js) fills the
 * endpoint's model cache. Any provider-published or looked-up value
 * outranks it. Review when a new tier ships.
 */
export const FALLBACK_CONTEXT_WINDOWS = Object.freeze({
  "gpt-6": 1050000, // astra / sol / luna (prefix: every gpt-6* id)
  "o1": 200000,
  "o3": 200000,
  "o4-mini": 200000,
});

/**
 * The curated fallback window for one model id, or null: an exact key,
 * then the longest table prefix the id starts with ("gpt-6-sol" ->
 * "gpt-6", "o3-2025-04-16" -> "o3").
 * @param {*} model - bare model id; non-string or empty values are rejected
 * @returns {number|null} matching fallback token window, or `null` when none
 */
export function fallbackContextWindow(model) {
  if (typeof model !== "string" || model === "") return null;
  if (FALLBACK_CONTEXT_WINDOWS[model]) return FALLBACK_CONTEXT_WINDOWS[model];
  let best = null;
  for (const [prefix, window] of Object.entries(FALLBACK_CONTEXT_WINDOWS)) {
    if (model.startsWith(`${prefix}-`) && (best === null || prefix.length > best[0])) best = [prefix.length, window];
  }
  return best?.[1] ?? null;
}
