/**
 * lib/env/endpoints.js — the endpoint registry surface (private to
 * Env): live endpoint configuration (`providers.<endpoint>`), known-endpoint presets, model lists (cached + live
 * refresh with bounded empty-discovery retries), and environment auto-detection (dynamic endpoints —
 * never persisted).
 */

import { isPlainObject } from "./settings.js";
import { durationTry as tryDurationValue } from "../util.js";
import { authSet } from "./auth.js";
import { applyModelFilter } from "./model-filter.js";
import { modelsChanged } from "./models-changed.js";

/** The built-in protocol an endpoint falls back to when neither its
 *  providers entry nor its auth/detection record names a `provider`
 *  (a url-only entry talks the OpenAI protocol; an entry with neither
 *  URL nor provider is a preference placeholder). */
export const DEFAULT_PROVIDER = "openai";

/** Live endpoint settings: the merged `providers.<name>` section — package and
 *  extension files, in-memory detected facts, user settings, login auth files
 *  (mounted at providers), project files and explicit settings, later sources
 *  winning. The endpoint is registered (endpointNames) while the section has a
 *  connection (a `provider`, a `url`, or both; a url-only connection resolves
 *  the DEFAULT_PROVIDER protocol at use). The endpoint's `filter` regex marks
 *  every non-matching model id `secret: true` (lib/env/model-filter.js).
 *  Credentials live under `.auth` — providers read `settings.auth?.token`.
 * @param {object} env - Env instance
 * @param {string} endpoint - endpoint name
 * @returns {Object} merged settings and auth section (possibly empty)
 */
export function endpointSettings(env, endpoint) {
  const section = env._sourceGraph.store.read(["providers", endpoint]);
  if (!isPlainObject(section)) return {};
  if (isPlainObject(section.models)) section.models = applyModelFilter(section, section.models);
  return section;
}

/**
 * Return the graph's current endpoint auth snapshot. File-backed graph
 * nodes poll for external writes; explicit refresh asks the graph to
 * asynchronously reload existing endpoint source nodes first.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {Promise<Object|undefined>} the endpoint's live settings section
 */
export async function refreshEndpointSettings(env, name) {
  // Environment facts have no disk owner; reading them must not create one.
  if (env._dynamicEndpoints.has(name)) return endpointSettings(env, name);
  const before = endpointSettings(env, name);
  await env._sourceGraph.endpointReload(name);
  const fresh = endpointSettings(env, name);
  // A transiently missing auth file cannot invalidate an active handle's
  // credentials. Keep the last snapshot only until its source returns.
  if (fresh.auth === undefined && before.auth !== undefined) return { ...fresh, auth: before.auth };
  return Object.keys(fresh).length ? fresh : undefined;
}

/**
 * One named endpoint's connection configuration: its settings section
 * without credentials or model/registry caches (CONNECTION_CACHE_KEYS).
 * A bare preferences section ({filter}, {maxActive}) has no connection.
 * @param {object} env
 * @param {string} name
 * @returns {Object|undefined}
 */
