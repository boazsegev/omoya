/**
 * lib/env/endpoints.js — the endpoint registry surface (private to
 * Env): live endpoint configuration plus endpoint-keyed auth/model
 * cache views, known-endpoint presets, model lists (cached + live
 * refresh with bounded empty-discovery retries), and environment auto-detection (dynamic endpoints —
 * never persisted).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../namespace.js";
import { isPlainObject } from "./settings.js";
import { durationTry as tryDurationValue } from "../util.js";
import { parseJsonc } from "./jsonc.js";
import { authSet, mergeAuthInMemory, mergeAuthUpdate } from "./auth.js";
import { applyModelFilter } from "./model-filter.js";
import { modelsChanged } from "./models-changed.js";

/** The built-in protocol an endpoint falls back to when neither its
 *  providers entry nor its auth/detection record names a `provider`
 *  (a url-only entry talks the OpenAI protocol; an entry with neither
 *  URL nor provider is a preference placeholder). */
export const DEFAULT_PROVIDER = "openai";

/** Resolve the endpoint's base auth/settings record, effective environment connection, and preferences layer.
 * The auth record is the base; a detected dynamic connection merges over it, and configured preferences win. A partial preferences placeholder is completed by the adopted environment connection or auth record.
 * @param {object} env - Env instance holding endpoint and settings maps
 * @param {string} name - endpoint name
 * @returns {{base: object, connection: object|undefined, prefs: object|undefined}} layers used by endpointSettings() and endpoint()
 */
function endpointLayers(env, name) {
  const prefs = env._configuredEndpoints?.has(name) === true ? env._endpoints[name] : undefined;
  const connection = prefs === undefined ? env._endpoints[name] : env._dynamicConnections?.get(name);
  const base = isPlainObject(env._settings[name]) ? env._settings[name] : {};
  return { base, connection, prefs };
}

/** Live endpoint configuration plus endpoint-keyed auth/model cache.
 *  The three layers of endpointLayers() merge per name. The endpoint
 *  is registered (endpointNames) only while some layer provides a
 *  connection (a `provider`, a `url`, or both; a url-only connection
 *  resolves the DEFAULT_PROVIDER protocol at use). The `models` MAPS
 *  (unique model names as keys, optional metadata as values) merge
 *  across layers the same way, and the endpoint's `filter` regex
 *  then marks every non-matching model id `secret: true`
 *  (lib/env/model-filter.js) — selectors, menus, and the last-model
 *  memory hide them through the existing secret path. Credentials
 *  live under the returned `.auth` object — providers read
 *  `settings.auth?.token` etc, never a flat `settings.token`.
 * @param {object} env - Env instance
 * @param {string} endpoint - endpoint name
 * @returns {Object} merged settings and auth section (possibly empty)
 */
export function endpointSettings(env, endpoint) {
  const { base, connection, prefs } = endpointLayers(env, endpoint);
  // Current auth data (credentials included) comes from the endpoint's
  // settings section ONLY: a copied auth payload in a connection record
  // is never connection policy (token rotation must win).
  const { auth: _b, ...conn } = isPlainObject(connection) ? connection : {};
  const merged = { ...base, ...conn, ...(isPlainObject(prefs) ? prefs : {}) };
  if (isPlainObject(base.models) || isPlainObject(conn.models) || isPlainObject(prefs?.models)) {
    merged.models = applyModelFilter(merged, {
      ...(isPlainObject(base.models) ? base.models : {}),
      ...(isPlainObject(conn.models) ? conn.models : {}),
      ...(isPlainObject(prefs?.models) ? prefs.models : {}),
    });
  }
  return merged;
}

/**
 * Re-read one endpoint's persisted settings/auth record from disk and
 * merge it over the live settings tree — the MULTI-PROCESS refresh:
 * another Omoya process may have rotated this endpoint's auth (login,
 * OAuth refresh) while this one kept its startup snapshot in memory.
 * The endpoint's OWN scope files are re-read (an unflushed queued
 * write wins over the file it is about to replace — same read rule
 * authSet applies): the scope's settings.json (`providers` entry plus
 * the endpoint's own section) and its auth file
 * (`auth-<endpoint>.json`, or the namespaced project auth file for
 * local scope). A vanished file is a NO-OP — Env never drops live
 * settings on a transient read gap. Dynamic (environment-detected)
 * endpoints persist nothing and have nothing to re-read.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {Object|undefined} the endpoint's live settings section
 */
