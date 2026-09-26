/**
 * lib/env/endpoints.js — the endpoint registry surface (private to
 * Env): live endpoint configuration plus endpoint-keyed auth/model
 * cache views, known-endpoint presets, model lists (cached + live
 * refresh), and environment auto-detection (dynamic endpoints —
 * never persisted).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../namespace.js";
import { isPlainObject } from "./settings.js";
import { tryDuration as tryDurationValue } from "./duration.js";
import { parseJsonc } from "./jsonc.js";
import { authSet, mergeAuthInMemory, mergeAuthUpdate } from "./auth.js";
import { applyModelFilter } from "./model-filter.js";

/** The built-in protocol an endpoint falls back to when neither its
 *  providers entry nor its auth/detection record names a `provider`
 *  (a url-only entry talks the OpenAI protocol; url-less entries are
 *  preference placeholders that never reach protocol resolution). */
export const DEFAULT_PROVIDER = "openai";

/** Live endpoint configuration plus endpoint-keyed auth/model cache.
 *  THREE layers merge per name: the endpoint's auth section (the
 *  durable auth-<endpoint>.json record — credentials, the fetched
 *  model cache, and for logged-in endpoints the connection itself)
 *  is the BASE, the environment connection of a detected (dynamic)
 *  endpoint merges over it, and the providers entry — the user's
 *  preferences — always wins. An entry may be PARTIAL ({filter},
 *  {maxActive}): it then simply rides on whichever connection layer
 *  completes the name, and the endpoint is registered (endpointNames)
 *  only while some layer provides a connection (a `provider`, a
 *  `url`, or both; a url-only connection resolves the
 *  DEFAULT_PROVIDER protocol at use). The `models` MAPS (unique
 *  model names as keys, optional metadata as values) merge across
 *  layers the same way, and the endpoint's `filter` regex then marks
 *  every non-matching model id `secret: true`
 *  (lib/env/model-filter.js) — selectors, menus, and the last-model
 *  memory hide them through the existing secret path. Credentials
 *  live under the returned `.auth` object — providers read
 *  `settings.auth?.token` etc, never a flat `settings.token`. */
export function endpointSettings(env, endpoint) {
  const prefs = env._configuredEndpoints?.has(endpoint) === true ? env.endpoints[endpoint] : undefined;
  const connection = prefs === undefined ? env.endpoints[endpoint] : env._dynamicConnections?.get(endpoint);
  // Current auth data (credentials included) comes from the endpoint's
  // settings section ONLY: a copied auth payload in a connection record
  // is never connection policy (token rotation must win).
  const base = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
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
    : [join(env.settingsDir ?? env.dir, "settings.json"), join(env.settingsDir ?? env.dir, `auth-${name}.json`)];
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

/** One named endpoint's CONNECTION configuration: its providers entry
 *  while the name is configured (the user's policy view — possibly a
 *  partial preferences record), else the live registry record
 *  (auth-file auto-catalog or environment detection). */
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
  // The preferences entry classifies when present (the user's policy);
  // the live registry record covers entries detection introduced.
  const entry = env._configuredEndpoints?.has(name) === true
    ? env.endpoints[name]
    : (env._dynamicConnections?.get(name) ?? env.endpoints[name]);
  return env.endpointScope?.(name) === "local" || entry?.remote === false || entry?.local === true;
}

/** The PREFERENCES keys a providers entry may carry without itself
 *  forming a connection: an entry holding ONLY these is a placeholder
 *  that rides on whatever layer completes the name. Any other key —
 *  `url`, `cmd`, `pipe`, whatever a protocol needs — is connection
 *  data: IO access is not assumed to be the web. */
export const ENDPOINT_PREFERENCE_KEYS = new Set(["filter", "maxActive", "secret", "local", "remote", "models"]);

/** Does a record carry connection data (any non-preferences key)?
 *  On the settings layer the `auth` envelope is credentials — a
 *  cache, never a connection (a dropped environment key must not
 *  leave its token impersonating one). */
function hasConnectionData(record) {
  return isPlainObject(record) && Object.keys(record).some((key) => key !== "auth" && !ENDPOINT_PREFERENCE_KEYS.has(key));
}

/** REGISTERED endpoint names — the entries some layer completes with
 *  CONNECTION data (the providers entry, an adopted environment
 *  connection, or the auth section — a `provider` alone counts, a
 *  `url` alone resolves the built-in OpenAI protocol at use, and
 *  future protocols may connect over `cmd` or a pipe instead). A
 *  bare preferences entry registers nothing. Filtered by exposure:
 *  local ones, remote ones, or all. */
export function endpointRegistered(env, name) {
  return hasConnectionData(env.endpoints[name])
    || hasConnectionData(env._dynamicConnections?.get(name))
    || hasConnectionData(env._settings[name]);
}

