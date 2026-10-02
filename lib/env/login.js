/**
 * lib/env/login.js — endpoint login/logout (private to Env; the only
 * per-endpoint API it publishes).
 *
 * login(name, {provider, url, token?, auth?}, {scope?, verify?}) is ONE
 * transaction over a provisional registration:
 *   - credentials: `auth` as given, else the provider's static
 *     login({token}) shapes them (an in-memory registration without
 *     token or auth carries none);
 *   - scope "package"/"local": the endpoint record (provider, url, a
 *     known preset's extras, credentials) persists to its auth file, the
 *     connection is verified (the provider's strict testConnection), the
 *     model list is fetched, and `verify(models)` — the endpoint's new
 *     catalog entries — may still reject. Any failure rolls memory and
 *     files back: nothing remains;
 *   - no scope: an in-memory (dynamic) registration — an invocation-only
 *     endpoint — whose model list is fetched once a host awaits
 *     env.modelsReady (a one-shot run that never asks pays nothing).
 * Success announces Env.EVENT.MODELS_CHANGED (through authSet / the fetch).
 */

import { join } from "node:path";
import { NAMES } from "../namespace.js";
import { isPlainObject } from "./settings.js";
import { authSet, mergeAuthInMemory, removeEndpoint } from "./auth.js";
import { endpoint, endpointSettings, endpointModels, knownEndpoints } from "./endpoints.js";
import { modelsChanged } from "./models-changed.js";

const SCOPES = new Set(["package", "local"]);

/**
 * Find a known endpoint preset to carry its behavioral extras into a login.
 * @param {object} env - Environment whose known endpoint presets are searched.
 * @param {string} name - Requested endpoint name.
 * @param {string} provider - Provider protocol identifier.
 * @param {string} url - Endpoint URL used as the fallback match.
 * @returns {object|undefined} Matching preset, preferring name and provider, or matching provider and URL; undefined if none matches.
 */
function presetOf(env, name, provider, url) {
  const presets = knownEndpoints(env);
  return presets.find((entry) => entry.name === name && entry.provider === provider)
    ?? presets.find((entry) => entry.provider === provider && entry.url === url);
}

/**
 * Capture the endpoint state needed to undo a provisional login.
 * @param {object} env - Environment whose endpoint state is read.
 * @param {string} name - Endpoint name to snapshot.
 * @returns {{record: object|undefined, section: object|undefined, dynamic: boolean, scope: string|undefined}} References and membership/scope state for restoring this endpoint.
 */
function snapshot(env, name) {
  return {
    record: env._endpoints[name],
    section: env._settings[name],
    dynamic: env._dynamicEndpoints.has(name),
    scope: env._endpointScopes.get(name),
  };
}

/**
 * Restore endpoint memory after login failure, discard queued auth-file writes, and notify model change observers.
 * @param {object} env - Environment to restore.
 * @param {string} name - Endpoint name being rolled back.
 * @param {{record: object|undefined, section: object|undefined, dynamic: boolean, scope: string|undefined}} saved - Snapshot previously returned by {@link snapshot}.
 * @param {string[]} files - Auth-file paths whose queued writes must be discarded.
 * @returns {void}
 */
function rollback(env, name, saved, files) {
  if (saved.record === undefined) delete env._endpoints[name];
  else env._endpoints[name] = saved.record;
  if (saved.section === undefined) {
    const { [name]: _dropped, ...rest } = env._settings;
    env._settings = rest;
  } else env._settings = { ...env._settings, [name]: saved.section };
  if (saved.dynamic) env._dynamicEndpoints.add(name);
  else env._dynamicEndpoints.delete(name);
  if (saved.scope === undefined) env._endpointScopes.delete(name);
  else env._endpointScopes.set(name, saved.scope);
  for (const file of files) env._writeQueue.discard(file);
  modelsChanged(env);
}

/**
 * Register an endpoint and, for persisted scopes, save credentials, test the connection, and optionally validate its models as one rollback-capable transaction.
 * @param {object} env - Environment that owns providers, endpoint state, and the auth write queue.
 * @param {string} name - Non-empty endpoint name; must not contain `/`.
 * @param {{provider: string, url: string, token?: string, auth?: object}} [config={}] - Provider protocol and URL, plus optional token or already-shaped credentials (`auth` takes precedence).
 * @param {{scope?: "package"|"local", verify?: (models: Map<string, object>) => *}} [options={}] - Optional persistence scope and asynchronous/synchronous validator receiving this endpoint's model entries.
 * @returns {Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>} Resolves with the registered endpoint, credentials, scope, and connection-test result; dynamic registrations defer model fetching. Rejects for invalid input, unknown provider, invalid scope, provider login/connection errors, or validator failure; persisted failures restore prior memory and discard queued auth writes.
 */
