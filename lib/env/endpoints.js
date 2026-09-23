/**
 * lib/env/endpoints.js — the endpoint registry surface (private to
 * Env): live endpoint configuration plus endpoint-keyed auth/model
 * cache views, known-endpoint presets, model lists (cached + live
 * refresh), and environment auto-detection (dynamic endpoints —
 * never persisted).
 */

import { isPlainObject } from "./settings.js";
import { tryDuration as tryDurationValue } from "./duration.js";
import { authSet, mergeAuthInMemory } from "./auth.js";

/** Live endpoint configuration plus endpoint-keyed auth/model cache.
 *  The `models` MAPS (unique model names as keys, optional metadata
 *  as values) merge: the STATIC config list (settings.providers —
 *  for endpoints that publish no dynamic list) is the base, the
 *  fetched cache (auth-<endpoint>.json) refreshes/overrides per key.
 *  Credentials live under the returned `.auth` object — providers
 *  read `settings.auth?.token` etc, never a flat `settings.token`. */
export function endpointSettings(env, endpoint) {
  const config = env.endpoints[endpoint];
  const auth = env._settings[endpoint];
  // A configured providers entry is the user's connection policy and
  // wins over the durable auth/cache record. An endpoint introduced by
  // authSet() itself is instead a single live record, so its current
  // auth section remains authoritative after a file edit.
  const configured = env._configuredEndpoints?.has(endpoint);
  // endpoint() retains the merged record for restart stability, but its
  // copied auth payload is never connection policy: current auth data
  // must win after token rotation.
  const { auth: cachedAuth, ...connection } = isPlainObject(config) ? config : {};
  const merged = configured
    ? { ...(isPlainObject(auth) ? auth : {}), ...connection }
    : { ...connection, ...(isPlainObject(auth) ? auth : {}) };
  if (isPlainObject(config?.models) || isPlainObject(auth?.models)) {
    merged.models = {
      ...(isPlainObject(config?.models) ? config.models : {}),
      ...(isPlainObject(auth?.models) ? auth.models : {}),
    };
  }
  return merged;
}

/** @returns {Object|undefined} one named endpoint configuration */
export function endpoint(env, name) {
  const found = env.endpoints[name];
  return isPlainObject(found) ? found : undefined;
}

/**
 * Is an endpoint LOCAL? An endpoint is local when the PROJECT's
 * settings file configured it (scope "local") or its record publishes
 * itself as local (`local: true`) or non-remote (`remote: false`) —
 * otherwise it is remote (public). One shared predicate: the
 * model-list access policy
 * (settings.local / settings.remote) classify the same way.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {boolean}
 */
export function endpointLocal(env, name) {
  const entry = env.endpoints[name];
  return env.endpointScope?.(name) === "local" || entry?.remote === false || entry?.local === true;
}