export function endpointNames(env, { includeSecret = false, access = "all" } = {}) {
  if (!["local", "remote", "all"].includes(access)) throw new TypeError('endpoint access must be "local", "remote", or "all"');
  return Object.keys(env.endpoints).filter((name) => {
    if (!endpointRegistered(env, name)) return false;
    if (!includeSecret && env.endpoints[name]?.secret === true) return false;
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
 * The endpoint's `filter` regex applies the same way as in
 * endpointSettings(): non-matching ids are `secret: true` here too,
 * so callers hiding secret models see the filtered list either way.
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
    const Protocol = env.provider(config.provider ?? DEFAULT_PROVIDER);
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
        if (isPlainObject(models)) return applyModelFilter(endpointSettings(env, name), models);
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
 * @param {Object} [options]
 * @param {number} [options.timeout] - per-protocol probe cap (ms)
 * @returns {Promise<string[]>} the added endpoint names
 */
export async function detectEndpoints(env, { timeout = 300 } = {}) {
  return env.batch(async () => {
    // protocols skip endpoint names they already know — the shadow map
    // hides dynamic ones so every probe re-detects them (rotation,
    // removal); persisted records stay visible (they own their slot),
    // and detection re-derives matching residue itself below
    const shadow = Object.fromEntries(Object.entries(env.endpoints)
      .filter(([name]) => !env._dynamicEndpoints.has(name) && env._configuredEndpoints?.has(name) !== true));
    const discoveries = await Promise.all(env.providerNames().map(async (name) => {
      const Protocol = env.providers[name];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref?.();
      try {
        return await Protocol.detectEndpoints({
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
        if (!env.providers[ep.provider]) continue;
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
    const candidates = [];
    for (const [name, ep] of pending) if (ep.dynamic === true) candidates.push([name, ep]);
    // An auth-file-registered endpoint was visible to the probe, so the
    // protocol skipped it and it never reached `pending` — offer it a
    // placeholder slot: the residue probe below re-derives the real
    // detection and either claims the record or keeps it
    for (const [name, existing] of Object.entries(env.endpoints)) {
      if (candidates.some(([n]) => n === name)) continue;
      if (env._dynamicEndpoints.has(name) || env._configuredEndpoints?.has(name)) continue;
      candidates.push([name, { provider: existing.provider, url: existing.url, dynamic: true }]);
    }
    for (const [name, ep] of candidates) {
      const configured = env._configuredEndpoints?.has(name) === true;
      const existing = configured ? undefined : env.endpoints[name];
      if (!configured && !env._dynamicEndpoints.has(name) && existing !== undefined) {
        // the slot was occupied at probe time: re-derive what the
        // environment detects with the slot hidden — residue claims
        // itself only when every connection field AND the auth match
        const Protocol = env.providers[existing.provider];
        if (!Protocol) continue;
        const hidden = { ...env.endpoints };
        delete hidden[name];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        timer.unref?.();
        let reprobed;
        try {
          reprobed = await Protocol.detectEndpoints({
            settings: env._settings,
            endpoints: hidden,
            signal: controller.signal,
          });
        } catch {
          reprobed = undefined;
        } finally {
          clearTimeout(timer);
        }
        const detected = isPlainObject(reprobed?.[name]) ? reprobed[name] : undefined;
        const section = isPlainObject(env._settings[name]) ? env._settings[name] : {};
        const residue = detected !== undefined
          && existing.provider === detected.provider && existing.url === detected.url
          && (!isPlainObject(detected.auth) || JSON.stringify(section.auth) === JSON.stringify(detected.auth));
        if (!residue) continue; // an explicit login to the same service, not detection residue
      }
      current.set(name, ep);
      env._dynamicEndpoints.add(name);
    }
    const added = [];
    for (const [name, ep] of current) {
      for (const file of new Set([
        join(env.settingsDir ?? env.dir, `auth-${name}.json`),
        join(env.cwd, `${NAMES.projectAuthPrefix}${name}.json`),
      ])) {
        env._writeQueue.discard(file);
        rmSync(file, { force: true });
      }
      const { auth: _a, dynamic: _d, ...config } = ep;
      if (env._configuredEndpoints?.has(name) === true) {
        // A configured entry ADOPTS the environment connection instead
        // of shadowing it: endpointSettings() merges this record under
        // the user's preferences (a full entry's own connection fields
        // keep winning; a preferences-only entry becomes a live
        // endpoint).
        env._dynamicConnections.set(name, { ...config });
      } else {
        const existing = env.endpoints[name];
        if (existing === undefined) {
          env.endpoints[name] = { ...config };
          added.push(name);
        } else if (ep.url !== existing.url) {
          env.endpoints[name] = { ...existing, url: ep.url }; // the environment moved the endpoint
        }
      }
      if (isPlainObject(ep.auth)) {
        mergeAuthInMemory(env, name, { auth: ep.auth }); // a rotated key overwrites, never deep-merges onto, the stale token
      }
    }
    for (const name of [...env._dynamicEndpoints]) {
      if (current.has(name)) continue;
      env._dynamicConnections.delete(name);
      env._dynamicEndpoints.delete(name);
      if (env._configuredEndpoints?.has(name) === true) continue; // the preferences entry stays
      delete env.endpoints[name];
      if (isPlainObject(env._settings[name])) {
        const { [name]: _dropped, ...rest } = env._settings;
        env._settings = rest;
      }
    }
    for (const [name, ep] of pending) {
      if (current.has(name) || env.endpoints[name] !== undefined) continue;
      const { auth, dynamic, ...config } = ep;
      env.endpoints[name] = { ...config };
      if (isPlainObject(auth)) authSet(env, name, { auth });
      added.push(name);
    }
    return added;
  });
}
