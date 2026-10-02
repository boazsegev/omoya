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

/** Codex catalog request timeout in milliseconds; it receives the full refresh budget. */
const CODEX_CATALOG_TIMEOUT = 4000;

/**
 * Convert a failed HTTP response into an error carrying its status and body.
 * Reads the response body; body-read failures are treated as an empty body.
 * @param {Response} response Failed response.
 * @returns {Promise<Error & {status: number, body: string}>}
 */
async function statusError(response) {
  const body = await response.text().catch(() => "");
  return Object.assign(new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`),
    { status: response.status, body });
}

/**
 * Normalize an endpoint URL, defaulting to OpenAI's v1 endpoint and removing one trailing slash.
 * @param {string | null | undefined} url Endpoint URL.
 * @returns {string} Normalized base URL.
 */
const baseUrlOf = (url) => String(url ?? "https://api.openai.com/v1").replace(/\/$/, "");

/**
 * Build request headers with a one-shot connection, optional bearer token, and token-derived Codex account ID.
 * @param {{token?: string}|null|undefined} auth Authentication record.
 * @param {Record<string, string>} [extra={}] Additional headers, which may override the connection header.
 * @returns {Record<string, string>} Request headers.
 */
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
 * @param {{url?: string, auth?: object, settings?: object, signal?: AbortSignal}} [options={}] Endpoint URL, credentials, settings (default `{}`), and optional cancellation signal.
 * @returns {Promise<object>} Model map keyed by model ID (or Codex slug).
 * @throws {Error} On HTTP, response parsing, cancellation, timeout, or Codex catalog failure.
 * @effects Performs a network request; Codex discovery may also invoke the CLI to determine its client version.
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

/**
 * Extract published context and output sizes; a larger max_context_window becomes contextWindow.
 * @param {object} model Model metadata from a listing.
 * @returns {object} Available contextWindow, maxContextWindow, and maxTokens fields.
 */
function contextOf(model) {
  return {
    ...(Number.isFinite(model.max_context_window) && model.max_context_window > model.context_window
      ? { contextWindow: model.max_context_window }
      : Number.isFinite(model.context_window) ? { contextWindow: model.context_window } : {}),
    ...(Number.isFinite(model.max_context_window) ? { maxContextWindow: model.max_context_window } : {}),
    ...(Number.isFinite(model.max_output_tokens) ? { maxTokens: model.max_output_tokens } : {}),
  };
}

/**
 * Extract published visibility and capability flags from model metadata.
 * @param {object} model Model metadata from a listing.
 * @returns {object} Applicable secret, supportedInApi, and webSearch flags.
 */
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
 * @param {Function} Protocol Registered provider class, used to resolve its client version.
 * @param {string} baseUrl Normalized endpoint base URL.
 * @param {object} auth Authentication record used to form request headers.
 * @param {object} settings Provider settings; cached models may supply missing metadata.
 * @param {AbortSignal} [signal] Optional caller cancellation signal.
 * @returns {Promise<object>} Map keyed by catalog model slug.
 * @throws {Error} On HTTP, JSON parsing, cancellation, timeout, or empty-catalog failure.
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
 * @param {Function} Protocol Registered provider class whose knownEndpoints may pin a version.
 * @param {string} baseUrl Normalized endpoint base URL.
 * @returns {string} Pinned, installed-CLI, or fallback client version.
 * @effects May synchronously invoke `codex --version` once per process and memoize its result.
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

/** Process-lifetime memo of the CLI version; null means absent or unparseable. */
let codexVersionCache;

/** Broad fallback client version used when `codex --version` is unavailable. */
const CODEX_CLIENT_VERSION = "99.99.99";

/**
 * Strict connection verification (login flows): THROW on any failure.
 * VERIFICATION MODE: `verify: "jwt"` endpoints (the Codex preset — its
 * catalog is not an OAuth credential check) verify the issued token
 * LOCALLY: it must BE a JWT and unexpired.
 * @param {{url?: string, auth?: object, settings?: object, signal?: AbortSignal}} [options={}] Endpoint URL, credentials, settings (default `{}`), and optional cancellation signal.
 * @returns {Promise<{models: number}>} Listed model count, or configured static model count in JWT mode.
 * @throws {Error} On HTTP/JSON/network failure; JWT mode throws an auth-kind error for invalid or expired tokens.
 * @effects Performs a `/models` request except in JWT verification mode, which checks claims locally.
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
 * @param {{token?: string}} [input={}] Login input; token takes precedence over saved credentials.
 * @param {{settings?: object}} [context={}] Endpoint context; settings may provide the saved auth token.
 * @returns {{type: "api_key", token: string}} Stored API-key auth record.
 * @throws {Error} An auth-kind error when no token is supplied or saved.
 */
export function login(input = {}, { settings } = {}) {
  const token = input.token ?? settings?.auth?.token;
  if (!token) throw Object.assign(new Error("login requires an API token"), { kind: "auth" });
  return { type: "api_key", token };
}
