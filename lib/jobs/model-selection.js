/** Resolve an unattended Job's explicit or last-used model through Env's public catalog. */

/**
 * Select a model for Jobs; unlike an interactive CLI there is no URL login or prompt.
 * @param {object} env Open environment; remains caller-owned and is not mutated.
 * @param {{model?: string}} args Explicit selector or no selection.
 * @param {{lastUsed?: boolean}} [options] Whether to fall back to the most recently used model.
 * @returns {Promise<string|undefined>} Qualified selector, or undefined if none is available.
 * @throws {Error} Invalid explicit selector or failed model discovery; retry with corrected configuration.
 */
export async function jobModelSelect(env, args, { lastUsed = false } = {}) {
  const requested = args.model;
  if (requested === undefined) {
    if (!lastUsed) return undefined;
    for (const key of ["projectLastUsed", "lastUsed"]) {
      let newest;
      for (const info of env.models().values()) {
        if (info[key] != null && (!newest || info[key] > newest[key])) newest = info;
      }
      if (newest) return `${newest.endpoint}/${newest.model}`;
    }
    return undefined;
  }
  if (typeof requested !== "string" || !requested.trim() || requested.startsWith("/")) {
    throw new Error("model combo must be a non-empty model or <endpoint>/<model>");
  }
  const catalog = [...env.models(true).values()];
  const known = (endpoint) => catalog.some((info) => info.endpoint === endpoint);
  const valid = (selector) => {
    try { env.connection(selector, { remember: false }); return true; } catch { return false; }
  };
  const endpointModel = async (endpoint) => {
    const pairs = [...env.models().values()].filter((info) => info.endpoint === endpoint)
      .sort((a, b) => a.model.localeCompare(b.model));
    if (pairs.every((info) => !info.listed)) await env.modelsReady;
    const model = [...env.models().values()].filter((info) => info.endpoint === endpoint && info.listed)
      .sort((a, b) => a.model.localeCompare(b.model))[0]?.model;
    return model === undefined ? undefined : `${endpoint}/${model}`;
  };
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const endpoint = requested.slice(0, slash);
    if (!requested.slice(slash + 1)) return (known(endpoint) || valid(`${endpoint}/-`)) ? endpointModel(endpoint) : undefined;
    if (valid(requested) || known(endpoint)) return requested;
  }
  const pair = catalog.find((info) => info.listed && info.model === requested);
  if (pair) return `${pair.endpoint}/${pair.model}`;
  return known(requested) || valid(`${requested}/-`) ? endpointModel(requested) : undefined;
}
