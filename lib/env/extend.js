/**
 * lib/env/extend.js — Env plugins (private to Env; published as
 * Env.extend). A higher layer (IO, Agent) installs the Env members it
 * owns AFTER the fact, so Env never knows those layers' APIs:
 *   - methods and getters land on Env.prototype;
 *   - events add Symbol-valued keys to Env.EVENT, and only the
 *     installing plugin can emit them (the returned `emit`). Env events
 *     report MEMBERSHIP (what exists); an object's activity is its own
 *     events, never an Env copy;
 *   - settings add the keys the layer owns to the defaults schema
 *     (env.settingsSchema(), `init` templates, API docs);
 *   - modelInfo(env, info, settings) contributes fields to every catalog
 *     entry (env.models(); `settings` = the endpoint's settings; Agent
 *     adds maxActive/active/available).
 * Installing a name that already exists throws — a plugin extends Env,
 * never overrides it.
 *
 * A plugin keeps per-env state under its own Symbol key on the env.
 */

import { settingsSchemaAdd } from "./settings-schema.js";

/** Installed catalog hooks, in install order. */
const MODEL_INFO_HOOKS = [];

/**
 * Return the registered model catalog hooks in installation order.
 * @returns {Function[]} The live array of `modelInfo(env, info, settings)` hooks.
 */
export function modelInfoHooks() {
  return MODEL_INFO_HOOKS;
}

/**
 * Install one plugin onto the Env class by adding members, events, settings,
 * and an optional model catalog hook. No existing Env member or event is
 * overridden. Settings are validated before any members or events install.
 * @param {Function} Env The Env class to extend; its prototype and `EVENT`
 *   object are modified.
 * @param {Object} [plugin={}] Plugin declarations.
 * @param {Object<string, Function>} [plugin.methods={}] Methods installed on
 *   `Env.prototype`.
 * @param {Object<string, Function>} [plugin.getters={}] Getters installed on
 *   `Env.prototype`.
 * @param {string[]} [plugin.events=[]] Event names to define on `Env.EVENT`.
 * @param {Object<string, {default: *, description: string}>} [plugin.settings={}] Settings
 *   added to the settings schema.
 * @param {(env: object, info: object, settings: object) => object} [plugin.modelInfo]
 *   Hook appended to the shared catalog-hook list.
 * @returns {{EVENT: Object<string, symbol>, emit: Function}} Frozen event-name
 *   map and an emitter restricted to this plugin's event symbols.
 * @throws {TypeError} If `modelInfo` is not a function, a member or event
 *   conflicts with an existing one, or settings validation fails.
 */
export function extend(Env, { methods = {}, getters = {}, events = [], settings = {}, modelInfo } = {}) {
  if (modelInfo !== undefined && typeof modelInfo !== "function") throw new TypeError("Env.extend: modelInfo must be a function");
  for (const name of [...Object.keys(methods), ...Object.keys(getters)]) {
    if (name in Env.prototype) throw new TypeError(`Env.extend: member "${name}" already exists`);
  }
  for (const name of events) {
    if (Object.hasOwn(Env.EVENT, name)) throw new TypeError(`Env.extend: event "${name}" already exists`);
  }
  settingsSchemaAdd(settings); // validates its own keys before anything installs
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(Env.prototype, name, { value, writable: true, configurable: true });
  }
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(Env.prototype, name, { get, configurable: true });
  }
  if (modelInfo) MODEL_INFO_HOOKS.push(modelInfo);
  const EVENT = {};
  for (const name of events) {
    EVENT[name] = Symbol(name.toLowerCase().replaceAll("_", "-"));
    Object.defineProperty(Env.EVENT, name, { value: EVENT[name], enumerable: true });
  }
  const owned = new Set(Object.values(EVENT));
  return {
    EVENT: Object.freeze(EVENT),
    /**
     * Emit an event owned by this plugin through the environment's optional
     * event-emission hook; stub environments without that hook are tolerated.
     * @param {object} env Environment receiving the event.
     * @param {symbol} event Event symbol from this plugin's `EVENT` map.
     * @param {object} payload Event payload.
     * @returns {void}
     * @throws {TypeError} If `event` is not owned by this plugin.
     */
    emit(env, event, payload) {
      if (!owned.has(event)) throw new TypeError("Env plugin emit: event not owned by this plugin");
      env?._emitEvent?.(event, payload); // tolerant of stub envs (tests, embedding hosts)
    },
  };
}
