// test/env-internals.js — Env's PRIVATE registry steps, for the tests
// that prove them directly (detection, refresh, provenance). Not a test
// file. Public consumers read env.models() / env.connection() instead.
import { detectEndpoints, refreshModels, isDynamic, endpointRegistered, endpointScope, refreshEndpointSettings } from "../lib/env/endpoints.js";
import { touchHistory } from "../lib/env/model-history.js";
import { modelsChanged } from "../lib/env/models-changed.js";
import { readLastCombo } from "../lib/cli/model.js";

export const detect = (env, options) => detectEndpoints(env, options);
export const refresh = (env, options) => refreshModels(env, options);
export const dynamic = (env, name) => isDynamic(env, name);
export const registered = (env, name) => endpointRegistered(env, name);
export const scope = (env, name) => endpointScope(env, name);
export const reread = (env, name) => refreshEndpointSettings(env, name);
/** The newest last-used published pair (the CLI's selection rule). */
export const lastPair = (env) => readLastCombo(env);
/** Record a pair as last used (what env.connection(selector) does). */
export const remember = (env, combo) => {
  touchHistory(env, combo);
  modelsChanged(env);
};
/** A pair's context window from the catalog (null when unknown). */
export const contextWindow = (env, endpoint, model) => env.models(true).get(`${endpoint}/${model}`)?.caps.contextWindow ?? null;

// ---- the endpoint/provider registry (Env-private since the catalog/login API)
import { endpointSettings, endpoint, endpointNames, endpointModels } from "../lib/env/endpoints.js";
import { authSet, mergeAuthInMemory } from "../lib/env/auth.js";
import { registerProvider, defaultProviderRoots } from "../lib/env/provider-registry.js";

/** One endpoint's live settings section (auth, model cache, preferences). */
export const settingsOf = (env, name) => endpointSettings(env, name);
/** One endpoint's effective connection record. */
export const endpointOf = (env, name) => endpoint(env, name);
/** Registered endpoint names (secret ones only on request). */
export const namesOf = (env, options) => endpointNames(env, options);
/** Persist endpoint data to its auth record. */
export const authSetOf = (env, name, data, options) => authSet(env, name, data, options);
/** In-memory-only endpoint data (dynamic endpoints). */
export const mergeInMemory = (env, name, data) => mergeAuthInMemory(env, name, data);
/** One endpoint's model map (live with `refresh`). */
export const modelsOf = (env, name, options) => endpointModels(env, name, options);
/** Register a provider class (embedders pass Env's `providers` option instead). */
export const providerAdd = (env, name, Protocol) => registerProvider(env, name, Protocol);
/** The registered provider class of one protocol name. */
export const providerOf = (env, name) => env._providers[name];
/** Registered protocol names. */
export const providerNamesOf = (env) => Object.keys(env._providers);
/** Provider scan roots. */
export const providerRoots = (env) => defaultProviderRoots(env);
/** Load provider classes (Env.create does this). */
export const providersLoad = (env, options) => env._providersLoad(options);
/** Run fn inside one coalesced settings-write batch. */
export const batch = (env, fn) => env._writeQueue.batch(fn);

// ---- the tool registry's private steps (the public surface is env.tools()/toolCall)
import { loadTools, refreshTools, refreshToolAvailability, toolsList, updateToolStatus, defaultToolRoots } from "../lib/env/tool-registry.js";

/** Scan tool roots (Env.create does this; tests pass explicit `dirs`). */
export const toolsLoad = (env, options) => loadTools(env, options);
/** Rescan the tool roots (the built-in tool-refresh does this). */
export const toolsRefresh = (env) => refreshTools(env);
/** Recheck dynamic availability (every env.tools() call does this). */
export const toolsAvailabilityRefresh = (env) => refreshToolAvailability(env);
/** Eligible tool names as of the last availability check (sync). */
export const toolNames = (env) => [...toolsList(env).keys()];
/** Eligible read-only tool names (sync). */
export const toolNamesSafe = (env) => [...toolsList(env, true).keys()];
/** Is a tool eligible now (sync)? */
export const toolExists = (env, name) => toolsList(env).has(name);
/** One tool's raw registry entry (fn included). */
export const toolEntry = (env, name) => env._tools.get(name);
/** The provider-facing catalog: [{name, ...schema}] (selection: omitted/["*"] = all). */
export const toolSchemas = (env, names, { includeSecret = false } = {}) => {
  const all = names === undefined || (names.length === 1 && names[0] === "*");
  return [...toolsList(env).values()]
    .filter((info) => (all || names.includes(info.name)) && (includeSecret || !info.secret))
    .map((info) => ({ name: info.name, ...info.schema }));
};
/** Merge a tool's live status (a running tool uses context.statusSet). */
export const toolStatusSet = (env, name, info) => updateToolStatus(env, name, info);
/** Tools with a live status. */
export const toolStatus = (env) => [...toolsList(env).values()].filter((info) => info.status !== undefined).map(({ name, status }) => ({ name, status }));
/** The default tool roots. */
export const toolRoots = (env) => defaultToolRoots(env);

// ---- skills/prompts: the accumulated root layers (env.skills()/prompts() read them)
import { defaultSkillRoots } from "../lib/env/catalogs.js";
export const skillRoots = (env) => defaultSkillRoots(env);
