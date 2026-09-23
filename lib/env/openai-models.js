/**
 * lib/env/openai-models.js — model listing and verification (private
 * to Env's OpenAI defaults): the /models listing with cache
 * fallback, the codex PROBE flow (the codex backend cannot LIST
 * models — a minimal POST /responses tells per candidate whether the
 * account may use it; candidates come from the preset's models.dev
 * registry on a TTL), the x-ratelimit-* plan/quota reporting, and the
 * strict login-time testConnection.
 */

import { HttpStatusError, singleShot } from "./http.js";
import { ProviderError } from "./provider-error.js";
import { jwtClaims, accountIdOf, isCodexBackend } from "./openai-codex.js";
import { registryEffortLevels, sortEfforts } from "./thinking.js";

/** A day: how long a probe result stays authoritative. */
const PROBE_TTL = 24 * 3600 * 1000;
/** A week: how long a registry snapshot stays fresh. */
const REGISTRY_TTL = 7 * 24 * 3600 * 1000;

/**
 * List models from the endpoint's OpenAI-compatible `/models` route as
 * a MAP (unique model ids as keys, optional metadata as values); the
 * fetched snapshot refreshes the endpoint's auth cache, and a failed
 * fetch falls back to the cached (or static config) list.
 * CODEX: the backend has no /models route — the account's usable
 * models are PROBED from the preset's candidate superset instead.
 */
