// Resolve explicit or last-used endpoint/model selection.

import { resolveModelCombo, readLastCombo } from "./model.js";

/**
 * No implicit endpoint/model exists: with neither `--model` nor a valid
 * last-model.json, interactive callers start model-less.
 */
export async function selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {}) {
  if (args.model !== undefined) {
    const combo = await resolveModelCombo(args.model, env);
    if (!combo.endpoint && args.url) {
      const slash = args.model.indexOf("/");
      const protocol = slash > 0 ? args.model.slice(0, slash) : undefined;
      // `--url` is an explicit, invocation-only endpoint: an in-memory
      // login (no scope — never persisted) whose models arrive in the
      // background. An unknown protocol is no endpoint.
      const registered = protocol !== undefined
        && await env.login(protocol, { provider: protocol, url: args.url }).then(() => true, () => false);
      if (registered) {
        const model = args.model.slice(slash + 1);
        // A registered provider plus an invocation-only URL makes the
        // prefix an endpoint even though it was not configured beforehand.
        // Keep the model identifier exactly as entered after that prefix.
        if (model !== "") return { endpoint: protocol, model };
        return resolveModelCombo(args.model, env);
      }
    }
    return { endpoint: combo.endpoint, model: combo.model };
  }
  // readLastCombo() takes the newest last-used published pair (the
  // catalog's lastUsed); dynamic connections count while
  // detected; a removed connection is skipped in favor of older entries.
  if (lastUsed) {
    const last = readLastCombo(env);
    if (last?.endpoint && last?.model) {
      log(`model: ${last.endpoint}/${last.model} (last used)`);
      return { endpoint: last.endpoint, model: last.model };
    }
  }
  return { endpoint: undefined, model: undefined };
}
