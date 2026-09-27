/**
 * lib/env/provider.js — static-side provider completion (private to
 * Env). A provider plugin default-exports one class and imports only
 * lib/context.js. Env registers it with its CATALOG side completed:
 *
 *   static provider        — {label, capabilities: {streaming, thinking, tools}}
 *                            normalized: thinking = native modes (least ->
 *                            max, [] = none); tools = false | true | map of
 *                            built-in tools {name: {description?, schema?, function}}
 *   static detect(...)     — endpoint auto-detection (default: nothing)
 *   static models(...)     — the endpoint's model map (default: OpenAI-
 *                            compatible /models, lib/env/openai-models.js)
 *   static testConnection  — strict login verification (default: same)
 *   static login(input)    — credentials -> auth record (default: api key)
 *
 * The instance (wire) side is IO's concern (lib/io/provider.js).
 */

import * as openai from "./openai-models.js";
import { isPlainObject } from "./settings.js";

const STATIC_DEFAULTS = {
  detect: async () => ({}),
  models: openai.models,
  testConnection: openai.testConnection,
  login: openai.login,
};

/** Normalize the provider's capabilities: native thinking modes and the tool map. */
function capabilitiesOf(capabilities = {}) {
  const thinking = Array.isArray(capabilities.thinking)
    ? capabilities.thinking.filter((mode) => typeof mode === "string" && mode !== "")
    : [];
  const tools = isPlainObject(capabilities.tools)
    ? Object.freeze(Object.fromEntries(Object.entries(capabilities.tools)
      .filter(([, tool]) => typeof tool?.function === "function")
      .map(([name, tool]) => [name, Object.freeze({ ...tool })])))
    : capabilities.tools === true;
  return Object.freeze({ ...capabilities, streaming: capabilities.streaming === true, thinking: Object.freeze(thinking), tools });
}

/**
 * Register-time completion of a provider class (static/catalog side).
 * @param {Function} Protocol - plugin class
 * @param {{name?: string}} [options] - basename registry key
 * @returns {Function} the registered class (a subclass of the plugin)
 */
export function defineProvider(Protocol, { name } = {}) {
  if (typeof Protocol !== "function") {
    throw new TypeError("defineProvider: provider module must default-export a class");
  }
  const key = name ?? Protocol.provider?.name;
  if (typeof key !== "string" || key === "") {
    throw new TypeError("defineProvider: provider basename/name required");
  }
  const { name: _name, label, capabilities, ...extras } = Protocol.provider ?? {};
  const Registered = class extends Protocol {};
  Object.defineProperty(Registered, "name", { value: Protocol.name || `${key}Provider` });
  Object.defineProperties(Registered, {
    provider: {
      value: Object.freeze({ ...extras, name: key, label: typeof label === "string" ? label : key, capabilities: capabilitiesOf(capabilities) }),
      enumerable: true,
    },
    original: { value: Protocol },
  });
  for (const [method, fallback] of Object.entries(STATIC_DEFAULTS)) {
    if (typeof Protocol[method] === "function") continue;
    Object.defineProperty(Registered, method, { value: fallback, writable: true, configurable: true });
  }
  return Registered;
}
