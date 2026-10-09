/**
 * lib/env/login.js — endpoint login/logout (private to Env; the only
 * per-endpoint API it publishes).
 *
 * login(name, {provider, url, token?, auth?, oauth?}, {scope?, verify?}) is ONE
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

import { isPlainObject } from "./settings.js";
import { authSet, mergeAuthInMemory, mergeAuthUpdate, removeEndpoint } from "./auth.js";
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
 * @returns {{detection: object|undefined, dynamic: boolean, scope: string|undefined}} Detection facts and membership/scope state.
 */
function snapshot(env, name) {
  return {
    detection: env._sourceGraph.detectionGet(name),
    dynamic: env._dynamicEndpoints.has(name),
    scope: env._endpointScopes.get(name),
  };
}

/**
 * Restore auth source and detection state after login failure and notify model observers.
 * @param {object} env - Environment to restore.
 * @param {string} name - Endpoint name being rolled back.
 * @param {object} saved - Snapshot previously returned by {@link snapshot}.
 * @param {{node: object, path: string[], record: object|undefined}|undefined} authFile - The node this login wrote, the endpoint's path in it, and its previous record.
 * @returns {Promise<void>} Restores the endpoint's previous record.
 */
async function rollback(env, name, saved, authFile) {
  if (authFile) authFile.node.assign(authFile.path, authFile.record);
  if (saved.detection === undefined) env._sourceGraph.detectionRemove(name);
  else env._sourceGraph.detectionSet(name, saved.detection);
  if (saved.dynamic) env._dynamicEndpoints.add(name);
  else env._dynamicEndpoints.delete(name);
  if (saved.scope === undefined) env._endpointScopes.delete(name);
  else env._endpointScopes.set(name, saved.scope);
  env._modelsPending?.delete(name);
  modelsChanged(env);
}

/**
 * Register an endpoint and, for persisted scopes, save credentials, test the connection, and optionally validate its models as one rollback-capable transaction.
 * @param {object} env - Environment owning providers and the source graph.
 * @param {string} name - Safe non-empty alphanumeric endpoint name (hyphens and underscores allowed).
 * @param {{provider: string, url: string, token?: string, auth?: object, oauth?: object}} [config={}] - Provider protocol and URL, plus optional token or already-shaped credentials (`auth` takes precedence), and a user-owned OAuth client descriptor.
 * @param {{scope?: "package"|"local", verify?: (models: Map<string, object>) => *}} [options={}] - Optional persistence scope and asynchronous/synchronous validator receiving this endpoint's model entries.
 * @returns {Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>} Registration result. Rejects for invalid input, unknown provider, invalid scope, provider errors or validator failure; persisted failures restore the auth source and detection facts.
 */
export async function login(env, name, { provider, url, token, auth, oauth } = {}, { scope, verify } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) || !provider || !url) {
    throw new Error("login requires endpoint name, provider protocol, and URL");
  }
  const Protocol = env._providers[provider];
  if (!Protocol) throw new Error(`unknown provider protocol: ${provider}`);
  if (scope !== undefined && !SCOPES.has(scope)) throw new Error('login scope must be "package" or "local"');

  const saved = snapshot(env, name);
  let authFile;
  const record = {
    provider,
    url,
  };
  // a KNOWN PRESET's behavioral extras ride with the record: `verify` (how
  // the endpoint checks credentials), `oauth`, and a static `models` list
  // (only where no registry supplies candidates — a persisted copy would
  // linger as stale data)
  const preset = presetOf(env, name, provider, url);
  const oauthConfig = oauth ?? (auth?.type === "oauth" ? preset?.oauth : undefined);
  if (provider === "gemini" && name === "gemini-oauth" && auth?.type !== "oauth") {
    throw new TypeError("login: Gemini OAuth preset requires OAuth credentials");
  }
  if (oauth !== undefined && provider !== "gemini") throw new TypeError("login: explicit OAuth configuration is supported for Gemini only");
  if (provider === "gemini" && (auth?.type === "oauth" || oauth !== undefined) &&
      (!oauthConfig?.clientId || !oauthConfig?.clientSecret || !oauthConfig?.projectId || auth?.type !== "oauth")) {
    throw new TypeError("login: Gemini OAuth requires its own Desktop client, project and OAuth credentials");
  }
  Object.assign(record,
    preset?.verify !== undefined ? { verify: preset.verify } : {},
    oauthConfig !== undefined ? { oauth: oauthConfig } : {},
    isPlainObject(preset?.models) && !preset?.registry ? { models: preset.models } : {});

  try {
      const credentials = auth ?? (scope !== undefined || token !== undefined
        ? await Protocol.login({ token }, { url, settings: endpointSettings(env, name) })
        : undefined);
      if (scope === undefined) {
        env._dynamicEndpoints.add(name);
        mergeAuthInMemory(env, name, { ...record, ...(isPlainObject(credentials) ? { auth: credentials } : {}) });
        (env._modelsPending ??= new Set()).add(name);
        return { name, endpoint: endpoint(env, name), auth: credentials, scope, verified: undefined };
      }
      // Login is the only writer that creates an auth file: the endpoint's
      // record IS that file (provider, url, extras, credentials);
      // settings.providers stays for manual config.
      // Without a settings folder, the record stays in memory for this process.
      const file = await env._sourceGraph.authFileCreate(name, { scope: scope === "local" ? "project" : "user" });
      const node = file ?? env._sourceGraph.runtime;
      const path = file ? [name] : ["providers", name];
      authFile = { node, path, record: node.own(path) };
      env._dynamicEndpoints.delete(name);
      env._sourceGraph.detectionRemove(name);
      node.assign(path, { ...mergeAuthUpdate(authFile.record ?? {}, record), ...(isPlainObject(credentials) ? { auth: credentials } : {}) });
      env._endpointScopes.set(name, scope);
      modelsChanged(env);
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
      await env._sourceGraph.flush();
      return { name, endpoint: endpoint(env, name), auth: credentials, scope, verified };
  } catch (error) {
    await rollback(env, name, saved, authFile);
    throw error;
  }
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
