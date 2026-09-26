/**
 * lib/env/auth.js — endpoint auth/config persistence (private to
 * Env): authSet (endpoint-keyed `auth-<endpoint>.json` — tokens +
 * cached model list), saveEndpoint (settings.json providers entries),
 * removeEndpoint (the /logout contract), and the in-memory-only merge
 * for environment-detected (dynamic) endpoints. Every disk write goes
 * through the env's write queue — atomic, batch-coalesced (see
 * lib/env/persist.js).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { NAMES } from "../namespace.js";
import { join } from "node:path";
import { isPlainObject } from "./settings.js";
import { parseJsonc } from "./jsonc.js";

const CATALOG_KEYS = ["provider", "url", "verify"];
const AUTH_KEYS = new Set(["type", "token", "access", "refresh", "expires"]);
const MODEL_PREFERENCE_KEYS = ["secret"];

/**
 * Split an authSet() update into root config fields and credential
 * fields. A caller may pass credentials flat at the top level
 * (`{token, type}`, authSet's own ergonomic shorthand) or already
 * wrapped (`{auth: {...}}}`, e.g. an OAuth refresh payload) — both
 * land under `section.auth`, never at the section root.
 */
function splitAuthUpdate(data) {
  const root = { ...data };
  const flat = {};
  for (const key of AUTH_KEYS) {
    if (key in root) { flat[key] = root[key]; delete root[key]; }
  }
  if (isPlainObject(data.auth)) {
    delete root.auth;
    return { root, auth: mergeAuthUpdate(flat, data.auth) };
  }
  return { root, auth: Object.keys(flat).length ? flat : undefined };
}

function persistedEndpointSection(env, endpoint, existing, data) {
  const config = isPlainObject(env.endpoints[endpoint]) ? env.endpoints[endpoint] : {};
  const base = mergeAuthUpdate(config, existing);
  const next = mergeAuthUpdate(base, data);
  if (!isPlainObject(data.models)) return next;
  // A refreshed catalogue owns membership and descriptors. Preserve only
  // policy for models still published; never resurrect a stale model.
  for (const [name, model] of Object.entries(next.models)) {
    const preferences = config.models?.[name];
    if (!isPlainObject(preferences)) continue;
    const retained = Object.fromEntries(MODEL_PREFERENCE_KEYS
      .filter((key) => preferences[key] !== undefined)
      .map((key) => [key, preferences[key]]));
    next.models[name] = { ...(model ?? {}), ...retained };
  }
  return next;
}

function endpointLocality(endpoint) {
  if (endpoint.provider === "ollama" && endpoint.local === undefined && endpoint.remote !== true) {
    return { ...endpoint, local: true };
  }
  return endpoint;
}

/**
 * Merge an auth UPDATE into an existing provider section: nested plain
 * objects merge key-by-key; scalars AND ARRAYS replace outright — no
 * concatenation. One exception: the `models` model MAP (unique model
 * names as keys) REPLACES wholesale even though it's a plain object —
 * a refreshed list must drop models the endpoint no longer publishes,
 * never keep them via a key-by-key merge. Unlike deepMerge (which
 * concatenates arrays — right for combining several settings FILES),
 * authSet applies successive UPDATES to the same section: a rotated
 * token or a refreshed model list must overwrite the stale value,
 * never grow it call over call.
 */
export function mergeAuthUpdate(existing, data) {
  const out = { ...existing };
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (value === undefined) { delete out[key]; continue; }
    out[key] = key !== "models" && isPlainObject(existing[key]) && isPlainObject(value)
      ? mergeAuthUpdate(existing[key], value)
      : value;
  }
  return out;
}

/**
 * Persist endpoint-keyed auth/model data: creates/updates
 * `auth-<endpoint>.json` holding `{ [endpoint]: data }` (tokens +
 * cached model list) in the endpoint's scope — the USER SETTINGS
 * folder ("package", the default; the package folder itself is
 * treated as read-only at runtime) or the project folder's
 * namespaced project auth file ("local"). Merges into live settings
 * tree under the endpoint key.
 * @param {object} env
 * @param {string} endpoint - the endpoint name
 * @param {object} data - config fields to merge at the section root,
 *   plus credentials — either `{auth: {...}}}` or flat (`type`,
 *   `token`, `access`, `refresh`, `expires`) — merged into
 *   `section.auth` (splitAuthUpdate)
 * @param {{scope?: "local"|"package"}} [options] - storage scope override
 * @returns {object} the merged endpoint section
 */