export async function models() {
  if (isCodexBackend(this)) return codexModels.call(this);
  const headers = {};
  const token = this.aiio?.settings?.auth?.token;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${this.baseUrl}/models`, singleShot({
      headers,
      signal: this.aiio?.requestSignal,
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const map = {};
    for (const model of body.data ?? []) {
      if (typeof model?.id !== "string" || model.id === "") continue;
      map[model.id] = {
        label: model.name ?? model.id,
        // only a listing that SAYS so marks a model non-reasoning: the
        // plain OpenAI /models omits the field for reasoning models too
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        input: model.input ?? ["text"],
        ...(Number.isFinite(model.context_window) ? { contextWindow: model.context_window } : {}),
        ...(Number.isFinite(model.max_output_tokens) ? { maxTokens: model.max_output_tokens } : {}),
      };
    }
    this.aiio?.authSet?.({ models: map });
    return map;
  } catch {
    const cached = this.aiio?.settings?.models;
    return cached !== null && typeof cached === "object" && !Array.isArray(cached) ? cached : {};
  }
}

/**
 * The codex backend cannot LIST models, but it ANSWERS: a minimal
 * POST /responses tells per model whether the ChatGPT account may use
 * it (400 "not supported" vs a stream start). Candidates come from
 * the preset's public model REGISTRY (models.dev — newly released
 * models need no code update), refreshed on a TTL and cached in the
 * endpoint settings; the preset's static list is the offline
 * fallback. Probing is the ground truth and itself cached for a day
 * — startup refreshes stay cheap. A probe that cannot decide
 * (auth/quota/network trouble) keeps the model's last-known entry; a
 * total probe failure throws so the caller keeps the stale cache.
 * @returns {Promise<object>} the filtered model map
 */
async function codexModels() {
  const settings = this.aiio?.settings ?? {};
  const cached = settings.models && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models : {};
  if (Object.keys(cached).length > 0 && Date.now() - (settings.modelsProbedAt ?? 0) < PROBE_TTL) {
    return cached;
  }
  const candidates = await registryCandidates.call(this);
  const ids = Object.keys(candidates);
  if (ids.length === 0) return cached;
  const [verdicts, advertised] = await Promise.all([
    Promise.all(ids.map((id) => probeCodexModel(this, id, settings.auth?.token))),
    codexReasoning(this, settings.auth?.token),
  ]);
  if (!verdicts.includes(true)) throw new Error("codex model probe: no model answered");
  const map = {};
  ids.forEach((id, index) => {
    if (verdicts[index] === true) map[id] = withReasoning(candidates[id], advertised[id]);
    else if (verdicts[index] === undefined && cached[id]) map[id] = cached[id];
  });
  this.aiio?.authSet?.({ models: map, modelsProbedAt: Date.now() });
  return map;
}

/** The endpoint's codex preset entry (URL match on knownEndpoints). */
function codexPreset(connection) {
  return (connection?.constructor.knownEndpoints ?? []).find(
    (entry) => String(entry.url ?? "").replace(/\/$/, "") === connection.baseUrl);
}

/**
 * The candidate superset for codex probing: the preset's public model
 * registry (models.dev shape: providers keyed by name, each with a
 * `models` object), cached in the endpoint settings for REGISTRY_TTL;
 * the cached registry, then the preset's static list, are the
 * fetch-failure fallbacks. Any preset can declare
 * `registry: { url, provider }` — the mechanism is not codex-specific.
 */
async function registryCandidates() {
  const settings = this.aiio?.settings ?? {};
  const preset = codexPreset(this);
  const registry = preset?.registry;
  const staticModels = preset?.models ?? settings.models ?? {};
  if (!registry?.url || !registry?.provider) return staticModels;
  const cache = settings.registry;
  const cacheFresh = cache && typeof cache === "object" && cache.models &&
    Date.now() - (cache.fetchedAt ?? 0) < REGISTRY_TTL;
  if (cacheFresh) return cache.models;
  try {
    const response = await fetch(registry.url, singleShot({ signal: this.aiio?.requestSignal }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = body?.[registry.provider]?.models;
    if (!models || typeof models !== "object") throw new Error("provider absent from registry");
    const mapped = {};
    for (const [id, m] of Object.entries(models)) {
      if (!m || typeof m !== "object") continue;
      const reasoningLevels = registryEffortLevels(m);
      mapped[id] = {
        label: m.name ?? id,
        reasoning: m.reasoning === true,
        ...(reasoningLevels ? { reasoningLevels } : {}),
        ...(Number.isFinite(m.limit?.context) ? { contextWindow: m.limit.context } : {}),
        ...(Number.isFinite(m.limit?.output) ? { maxTokens: m.limit.output } : {}),
      };
    }
    if (Object.keys(mapped).length === 0) throw new Error("registry held no models");
    this.aiio?.authSet?.({ registry: { fetchedAt: Date.now(), models: mapped } });
    return mapped;
  } catch {
    return cache?.models && typeof cache.models === "object" ? cache.models : staticModels;
  }
}

/** The codex backend request headers for one token. */
function codexHeaders(token) {
  const headers = { "content-type": "application/json", "OpenAI-Beta": "responses=experimental" };
  if (token) headers.authorization = `Bearer ${token}`;
  const accountId = accountIdOf(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

/** The Codex client version the backend's /models catalog is keyed by. */
const CODEX_CLIENT_VERSION = "0.144.1";

/**
 * The codex backend's advertised reasoning metadata per model slug
 * (GET /models?client_version=: `supported_reasoning_levels[].effort`,
 * `default_reasoning_level`, `supports_reasoning_summary_parameter`).
 * Advisory only — an unreachable catalog yields {} and the registry's
 * levels stand alone.
 * @returns {Promise<Object<string, object>>}
 */
async function codexReasoning(connection, token) {
  try {
    const response = await fetch(`${connection.baseUrl}/models?client_version=${CODEX_CLIENT_VERSION}`, singleShot({
      headers: codexHeaders(token),
      signal: connection.aiio?.requestSignal,
    }));
    if (!response.ok) return {};
    const body = await response.json();
    const out = {};
    for (const model of Array.isArray(body?.models) ? body.models : []) {
      if (typeof model?.slug !== "string") continue;
      const levels = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level) => level?.effort);
      out[model.slug] = {
        reasoningLevels: sortEfforts(levels),
        ...(typeof model.default_reasoning_level === "string" ? { defaultReasoning: model.default_reasoning_level } : {}),
        ...(model.supports_reasoning_summary_parameter === false ? { reasoningSummary: false } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A candidate descriptor with advertised reasoning metadata merged in:
 * the level sets UNITE (the catalog omits `none`, which the backend
 * accepts; the registry lists it), the catalog's default wins.
 */
function withReasoning(candidate, advertised) {
  if (!advertised) return candidate;
  const { reasoningLevels, ...rest } = advertised;
  const levels = sortEfforts([...(candidate.reasoningLevels ?? []), ...(reasoningLevels ?? [])]);
  return { ...candidate, ...rest, ...(levels.length > 0 ? { reasoningLevels: levels } : {}) };
}

/**
 * One probe request for one candidate model.
 * @returns {Promise<boolean|undefined>} true usable, false the backend
 *   rejected the model for this account, undefined undecidable
 */
async function probeCodexModel(connection, model, token) {
  try {
    const response = await fetch(`${connection.baseUrl}/responses`, singleShot({
      method: "POST",
      headers: codexHeaders(token),
      signal: connection.aiio?.requestSignal,
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions: "",
        stream: true,
        store: false,
      }),
    }));
    try {
      if (response.ok) return true;
      const text = await response.text().catch(() => "");
      if (response.status === 400 && /not supported/i.test(text)) return false;
      return undefined;
    } finally {
      response.body?.cancel().catch(() => {});
    }
  } catch {
    return undefined;
  }
}

/** Anthropic-subscription-style rolling-window header:
 *  `<vendor->ratelimit-unified-<window>-utilization` (a SPENT FRACTION,
 *  0–1 — no vendor prefix assumed, so a gateway using its own name
 *  still matches; see providers/anthropic.js for the fuller rationale,
 *  duplicated here as this default's second fallback dialect). */
const UNIFIED_WINDOW = /ratelimit-unified-([a-z0-9]+)-utilization$/i;

/** How often the Codex-backend usage endpoint (below) is re-fetched,
 *  per IO instance. In-memory only — usage changes with every turn,
 *  so persisting it to disk settings would go stale immediately — and
 *  throttled rather than fetched every turn: the Codex CLI itself has
 *  been flagged for hammering this same endpoint on every request. */
const CODEX_USAGE_TTL = 60 * 1000;

/** A window's length in seconds as a short label — 18000 -> "5h",
 *  604800 -> "7d", 1800 -> "30m" — the largest whole unit that divides
 *  the value evenly (seconds are always whole, so this never fails to
 *  resolve). null for a missing/invalid length: the account's actual
 *  window durations are NOT assumed anywhere in this codebase (a
 *  "5h"/weekly plan today is a fact about the current default plan,
 *  not a promise about every account or a future one). */
function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  for (const [suffix, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (seconds % size === 0) return `${seconds / size}${suffix}`;
  }
  return null; // unreachable (size 1 always matches) — kept for clarity
}

/** windowLabel's inverse, for dialect 2 below: the Anthropic-style
 *  unified header publishes the window as a NAME ("5h"), never a raw
 *  second count, so getting a number back out means parsing the name
 *  itself — undefined for anything not a clean <n><unit> shape (never
 *  guessed; duplicated in providers/anthropic.js, which cannot import
 *  this private module — see its own copy for the fuller rationale). */
function parseWindowSeconds(label) {
  const match = /^(\d+)([dhms])$/i.exec(String(label ?? ""));
  if (!match) return undefined;
  const size = { d: 86400, h: 3600, m: 60, s: 1 }[match[2].toLowerCase()];
  return Number(match[1]) * size;
}

/**
 * Codex-backend plan/quota reporting: unlike every response-header
 * dialect this module otherwise tries, the ChatGPT Codex backend
 * (chatgpt.com/backend-api/codex) puts NOTHING rate-limit-shaped on
 * its own chat-response headers — usage instead lives behind a
 * separate `GET https://chatgpt.com/backend-api/wham/usage` call
 * (community-reverse-engineered — OpenAI does not publish this
 * endpoint — response shape: `rate_limit.primary_window` /
 * `.secondary_window`, each `{used_percent, limit_window_seconds,
 * reset_at}`). The window's actual length (`limit_window_seconds`) is
 * read from the response and turned into its quota key (see
 * windowLabel) — NOT assumed to be "5h"/"7d" the way earlier code
 * here did: those are today's OpenAI defaults, not a guarantee for
 * every plan or every future account. Falls back to the neutral
 * "primary"/"secondary" only if the endpoint omits the window length.
 * Cached per `aiio` for CODEX_USAGE_TTL. Best-effort throughout: a
 * missing token, a failed fetch, or an unrecognized response shape
 * all just mean nothing is reported this round.
 * @param {object} aiio
 */
async function reportCodexUsage(aiio) {
  if (!aiio) return;
  const cache = aiio._codexUsage;
  if (cache && Date.now() - cache.fetchedAt < CODEX_USAGE_TTL) return;
  aiio._codexUsage = { fetchedAt: Date.now() }; // claim the slot before awaiting — one fetch in flight at a time
  const token = aiio.settings?.auth?.token;
  if (!token) return;
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", singleShot({
      headers: { authorization: `Bearer ${token}` },
      signal: aiio.requestSignal,
    }));
    if (!response.ok) return;
    const body = await response.json();
    const quotas = {};
    for (const [wire, fallbackKey] of [["primary_window", "primary"], ["secondary_window", "secondary"]]) {
      const window = body?.rate_limit?.[wire];
      const usedPct = Number(window?.used_percent);
      if (!Number.isFinite(usedPct)) continue;
      const rounded = Math.min(100, Math.max(0, Math.round(usedPct)));
      const windowSeconds = Number(window?.limit_window_seconds);
      const key = windowLabel(windowSeconds) ?? fallbackKey;
      quotas[key] = {
        total: 100, used: rounded, remaining: 100 - rounded,
        ...(typeof window.reset_at === "string" && window.reset_at !== "" ? { reset: window.reset_at } : {}),
        // the window's full cycle length, straight from the endpoint —
        // lets a consumer show elapsed time / a countdown too
        ...(Number.isFinite(windowSeconds) ? { windowSeconds } : {}),
      };
    }
    if (Object.keys(quotas).length > 0) {
      aiio.setPlanUsage?.({
        ...(typeof body?.plan_type === "string" && body.plan_type !== "" ? { label: body.plan_type } : {}),
        quotas,
      });
    }
  } catch { /* best-effort — a failed usage fetch never breaks the turn */ }
}

