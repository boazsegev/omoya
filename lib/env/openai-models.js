/**
 * lib/env/openai-models.js — the OpenAI-compatible CATALOG defaults
 * (private to Env; static provider methods completed by
 * lib/env/provider.js): the /models listing, the Codex account catalog
 * (one authenticated catalog request returning models, native thinking
 * modes, context windows, and visibility for the actual account), the
 * strict login-time verification, and API-key login. Each is called
 * with `this` = the registered provider class. Listing failures THROW:
 * Env keeps the cached map as the offline fallback.
 */

import { execFileSync } from "node:child_process";
import { jwtClaims, openaiAccountId, openaiCodexBackend } from "../util.js";

/** The Codex catalog gets the whole refresh budget: it is the
 *  authoritative, single-request discovery path. */
const CODEX_CATALOG_TIMEOUT = 4000;

/** A failed HTTP response as a plain classifiable error (status rides along). */
async function statusError(response) {
  const body = await response.text().catch(() => "");
  return Object.assign(new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`),
    { status: response.status, body });
}

const baseUrlOf = (url) => String(url ?? "https://api.openai.com/v1").replace(/\/$/, "");

/** Bearer (plus the Codex account id when the token carries one); one-shot sockets. */
function headersOf(auth, extra = {}) {
  const headers = { connection: "close", ...extra };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  const accountId = openaiAccountId(auth?.token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

/**
 * The endpoint's model MAP from its OpenAI-compatible `/models` route
 * (unique model ids as keys, published metadata as values). The Codex
 * backend reads its account catalog instead.
 * @param {{url?: string, auth?: object, settings?: object, signal?: AbortSignal}} options
 * @returns {Promise<object>}
 */
export async function models({ url, auth, settings = {}, signal } = {}) {
  const baseUrl = baseUrlOf(url);
  if (openaiCodexBackend(baseUrl, settings)) return codexModels(this, baseUrl, auth, settings, signal);
  const response = await fetch(`${baseUrl}/models`, { headers: headersOf(auth), signal });
  if (!response.ok) throw await statusError(response);
  const body = await response.json();
  const map = {};
  for (const model of body.data ?? []) {
    if (typeof model?.id !== "string" || model.id === "") continue;
    map[model.id] = {
      label: model.name ?? model.display_name ?? model.id,
      input: model.input ?? (Array.isArray(model.input_modalities) && model.input_modalities.length > 0
        ? model.input_modalities.filter((m) => typeof m === "string") : ["text"]),
      // only a listing that SAYS so marks a model non-reasoning: the
      // plain OpenAI /models omits the field for reasoning models too
      ...(model.reasoning === false ? { thinking: [] } : {}),
      ...contextOf(model),
      ...(Array.isArray(model.supported_reasoning_levels)
        ? { thinking: model.supported_reasoning_levels.map((level) => level?.effort).filter((e) => typeof e === "string") } : {}),
      ...(typeof model.default_reasoning_level === "string" ? { thinkingDefault: model.default_reasoning_level } : {}),
      ...flagsOf(model),
    };
  }
  return map;
}

/** Context/output sizes a listing publishes (max_context_window wins when larger). */
function contextOf(model) {
  return {
    ...(Number.isFinite(model.max_context_window) && model.max_context_window > model.context_window
      ? { contextWindow: model.max_context_window }
      : Number.isFinite(model.context_window) ? { contextWindow: model.context_window } : {}),
    ...(Number.isFinite(model.max_context_window) ? { maxContextWindow: model.max_context_window } : {}),
    ...(Number.isFinite(model.max_output_tokens) ? { maxTokens: model.max_output_tokens } : {}),
  };
}

/** Visibility and capability flags a listing publishes. */
function flagsOf(model) {
  return {
    ...(model.visibility === "hide" ? { secret: true } : {}),
    ...(model.supported_in_api === false ? { supportedInApi: false } : {}),
    ...(model.supports_search_tool === false ? { webSearch: false } : {}),
  };
}

/**
 * The account's Codex catalog (GET /models?client_version=) is
 * authoritative: exactly its slugs, with models and their thinking
 * modes from the same entry. Cached labels/sizes fill omissions. A
 * failed or empty catalog throws (Env keeps the cached map).
 */
async function codexModels(Protocol, baseUrl, auth, settings, signal) {
  const cached = settings.models !== null && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models : {};
  const controller = new AbortController();
  const onOuter = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", onOuter, { once: true });
  const timer = setTimeout(() => controller.abort(), CODEX_CATALOG_TIMEOUT);
  timer.unref?.();
  try {
    const response = await fetch(`${baseUrl}/models?client_version=${codexClientVersion(Protocol, baseUrl)}`, {
      headers: headersOf(auth, { "content-type": "application/json", "OpenAI-Beta": "responses=experimental" }),
      signal: controller.signal,
    });
    if (!response.ok) throw await statusError(response);
    const body = await response.json();
    if (!Array.isArray(body?.models) || body.models.length === 0) throw new Error("empty Codex model catalog");
    const map = {};
    for (const model of body.models) {
      if (typeof model?.slug !== "string" || model.slug === "") continue;
      const previous = cached[model.slug] ?? {};
      map[model.slug] = {
        label: typeof model.display_name === "string" && model.display_name !== "" ? model.display_name : previous.label ?? model.slug,
        ...(Number.isFinite(previous.contextWindow) ? { contextWindow: previous.contextWindow } : {}),
        ...(Number.isFinite(previous.maxTokens) ? { maxTokens: previous.maxTokens } : {}),
        ...contextOf(model),
        thinking: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
          .map((level) => level?.effort).filter((effort) => typeof effort === "string"),
        ...(typeof model.default_reasoning_level === "string" ? { thinkingDefault: model.default_reasoning_level } : {}),
        ...(model.supports_reasoning_summary_parameter === false ? { reasoningSummary: false } : {}),
        ...flagsOf(model),
        ...(Array.isArray(model.input_modalities) && model.input_modalities.length > 0
          ? { input: model.input_modalities.filter((m) => typeof m === "string") } : {}),
      };
    }
    if (Object.keys(map).length === 0) throw new Error("empty Codex model catalog");
    return map;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuter);
  }
}

/**
 * The catalog's client version: the preset's pinned version, else the
 * installed `codex` CLI's version (the catalog's compatibility filter is
 * keyed by it), else 99.99.99 — the broadest, freshest catalog the
 * backend offers (no client-gating on model availability).
 * @returns {string}
 */
function codexClientVersion(Protocol, baseUrl) {
  const preset = (Protocol?.knownEndpoints ?? []).find((entry) => baseUrlOf(entry.url) === baseUrl);
  if (typeof preset?.version === "string" && preset.version !== "") return preset.version;
  if (codexVersionCache === undefined) {
    try {
      const out = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 3000 });
      codexVersionCache = out.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    } catch {
      codexVersionCache = null;
    }
  }
  return codexVersionCache ?? CODEX_CLIENT_VERSION;
}

/** Process-lifetime memo: null = codex CLI absent/unparseable. */
let codexVersionCache;

/** Fallback client version when `codex --version` is unavailable. */
const CODEX_CLIENT_VERSION = "99.99.99";

/**
 * Strict connection verification (login flows): THROW on any failure.
 * VERIFICATION MODE: `verify: "jwt"` endpoints (the Codex preset — its
 * catalog is not an OAuth credential check) verify the issued token
 * LOCALLY: it must BE a JWT and unexpired.
 * @param {{url?: string, auth?: object, settings?: object, signal?: AbortSignal}} options
 * @returns {Promise<{models: number}>} the listed model count
 */
export async function testConnection({ url, auth, settings = {}, signal } = {}) {
  if (settings.verify === "jwt") {
    const claims = jwtClaims(auth?.token);
    if (!claims) {
      throw Object.assign(new Error("this endpoint verifies OAuth (JWT) tokens: the stored token is not a JWT — sign in with the browser"), { kind: "auth" });
    }
    if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) {
      throw Object.assign(new Error("the stored OAuth token is expired — sign in again"), { kind: "auth" });
    }
    const staticModels = settings.models && typeof settings.models === "object" ? settings.models : {};
    return { models: Object.keys(staticModels).length };
  }
  const response = await fetch(`${baseUrlOf(url)}/models`, { headers: headersOf(auth), signal });
  if (!response.ok) throw await statusError(response);
  const body = await response.json();
  return { models: Array.isArray(body.data) ? body.data.length : 0 };
}

/**
 * The auth record an API-token login stores.
 * @param {{token?: string}} [input]
 * @param {{settings?: object}} [context] - the endpoint's current settings
 * @returns {object}
 */
export function login(input = {}, { settings } = {}) {
  const token = input.token ?? settings?.auth?.token;
  if (!token) throw Object.assign(new Error("login requires an API token"), { kind: "auth" });
  return { type: "api_key", token };
}