export function refreshEndpointSettings(env, name) {
  // A dynamic endpoint's environment connection is re-derived every
  // startup (nothing to re-read), but its AUTH section may still hold a
  // live model cache worth refreshing from disk below.
  if (env._dynamicEndpoints.has(name) && env._configuredEndpoints?.has(name) !== true) return env._settings[name];
  const scope = env._endpointScopes.get(name) ?? "package";
  /** Read one scope file, preferring a queued write over disk.
   * @param {string} file - settings or auth file path
   * @returns {Object|undefined} parsed plain-object data; undefined only when the file is absent and has no queued write
   */
  const read = (file) => {
    let parsed = env._writeQueue.peek(file);
    if (parsed !== undefined) return isPlainObject(parsed) ? parsed : {};
    if (!existsSync(file)) return undefined; // a vanished file: no update
    try {
      const value = parseJsonc(readFileSync(file, "utf8"));
      return isPlainObject(value) ? value : {};
    } catch {
      return {}; // an unreadable file contributes nothing
    }
  };
  // An auth file is rewritten wholesale per write, so its on-disk record
  // carries only this endpoint's section (authSet's round-trip): a
  // missing section is the empty record, never "file vanished".
  const files = scope === "local"
    ? [join(env.cwd, NAMES.projectSettings), join(env.cwd, `${NAMES.projectAuthPrefix}${name}.json`)]
    : [join(env._settingsDir ?? env._dir, "settings.json"), join(env._settingsDir ?? env._dir, `auth-${name}.json`)];
  const [settingsFile, authFile] = files.map(read);
  if (settingsFile === undefined && authFile === undefined) return env._settings[name];
  const section = {
    ...(isPlainObject(authFile?.[name]) ? authFile[name] : {}),
    ...(isPlainObject(settingsFile?.[name]) ? settingsFile[name] : {}),
  };
  const existing = isPlainObject(env._settings[name]) ? env._settings[name] : {};
  // The file wins over the stale in-memory view (a rotation must
  // overwrite, not deep-merge onto, the old token), same rule authSet
  // applies when a caller persists.
  env._settings = { ...env._settings, [name]: mergeAuthUpdate(existing, section) };
  return env._settings[name];
}

/**
 * One named endpoint's EFFECTIVE connection configuration — the
 * connection-layer view of the endpointLayers() merge (endpointSettings
 * is the settings view): the auth record's connection data as the
 * base, the adopted environment connection of a detected (dynamic)
 * endpoint over it, and the providers entry — the user's policy —
 * always winning. A bare PREFERENCES placeholder ({filter},
 * {maxActive}) is not an endpoint: it contributes its preferences
 * while the completing layer's `provider`/`url` show through — this
 * is where the adoption rule is decided, so no consumer re-derives
 * it (a placeholder alone would fall back to the OpenAI protocol at
 * no URL and answer "no models"). SETTINGS-layer fields (the `auth`
 * envelope, the model/registry caches — CONNECTION_CACHE_KEYS) stay
 * endpointSettings-only: connection policy never carries a token or
 * a cache blob.
 * @param {object} env
 * @param {string} name
 * @returns {Object|undefined}
 */
export function endpoint(env, name) {
  const { base, connection, prefs } = endpointLayers(env, name);
  const merged = { ...stripCache(base), ...stripCache(connection), ...stripCache(prefs) };
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
export const ENDPOINT_PREFERENCE_KEYS = new Set(["filter", "maxActive", "secret", "models"]);

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
  return hasConnectionData(env._endpoints[name])
    || hasConnectionData(env._dynamicConnections?.get(name))
    || hasConnectionData(env._settings[name]);
}

/** List registered endpoint names after secret filtering.
 * @param {object} env - Env instance
 * @param {object} [options={}] - listing options
 * @param {boolean} [options.includeSecret=false] - include endpoints marked secret
 * @returns {string[]} endpoint names in registry key order
 */
