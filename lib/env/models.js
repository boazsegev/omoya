/**
 * lib/env/models.js — the published MODEL CATALOG (private to Env):
 * env.models(secret) — a Map keyed `endpoint/model` whose ModelInfo
 * values hold everything already computed from current state — and
 * env.connection(selector), IO's handle on one pair.
 *
 * ModelInfo = {
 *   endpoint, model, label, listed, secret, local, loginRequired, lastUsed,
 *   caps: { contextWindow, thinking, tools, streaming, input? },
 *   ...plugin fields (Agent: maxActive, active, available)
 * }
 *   - listed: the endpoint's catalog publishes the model; an endpoint
 *     with no catalog yet (collection pending) still answers its
 *     last-used pairs, unlisted;
 *   - secret: the endpoint's `filter` / `secret: true`, the model's own
 *     `secret`, or the `modelAccess` policy hides it (models() omits it;
 *     models(true) includes it, flagged);
 *   - caps.thinking: the model entry's native modes, else the provider's;
 *   - caps.tools: the provider's built-in tools minus settings opt-outs,
 *     first explicit boolean wins: <ep>.models.<m>.tools.<name>, then
 *     <ep>.tools.<name>, then providerTools.<name>.
 * Plugins add fields through Env.extend({modelInfo(env, info)}).
 *
 * The catalog is collected in the BACKGROUND (collect(): context-window
 * registry, live model lists, bounded retries); every change emits
 * Env.EVENT.MODELS_CHANGED (coalesced per tick) and consumers re-read.
 */

import { isPlainObject } from "./settings.js";
import {
  endpointSettings, endpoint as endpointConfig, endpointNames, endpointLocal, endpointRegistered,
  refreshModels, refreshEndpointSettings, DEFAULT_PROVIDER,
} from "./endpoints.js";
import { statSync } from "node:fs";
import { readHistory, touchHistory, lastModelFile } from "./model-history.js";
import { contextWindowsLoad, registryContextWindow } from "./model-windows.js";
import { authSet, mergeAuthUpdate } from "./auth.js";
import { modelInfoHooks } from "./extend.js";
import { modelsChanged } from "./models-changed.js";

export { MODELS_CHANGED, modelsChanged } from "./models-changed.js";

/**
 * Start the background collection once: the models.dev context
 * windows and every endpoint's live model list (bounded; empty answers
 * retry later). Each arrival announces itself; the returned promise
 * settles when the first pass has answered.
 * @param {object} env
 * @returns {Promise<void>}
 */
export function collect(env) {
  env._modelsReady ??= Promise.all([
    contextWindowsLoad().then(() => modelsChanged(env)),
    refreshModels(env).catch(() => {}),
  ]).then(() => { modelsChanged(env); });
  return env._modelsReady;
}

/**
 * The model's context window in tokens, WHEN KNOWN — synchronous, never
 * fetches: an explicit endpoint `contextWindow` wins. For api.openai.com
 * the loaded models.dev registry outranks stale cached descriptors
 * (its /models omits windows); otherwise cached metadata wins (a larger
 * maxContextWindow first), then the registry. Unknown: null.
 */
function contextWindowOf(section, model) {
  if (Number.isFinite(section.contextWindow) && section.contextWindow > 0) return section.contextWindow;
  const registry = typeof model === "string" && model !== "" ? registryContextWindow(model) : null;
  if (section.provider === "openai" && /^https:\/\/api\.openai\.com\/v1\/?$/.test(section.url ?? "") && registry !== null) return registry;
  const found = isPlainObject(section.models) ? section.models[model] : undefined;
  if (Number.isFinite(found?.maxContextWindow) && found.maxContextWindow > 0 &&
      (!Number.isFinite(found.contextWindow) || found.maxContextWindow > found.contextWindow)) {
    return found.maxContextWindow;
  }
  if (Number.isFinite(found?.contextWindow) && found.contextWindow > 0) return found.contextWindow;
  return registry;
}

/** The first explicit boolean of a list, else undefined. */
const flag = (...values) => values.find((value) => value === true || value === false);

/** The provider tools a pair publishes, after the settings opt-outs. */
function toolsOf(env, capabilities, section, model) {
  const tools = isPlainObject(capabilities?.tools) ? Object.keys(capabilities.tools) : [];
  return tools.filter((name) => flag(
    section.models?.[model]?.tools?.[name], section.tools?.[name], env._settings.providerTools?.[name],
  ) !== false);
}

/** The registered provider class of one endpoint (undefined: unknown protocol). */
function protocolOf(env, name) {
  const config = endpointConfig(env, name);
  return env._providers[config?.provider ?? DEFAULT_PROVIDER];
}

/**
 * The catalog: every known endpoint/model pair.
 * @param {object} env
 * @param {boolean} [secret=false] - include hidden pairs (flagged secret)
 * @returns {Map<string, object>} `endpoint/model` -> ModelInfo
 */
export function models(env, secret = false) {
  // the last-used memory is shared with other processes: its file's
  // mtime is part of the cache key
  let stamp = 0;
  try { stamp = statSync(lastModelFile(env)).mtimeMs; } catch { /* no memory yet */ }
  if (env._modelsCache && env._modelsCacheStamp !== stamp) env._modelsCache = null;
  env._modelsCacheStamp = stamp;
  env._modelsCache ??= catalog(env);
  const out = new Map();
  for (const [key, base] of env._modelsCache) {
    if (base.info.secret && !secret) continue;
    // the registry windows load at module level: read them per call
    const info = { ...base.info, caps: { ...base.info.caps, contextWindow: contextWindowOf(base.section, base.info.model) } };
    for (const hook of modelInfoHooks()) Object.assign(info, hook(env, info, base.section));
    out.set(key, Object.freeze(info));
  }
  return out;
}

