/**
 * lib/usage.js — usage accounting.
 *
 * Trust provider-reported usage numbers; when absent, estimate from
 * the larger of word count × token-per-word likelihood ratio and
 * characters / 4 (unspaced JSON/code cannot count as a single token).
 *
 * Normalized usage envelope (rides in the terminal done/error event):
 *   { inputTokens, outputTokens, source: "provider" | "estimate", cost? }
 * Connectors attach provider-reported numbers (cost rides along when
 * the provider reports one); IO fills the fallback via finalizeUsage
 * — this is the whole of IO's job, PER TURN. Agent sums that
 * envelope across every request it makes (lib/agent.js's `usage`
 * getter) — nothing here or in Env persists it (no usage.json). The
 * one-shot CLI binding (bin/scripts/io, bin/scripts/agent) renders the stderr
 * summary straight from a single terminal event via usageSummary().
 */

/** tokens ≈ words × 4/3 (token-per-word likelihood ratio) */
export const TOKENS_PER_WORD = 4 / 3;

/** Whitespace test matching JavaScript's `\s` for the ASCII range (the
 *  estimate's inputs are overwhelmingly ASCII code/prose; the exotic
 *  unicode separators beyond it round into the same 4/3 noise). */
function isSpace(code) {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** @param {string} text @returns {number} whitespace-separated words */
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

/** Count long unbroken strings too (JSON, code, base64 and CJK have few spaces).
 * This is a conservative budget heuristic, not a provider tokenizer. */
function estimatedTextTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.max(wordCount(text) * TOKENS_PER_WORD, text.length / 4);
}

/** @param {string} text @returns {number} estimated token count */
export function estimateTokens(text) {
  return Math.ceil(estimatedTextTokens(text));
}

/** All text carried by a message's content blocks. */
function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return "";
  let out = "";
  for (const block of msg.content) {
    if (block && typeof block.text === "string") out += block.text + " ";
    if (block && typeof block.arguments === "string") out += block.arguments + " ";
  }
  return out;
}

/** Estimated tokens over a message's text blocks, no intermediate string. */
function messageTokens(msg) {
  if (!msg || !Array.isArray(msg.content)) return 0;
  let tokens = 0;
  for (const block of msg.content) {
    if (block && typeof block.text === "string") tokens += estimatedTextTokens(block.text);
    if (block && typeof block.arguments === "string") tokens += estimatedTextTokens(block.arguments);
  }
  return tokens;
}

/** Per-MESSAGE memo: the status surface re-estimates EVERY rendered frame
 *  over a fresh messages() copy, and a stored message only ever changes by
 *  wholesale content replacement (never in-place mutation) — so message
 *  plus content identity is a sound validity fingerprint, and a re-estimate
 *  costs one lookup per message instead of a scan of the whole text. */
const messageEstimates = new WeakMap();

function messageTokensMemo(msg) {
  if (!msg || typeof msg !== "object") return 0;
  const cached = messageEstimates.get(msg);
  if (cached !== undefined && cached.content === msg.content) return cached.tokens;
  const tokens = messageTokens(msg);
  messageEstimates.set(msg, { content: msg.content, tokens });
  return tokens;
}

/**
 * Estimated token count of a whole context (the input side of a
 * request — also the live "window consumption" readout when no
 * provider-reported count exists yet). Counts words per block: the
 * historical one-giant-string + word-array version allocated several
 * full copies of the context per call, per frame.
 * @param {Array} [context]
 * @returns {number}
 */
export function estimateContextTokens(context = []) {
  let estimate = 0;
  for (const msg of context) estimate += messageTokensMemo(msg);
  return Math.ceil(estimate);
}

/**
 * Estimate usage from the request context and the assembled response.
 * @param {Array} [context] - request messages (input side)
 * @param {object} [message] - assembled assistant message (output side)
 * @returns {{inputTokens:number, outputTokens:number, source:"estimate"}}
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
 * Provider numbers win per-field only as a whole: a partial/invalid
 * report is treated as absent (honest fallback, no mixed sources).
 * @param {*} reported - whatever the connector extracted
 * @param {Array} [context] - request context (fallback input side)
 * @param {object} [message] - assembled message (fallback output side)
 * @returns {{inputTokens:number, outputTokens:number, source:string}}
 */
export function finalizeUsage(reported, context, message) {
  if (
    reported !== null &&
    typeof reported === "object" &&
    Number.isFinite(reported.inputTokens) &&
    Number.isFinite(reported.outputTokens)
  ) {
    return {
      inputTokens: reported.inputTokens,
      outputTokens: reported.outputTokens,
      source: "provider",
      // a provider-reported cost rides along (never estimated)
      ...(Number.isFinite(reported.cost) ? { cost: reported.cost } : {}),
    };
  }
  return estimateUsage(context, message);
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
 * @param {string} model - bare model id
 * @returns {number|null}
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

/** One-line human-readable usage summary (e.g. for a host's diagnostics). */
export function usageSummary(usage) {
  if (!usage) return "usage: unknown";
  const cost = Number.isFinite(usage.cost) ? ` $${usage.cost.toFixed(4)}` : "";
  return `usage: in=${usage.inputTokens} out=${usage.outputTokens} (${usage.source})${cost}`;
}