export function endpointNames(env, { includeSecret = false } = {}) {
  return Object.keys(env._endpoints).filter((name) => endpointRegistered(env, name)
    && (includeSecret || env._endpoints[name]?.secret !== true));
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
  return env._endpointScopes.get(name) ?? "package";
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
  const registeredRecord = env._endpoints[name];
  if (refresh && config) {
    // endpoint() is the effective connection view (a bare preferences
    // placeholder rides the adopted environment connection), so the
    // protocol/URL resolve here without a merged-view fallback.
    const Protocol = env._providers[config.provider ?? DEFAULT_PROVIDER];
    if (Protocol) {
      try {
        const settings = endpointSettings(env, name);
        const models = await Protocol.models({ url: url ?? config.url, auth: settings.auth, settings, signal });
        // A timed-out probe may still finish if a provider ignores abort.
        // It must never publish stale results or resurrect a removed endpoint.
        const current = endpoint(env, name);
        const stale = signal?.aborted || (registeredRecord !== undefined && env._endpoints[name] !== registeredRecord)
          || current?.provider !== config.provider || current?.url !== config.url;
        if (!stale && isPlainObject(models)) {
          authSet(env, name, { models });
          return applyModelFilter(endpointSettings(env, name), models);
        }
      } catch {
        // Cached/static models below are the offline fallback.
      }
    }
  }
  const cached = endpointSettings(env, name).models;
  return isPlainObject(cached) ? cached : {};
}

/**
 * Query EVERY registered endpoint for its available models (parallel,
 * each bounded by `timeout`): the startup cache renewal. An empty
 * result schedules bounded post-startup retries, which update the live
 * Env's model map when the endpoint responds. A failed query uses any
 * existing cache/static models. Each refresh batches its immediate writes
 * (lib/env/persist.js); late discoveries write separately.
 */
