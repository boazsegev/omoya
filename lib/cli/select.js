// Resolve explicit or last-used endpoint/model selection.

import { resolveModelCombo, readLastCombo } from "./model.js";

/**
 * No implicit endpoint/model exists: with neither `--model` nor a valid
 * last-model.json, interactive callers start model-less.
 */
export async function selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {}) {
  if (args.model !== undefined) {
    const combo = await resolveModelCombo(args.model, env, { url: args.url });
    if (!combo.endpoint && args.url) {
      const slash = args.model.indexOf("/");
      const protocol = slash > 0 ? args.model.slice(0, slash) : undefined;
      if (protocol && env.provider(protocol)) {
        // `--url` is an explicit, invocation-only endpoint. It retains
        // endpoint-based IO without secretly persisting a configuration.
        env.endpoints[protocol] ??= { provider: protocol, url: args.url };
        const model = args.model.slice(slash + 1);
        // A registered provider plus an invocation-only URL makes the
        // prefix an endpoint even though it was not configured beforehand.
        // Keep the model identifier exactly as entered after that prefix.
        if (model !== "") return { endpoint: protocol, model };
        return resolveModelCombo(args.model, env, { url: args.url });
      }
    }
    return { endpoint: combo.endpoint, model: combo.model };
  }
  if (lastUsed) {
    const last = readLastCombo(env);
    const slash = last?.endpoint ? -1 : last?.model?.indexOf("/") ?? -1;
    const endpoint = last?.endpoint ?? (slash > 0 ? last.model.slice(0, slash) : undefined);
    const model = last?.endpoint ? last.model : (slash > 0 ? last.model.slice(slash + 1) : undefined);
    if (endpoint && model && (env.endpoint(endpoint) || (args.url && env.provider(endpoint)))) {
      env.endpoints[endpoint] ??= { provider: endpoint, url: args.url };
      log(`model: ${endpoint}/${model} (last used)`);
      return { endpoint, model };
    }
  }
  return { endpoint: undefined, model: undefined };
}
