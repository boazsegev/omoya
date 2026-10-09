/** Endpoint/model selection over the Env model catalog (env.models()). */

/**
 * Get all catalog entries for one endpoint, preserving catalog order.
 * @param {object} env Env whose published model catalog is inspected.
 * @param {string} endpoint Endpoint id to match.
 * @returns {object[]} Matching model catalog entries (possibly empty).
 */
function endpointPairs(env, endpoint) {
  return [...env.models().values()].filter((info) => info.endpoint === endpoint)
    .sort((a, b) => a.model.localeCompare(b.model));
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