/**
 * Default plan/quota reporting: only what the endpoint actually
 * publishes is reported (endpoints without rate-limit headers — local
 * servers — produce no report). A Protocol class overrides this for
 * its own quota dialect; this default instead ATTEMPTS EVERY KNOWN
 * DIALECT in turn, for generic/unrecognized OpenAI-compatible
 * endpoints that speak one of them without a dedicated plugin:
 *   0. The Codex backend's separate usage endpoint (see
 *      reportCodexUsage) — it has no relevant response headers at
 *      all, so the header dialects below never apply to it
 *   1. OpenAI's own `x-ratelimit-{limit,remaining,reset}-<family>`
 *      (requests, tokens, and — project-scoped keys — project-tokens;
 *      developers.openai.com/api/docs/guides/rate-limits)
 *   2. Anthropic-subscription-style unified rolling windows (see
 *      UNIFIED_WINDOW) — reported as {total: 100, used, remaining}
 *      percentage points, same shape as every other quota
 *   3. Kimi/Moonshot-style bare `x-ratelimit-{limit,remaining,reset}`
 *      (no requests/tokens split) — only when dialect 1 left
 *      "requests" unclaimed
 * May return a promise (dialect 0's own network call) — never
 * awaited by the caller (must not add latency to the turn); it never
 * rejects, so an unhandled rejection is not a risk.
 * @param {Headers} headers - the response's headers
 * @param {object} [aiio]
 */