const MODEL_RETRY_DELAYS = [1000, 3000];
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
  if (!sameConnection(env, name, connection)) return false;
  try {
    const models = await boundedModelQuery(env, name, MODEL_RETRY_TIMEOUTS[attempt]);
    return (models === null || Object.keys(models).length === 0) && sameConnection(env, name, connection);
  } catch {
    return sameConnection(env, name, connection);
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
  if (attempt >= MODEL_RETRY_DELAYS.length || env._modelRetries.has(name)) return;
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
 * @throws {Error} if the write-queue batch rejects
 */
export async function refreshModels(env, { timeout = 2000 } = {}) {
  return env._writeQueue.batch(async () => {
    const ms = tryDurationValue(timeout) ?? 2000;
    const answered = [];
    await Promise.all(Object.keys(env._endpoints).map(async (name) => {
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
  });
}

/**
 * Run provider-owned endpoint probes and fill only absent settings entries.
 * A discovered endpoint may carry an `auth` payload (e.g. an API key
 * found in the process environment): it is stripped from the endpoint
 * config and routed into the endpoint's auth namespace instead.
 * Discoveries marked `dynamic: true` are ENVIRONMENT-DEFINED: they
 * are never persisted — the endpoint joins the live map and its auth
 * merges into the live settings tree in memory only, so a vanished
 * server or a removed API key simply isn't there next startup (and
 * no key is ever written to disk by detection). Discovery data is
 * passed a SHADOW endpoints map (existing dynamic entries hidden,
 * configured entries REMOVED — a providers entry never shadows
 * detection, whether it is a full connection or a bare preferences
 * placeholder): a
 * dynamic endpoint re-detects every probe, so a rotated environment
 * key lands immediately, a key REMOVED from the environment drops
 * the endpoint out of the live map, and any stale persisted record
 * (an auth-<endpoint>.json left by a build that persisted dynamic
 * endpoints — its self-contained record would otherwise resurrect
 * the endpoint after the key is gone) is removed when it exactly
 * matches the re-detected environment value.
 * @param {object} env
 * @param {Object} [options={}] - detector options
 * @param {number} [options.timeout=300] - per-protocol probe cap in milliseconds
 * @returns {Promise<string[]>} newly added endpoint names; configured adoptions and updates are not listed
 * @throws {Error} if an unexpected write-queue, filesystem cleanup, or state-update operation fails; protocol detection errors are ignored
 */
export async function detectEndpoints(env, { timeout = 300 } = {}) {
  return env._writeQueue.batch(async () => {
    // Only explicit settings-owned endpoints occupy detector slots. Dynamic
    // endpoints and auth-file records are hidden so one parallel detector pass
    // can handle rotation/removal and identify old dynamic residue without a
    // second serial network probe.
    const shadow = {};
    const discoveries = await Promise.all(Object.keys(env._providers).map(async (name) => {
      const Protocol = env._providers[name];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        return await Protocol.detect({
          settings: env._settings,
          endpoints: shadow,
          signal: controller.signal,
        });
      } catch {
        return {};
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
    // NOTHING and survives its environment in nothing. On each
    // detection, dynamic discoveries refresh their live auth (a rotated
    // key lands immediately), and every OTHER dynamic endpoint — its
    // environment key gone — is dropped from the live map along with
    // its in-memory auth section. Detection also claims an auth-file
    // record that EXACTLY matches what the environment provides (same
    // provider, same URL, same auth — precisely what a build that
    // persisted dynamic endpoints wrote): that is residue, not user
    // configuration; deleting it loses nothing the environment does
    // not re-derive. A record that DIFFERS in any field is the user's
    // own explicit login to the same service and wins over the
    // environment, untouched.
    const current = new Map();
    for (const [name, ep] of pending) {
      if (ep.dynamic !== true) continue;
      const configured = env._configuredEndpoints?.has(name) === true;
      const existing = configured ? undefined : env._endpoints[name];
      if (!configured && !env._dynamicEndpoints.has(name) && existing !== undefined) {
        const section = isPlainObject(env._settings[name]) ? env._settings[name] : {};
        const residue = existing.provider === ep.provider && existing.url === ep.url
          && (!isPlainObject(ep.auth) || JSON.stringify(section.auth) === JSON.stringify(ep.auth));
        if (!residue) continue; // an explicit login to the same service, not detection residue
      }
      current.set(name, ep);
      env._dynamicEndpoints.add(name);
    }
    const added = [];
    for (const [name, ep] of current) {
      for (const file of new Set([
        join(env._settingsDir ?? env._dir, `auth-${name}.json`),
        join(env.cwd, `${NAMES.projectAuthPrefix}${name}.json`),
      ])) {
        env._writeQueue.discard(file);
        rmSync(file, { force: true });
      }
      const { auth: _a, models: discoveredModels, dynamic: _d, ...config } = ep;
      if (env._configuredEndpoints?.has(name) === true) {
        // A configured entry ADOPTS the environment connection instead
        // of shadowing it: endpointSettings() merges this record under
        // the user's preferences (a full entry's own connection fields
        // keep winning; a preferences-only entry becomes a live
        // endpoint).
        env._dynamicConnections.set(name, { ...config });
      } else {
        const existing = env._endpoints[name];
        if (existing === undefined) {
          env._endpoints[name] = { ...config };
          added.push(name);
        } else if (ep.url !== existing.url) {
          env._endpoints[name] = { ...existing, url: ep.url }; // the environment moved the endpoint
        }
      }
      const dynamicCache = {
        ...(isPlainObject(ep.auth) ? { auth: ep.auth } : {}),
        ...(isPlainObject(discoveredModels) ? { models: discoveredModels } : {}),
      };
      if (Object.keys(dynamicCache).length > 0) {
        // Credentials and proactively discovered models share the dynamic
        // endpoint's process-lifetime cache. Neither belongs in its
        // connection record or on disk; a later detection replaces both.
        mergeAuthInMemory(env, name, dynamicCache);
      }
    }
    for (const name of [...env._dynamicEndpoints]) {
      if (current.has(name)) continue;
      clearTimeout(env._modelRetries?.get(name)?.timer);
      env._modelRetries?.delete(name);
      env._dynamicConnections.delete(name);
      env._dynamicEndpoints.delete(name);
      if (env._configuredEndpoints?.has(name) === true) continue; // the preferences entry stays
      delete env._endpoints[name];
      if (isPlainObject(env._settings[name])) {
        const { [name]: _dropped, ...rest } = env._settings;
        env._settings = rest;
      }
    }
    for (const [name, ep] of pending) {
      if (current.has(name) || env._endpoints[name] !== undefined) continue;
      const { auth, dynamic, ...config } = ep;
      env._endpoints[name] = { ...config };
      if (isPlainObject(auth)) authSet(env, name, { auth });
      added.push(name);
    }
    modelsChanged(env);
    return added;
  });
}