export function authSet(env, endpoint, data, { scope } = {}) {
  if (!endpoint || typeof endpoint !== "string") {
    throw new TypeError("Env.authSet: endpoint name required");
  }
  if (!isPlainObject(data)) {
    throw new TypeError("Env.authSet: data must be an object");
  }
  // A DYNAMIC (environment-detected) endpoint persists NOTHING: its
  // credentials come from the process environment, so a removed env
  // var must leave no persisted key behind. Model-cache refreshes and
  // rotated tokens route here too (providers call authSet blindly);
  // they merge into the live tree in memory only — no auth file, no
  // queued write, no scope, no endpoint-object introduction. The
  // endpoint stops being dynamic the moment saveEndpoint() promotes
  // it to a configured one (an explicit login must persist).
  if (env._dynamicEndpoints?.has(endpoint)) {
    const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
    const update = splitAuthUpdate(data);
    let section = mergeAuthUpdate(existing, update.root);
    if (update.auth !== undefined) {
      section = { ...section, auth: mergeAuthUpdate(isPlainObject(section.auth) ? section.auth : {}, update.auth) };
    }
    env._settings = { ...env._settings, [endpoint]: section };
    return section;
  }
  const resolvedScope = scope ?? env._endpointScopes.get(endpoint) ?? "package";
  const file = resolvedScope === "local"
    ? join(env.cwd, `${NAMES.projectAuthPrefix}${endpoint}.json`)
    : join(env.settingsDir ?? env.dir, `auth-${endpoint}.json`);
  const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
  let persisted = env._writeQueue.peek(file);
  if (!isPlainObject(persisted) && existsSync(file)) {
    try { persisted = parseJsonc(readFileSync(file, "utf8")); } catch { persisted = {}; }
  }
  const onDisk = isPlainObject(persisted?.[endpoint]) ? persisted[endpoint] : {};
  // A user edit to the endpoint file wins over the stale in-memory view;
  // the immediate update is authoritative.
  const source = mergeAuthUpdate(existing, onDisk);
  const update = splitAuthUpdate(data);
  const withRoot = persistedEndpointSection(env, endpoint, source, update.root);
  const section = update.auth === undefined
    ? withRoot
    : { ...withRoot, auth: mergeAuthUpdate(isPlainObject(withRoot.auth) ? withRoot.auth : {}, update.auth) };
  if (JSON.stringify(section) !== JSON.stringify(existing) || !existsSync(file)) {
    // ZERO DATA LOSS: the file is rewritten WHOLESALE (the write queue
    // keeps only the latest content per file), so sections stored under
    // any OTHER name — an earlier record of a renamed endpoint, a
    // case-variant — survive from the pending write or the file on
    // disk; the settings tree only ever carries the endpoint's own
    // section, so without this an authSet would silently destroy them
    env._writeQueue.write(file, { ...(isPlainObject(persisted) ? persisted : {}), [endpoint]: section });
  }
  env._settings = { ...env._settings, [endpoint]: section };
  env._endpointScopes.set(endpoint, resolvedScope);
  // First credential write may introduce a self-contained auth-file
  // endpoint. Existing live configuration remains authoritative until
  // restart, preserving explicit static model entries.
  if (!env.endpoints[endpoint] && CATALOG_KEYS.some((key) => section[key] !== undefined)) {
    env.endpoints[endpoint] = { ...section };
  }
  return section;
}

/**
 * Merge auth data into the live settings tree IN MEMORY ONLY — the
 * persistence path of environment-detected (dynamic) endpoints:
 * their credentials come from the process environment, so nothing
 * is written (a removed env var must not leave a persisted key
 * behind; see detectEndpoints).
 * @param {object} env
 * @param {string} endpoint
 * @param {object} data
 * @returns {object} the merged endpoint section
 */
export function mergeAuthInMemory(env, endpoint, data) {
  const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
  env._settings = { ...env._settings, [endpoint]: mergeAuthUpdate(existing, data) };
  return env._settings[endpoint];
}

/** Add/update one configured endpoint and persist it to the scope's
 *  settings file (the user settings folder's settings.json, or the
 *  namespaced project settings file for "local"). */