/** Endpoint names filtered by exposure: local ones, remote ones, or all. */
export function endpointNames(env, { includeSecret = false, access = "all" } = {}) {
  if (!["local", "remote", "all"].includes(access)) throw new TypeError('endpoint access must be "local", "remote", or "all"');
  return Object.keys(env.endpoints).filter((name) => {
    const entry = env.endpoints[name];
    if (!includeSecret && entry?.secret === true) return false;
    const local = endpointLocal(env, name);
    return access === "all" || (access === "local" ? local : !local);
  });
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
 * wizards drive browser sign-in AUTOMATICALLY. First protocol wins
 * on a name collision; secret protocols stay unpublished. The
 * wizards always ALSO offer a manual (enter-URL) endpoint on top of
 * these.
 * @param {object} env
 * @returns {Array<{name: string, label: string, url: string, provider: string, oauth?: object}>}
 */
export function knownEndpoints(env) {
  const out = [];
  const seen = new Set();
  for (const protocol of env.providerNames()) {
    const Protocol = env.providers[protocol];
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
 * through its protocol class (which refreshes the auth cache on
 * success); a failed/unreachable query falls back to the cached +
 * static config list — a stale list persists, never blocks startup.
 * @param {object} env
 * @param {string} name - endpoint name
 * @param {Object} [options]
 * @param {boolean} [options.refresh] - query the endpoint live first
 * @param {string} [options.url] - URL override (invocation-only endpoints)
 * @param {AbortSignal} [options.signal] - aborts the live query
 * @returns {Promise<Object>} the model map ({} when nothing is known)
 */
export async function endpointModels(env, name, { refresh = false, url, signal } = {}) {
  const config = endpoint(env, name);
  if (refresh && config) {
    const Protocol = env.provider(config.provider);
    if (Protocol) {
      // the same lightweight IO facade the login flow uses: enough
      // for the protocol's models() (settings view, authSet, signal)
      const aiio = {
        endpoint: name,
        url: url ?? config.url,
        requestSignal: signal,
        authSet: (data, options) => authSet(env, name, data, options),
      };
      Object.defineProperty(aiio, "settings", { get: () => endpointSettings(env, name) });
      const connection = new Protocol(aiio.url, aiio);
      try {
        const models = await connection.models();
        if (isPlainObject(models)) return models;
      } catch {
        // Cached/static models below are the offline fallback.
      } finally {
        await connection.close?.().catch(() => {});
      }
    }
  }
  const cached = endpointSettings(env, name).models;
  return isPlainObject(cached) ? cached : {};
}

/**
 * Query EVERY configured endpoint for its available models (parallel,
 * each bounded by `timeout`): the startup cache renewal. Failures
 * leave the stale cache untouched — an unreachable endpoint keeps
 * its last-known (or static config) list. Batched: each auth file
 * lands at most one write (lib/env/persist.js).
 * @param {object} env
 * @param {Object} [options]
 * @param {number|string} [options.timeout] - per-endpoint cap (default 2s)
 * @returns {Promise<string[]>} the endpoints that answered
 */
export async function refreshModels(env, { timeout = 2000 } = {}) {
  return env.batch(async () => {
    const ms = tryDurationValue(timeout) ?? 2000;
    const answered = [];
    await Promise.all(Object.keys(env.endpoints).map(async (name) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      timer.unref?.();
      try {
        await endpointModels(env, name, { refresh: true, signal: controller.signal });
        answered.push(name);
      } catch {
        // endpointModels itself never throws (cached fallback); this is
        // belt-and-braces for a protocol whose models()/close() misbehaves.
      } finally {
        clearTimeout(timer);
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
 * no key is ever written to disk by detection).
 * @param {object} env
 * @param {Object} [options]
 * @param {number} [options.timeout] - per-protocol probe cap (ms)
 * @returns {Promise<string[]>} the added endpoint names
 */
export async function detectEndpoints(env, { timeout = 300 } = {}) {
  return env.batch(async () => {
    const discoveries = await Promise.all(env.providerNames().map(async (name) => {
      const Protocol = env.providers[name];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        return await Protocol.detectEndpoints({
          settings: env._settings,
          endpoints: env.endpoints,
          signal: controller.signal,
        });
      } catch {
        return {};
      } finally {
        clearTimeout(timer);
      }
    }));
    const added = [];
    for (const found of discoveries) {
      if (!isPlainObject(found)) continue;
      for (const [name, ep] of Object.entries(found)) {
        if (env.endpoints[name] !== undefined) continue;
        if (!isPlainObject(ep) || typeof ep.provider !== "string" || typeof ep.url !== "string") continue;
        if (!env.providers[ep.provider]) continue;
        const { auth, dynamic, ...config } = ep;
        env.endpoints[name] = { ...config };
        if (dynamic === true) env._dynamicEndpoints.add(name);
        if (isPlainObject(auth)) {
          if (dynamic === true) mergeAuthInMemory(env, name, { auth });
          else authSet(env, name, { auth });
        }
        added.push(name);
      }
    }
    return added;
  });
}
