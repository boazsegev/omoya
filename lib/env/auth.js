/**
 * lib/env/auth.js — endpoint auth/config persistence (private to
 * Env): authSet (endpoint-keyed `auth-<endpoint>.json` — tokens +
 * cached model list), removeEndpoint (the /logout contract), and the in-memory-only merge
 * for environment-detected (dynamic) endpoints. Every disk write goes
 * through the env's write queue — atomic, batch-coalesced (see
 * lib/env/persist.js).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { NAMES } from "../namespace.js";
import { join } from "node:path";
import { isPlainObject } from "./settings.js";
import { parseJsonc } from "./jsonc.js";
import { modelsChanged } from "./models-changed.js";

const CATALOG_KEYS = ["provider", "url", "verify"];
const AUTH_KEYS = new Set(["type", "token", "access", "refresh", "expires"]);

/**
 * Split an authSet() update into root config fields and credential
 * fields. A caller may pass credentials flat at the top level
 * (`{token, type}`, authSet's own ergonomic shorthand) or already
 * wrapped (`{auth: {...}}`, e.g. an OAuth refresh payload) — both
 * land under `section.auth`, never at the section root.
 * @param {object} data - update object; credential keys are separated from root fields
 * @returns {{root: object, auth: object|undefined}} root fields and normalized credentials;
 *   `auth` is undefined when no credentials were supplied
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
 * @param {object} existing - current section data used as the merge base
 * @param {object} data - update fields; a field set to `undefined` is removed
 * @returns {object} a new section object with the update applied
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
 * @param {object} env - environment state; its write queue and settings/endpoints are updated
 * @param {string} endpoint - endpoint name; must be a non-empty string
 * @param {object} data - config fields to merge at the section root,
 *   plus credentials — either `{auth: {...}}` or flat (`type`,
 *   `token`, `access`, `refresh`, `expires`) — merged into
 *   `section.auth` (splitAuthUpdate)
 * @param {{scope?: "local"|"package"}} [options={}] - optional storage scope override;
 *   defaults to the endpoint's registered scope, then `"package"`
 * @returns {object} the endpoint section this auth file owns after the update —
 *   only fields stored here (provider/url from settings.json are not echoed; use
 *   endpointSettings() for the effective view). Dynamic endpoints return their
 *   in-memory section and are never persisted. This function is synchronous.
 * @throws {TypeError} if endpoint is missing/not a string or data is not a plain object
 * @throws {Error} if synchronous filesystem or write-queue operations fail
 * @effects Updates the in-memory settings tree and model state; static endpoint
 *   updates are queued for persistence, while dynamic endpoint updates stay in memory.
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
  // queued write, no scope, no endpoint-object introduction.
  if (env._dynamicEndpoints?.has(endpoint)) {
    const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
    const update = splitAuthUpdate(data);
    let section = mergeAuthUpdate(existing, update.root);
    if (update.auth !== undefined) {
      section = { ...section, auth: mergeAuthUpdate(isPlainObject(section.auth) ? section.auth : {}, update.auth) };
    }
    env._settings = { ...env._settings, [endpoint]: section };
    modelsChanged(env);
    return section;
  }
  const resolvedScope = scope ?? env._endpointScopes.get(endpoint) ?? "package";
  const file = resolvedScope === "local"
    ? join(env.cwd, `${NAMES.projectAuthPrefix}${endpoint}.json`)
    : join(env._settingsDir ?? env._dir, `auth-${endpoint}.json`);
  const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
  let persisted = env._writeQueue.peek(file);
  if (!isPlainObject(persisted) && existsSync(file)) {
    try { persisted = parseJsonc(readFileSync(file, "utf8")); } catch { persisted = {}; }
  }
  const onDisk = isPlainObject(persisted?.[endpoint]) ? persisted[endpoint] : {};
  // Persist only values already owned by this auth file plus this update.
  // `existing` is the fully merged runtime view and may contain policy from
  // settings.json/providers; copying it here would make the generated auth
  // file override the user's chosen source on the next load.
  const update = splitAuthUpdate(data);
  const withRoot = mergeAuthUpdate(onDisk, update.root);
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
  if (!env._endpoints[endpoint] && CATALOG_KEYS.some((key) => section[key] !== undefined)) {
    env._endpoints[endpoint] = { ...section };
  }
  modelsChanged(env);
  return section;
}

/**
 * Merge auth data into the live settings tree IN MEMORY ONLY — the
 * persistence path of environment-detected (dynamic) endpoints:
 * their credentials come from the process environment, so nothing
 * is written (a removed env var must not leave a persisted key
 * behind; see detectEndpoints).
 * @param {object} env - environment state whose live settings are updated
 * @param {string} endpoint - endpoint key in the live settings tree
 * @param {object} data - fields to merge into the endpoint section
 * @returns {object} the merged endpoint section; this function is synchronous
 * @effects Updates `env._settings` and notifies model state; it never queues or
 *   performs a disk write.
 */
export function mergeAuthInMemory(env, endpoint, data) {
  const existing = isPlainObject(env._settings[endpoint]) ? env._settings[endpoint] : {};
  env._settings = { ...env._settings, [endpoint]: mergeAuthUpdate(existing, data) };
  modelsChanged(env);
  return env._settings[endpoint];
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
 * @param {object} env - environment state whose endpoint, settings, and scope records are updated
 * @param {string} name - registered endpoint name to remove
 * @returns {{name: string, dynamic: boolean}} removed endpoint identity and whether it was dynamic;
 *   this function is synchronous
 * @throws {Error} if the named endpoint is not registered
 * @throws {Error} if synchronous filesystem operations fail while removing static endpoint data
 * @effects Clears pending model retries and in-memory endpoint state. For static endpoints,
 *   removes matching provider settings and auth files from user/project locations through
 *   the write queue/filesystem; dynamic endpoint removal only clears in-memory state.
 */
export function removeEndpoint(env, name) {
  if (!env._endpoints[name]) throw new Error(`Env.endpointRemove: unknown endpoint "${name}"`);
  const dynamic = env._dynamicEndpoints.has(name);
  clearTimeout(env._modelRetries?.get(name)?.timer);
  env._modelRetries?.delete(name);
  delete env._endpoints[name]; // the same object as _settings.providers when configured
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
      join(env._settingsDir ?? env._dir, "settings.json"),
      join(env.cwd, NAMES.projectSettings),
    ];
    const authFiles = [
      join(env._settingsDir ?? env._dir, `auth-${name}.json`),
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
  modelsChanged(env);
  return { name, dynamic };
}
