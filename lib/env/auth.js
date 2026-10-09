/**
 * lib/env/auth.js — endpoint auth/config updates (private to Env):
 * authSet, mergeAuthInMemory and removeEndpoint (the /logout contract).
 * Only login (lib/env/login.js) or the user creates `auth-*.json` files.
 * Updates land where the endpoint's data already lives; data with no
 * file stays in the settings tree's in-memory runtime node.
 */

import { isPlainObject } from "./settings.js";

import { modelsChanged } from "./models-changed.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
function checkName(name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name) || UNSAFE_NAMES.has(name)) {
    throw new TypeError("Env auth: invalid endpoint name");
  }
}
const AUTH_KEYS = new Set(["type", "token", "access", "refresh", "expires"]);

function checkUpdate(value) {
  const visit = (item) => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (!isPlainObject(item)) return;
    for (const [key, entry] of Object.entries(item)) {
      if (UNSAFE_NAMES.has(key)) throw new TypeError("Env auth: unsafe update key");
      visit(entry);
    }
  };
  visit(value);
}

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
 * never keep them via a key-by-key settings overlay. In contrast to
 * source layering, authSet applies successive UPDATES to the same section:
 * a rotated
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

/** The auth file holding an endpoint's section (project scope first), else undefined. */
function authRecord(graph, endpoint) {
  return [graph.authFile(endpoint, { scope: "project" }), graph.authFile(endpoint)].find((node) => node?.has([endpoint]));
}

/** Write `updates` (endpoint keys) to `node` at providers.<endpoint>, or to memory without one. */
function endpointWrite(env, endpoint, updates, node) {
  const graph = env._sourceGraph;
  for (const [key, value] of Object.entries(updates)) {
    const path = ["providers", endpoint, key];
    // Credentials stay where they are kept; other known keys never enter user settings files.
    const target = node ?? (key === "auth" ? graph.store.owner(path) : undefined);
    if (target) target.assign(target.relative(path), value);
    else graph.runtime.assign(path, value);
  }
  modelsChanged(env);
  return updates;
}

/** Split an update and merge its credentials over the endpoint's current ones. */
function endpointUpdates(env, endpoint, data) {
  const { root, auth } = splitAuthUpdate(data);
  if (auth === undefined) return root;
  const current = env._sourceGraph.store.read(["providers", endpoint, "auth"]);
  return { ...root, auth: mergeAuthUpdate(isPlainObject(current) ? current : {}, auth) };
}

/**
 * Update an endpoint's known keys (`url`, `auth`, `models`, and other record
 * fields) in its auth file — the one a login created — or, without one, in
 * memory for this process. Credentials already kept under another file's
 * `providers.<endpoint>.auth` are updated there. Never creates a file; user
 * preferences (e.g. `models.<m>.maxActive` in settings.json) are not touched.
 * @param {object} env - environment owning the source graph
 * @param {string} endpoint - endpoint name
 * @param {object} data - fields to replace (a `models` map replaces wholesale), plus
 *   credentials — either `{auth: {...}}` or flat (`type`, `token`, `access`,
 *   `refresh`, `expires`), merged over the current ones; `undefined` removes a field
 * @returns {object} the written fields
 * @throws {TypeError} if endpoint or data is invalid
 */
export function authSet(env, endpoint, data) {
  checkName(endpoint);
  if (!isPlainObject(data)) throw new TypeError("Env.authSet: data must be an object");
  checkUpdate(data);
  return endpointWrite(env, endpoint, endpointUpdates(env, endpoint, data), authRecord(env._sourceGraph, endpoint));
}

/**
 * Update an endpoint's fields in memory only — the path of environment-detected
 * (dynamic) endpoints and unscoped logins: nothing is written to disk.
 * @param {object} env - environment owning the source graph
 * @param {string} endpoint - endpoint name
 * @param {object} data - fields as for authSet
 * @returns {object} the written fields
 */
export function mergeAuthInMemory(env, endpoint, data) {
  checkName(endpoint);
  if (!isPlainObject(data)) throw new TypeError("Env.mergeAuthInMemory: data must be an object");
  checkUpdate(data);
  const updates = endpointUpdates(env, endpoint, data);
  for (const [key, value] of Object.entries(updates)) env._sourceGraph.runtime.assign(["providers", endpoint, key], value);
  modelsChanged(env);
  return updates;
}

/**
 * Remove an endpoint — the /logout contract: its `providers.<name>` section
 * leaves every writable source (an auth file left empty is deleted on save)
 * and memory. A read-only package entry may remain visible.
 * @param {object} env - environment whose settings and endpoint state are updated
 * @param {string} name - registered endpoint name to remove
 * @returns {{name: string, dynamic: boolean}} removed endpoint identity and whether it was dynamic
 * @throws {Error} if the named endpoint is unknown
 */
export function removeEndpoint(env, name) {
  checkName(name);
  const graph = env._sourceGraph;
  const store = graph.store;
  if (!isPlainObject(store.read(["providers", name])) && !env._dynamicEndpoints.has(name)) {
    throw new Error(`Env.endpointRemove: unknown endpoint "${name}"`);
  }
  const dynamic = env._dynamicEndpoints.has(name);
  clearTimeout(env._modelRetries?.get(name)?.timer);
  env._modelRetries?.delete(name);
  env._modelsPending?.delete(name);
  env._configuredEndpoints?.delete(name);
  env._dynamicConnections?.delete(name);
  env._dynamicEndpoints.delete(name);
  env._endpointScopes.delete(name);
  graph.runtime.assign(["providers", name], undefined);
  // Each write removes the highest remaining owner; stop when none is left.
  if (!dynamic) while (store.owner(["providers", name])) store.write(["providers", name], undefined);
  modelsChanged(env);
  return { name, dynamic };
}