/** Every pair's state-derived fields (cached until the next change). */
function catalog(env) {
  const access = env._settings.modelAccess ?? "all";
  const visible = new Set(endpointNames(env, { access }));
  const lastUsed = new Map(readHistory(env).map(({ endpoint, model, ts }) => [`${endpoint}/${model}`, ts]));
  const out = new Map();
  for (const name of endpointNames(env, { includeSecret: true })) {
    const section = endpointSettings(env, name);
    const listed = isPlainObject(section.models) && Object.keys(section.models).length > 0;
    const catalog = listed ? section.models
      : Object.fromEntries([...lastUsed.keys()].filter((key) => key.startsWith(`${name}/`)).map((key) => [key.slice(name.length + 1), {}]));
    const capabilities = protocolOf(env, name)?.provider?.capabilities ?? {};
    const hidden = !visible.has(name) || env._endpoints[name]?.secret === true;
    for (const [model, meta] of Object.entries(catalog)) {
      if (model === "") continue;
      const info = {
        endpoint: name,
        model,
        label: typeof meta?.label === "string" ? meta.label : model,
        listed,
        secret: hidden || meta?.secret === true,
        local: endpointLocal(env, name),
        loginRequired: section.loginRequired === true,
        lastUsed: lastUsed.get(`${name}/${model}`) ?? null,
        caps: {
          contextWindow: null, // per read (models())
          thinking: Array.isArray(meta?.thinking) ? meta.thinking : capabilities.thinking ?? [],
          tools: toolsOf(env, capabilities, section, model),
          streaming: capabilities.streaming === true,
          ...(Array.isArray(meta?.input) ? { input: meta.input } : {}),
        },
      };
      out.set(`${name}/${model}`, { info, section });
    }
  }
  return out;
}

/**
 * Validate and split a `<endpoint>/<model>` selector: an unknown
 * endpoint throws; so does a model its non-empty catalog lacks (a
 * secret model is unlisted, never unusable).
 * @returns {{endpoint: string, model: string}}
 */
export function selectorParse(env, value, owner = "Env") {
  if (typeof value !== "string") throw new TypeError(`${owner}: model selector must be a string`);
  const slash = value.indexOf("/");
  const name = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (slash <= 0 || model === "") throw new TypeError(`${owner}: model selector must be <endpoint>/<model>`);
  if (!endpointRegistered(env, name) || endpointConfig(env, name) === undefined) {
    throw new TypeError(`${owner}: unknown endpoint: ${JSON.stringify(name)}`);
  }
  const catalog = endpointSettings(env, name).models;
  if (isPlainObject(catalog) && Object.keys(catalog).length > 0 && !Object.hasOwn(catalog, model)) {
    throw new TypeError(`${owner}: unknown model for ${JSON.stringify(name)}: ${JSON.stringify(model)}`);
  }
  return { endpoint: name, model };
}

/**
 * IO's handle on one pair.
 * @param {object} env
 * @param {string} selector - `<endpoint>/<model>`
 * @param {{remember?: boolean, owner?: string}} [options] - remember: record
 *   the pair as last used (never for a secret/scripted endpoint)
 * @returns {{endpoint: string, model: string, Protocol: Function, url: string|undefined,
 *   settings: object, authSet: Function, authReload: Function}}
 */
export function connection(env, selector, { remember = true, owner = "Env.connection" } = {}) {
  const { endpoint: name, model } = selectorParse(env, selector, owner);
  const config = endpointConfig(env, name);
  const protocol = config.provider ?? DEFAULT_PROVIDER;
  if (remember && env._providers[protocol]?.provider?.secret !== true && config.secret !== true) {
    touchHistory(env, { endpoint: name, model });
    modelsChanged(env); // lastUsed moved
  }
  return Object.freeze({
    endpoint: name,
    model,
    /** The registered provider class (resolved on use: validation needs none). */
    get Protocol() {
      const Protocol = env._providers[protocol];
      if (!Protocol) {
        throw Object.assign(new Error(`${owner}: endpoint "${name}" uses unknown provider protocol "${protocol}"`), { kind: "provider" });
      }
      return Protocol;
    },
    url: config.url,
    /** The endpoint's live settings (auth, model cache, preferences). */
    get settings() { return endpointSettings(env, name); },
    /** Persist endpoint data (credentials, learned model metadata, the loginRequired mark). */
    authSet(data, options) {
      return authSet(env, name, data, options);
    },
    /**
     * Re-read the endpoint's persisted record (another process may have
     * rotated its credentials) and merge it over `current` — Env's own
     * update rule (file over memory).
     * @param {object} [current] - the caller's effective auth record
     * @returns {{auth: object|undefined, url: string|undefined}}
     */
    authReload(current) {
      const section = refreshEndpointSettings(env, name);
      const fresh = isPlainObject(section?.auth) ? section.auth : undefined;
      return {
        auth: fresh === undefined ? undefined : mergeAuthUpdate(isPlainObject(current) ? current : {}, fresh),
        url: typeof section?.url === "string" ? section.url : endpointConfig(env, name)?.url,
      };
    },
  });
}
