/** Endpoint/model selection over the Env model catalog (env.models()). */

/** @returns {{endpoint: string, model: string}|null} the newest last-used published pair, or null */
export function readLastCombo(env) {
  let newest = null;
  for (const info of env.models().values()) {
    if (info.lastUsed !== null && (newest === null || info.lastUsed > newest.lastUsed)) newest = info;
  }
  return newest === null ? null : { endpoint: newest.endpoint, model: newest.model };
}

/** The published pairs of one endpoint (catalog order). */
function endpointPairs(env, endpoint) {
  return [...env.models().values()].filter((info) => info.endpoint === endpoint);
}

/** Does the endpoint appear in the catalog at all (secret pairs included)? */
function knownEndpoint(env, endpoint) {
  for (const info of env.models(true).values()) if (info.endpoint === endpoint) return true;
  return false;
}

/** Is `selector` a valid pair for this Env (the catalog's own validation)? */
function validPair(env, selector) {
  try {
    env.connection(selector, { remember: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare
 * model. An endpoint alone selects its first published model once the
 * background collection has answered (env.modelsReady).
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
    if (model !== "" && (validPair(env, value) || knownEndpoint(env, endpoint))) return { endpoint, model };
  }

  for (const info of env.models().values()) {
    if (info.listed && info.model === value) return { endpoint: info.endpoint, model: value };
  }

  if (knownEndpoint(env, value) || validPair(env, `${value}/-`)) return endpointOnly(value, env);
  return { model: value };
}

/** Published endpoint/model completion candidates. */
export function listModelCandidates(env) {
  const out = new Set();
  for (const { endpoint, model } of env.models?.().values() ?? []) {
    out.add(endpoint);
    out.add(model);
    out.add(`${endpoint}/${model}`);
  }
  return [...out];
}

/** Every endpoint the catalog knows (secret ones included) — logout choices. */
export function listEndpoints(env) {
  return [...new Set([...(env.models?.(true).values() ?? [])].map((info) => info.endpoint))];
}

/** Published endpoints with their published model ids for the menu;
 *  loginRequired flags endpoints whose credentials failed (see Agent). */
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

/** Every published endpoint's model ids once the background collection
 *  has answered (a provider failure shows its cached/static catalogue). */
export async function listModels(env) {
  await env.modelsReady;
  return listEndpointModels(env).map(({ name, models }) => ({ name, models }));
}

async function endpointOnly(endpoint, env) {
  if (endpointPairs(env, endpoint).every((info) => !info.listed)) await env.modelsReady;
  return { endpoint, model: endpointPairs(env, endpoint).find((info) => info.listed)?.model };
}
