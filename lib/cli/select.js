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
  // Last-model restore applies only to CONFIGURED endpoints: an
  // invocation-only --url endpoint has no configuration, hence no memory
  // (Env.lastModel() already treats such a record as absent).
  if (lastUsed) {
    const last = readLastCombo(env);
    if (last?.endpoint && last?.model && !env.isDynamic?.(last.endpoint)
      && env.endpoint(last.endpoint)?.secret !== true) {
      log(`model: ${last.endpoint}/${last.model} (last used)`);
      return { endpoint: last.endpoint, model: last.model };
    }
  }
  return { endpoint: undefined, model: undefined };
}
