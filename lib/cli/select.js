// Resolve explicit or last-used qualified model selection.

import { resolveModelCombo, readLastCombo } from "./model.js";

/**
 * Select a qualified model from CLI input or the last-used published model.
 * @param {object} env Environment providing model resolution and login.
 * @param {object} args CLI arguments: model selector and optional invocation-only URL.
 * @param {object} [options={}] Selection options.
 * @param {boolean} [options.lastUsed=false] Consider the newest available last-used model when no explicit model is supplied.
 * @param {Function} [options.log=()=>{}] Log the selected last-used qualified model.
 * @returns {Promise<string|undefined>} Qualified `<endpoint>/<model>`, or undefined if unresolved.
 * @throws {Error} Invalid input or catalog failures; explicit URL login failures leave the model unresolved.
 * @effects May register an invocation-only endpoint; never persists the URL here.
 */
export async function selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {}) {
  if (args.model !== undefined) {
    const model = await resolveModelCombo(args.model, env);
    if (model !== undefined || !args.url) return model;
    return modelAtUrl(env, args);
  }
  const model = lastUsed ? readLastCombo(env) : undefined;
  if (model) log(`model: ${model} (last used)`);
  return model ?? undefined;
}

/** Register an explicit URL's provider and retain the qualified input unchanged. */
async function modelAtUrl(env, { model, url }) {
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const protocol = model.slice(0, slash);
  try {
    await env.login(protocol, { provider: protocol, url });
  } catch {
    return undefined;
  }
  return model.slice(slash + 1) !== "" ? model : resolveModelCombo(model, env);
}