export function saveEndpoint(env, name, endpoint, { scope = "package" } = {}) {
  if (!name || typeof name !== "string") throw new TypeError("Env.saveEndpoint: endpoint name required");
  if (!isPlainObject(endpoint) || typeof endpoint.provider !== "string" || typeof endpoint.url !== "string") {
    throw new TypeError("Env.saveEndpoint: endpoint requires provider and url strings");
  }
  const previous = isPlainObject(env.endpoints[name]) ? env.endpoints[name] : {};
  endpoint = endpointLocality({ ...endpoint });
  env.endpoints[name] = endpoint;
  env._configuredEndpoints?.add(name);
  // Endpoint configuration belongs in the scope's settings file, not
  // just its auth cache. Keep the live providers map and the merged
  // settings tree on the same object for callers that read either view.
  env._settings = { ...env._settings, providers: env.endpoints };
  const settingsFile = scope === "local"
    ? join(env.cwd, NAMES.projectSettings)
    : join(env.settingsDir ?? env.dir, "settings.json");
  let persisted = env._writeQueue.peek(settingsFile);
  if (!isPlainObject(persisted) && existsSync(settingsFile)) {
    try { persisted = parseJsonc(readFileSync(settingsFile, "utf8")); } catch { persisted = {}; }
  }
  const providers = isPlainObject(persisted?.providers) ? persisted.providers : {};
  const next = { ...(isPlainObject(persisted) ? persisted : {}), providers: { ...providers, [name]: { ...endpoint } } };
  if (JSON.stringify(next) !== JSON.stringify(persisted) || !existsSync(settingsFile)) {
    env._writeQueue.write(settingsFile, next);
  }
  env._dynamicEndpoints.delete(name); // a configured endpoint is no longer environment-only
  env._endpointScopes.set(name, scope);
  // Undefined instructs mergeAuthUpdate to remove a setting deleted by
  // the menu, rather than resurrecting it from the prior auth record.
  const removed = Object.fromEntries(Object.keys(previous)
    .filter((key) => endpoint[key] === undefined)
    .map((key) => [key, undefined]));
  authSet(env, name, { ...endpoint, ...removed }, { scope });
  return env.endpoints[name];
}

/**
 * Remove an endpoint — the /logout contract: its configuration drops
 * out of the scope's settings.json, its `auth-<endpoint>.json` file
 * is deleted (both scopes are cleaned — an endpoint may have moved),
 * and every in-memory trace (the endpoints map, the auth section of
 * the live settings tree, the scope/dynamic marks) is removed.
 * Environment-detected (dynamic) endpoints have nothing persisted —
 * removal clears the in-memory registration only (the environment
 * variable itself is the user's to unset; it would re-detect on the
 * next startup while set).
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {{name: string, dynamic: boolean}}
 */
export function removeEndpoint(env, name) {
  if (!env.endpoints[name]) throw new Error(`Env.removeEndpoint: unknown endpoint "${name}"`);
  const dynamic = env._dynamicEndpoints.has(name);
  delete env.endpoints[name]; // the same object as _settings.providers when configured
  env._configuredEndpoints?.delete(name);
  env._dynamicEndpoints.delete(name);
  env._endpointScopes.delete(name);
  if (isPlainObject(env._settings[name])) {
    const { [name]: _dropped, ...rest } = env._settings;
    env._settings = rest;
  }
  if (!dynamic) {
    // every settings/auth location the endpoint could live in: the
    // user settings folder and the namespaced project files
    const settingsFiles = [
      join(env.settingsDir ?? env.dir, "settings.json"),
      join(env.cwd, NAMES.projectSettings),
    ];
    const authFiles = [
      join(env.settingsDir ?? env.dir, `auth-${name}.json`),
      join(env.cwd, `${NAMES.projectAuthPrefix}${name}.json`),
    ];
    for (const file of new Set(settingsFiles)) {
      let parsed = env._writeQueue.peek(file);
      if (!isPlainObject(parsed) && existsSync(file)) {
        try {
          parsed = parseJsonc(readFileSync(file, "utf8"));
        } catch {
          parsed = null; // an unreadable settings file is left untouched
        }
      }
      if (isPlainObject(parsed?.providers) && parsed.providers[name] !== undefined) {
        const providers = { ...parsed.providers };
        delete providers[name];
        const next = { ...parsed, providers };
        if (Object.keys(providers).length === 0 && Object.keys(parsed).length === 1) {
          env._writeQueue.discard(file);
          rmSync(file, { force: true });
        } else {
          env._writeQueue.write(file, next);
        }
      }
    }
    for (const file of new Set(authFiles)) {
      env._writeQueue.discard(file);
      rmSync(file, { force: true });
    }
  }
  return { name, dynamic };
}
