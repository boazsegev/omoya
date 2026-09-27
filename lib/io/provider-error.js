/**
 * lib/io/provider-error.js — the stable provider failure taxonomy
 * (private to IO): auth / network / provider / malformed. Providers
 * throw plain errors carrying `kind` or `status`; IO classifies them
 * here, and a provider's own classifyError(err, base) may refine the
 * default verdict.
 */

const KINDS = new Set(["auth", "network", "provider", "malformed"]);

/** Provider/transport error with a stable failure class. */
export class ProviderError extends Error {
  /** Build a stable classified provider error.
   * @param {"auth"|"network"|"provider"|"malformed"} kind
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    Object.assign(this, detail);
  }
}

/**
 * Classify a raw error into the stable provider taxonomy. An explicit
 * `kind` wins; 401/403 are credential verdicts, every other status a
 * provider failure (402/429 included — budgets, see depletionError).
 * @param {*} err
 * @param {string} [providerName] - named in the message
 * @returns {ProviderError}
 */
export function classifyError(err, providerName) {
  if (err instanceof ProviderError) return err;
  const at = providerName ? ` [${providerName}]` : "";
  const status = typeof err?.status === "number" ? { status: err.status } : {};
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return new ProviderError("network", `request aborted${at}: ${err.message}`, { cause: err });
  }
  if (KINDS.has(err?.kind)) {
    return new ProviderError(err.kind, `${err.message}${at}`, { ...status, cause: err });
  }
  if (status.status !== undefined) {
    const kind = err.status === 401 || err.status === 403 ? "auth" : "provider";
    return new ProviderError(kind, `${err.message}${at}`, { ...status, cause: err });
  }
  if (err instanceof SyntaxError) {
    return new ProviderError("malformed", `malformed provider data${at}: ${err.message}`, { cause: err });
  }
  if (err instanceof TypeError) {
    return new ProviderError("network", `network failure${at}: ${err.message}`, { cause: err });
  }
  return new ProviderError("provider", `${err?.message ?? String(err)}${at}`, { cause: err });
}

/** A provider error body/code that NAMES a token/quota budget. */
const DEPLETION_BODY = /rate.?limit|too many requests|insufficient[_ ]?quota|quota exceeded|billing|spending (cap|limit)|usage (cap|limit)|credits? exhausted/i;

/**
 * The shared TOKEN-DEPLETION predicate: exact signals only. 429/402
 * are the HTTP rate/quota statuses; otherwise the error body/code must
 * NAME a budget. A 404 (wrong model), a 401/403 (credential), a
 * transient 5xx or a stall never marks the endpoint depleted.
 * @param {object} classified - a classified error/event ({kind, message, status?})
 * @returns {boolean}
 */
export function depletionError(classified) {
  if (classified?.kind !== "provider" && classified?.kind !== "auth") return false;
  if (classified?.status === 429 || classified?.status === 402) return true;
  return DEPLETION_BODY.test(String(classified?.message ?? ""));
}
