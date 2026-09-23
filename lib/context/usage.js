/**
 * lib/usage.js — usage accounting.
 *
 * Trust provider-reported usage numbers; when absent, estimate from
 * word count × token-per-word likelihood ratio (~4 chars ≈ 1 token ≈
 * 0.75 words, so tokens ≈ words × 4/3).
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

/** @param {string} text @returns {number} estimated token count */
export function estimateTokens(text) {
  return Math.ceil(wordCount(text) * TOKENS_PER_WORD);
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

/** Word count over a message's content blocks, no intermediate string. */
function messageWords(msg) {
  if (!msg || !Array.isArray(msg.content)) return 0;
  let words = 0;
  for (const block of msg.content) {
    if (block && typeof block.text === "string") words += wordCount(block.text);
    if (block && typeof block.arguments === "string") words += wordCount(block.arguments);
  }
  return words;
}

/** Per-context memo: the status surface re-estimates EVERY rendered frame,
 *  and a stored context only ever changes by append (length) or wholesale
 *  message/content replacement (never in-place mutation) — so length plus
 *  message/content identity is a sound validity fingerprint. */
const contextEstimates = new WeakMap();

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
  const cached = contextEstimates.get(context);
  if (cached !== undefined && cached.length === context.length &&
    cached.messages.every((msg, index) => msg === context[index] && cached.contents[index] === context[index]?.content)) {
    return cached.tokens;
  }
  let words = 0;
  for (const msg of context) words += messageWords(msg);
  const tokens = Math.ceil(words * TOKENS_PER_WORD);
  if (Array.isArray(context)) {
    contextEstimates.set(context, {
      length: context.length,
      messages: [...context],
      contents: context.map((msg) => msg?.content),
      tokens,
    });
  }
  return tokens;
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

/** One-line human-readable usage summary (e.g. for a host's diagnostics). */
export function usageSummary(usage) {
  if (!usage) return "usage: unknown";
  const cost = Number.isFinite(usage.cost) ? ` $${usage.cost.toFixed(4)}` : "";
  return `usage: in=${usage.inputTokens} out=${usage.outputTokens} (${usage.source})${cost}`;
}
