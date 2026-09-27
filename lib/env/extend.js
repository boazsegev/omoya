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

/** @returns {Function[]} the plugins' modelInfo(env, info) hooks */
export function modelInfoHooks() {
  return MODEL_INFO_HOOKS;
}

/**
 * Install one plugin onto the Env class.
 * @param {Function} Env - the Env class
 * @param {{methods?: Object<string, Function>, getters?: Object<string, Function>, events?: string[], settings?: Object<string, {default: *, description: string}>, modelInfo?: (env: object, info: object, settings: object) => object}} plugin
 * @returns {{EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void}}
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
    emit(env, event, payload) {
      if (!owned.has(event)) throw new TypeError("Env plugin emit: event not owned by this plugin");
      env?._emitEvent?.(event, payload); // tolerant of stub envs (tests, embedding hosts)
    },
  };
}
