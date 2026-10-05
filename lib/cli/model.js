/** Endpoint/model selection over the Env model catalog (env.models()). */

/**
 * Return the published endpoint/model pair used last: the pinned project's
 * newest pair first (`projectLastUsed`), else the global newest (`lastUsed`).
 * @param {object} env Env whose model catalog is inspected.
 * @returns {string|null} The newest qualified selector, or null when no model has been used.
 */
export function readLastCombo(env) {
  let newest = null;
  for (const field of ["projectLastUsed", "lastUsed"]) {
    for (const info of env.models().values()) {
      if (info[field] != null && (newest === null || info[field] > newest[field])) newest = info;
    }
    if (newest !== null) break;
  }
  return newest === null ? null : `${newest.endpoint}/${newest.model}`;
}

/**
 * Get all catalog entries for one endpoint, preserving catalog order.
 * @param {object} env Env whose published model catalog is inspected.
 * @param {string} endpoint Endpoint id to match.
 * @returns {object[]} Matching model catalog entries (possibly empty).
 */
function endpointPairs(env, endpoint) {
  return [...env.models().values()].filter((info) => info.endpoint === endpoint);
}

/**
 * Check whether an endpoint appears in the catalog, including secret pairs.
 * @param {object} env Env whose full model catalog is inspected.
 * @param {string} endpoint Endpoint id to find.
 * @returns {boolean} True if any catalog entry uses the endpoint.
 */
function knownEndpoint(env, endpoint) {
  for (const info of env.models(true).values()) if (info.endpoint === endpoint) return true;
  return false;
}

/**
 * Test a selector using Env's connection validation without remembering it.
 * @param {object} env Env used to validate the selector.
 * @param {string} selector Endpoint/model selector to validate.
 * @returns {boolean} True when Env accepts the selector; false when validation throws.
 */
function validPair(env, selector) {
  try {
    env.connection(selector, { remember: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model.
 * An endpoint alone selects its first published model once background
 * collection has answered (`env.modelsReady`).
 * @param {string} value Selector to resolve; must be a non-empty string.
 * @param {object} env Env providing model catalog, validation, and readiness.
 * @returns {Promise<string|undefined>} Qualified selector, or undefined when no endpoint/model resolves.
 * @throws {Error} If value is empty or has an empty endpoint before a slash.
 * @throws {Error} May reject if waiting for `env.modelsReady` rejects.
 */
export async function resolveModelCombo(value, env) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("model combo must not be empty (use <endpoint>/<model>, <model>, or <endpoint>)");
  }
  if (value.startsWith("/")) {
    throw new Error(`empty endpoint in model combo "${value}" (use <endpoint>/<model>)`);
  }

  const slash = value.indexOf("/");
  if (slash > 0) {
    const endpoint = value.slice(0, slash);
    const model = value.slice(slash + 1);
    // a registered endpoint with no catalog yet accepts any model id (`-`)
    if (model === "" && (knownEndpoint(env, endpoint) || validPair(env, `${endpoint}/-`))) return endpointOnly(endpoint, env);
    // a registered endpoint: the pair resolves (an unknown model is the
    // selection's own error, raised where the Agent adopts it)
    if (model !== "" && (validPair(env, value) || knownEndpoint(env, endpoint))) return value;
  }

  for (const info of env.models().values()) {
    if (info.listed && info.model === value) return `${info.endpoint}/${value}`;
  }

  if (knownEndpoint(env, value) || validPair(env, `${value}/-`)) return endpointOnly(value, env);
  return undefined;
}

/**
 * List published endpoint, model, and endpoint/model completion candidates.
 * @param {object} env Env providing the optionally available model catalog.
 * @returns {string[]} Unique candidate strings in first-seen order.
 */
export function listModelCandidates(env) {
  const out = new Set();
  for (const { endpoint, model } of env.models?.().values() ?? []) {
    out.add(endpoint);
    out.add(model);
    out.add(`${endpoint}/${model}`);
  }
  return [...out];
}

/**
 * List every endpoint known to the catalog, including secret entries, for logout choices.
 * @param {object} env Env providing the optionally available full model catalog.
 * @returns {string[]} Unique endpoint ids in first-seen order.
 */
export function listEndpoints(env) {
  return [...new Set([...(env.models?.(true).values() ?? [])].map((info) => info.endpoint))];
}

/**
 * Build menu entries for published endpoints and their published model ids.
 * `loginRequired` is set for endpoints whose credentials failed (see Agent).
 * @param {object} env Env providing the optionally available published model catalog.
 * @returns {{name: string, models: string[], loginRequired?: boolean}[]} Endpoint entries in catalog order.
 */
export function listEndpointModels(env) {
  const byEndpoint = new Map();
  for (const info of env.models?.().values() ?? []) {
    const entry = byEndpoint.get(info.endpoint) ?? { name: info.endpoint, models: [] };
    if (info.listed) entry.models.push(info.model);
    if (info.loginRequired) entry.loginRequired = true;
    byEndpoint.set(info.endpoint, entry);
  }
  return [...byEndpoint.values()];
}

/**
 * Return every published endpoint's model ids after background collection
 * completes; provider failure can leave a cached/static catalog.
 * @param {object} env Env with a `modelsReady` promise and model catalog.
 * @returns {Promise<{name: string, models: string[]}[]>} Endpoint names and their published model ids.
 * @throws {Error} Rejects if `env.modelsReady` rejects.
 */
export async function listModels(env) {
  await env.modelsReady;
  return listEndpointModels(env).map(({ name, models }) => ({ name, models }));
}

/**
 * Resolve an endpoint-only selection to its first published model, if available.
 * Waits for model collection only when no published entry currently exists.
 * @param {string} endpoint Endpoint id to resolve.
 * @param {object} env Env providing model catalog and readiness promise.
 * @returns {Promise<string|undefined>} Qualified first published model, or undefined when none is listed.
 * @throws {Error} Rejects if waiting for `env.modelsReady` rejects.
 */
async function endpointOnly(endpoint, env) {
  if (endpointPairs(env, endpoint).every((info) => !info.listed)) await env.modelsReady;
  const model = endpointPairs(env, endpoint).find((info) => info.listed)?.model;
  return model === undefined ? undefined : `${endpoint}/${model}`;
}
