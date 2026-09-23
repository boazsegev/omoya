/**
 * Provider class contract normalization and stable error taxonomy.
 *
 * A plugin default-exports one class and may use public Env/Context
 * helpers, but never imports the private OpenAI defaults. The harness
 * completes missing methods from lib/env/openai.js. Construction replaces
 * the old connect() hook; each instance owns one endpoint's transport state.
 */

import * as openai from "./openai.js";
import { ProviderError } from "./provider-error.js";
export { ProviderError } from "./provider-error.js";

const INSTANCE_DEFAULTS = {
  context2msg: openai.context2msg,
  msg2events: openai.msg2events,
  send: openai.send,
  read: openai.read,
  close: openai.close,
  models: openai.models,
  login: openai.login,
  reportPlanUsage: openai.reportPlanUsage,
  testConnection: openai.testConnection,
  // the shared taxonomy by default; a provider whose error BODIES
  // distinguish a dead credential from something else (a rate/usage
  // limit, say) overrides this to refine ONE status code's kind —
  // see providers/kimi.js. A wrong "auth" kind here has a real cost:
  // lib/agent/run.js reacts to it by wiping cached models and forcing
  // a re-login, so a status code that is NOT unambiguously a
  // credential problem must never default to "auth" without one.
  classifyError(err) { return classifyError(err, this.aiio?.name); },
  // does this classified failure mean the endpoint's TOKEN BUDGET is
  // spent (depletionError)? The shared default is exact by dialect —
  // depletionError() below; a provider whose rate-limit signal differs
  // (Kimi's usage-limit 403 bodies) overrides it. NO kind is ever
  // enough on its own: a 404 says the model name is wrong, a 401 says
  // the credential is dead — neither is a budget.
  depletionError(classified) { return depletionError(classified); },
};

/**
 * The shared TOKEN-DEPLETION predicate: exact signals only.
 * 429 (Too Many Requests) and 402 (Payment Required) are the HTTP
 * rate/quota statuses; otherwise the provider's own error body/code
 * must NAME a budget — rate limits, quotas, billing (OpenAI's
 * `insufficient_quota`, Anthropic's `rate_limit_error`). A 404 (a
 * wrong model name), a 401/403 (a credential verdict), a transient
 * 5xx, a mid-stream stall: none of these is a budget, and none of
 * them marks the endpoint depleted. The message/body rides on the
 * classified ProviderError (HttpStatusError bodies included — the
 * first 200 chars travel in the message).
 * @param {object} classified - a classified error/event ({kind, message, status?})
 * @returns {boolean}
 */
export function depletionError(classified) {
  if (classified?.kind !== "provider" && classified?.kind !== "auth") return false;
  if (classified?.status === 429 || classified?.status === 402) return true;
  return DEPLETION_BODY.test(String(classified?.message ?? ""));
}

/** A provider error body/code that NAMES a token/quota budget. */
const DEPLETION_BODY = /rate.?limit|too many requests|insufficient[_ ]?quota|quota exceeded|billing|spending (cap|limit)|usage (cap|limit)|credits? exhausted/i;

/**
 * Complete a standalone provider class with OpenAI-compatible defaults.
 * The returned class is the sole runtime contract; function-module plugins
 * are intentionally unsupported in this pre-release core.
 * @param {Function} Protocol - plugin class
 * @param {{name?: string}} [options] - basename registry key
 * @returns {Function} completed provider class
 */
export function defineProvider(Protocol, { name } = {}) {
  if (typeof Protocol !== "function") {
    throw new TypeError("defineProvider: provider module must default-export a class");
  }
  const key = name ?? Protocol.provider?.name;
  if (typeof key !== "string" || key === "") {
    throw new TypeError("defineProvider: provider basename/name required");
  }
  const meta = Protocol.provider ?? {};

  class CompletedProvider extends Protocol {
    constructor(url, aiio) {
      super(url, aiio);
      openai.initializeOpenAI(this, url, aiio);
    }
  }
  Object.defineProperty(CompletedProvider, "name", { value: Protocol.name || `${key}Provider` });
  Object.defineProperties(CompletedProvider, {
    provider: {
      value: {
        name: key,
        label: typeof meta.label === "string" ? meta.label : key,
        capabilities: {
          tools: meta.capabilities?.tools === true,
          thinking: meta.capabilities?.thinking === true,
          streaming: meta.capabilities?.streaming === true,
          ...meta.capabilities,
        },
        ...spreadMetaExtras(meta),
      },
      enumerable: true,
    },
    original: { value: Protocol },
    detectEndpoints: {
      value: typeof Protocol.detectEndpoints === "function"
        ? Protocol.detectEndpoints.bind(Protocol)
        : async () => ({}),
    },
  });
  for (const [method, fallback] of Object.entries(INSTANCE_DEFAULTS)) {
    if (typeof Protocol.prototype[method] === "function") continue;
    Object.defineProperty(CompletedProvider.prototype, method, {
      value: fallback,
      writable: true,
      configurable: true,
    });
  }
  return CompletedProvider;
}

function spreadMetaExtras(meta) {
  const { name, label, capabilities, ...extras } = meta;
  return extras;
}

/** Classify a raw error into the stable provider taxonomy. */
export function classifyError(err, providerName) {
  if (err instanceof ProviderError) return err;
  const at = providerName ? ` [${providerName}]` : "";

  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return new ProviderError("network", `request aborted${at}: ${err.message}`, { cause: err });
  }
  if (typeof err?.status === "number") {
    // 402/429 read "provider" (a BUDGET/throughput verdict, never a
    // credential one — the depletion predicate needs its exact kind);
    // 401/403 stay the credential verdicts; every other status is a
    // provider-side failure (its body still reaches depletionError)
    const kind = err.status === 401 || err.status === 403 ? "auth" : "provider";
    return new ProviderError(kind, `${err.message}${at}`, { status: err.status, cause: err });
  }
  if (err instanceof SyntaxError) {
    return new ProviderError("malformed", `malformed provider data${at}: ${err.message}`, { cause: err });
  }
  if (err instanceof TypeError) {
    return new ProviderError("network", `network failure${at}: ${err.message}`, { cause: err });
  }
  if (err?.kind === "auth") {
    return new ProviderError("auth", `${err.message}${at}`, { cause: err });
  }
  return new ProviderError("provider", `${err?.message ?? String(err)}${at}`, { cause: err });
}