export async function login(env, name, { provider, url, token, auth } = {}, { scope, verify } = {}) {
  if (typeof name !== "string" || name === "" || name.includes("/") || !provider || !url) {
    throw new Error("login requires endpoint name, provider protocol, and URL");
  }
  const Protocol = env._providers[provider];
  if (!Protocol) throw new Error(`unknown provider protocol: ${provider}`);
  if (scope !== undefined && !SCOPES.has(scope)) throw new Error('login scope must be "package" or "local"');

  const saved = snapshot(env, name);
  const files = scope === "local"
    ? [join(env.cwd, `${NAMES.projectAuthPrefix}${name}.json`)]
    : [join(env._settingsDir ?? env._dir, `auth-${name}.json`)];
  const record = {
    provider,
    url,
  };
  // a KNOWN PRESET's behavioral extras ride with the record: `verify` (how
  // the endpoint checks credentials), `oauth`, and a static `models` list
  // (only where no registry supplies candidates — a persisted copy would
  // linger as stale data)
  const preset = presetOf(env, name, provider, url);
  Object.assign(record,
    preset?.verify !== undefined ? { verify: preset.verify } : {},
    preset?.oauth !== undefined ? { oauth: preset.oauth } : {},
    isPlainObject(preset?.models) && !preset?.registry ? { models: preset.models } : {});

  return env._writeQueue.batch(async () => {
    try {
      const credentials = auth ?? (scope !== undefined || token !== undefined
        ? await Protocol.login({ token }, { url, settings: endpointSettings(env, name) })
        : undefined);
      env._endpoints[name] = record;
      if (scope === undefined) {
        env._dynamicEndpoints.add(name);
        mergeAuthInMemory(env, name, isPlainObject(credentials) ? { auth: credentials } : {});
        (env._modelsPending ??= new Set()).add(name);
        return { name, endpoint: endpoint(env, name), auth: credentials, scope, verified: undefined };
      }
      env._dynamicEndpoints.delete(name);
      // the endpoint's record IS its auth file: self-contained (provider,
      // url, extras, credentials); settings.providers stays for manual config
      authSet(env, name, { ...record, ...(isPlainObject(credentials) ? { auth: credentials } : {}) }, { scope });
      const settings = endpointSettings(env, name);
      let verified;
      try {
        verified = await Protocol.testConnection({ url, auth: settings.auth, settings });
      } catch (error) {
        throw Object.assign(new Error(`connection test failed for ${name} at ${url}: ${error.message}`), { cause: error, status: error.status });
      }
      if (settings.loginRequired === true) authSet(env, name, { loginRequired: false });
      try { await endpointModels(env, name, { refresh: true }); } catch { /* the cached/static list stays */ }
      if (verify) {
        const pairs = new Map([...env.models(true)].filter(([, info]) => info.endpoint === name));
        await verify(pairs);
      }
      return { name, endpoint: endpoint(env, name), auth: credentials, scope, verified };
    } catch (error) {
      rollback(env, name, saved, files);
      throw error;
    }
  });
}

/**
 * Start deferred model fetches for in-memory logins and join each fetch to the environment's models-ready promise.
 * @param {object} env - Environment with pending dynamic endpoint names and the readiness promise.
 * @returns {void}
 * @effects Clears the pending-name set; fetch failures are swallowed, and completion signals model changes.
 */
export function collectPending(env) {
  for (const name of env._modelsPending ?? []) {
    const fetched = endpointModels(env, name, { refresh: true }).catch(() => {}).then(() => modelsChanged(env));
    env._modelsReady = Promise.all([env._modelsReady, fetched]).then(() => {});
  }
  env._modelsPending?.clear();
}

/**
 * Remove an endpoint — the /logout contract (lib/env/auth.js removeEndpoint):
 * configuration and auth files go, every in-memory trace with them; an
 * environment-detected endpoint clears in memory only.
 * @param {object} env - Environment from which the endpoint is removed.
 * @param {string} name - Endpoint name; surrounding whitespace is trimmed.
 * @returns {{name: string, dynamic: boolean}} Removal result returned by `removeEndpoint`.
 * @throws {Error} If name is not a string or is blank after trimming.
 */
export function logout(env, name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("logout requires an endpoint name");
  return removeEndpoint(env, name.trim());
}

/**
 * The login presets every non-secret provider publishes (its static
 * knownEndpoints: {name, label, url, provider, oauth?, note?, ...}).
 * @param {object} env - Environment whose provider presets are queried.
 * @returns {object[]} Known non-secret login presets returned by `knownEndpoints`.
 */
export function loginPresets(env) {
  return knownEndpoints(env);
}