export function endpoint(env, name) {
  const merged = stripCache(env._sourceGraph.store.read(["providers", name]));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Settings-layer fields that never belong to a CONNECTION view: credentials and runtime model/registry caches. */
const CONNECTION_CACHE_KEYS = ["auth", "models", "registry"];

/** Copy a connection layer without auth or runtime cache fields.
 * @param {*} record - candidate endpoint layer
 * @returns {Object} shallow copy with CONNECTION_CACHE_KEYS removed, or {} for non-plain input
 */
function stripCache(record) {
  if (!isPlainObject(record)) return {};
  const out = { ...record };
  for (const key of CONNECTION_CACHE_KEYS) delete out[key];
  return out;
}

/** Settings-only keys retained for callers that inspect endpoint preferences.
 *  Registration itself uses a connection whitelist, not this list. */
export const ENDPOINT_PREFERENCE_KEYS = new Set(["filter", "maxActive", "secret", "disabled", "models"]);

/** Check whether a record supplies provider or URL connection identity; credentials, commands, and other preferences alone do not register an endpoint.
 * @param {*} record - candidate endpoint record
 * @returns {boolean} true only for a plain object with a truthy provider or URL
 */
function hasConnectionData(record) {
  return isPlainObject(record) && (Boolean(record.url) || Boolean(record.provider));
}

/** REGISTERED endpoint names — a settings, environment or auth layer
 *  supplies a URL or provider. Bare preferences register nothing.
 * @param {object} env - Env instance
 * @param {string} name - endpoint name
 * @returns {boolean} whether any registry/settings layer provides a provider or URL
 */
export function endpointRegistered(env, name) {
  return hasConnectionData(endpoint(env, name));
}

/** List registered endpoint names after secret filtering.
 * @param {object} env - Env instance
 * @param {object} [options={}] - listing options
 * @param {boolean} [options.includeSecret=false] - include endpoints marked secret
 * @returns {string[]} endpoint names in registry key order
 */
export function endpointNames(env, { includeSecret = false } = {}) {
  return env._sourceGraph.endpointNames().filter((name) => endpointRegistered(env, name)
    && (includeSecret || endpoint(env, name)?.secret !== true));
}

/**
 * The scope an endpoint's settings/auth live in: "local" when its
 * configuration came from the PROJECT's settings.json, "package"
 * otherwise — the re-authorization flow re-saves where the endpoint
 * already lives instead of asking.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {"package"|"local"}
 */
export function endpointScope(env, name) {
  return env._endpointScopes.get(name) ?? env._sourceGraph.endpointScope(name);
}

/**
 * Is the endpoint ENVIRONMENT-DEFINED (auto-detected from the process
 * environment — an API key, a reachable local server)? Dynamic
 * endpoints are never persisted: /logout clears the in-memory
 * registration only, and a vanished environment means the endpoint
 * simply isn't detected next startup.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {boolean}
 */
export function isDynamic(env, name) {
  return env._dynamicEndpoints.has(name);
}

/**
 * Known endpoint presets offered by the login wizards: every loaded
 * protocol class may publish a static `knownEndpoints` list of
 * {name, label, url, ...extras} — endpoints its protocol can already
 * talk to (cloud services, well-known local servers). Extras ride
 * along verbatim: a preset's `oauth` descriptor is what lets the
 * wizards drive browser sign-in AUTOMATICALLY, and an optional
 * `note` string is a caveat the login wizard prints next to the
 * entry (billing surprises, provider-support fragility). First protocol wins
 * on a name collision; secret protocols stay unpublished. The
 * wizards always ALSO offer a manual (enter-URL) endpoint on top of
 * these.
 * @param {object} env
 * @returns {Array<{name: string, label: string, url: string, provider: string, oauth?: object, note?: string}>}
 */
export function knownEndpoints(env) {
  const out = [];
  const seen = new Set();
  for (const protocol of Object.keys(env._providers)) {
    const Protocol = env._providers[protocol];
    if (Protocol.provider?.secret === true) continue;
    for (const entry of Protocol.knownEndpoints ?? []) {
      if (typeof entry?.name !== "string" || entry.name === "") continue;
      if (typeof entry?.url !== "string" || entry.url === "") continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({
        ...entry, // extras (the oauth descriptor, future fields) ride along
        name: entry.name,
        label: typeof entry.label === "string" ? entry.label : entry.name,
        url: entry.url,
        provider: protocol,
      });
    }
  }
  return out;
}

/**
 * One endpoint's model MAP (unique model names as keys, optional
 * metadata as values). With `refresh`, the endpoint is queried live
 * through its provider's static models() and the result refreshes the
 * auth cache; a failed/unreachable query falls back to the cached +
 * static config list — a stale list persists, never blocks startup.
 * The endpoint's `filter` regex applies the same way as in
 * endpointSettings(): non-matching ids are `secret: true` here too,
 * so callers hiding secret models see the filtered list either way.
 * @param {object} env
 * @param {string} name - endpoint name
 * @param {Object} [options={}] - live-query options
 * @param {boolean} [options.refresh=false] - query the endpoint live first
 * @param {string} [options.url] - URL override for the live query; does not change endpoint configuration
 * @param {AbortSignal} [options.signal] - aborts the live query; aborted or stale results are not cached
 * @returns {Promise<Object>} model map ({} when nothing is known); provider failures fall back to cached settings
 * @throws {Error} if resolving the cached fallback settings fails
 */
export async function endpointModels(env, name, { refresh = false, url, signal } = {}) {
  const config = endpoint(env, name);
  const registeredRecord = JSON.stringify(config);
  if (refresh && config) {
    // endpoint() is the effective connection view (a bare preferences
    // placeholder rides the adopted environment connection), so the
    // protocol/URL resolve here without a merged-view fallback.
    const Protocol = env._providers[config.provider ?? DEFAULT_PROVIDER];
    if (Protocol) {
      let models;
      try {
        const settings = endpointSettings(env, name);
        models = await Protocol.models({ url: url ?? config.url, auth: settings.auth, settings, signal });
      } catch {
        // Provider failures use the cached/static offline fallback.
      }
      // A timed-out probe may still finish if a provider ignores abort.
      // Never publish stale results or resurrect a removed endpoint.
      const current = endpoint(env, name);
      const stale = signal?.aborted || !endpointRegistered(env, name) || JSON.stringify(current) !== registeredRecord;
      if (!stale && isPlainObject(models)) {
        // Persistence failures are not provider failures; surface them.
        authSet(env, name, { models });
        return applyModelFilter(endpointSettings(env, name), models);
      }
    }
  }
  const cached = endpointSettings(env, name).models;
  return isPlainObject(cached) ? cached : {};
}

/**
 * Query EVERY registered endpoint for its available models (parallel,
 * each bounded by `timeout`): the startup cache renewal. Empty results
 * schedule bounded retries. Successful file-backed auth updates persist
 * through their graph source.
 */
const MODEL_RETRY_DELAYS = [1000, 3000];

// Only providers opting into the environment-only hook are cached. Legacy
// detect() remains live: custom detectors may mix settings, files and probes.
const environmentDiscoveries = new WeakMap();

async function environmentDetection(env, name, Protocol, settings, endpoints) {
  if (typeof Protocol.detectEnvironment !== "function") return {};
  let cache = environmentDiscoveries.get(env);
  if (!cache) environmentDiscoveries.set(env, cache = new Map());
  let entry = cache.get(name);
  if (!entry || entry.Protocol !== Protocol) {
    entry = { Protocol, result: Promise.resolve().then(() => Protocol.detectEnvironment({ settings, endpoints }))
      .catch(() => ({})) };
    cache.set(name, entry);
  }
  return entry.result;
}

const MODEL_RETRY_TIMEOUTS = [5000, 10000];

/** Check whether the endpoint remains registered with the same provider and URL.
 * @param {object} env - Env instance
 * @param {string} name - endpoint name
 * @param {object} connection - connection snapshot
 * @returns {boolean} true if current connection matches the snapshot
 */
function sameConnection(env, name, connection) {
  const current = endpoint(env, name);
  return endpointRegistered(env, name) && current?.provider === connection.provider && current?.url === connection.url;
}

/** Run one bounded post-startup model attempt; failures never reject into a timer callback.
 * @param {object} env - Env instance
 * @param {string} name - endpoint name
 * @param {object} connection - connection snapshot guarding this retry
 * @param {number} attempt - retry index selecting the timeout
 * @returns {Promise<boolean>} whether another retry may be useful while the same connection remains
 */
async function retryModelAttempt(env, name, connection, attempt) {
  if (env.closed || !sameConnection(env, name, connection)) return false;
  try {
    const models = await boundedModelQuery(env, name, MODEL_RETRY_TIMEOUTS[attempt]);
    return !env.closed && (models === null || Object.keys(models).length === 0) && sameConnection(env, name, connection);
  } catch {
    return !env.closed && sameConnection(env, name, connection);
  }
}

/** Schedule bounded retries after empty model discovery without blocking startup.
 * @param {object} env - Env instance whose retry map and timers are updated
 * @param {string} name - endpoint name
 * @param {object} connection - connection snapshot; changed endpoints are not retried
 * @param {number} [attempt=0] - retry index
 * @returns {void}
 */
function retryEmptyModels(env, name, connection, attempt = 0) {
  env._modelRetries ??= new Map();
  if (env.closed || attempt >= MODEL_RETRY_DELAYS.length || env._modelRetries.has(name)) return;
  const ticket = { timer: null };
  ticket.timer = setTimeout(() => {
    void retryModelAttempt(env, name, connection, attempt).then((again) => {
      if (env._modelRetries.get(name) !== ticket) return;
      env._modelRetries.delete(name);
      if (again) retryEmptyModels(env, name, connection, attempt + 1);
    });
  }, MODEL_RETRY_DELAYS[attempt]);
  ticket.timer.unref?.();
  env._modelRetries.set(name, ticket);
}

/** Bound a live model query even when its provider ignores the AbortSignal.
 * @param {object} env - Env instance
 * @param {string} name - endpoint name
 * @param {number} timeout - deadline in milliseconds
 * @returns {Promise<Object|null>} model map, or null when the deadline wins
 * @throws {Error} if endpointModels() rejects before the deadline
 */
async function boundedModelQuery(env, name, timeout) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
    timer.unref?.();
  });
  try {
    return await Promise.race([endpointModels(env, name, { refresh: true, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh registered endpoints' model caches in parallel and batch immediate persistence.
 * Empty, timed-out, or failed discoveries schedule bounded post-startup retries; successful non-empty results cancel pending retries.
 * @param {object} env - Env instance
 * @param {{timeout?: number|string}} [options={}] - startup timeout per endpoint; duration strings are accepted
 * @param {number|string} [options.timeout=2000] - per-endpoint timeout; invalid values fall back to 2000 ms
 * @returns {Promise<string[]>} endpoints whose query completed before timeout, including cache/static fallback results
 * @throws {Error} if graph reads fail
 */
export async function refreshModels(env, { timeout = 2000 } = {}) {
  {
    const ms = tryDurationValue(timeout) ?? 2000;
    const answered = [];
    await Promise.all(endpointNames(env, { includeSecret: true }).map(async (name) => {
      if (!endpointRegistered(env, name)) return;
      const connection = endpoint(env, name);
      try {
        const models = await boundedModelQuery(env, name, ms);
        if (models !== null) answered.push(name);
        if (models === null || Object.keys(models).length === 0) retryEmptyModels(env, name, connection);
        else {
          clearTimeout(env._modelRetries?.get(name)?.timer);
          env._modelRetries?.delete(name);
        }
      } catch {
        // A protocol's models()/close() may misbehave; allow a later retry.
        retryEmptyModels(env, name, connection);
      }
    }));
    return answered;
  }
}

/**
 * Run provider-owned endpoint probes and fill only absent settings entries.
 * A discovered endpoint may carry an `auth` payload (e.g. an API key
 * found in the process environment). Detection never writes a file:
 * discoveries marked `dynamic: true` are ENVIRONMENT-DEFINED and live in
 * memory only, so a vanished server or a removed API key simply isn't
 * there next startup; other discoveries are kept in memory too. A login's
 * own record (an auth file with a connection) is never claimed by
 * detection. Live probes re-detect every pass, while opt-in
 * environment-only keys remain fixed for this Env (process environment
 * does not change at runtime); a vanished dynamic endpoint drops out.
 * @param {object} env
 * @param {Object} [options={}] - detector options
 * @param {number} [options.timeout=300] - per-protocol probe cap in milliseconds
 * @returns {Promise<string[]>} newly added endpoint names; configured adoptions and updates are not listed
 * @throws {Error} if an unexpected graph or auth-source update fails; protocol detection errors are ignored
 */
export async function detectEndpoints(env, { timeout = 300 } = {}) {
  {
    // Only explicit settings-owned endpoints occupy detector slots. Dynamic
    // endpoints and auth-file records are hidden so one parallel detector pass
    // can handle rotation/removal and identify old dynamic residue without a
    // second serial network probe.
    const shadow = {};
    const discoveries = await Promise.all(Object.keys(env._providers).map(async (name) => {
      const Protocol = env._providers[name];
      const settings = env._sourceGraph.store.read([]);
      const cached = await environmentDetection(env, name, Protocol, settings, shadow);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        const live = Protocol.detectEnvironmentOnly === true ? {} :
          await Protocol.detect({ settings, endpoints: shadow, signal: controller.signal });
        return { ...cached, ...live };
      } catch {
        return cached;
      } finally {
        clearTimeout(timer);
      }
    }));
    const pending = [];
    const seen = new Set();
    for (const found of discoveries) {
      if (!isPlainObject(found)) continue;
      for (const [name, ep] of Object.entries(found)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (!isPlainObject(ep) || typeof ep.provider !== "string" || typeof ep.url !== "string") continue;
        if (!env._providers[ep.provider]) continue;
        pending.push([name, ep]);
      }
    }
    // The DYNAMIC lifecycle: an environment-defined endpoint persists
    // NOTHING. Each detection refreshes its facts in memory, and every
    // other dynamic endpoint (its environment key gone) is dropped. An
    // endpoint with its own record (a login's auth file, a settings
    // section) is the user's and is not shadowed by detection.
    const current = new Map();
    for (const [name, ep] of pending) {
      if (ep.dynamic !== true) continue;
      // A login's own record (an auth file with a connection) is the user's: detection never claims it.
      const login = [env._sourceGraph.authFile(name), env._sourceGraph.authFile(name, { scope: "project" })]
        .some((node) => hasConnectionData(node?.own([name])));
      if (!env._dynamicEndpoints.has(name) && login) continue;
      current.set(name, ep);
    }
    const previous = new Set(env._dynamicEndpoints);
    const added = [];
    let changed = false;
    for (const [name, ep] of current) {
      if (!env._sourceGraph.configuredEndpoint(name) && !endpointRegistered(env, name)) added.push(name);
      // A detector that publishes no model list keeps the one learned for the same connection.
      const learned = env._sourceGraph.detectionGet(name);
      const models = isPlainObject(ep.models) ? ep.models
        : learned?.provider === ep.provider && learned?.url === ep.url ? learned.models : undefined;
      const facts = { provider: ep.provider, url: ep.url,
        ...(isPlainObject(ep.auth) ? { auth: ep.auth } : {}),
        ...(isPlainObject(models) ? { models } : {}) };
      if (env._sourceGraph.detectionSet(name, facts) !== false || !env._dynamicEndpoints.has(name)) changed = true;
      env._dynamicEndpoints.add(name);
    }
    for (const name of previous) {
      if (current.has(name)) continue;
      clearTimeout(env._modelRetries?.get(name)?.timer);
      env._modelRetries?.delete(name);
      env._sourceGraph.detectionRemove(name);
      env._dynamicEndpoints.delete(name);
      changed = true;
    }
    for (const [name, ep] of pending) {
      if (current.has(name) || endpointRegistered(env, name)) continue;
      authSet(env, name, { provider: ep.provider, url: ep.url,
        ...(isPlainObject(ep.auth) ? { auth: ep.auth } : {}),
        ...(isPlainObject(ep.models) ? { models: ep.models } : {}) });
      added.push(name);
      changed = true;
    }
    if (changed) modelsChanged(env);
    return added;
  }
}
