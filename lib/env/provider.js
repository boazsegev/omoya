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
  /**
   * Default endpoint detection; reports no detected endpoint.
   * @param {...any} _args - ignored detection arguments
   * @returns {Promise<Object>} resolves to an empty detection result
   * @effects Performs no I/O and has no external side effects.
   */
  detect: async () => ({}),
  models: openai.models,
  testConnection: openai.testConnection,
  login: openai.login,
};

/**
 * Normalize provider capabilities into a frozen capability record.
 * Preserves other enumerable capability fields, coerces streaming to a strict
 * boolean, retains only nonempty string thinking modes, and normalizes tools
 * to true/false or a frozen map containing shallow-frozen callable tools.
 * @param {Object} [capabilities={}] - source capability record; omitted values
 *   default to an empty object
 * @returns {Object} a frozen normalized record with a frozen thinking array
 * @throws {*} propagates errors raised while reading, enumerating, copying,
 *   or freezing supplied values (including TypeError for invalid inputs)
 * @effects Does not mutate ordinary input records; returned records and copied
 *   tool records are frozen. Accessors/proxies on input may have side effects.
 */
function capabilitiesOf(capabilities = {}) {
  const thinking = Array.isArray(capabilities.thinking)
    ? capabilities.thinking.filter(/**
      * Keep only supported string-valued native thinking modes.
      * @param {*} mode - candidate mode from the thinking array
      * @returns {boolean} whether the mode is a nonempty string
      * @effects None; only checks primitive type and equality.
      */(mode) => typeof mode === "string" && mode !== "")
    : [];
  const tools = isPlainObject(capabilities.tools)
    ? Object.freeze(Object.fromEntries(Object.entries(capabilities.tools)
      .filter(/**
        * Keep entries whose tool exposes a callable implementation.
        * @param {[string, *]} entry - a tool name and tool record pair
        * @returns {boolean} whether the record has a function-valued function field
        * @throws {*} propagates an exception from a tool function-property getter
        * @effects Reads the tool's function property; accessors may have side effects.
        */([, tool]) => typeof tool?.function === "function")
      .map(/**
        * Copy and freeze one accepted tool record.
        * @param {[string, Object]} entry - the tool name and record pair
        * @returns {[string, Object]} the name paired with a frozen shallow copy
        * @throws {*} propagates exceptions raised while copying/freezing tool properties
        * @effects Freezes the copied tool record, not the input record.
        */([name, tool]) => [name, Object.freeze({ ...tool })])))
    : capabilities.tools === true;
  return Object.freeze({ ...capabilities, streaming: capabilities.streaming === true, thinking: Object.freeze(thinking), tools });
}

/**
 * Register-time completion of a provider class (static/catalog side).
 * @param {Function} Protocol - plugin class
 * @param {Object} [options={}] - registration options
 * @param {string} [options.name] - registry basename; defaults to
 *   `Protocol.provider.name`
 * @returns {Function} the registered subclass, with normalized static provider
 *   metadata and missing static defaults supplied
 * @throws {TypeError} if Protocol is not a function, the options destructure
 *   fails, or the resolved registry key is not a nonempty string
 * @throws {*} propagates errors raised while reading plugin properties or
 *   defining the registered class (including from unusual getters/proxies)
 * @effects Creates a subclass, freezes normalized provider metadata, and adds
 *   static fallback methods only where the plugin has no function-valued method.
 *   It does not mutate the original plugin class under ordinary inputs.
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
