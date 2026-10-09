/** App-only projections of the published Env model catalog for menus and completion. */

/** Newest project-local pair, falling back to global last-used pair. */
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

/** Published endpoint/model completion candidates. */
export function listModelCandidates(env) {
  const out = new Set();
  for (const { endpoint, model } of env?.models?.().values() ?? []) {
    out.add(endpoint);
    out.add(model);
    out.add(`${endpoint}/${model}`);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Configured and catalogued endpoints, including disabled entries, for logout. */
export function listEndpoints(env) {
  const configured = Object.keys(env.settings?.providers ?? {});
  const catalog = [...(env.models?.(true).values() ?? [])].map((info) => info.endpoint);
  return [...new Set([...configured, ...catalog])].sort((a, b) => a.localeCompare(b));
}

/** Group published models for menus; preserve login-required status. */
export function listEndpointModels(env) {
  const byEndpoint = new Map();
  for (const info of env.models?.().values() ?? []) {
    const entry = byEndpoint.get(info.endpoint) ?? { name: info.endpoint, models: [] };
    if (info.listed) entry.models.push(info.model);
    if (info.loginRequired) entry.loginRequired = true;
    byEndpoint.set(info.endpoint, entry);
  }
  return [...byEndpoint.values()]
    .map((entry) => ({ ...entry, models: entry.models.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