export function reportPlanUsage(headers, aiio = this?.aiio) {
  if (isCodexBackend(this)) return reportCodexUsage(aiio);
  const get = (name) => headers?.get?.(name) ?? undefined;
  const num = (name) => {
    const value = Number(get(name));
    return get(name) !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const quotas = {};

  // 1) OpenAI dialect.
  const families = [
    ["requests", "requests"], ["tokens", "tokens"], ["project-tokens", "projectTokens"],
  ];
  for (const [wire, key] of families) {
    const quota = {
      ...(num(`x-ratelimit-limit-${wire}`) !== undefined ? { total: num(`x-ratelimit-limit-${wire}`) } : {}),
      ...(num(`x-ratelimit-remaining-${wire}`) !== undefined ? { remaining: num(`x-ratelimit-remaining-${wire}`) } : {}),
      ...(get(`x-ratelimit-reset-${wire}`) ? { reset: get(`x-ratelimit-reset-${wire}`) } : {}),
    };
    if (Object.keys(quota).length > 0) quotas[key] = quota;
  }

  // 2) Anthropic-subscription dialect.
  if (typeof headers?.forEach === "function") {
    headers.forEach((value, name) => {
      const match = UNIFIED_WINDOW.exec(name);
      if (!match) return;
      const spent = Number(value);
      if (!Number.isFinite(spent)) return;
      const window = match[1].toLowerCase();
      if (quotas[window]) return; // an OpenAI-named family already claimed this key
      const usedPct = Math.min(100, Math.max(0, Math.round(spent * 100)));
      const reset = headers.get?.(name.replace(/utilization$/i, "reset"));
      const windowSeconds = parseWindowSeconds(window);
      quotas[window] = {
        total: 100, used: usedPct, remaining: 100 - usedPct,
        ...(reset ? { reset } : {}),
        ...(Number.isFinite(windowSeconds) ? { windowSeconds } : {}),
      };
    });
  }

  // 3) Kimi/Moonshot dialect — only if dialect 1 left "requests" unclaimed.
  if (!quotas.requests) {
    const bare = {
      ...(num("x-ratelimit-limit") !== undefined ? { total: num("x-ratelimit-limit") } : {}),
      ...(num("x-ratelimit-remaining") !== undefined ? { remaining: num("x-ratelimit-remaining") } : {}),
      ...(get("x-ratelimit-reset") ? { reset: get("x-ratelimit-reset") } : {}),
    };
    if (Object.keys(bare).length > 0) quotas.requests = bare;
  }

  if (Object.keys(quotas).length > 0) aiio?.setPlanUsage?.({ quotas });
}

/**
 * Strict connection verification (login flows): list the models and
 * THROW on any failure — unlike models(), which falls back to the
 * cache and never reports why. A login must know the endpoint and its
 * credentials actually work.
 * VERIFICATION MODE: endpoints whose settings say `verify: "jwt"`
 * (the OpenAI Codex preset — the codex backend has no GET /models,
 * only POST /codex/responses) verify the freshly issued OAuth token
 * LOCALLY instead: it must BE a JWT (an opaque API key can never
 * work there) and unexpired — the successful token exchange already
 * proved the credentials, the claim check proves the shape.
 * @returns {Promise<{models: number}>} the listed model count
 */
export async function testConnection() {
  const settings = this.aiio?.settings ?? {};
  const token = settings.auth?.token;
  if (settings.verify === "jwt") {
    const claims = jwtClaims(token);
    if (!claims) {
      throw new ProviderError("auth",
        "this endpoint verifies OAuth (JWT) tokens: the stored token is not a JWT — sign in with the browser");
    }
    if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) {
      throw new ProviderError("auth", "the stored OAuth token is expired — sign in again");
    }
    const staticModels = settings.models && typeof settings.models === "object" ? settings.models : {};
    return { models: Object.keys(staticModels).length };
  }
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const accountId = accountIdOf(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const response = await fetch(`${this.baseUrl}/models`, singleShot({
    headers,
    signal: this.aiio?.requestSignal,
  }));
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpStatusError(response.status, response.statusText, body);
  }
  const body = await response.json();
  return { models: Array.isArray(body.data) ? body.data.length : 0 };
}
