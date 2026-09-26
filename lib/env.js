/**
 * lib/env.js — Env: the sole global environment object.
 *
 * The environment loads and manages everything a session uses: merged
 * settings, endpoint-keyed authentication, protocol classes, endpoints,
 * tools, context-window sizing, and the titled folder surface. Env is the
 * shared registry referenced by IO and Agent. Usage accounting is kept by
 * IO and Agent: IO reports usage per turn, and Agent sums it in memory;
 * Env does not track or persist usage accounting.
 *
 * Settings scan in LAYERS (lib/env/paths.js): the package folder's
 * top-level JSON files, then the namespace user settings folder
 * (created when missing and the target of every DYNAMIC settings write),
 * then the project's namespaced settings and auth files ONLY. Files merge into
 * one tree — objects deep-merge, arrays concatenate, scalar collisions
 * follow incidental read order (file ordering is NOT a precedence
 * mechanism). A package or project settings-file parse failure crashes
 * the load (fail fast); any other file's parse failure is ignored.
 * Explicit constructor arguments override merged settings.
 *
 * Authentication: authSet(endpoint, data) creates/updates `auth-${endpoint}.json`
 * holding `{ [endpoint]: data }` (tokens + cached model list). Endpoint
 * configuration lives at `settings.providers[endpoint]`.
 *
 * Protocols: `providers/*.js` and configured `settings.providerPaths`
 * roots (package/settings scope only — never the project folder) are
 * scanned as default-exported classes and completed with OpenAI HTTP
 * defaults. This module exports the provider contract, error taxonomy,
 * and HTTP defaults for provider authors; `lib/io.js` re-exports them
 * for IO consumers.
 *
 * Environment surface (`env.environment`): the folders that matter to a
 * session, each a TITLED {title, path} pair — the project folder (cwd),
 * the harness source, the tool roots (added by loadTools); consumers
 * may push more (same shape). The TUI lists them when a fresh session
 * starts.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES } from "./namespace.js";
import { currentRevision, isToolModuleFile } from "./env/tools.js";
import { deepMerge, isPlainObject } from "./env/settings.js";
import { parseDuration, tryDuration } from "./env/duration.js";
import { createWriteQueue, writeJsonAtomic } from "./env/persist.js";
import { scanAndMergeSettings } from "./env/load.js";
import { defaultSettingsDir, defaultSessionsDir } from "./env/paths.js";
import { osSandboxAvailable, osSandboxKind, osSandboxWrap } from "./env/os-sandbox.js";
import { authSet, mergeAuthInMemory, saveEndpoint, removeEndpoint, mergeAuthUpdate } from "./env/auth.js";
import {
  endpointSettings, endpoint, endpointNames, endpointScope, endpointLocal, isDynamic,
  knownEndpoints, endpointModels, refreshModels, detectEndpoints, refreshEndpointSettings,
} from "./env/endpoints.js";
import {
  registerProvider, provider, providerNames, defaultProviderRoots, loadProviders,
} from "./env/provider-registry.js";
import {
  registerTool, updateToolStatus, toolStatus,
  toolNames, safeView, safeToolNames, toolSchemas, hasTool, toolEntry,
  defaultToolRoots, loadTools, refreshTools, refreshToolAvailability, callTool,
} from "./env/tool-registry.js";
import { defaultsSchema } from "./env/settings-schema.js";
import { resolveSystemPrompt, expandSkillRefs } from "./env/system-prompt.js";
import {
  defaultSkillRoots, defaultPromptRoots, skillCatalog, skillBodies, promptCatalog, promptBody, promptNames, promptNamesAsync,
} from "./env/catalogs.js";
import Context from "./context.js";
const { estimateContextTokens } = Context;
import {
  configuredToolTimeout, configuredToolTimeoutLimit,
  DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT, TOOL_ON_TIMEOUT_LIMIT,
} from "./env/tool-timeout.js";
import {
  configuredContextGuardCap, configuredContextGuardTurnCap,
  DEFAULT_CONTEXT_GUARD_CAP, DEFAULT_CONTEXT_GUARD_TURN_CAP,
} from "./env/context-guard.js";
import { configuredMaxAttempts, retryDelay, RETRYABLE_KINDS, awaitTimeout } from "./env/reliability.js";
import { agentsEndpointLimit, agentsAt, agentEndpointAvailable, agentsEndpointLimitSet } from "./env/agents.js";
import { ENV_EVENT } from "./env/events.js";
import {
  THINKING_LEVELS, DEFAULT_THINKING, resolveEffort, sortEfforts, registryEffortLevels, supportedValues,
} from "./env/thinking.js";
import { defineProvider, ProviderError, classifyError, depletionError } from "./env/provider.js";
import { mcpPool, closeMcpPool } from "./env/mcp.js";
import {
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody,
  defaultRead, defaultClose, singleShot,
} from "./env/http.js";

export { deepMerge } from "./env/settings.js";
export { mergeAuthUpdate } from "./env/auth.js";
export { parseDuration, tryDuration } from "./env/duration.js";
export { DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT, TOOL_ON_TIMEOUT_LIMIT } from "./env/tool-timeout.js";
export { DEFAULT_CONTEXT_GUARD_CAP, DEFAULT_CONTEXT_GUARD_TURN_CAP } from "./env/context-guard.js";
export { retryDelay, RETRYABLE_KINDS, awaitTimeout } from "./env/reliability.js";
export {
  THINKING_LEVELS, DEFAULT_THINKING, resolveEffort, sortEfforts, registryEffortLevels, supportedValues,
} from "./env/thinking.js";
export { defineProvider, ProviderError, classifyError, depletionError } from "./env/provider.js";
// the Responses API `web_search` server-tool capability, implemented
// with the OpenAI defaults (lib/env/openai.js); providers/openai.js
// references it through this façade so provider plugins keep importing
// only public lib roots (see test/base-architecture.test.js)
export { webSearch as openaiWebSearch } from "./env/openai.js";
export { writeJsonAtomic } from "./env/persist.js";
export { ENV_EVENT } from "./env/events.js";
export { defaultSettingsDir, defaultSessionsDir } from "./env/paths.js";
export { isToolModuleFile, scanToolRoots } from "./env/tools.js";
export { osSandboxAvailable, osSandboxKind, osSandboxWrap } from "./env/os-sandbox.js";
export {
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody,
  defaultRead, defaultClose, singleShot,
} from "./env/http.js";

import { webSearch as openaiWebSearch } from "./env/openai.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Validate and split the public `<endpoint>/<model>` selector. */
function parseModelSelector(env, value, owner = "Env") {
  if (typeof value !== "string") throw new TypeError(`${owner}: model selector must be a string`);
  const slash = value.indexOf("/");
  const endpoint = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (slash <= 0 || model === "") throw new TypeError(`${owner}: model selector must be <endpoint>/<model>`);
  if (env.endpoint?.(endpoint) === undefined) throw new TypeError(`${owner}: unknown endpoint: ${JSON.stringify(endpoint)}`);
  const models = env.endpointSettings?.(endpoint)?.models;
  if (models !== null && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0
    && (!Object.hasOwn(models, model) || models[model]?.secret === true)) {
    throw new TypeError(`${owner}: unknown model for ${JSON.stringify(endpoint)}: ${JSON.stringify(model)}`);
  }
  return { endpoint, model };
}

/**
 * The sole global environment object: settings, auth, providers,
 * tools, and the titled folder surface.
 */
export class Env {
  /**
   * Create a ready-to-use environment. Construction loads synchronous
   * settings first; this factory then loads the asynchronous provider and
   * tool registries, so callers never receive a half-initialized Env.
   *
   * @param {ConstructorParameters<typeof Env>[0]} [options]
   * @param {{providers?: boolean, tools?: boolean, detect?: boolean}} [initOptions]
   * @returns {Promise<Env>}
   */
  static async create(options, initOptions = {}) {
    const { providers = true, tools = true, detect = true } = initOptions;
    const env = new Env(options);
    if (providers) await env.loadProviders({ detect });
    if (tools) await env.loadTools();
    return env;
  }

  /**
   * Build the environment: scan and merge the layered settings (the
   * package folder, user settings folder, and namespaced project
   * files — see lib/env/load.js), seed the titled folder surface,
   * register the built-in tools. Providers and tools load afterwards
   * (loadProviders/loadTools).
   * @param {Object} [options]
   * @param {string} [options.dir] - package folder to scan (default: this package's root)
   * @param {string|null} [options.settingsDir] - the USER SETTINGS
   *   folder (default: the namespace setting or namespace home folder,
   *   created when missing) — scanned after the package folder and the target
   *   of every dynamic settings write; null disables the layer
   *   (embedded/test hosts)
   * @param {string} [options.cwd] - the PROJECT folder (default: process.cwd()) —
   *   separate from `dir` so a test (or an embedding host) can isolate
   *   both independently; consumed by the folder surface below and by
   *   resolveSystemPrompt()'s project-local AGENTS.md layer
   * @param {Object} [options.settings] - explicit settings, merged LAST (override)
   */
  constructor({ dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings } = {}) {
    this.dir = dir;
    this.cwd = cwd;
    this.settingsDir = settingsDir === undefined ? defaultSettingsDir() : settingsDir;
    if (this.settingsDir !== null) mkdirSync(this.settingsDir, { recursive: true }); // dynamic writes must never fail on a missing folder
    this._endpointScopes = new Map();
    this._dynamicEndpoints = new Set(); // environment-detected, never persisted
    this._writeQueue = createWriteQueue(); // atomic, batch-coalesced settings writes
    const { merged, scopes, authSections } = scanAndMergeSettings({
      dir,
      cwd,
      settingsDir: this.settingsDir,
      settings,
      loadThemes: this.constructor._loadThemes === true,
    });
    this._settings = merged;
    for (const [name, scope] of scopes) this._endpointScopes.set(name, scope);
    this.endpoints = isPlainObject(this._settings.providers) ? this._settings.providers : {};
    // This provenance distinguishes a user's providers entry from an
    // endpoint object introduced later by a host or authSet().
    this._configuredEndpoints = new Set(Object.keys(this.endpoints));
    // AUTH-FILE endpoints auto-catalog: a package or namespaced project
    // auth file carrying provider+url is the endpoint's
    // SELF-CONTAINED record — no settings.providers entry is required.
    // When a manual providers entry exists, it remains authoritative for
    // connection configuration. Its auth file is a cache for credentials
    // and the fetched model catalogue, not a higher-precedence URL/model
    // configuration source.
    for (const [name, scope] of authSections ?? []) {
      if (!this._endpointScopes.has(name)) this._endpointScopes.set(name, scope);
      const section = isPlainObject(this._settings[name]) ? this._settings[name] : {};
      if (this.endpoints[name] === undefined && typeof section.provider === "string" && typeof section.url === "string") {
        this.endpoints[name] = { ...section };
      } else if (this.endpoints[name] !== undefined && Object.keys(section).length > 0) {
        // Keep endpoint() restart-stable: credentials and fetched models
        // from the durable record remain visible, while the manual
        // provider entry owns connection fields and static model policy.
        const configured = this.endpoints[name];
        this.endpoints[name] = { ...section, ...configured };
        if (isPlainObject(section.models) || isPlainObject(configured.models)) {
          this.endpoints[name].models = { ...(configured.models ?? {}), ...(section.models ?? {}) };
        }
      }
    }

    // The environment data surface for the TUI: the folders that matter
    // to a session, each TITLED — the project folder (cwd), the harness
    // source, and the tool roots (appended by loadTools). Consumers
    // (tools, the host app) may push more {title, path} entries; the
    // TUI lists them on a fresh session.
    this.environment = {
      folders: [
        { title: "project folder", path: this.cwd },
        { title: "harness folder", path: PACKAGE_DIR },
        ...(this.settingsDir === null ? [] : [{ title: "settings folder", path: this.settingsDir }]),
      ].filter((f, i, all) => all.findIndex((g) => g.path === f.path) === i),
    };

    // Registry surfaces — protocols are basename-keyed classes;
    // endpoints are the live settings.providers map built above.
    this.providers = Object.create(null);
    this._defaultProvidersPromise = null; // shared lazy default-provider load
    this._tools = new Map(); // flattened name -> { fn, schema, builtin?, file?, safe?, onTimeout? }
    this._toolRoots = null; // resolved by loadTools(); default on demand
    this._agents = new Set(); // Strong references to active Agents; only Agent.close() removes one.
    this._eventCallbacks = new Map();
    this._eventHandle = 0;

    // Built-in tools are always registered and survive refreshTools()
    // rebuilds. Availability selection still decides whether a model
    // sees them.
    this._registerBuiltin("tool-refresh", async () => {
      const names = await this.refreshTools();
      return { refreshed: true, tools: names };
    }, {
      description:
        "Rescan the tool folders and rebuild the tool registry. Added, " +
        "changed, and removed tools apply from the next request. Call after you add / edit a tool.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  /** Read the valid last-used endpoint/model selection. Invalid, stale,
   * malformed, or absent state is indistinguishable from no saved selection.
   * Memory belongs to CONFIGURED endpoints only: a record naming a secret
   * or environment-detected (dynamic) endpoint — both outside the user's
   * durable configuration — reads as absent. */
  lastModel() {
    try {
      const parsed = JSON.parse(readFileSync(join(this.settingsDir ?? this.dir, "last-model.json"), "utf8"));
      if (!isPlainObject(parsed) || typeof parsed.model !== "string" || parsed.model === "") return null;
      const slash = typeof parsed.endpoint === "string" && parsed.endpoint !== "" ? -1 : parsed.model.indexOf("/");
      const endpoint = slash > 0 ? parsed.model.slice(0, slash) : parsed.endpoint;
      const model = slash > 0 ? parsed.model.slice(slash + 1) : parsed.model;
      const selected = parseModelSelector(this, `${endpoint}/${model}`, "last-model.json");
      // parseModelSelector already rejects unregistered endpoints and
      // unlisted/secret models; the endpoint itself must also be
      // non-secret and registered in durable configuration.
      if (this.endpoints[selected.endpoint]?.secret === true || this._dynamicEndpoints.has(selected.endpoint)) return null;
      return selected;
    } catch {
      return null;
    }
  }

  /** @returns {Object} the merged settings tree (live reference) */
  get settings() {
    return this._settings;
  }

  /**
   * Default Agent-enforced duration of one tool call. The merged
   * `toolTimeout` setting accepts milliseconds or a unit string;
   * absent means 120 seconds.
   * @returns {number} milliseconds
   */
  get toolTimeout() {
    return configuredToolTimeout(this._settings);
  }

  /**
   * Hard ceiling for a tool's schema-declared, model-requested
   * `timeout` argument. The merged `toolTimeoutLimit` setting accepts
   * milliseconds or a unit string; absent means twenty minutes.
   * @returns {number} milliseconds
   */
  get toolTimeoutLimit() {
    return configuredToolTimeoutLimit(this._settings);
  }

  /**
   * The Agent tool loop's runaway guard: the OVERALL context-usage
   * ceiling, a (0,1] fraction of the model's context window (settings
   * value > 1 reads as a percentage). Crossing it refuses to continue
   * — user oversight and /compact are required first (lib/agent/run.js
   * owns enforcement). The merged `contextGuardCap` setting; absent
   * means 90% — always leaving room for /compact itself to run.
   * @returns {number}
   */
  get contextGuardCap() {
    return configuredContextGuardCap(this._settings);
  }

  /**
   * The Agent tool loop's runaway guard: the PER-TURN context-growth
   * ceiling, a (0,1] fraction of the model's context window — even
   * starting near-empty, one agent turn alone cannot consume more
   * than this before it's stopped. The merged `contextGuardTurnCap`
   * setting; absent means 40%.
   * @returns {number}
   */
  get contextGuardTurnCap() {
    return configuredContextGuardTurnCap(this._settings);
  }

  /**
   * Provider-request attempts per IO turn (settings.maxAttempts,
   * default 3): the first write plus its retries — only failure
   * classes that can heal with time retry (Env.RETRYABLE_KINDS);
   * the interval grows from retryBase, doubling per attempt,
   * capped at retryMax (lib/env/reliability.js). The Agent's run
   * loop owns enforcement.
   * @returns {number}
   */
  get maxAttempts() {
    return configuredMaxAttempts(this._settings);
  }

  /**
   * One retry's delay (lib/env/reliability.js): retryBase doubling
   * per attempt, capped at retryMax, jittered against lockstep.
   * @param {number} attempt - 0 for the first retry
   * @returns {number} milliseconds
   */
  retryDelay(attempt) {
    return retryDelay(this._settings, attempt);
  }

  /* ------------------------------------- context size (TUI) */

  /**
   * The model's context window in tokens, WHEN KNOWN: an explicit
   * provider-settings override (`<provider>.contextWindow`) wins over
   * the cached model descriptor's `contextWindow` (the models()
   * snapshot persisted in the provider's auth namespace). Returns null
   * when unknown — consumers hide the window readout then rather than
   * show a guessed number.
   * @param {string} [endpoint]
   * @param {string} [model] - bare model id
   * @returns {number|null}
   */
  contextWindow(endpoint, model) {
    const section = this.endpointSettings(endpoint);
    if (Number.isFinite(section.contextWindow) && section.contextWindow > 0) {
      return section.contextWindow;
    }
    const models = isPlainObject(section.models) ? section.models : {};
    const found = models[model];
    return Number.isFinite(found?.contextWindow) && found.contextWindow > 0
      ? found.contextWindow
      : null;
  }

  /**
   * Current context consumption in tokens: the provider-reported input
   * count of the last request when available (the exact number the
   * provider processed), else the word-count estimate of the live
   * context (the token-per-word likelihood ratio).
   * @param {Array} [context] - the live context
   * @param {object} [lastUsage] - the last terminal usage envelope
   * @returns {number}
   */
  contextConsumption(context, lastUsage) {
    if (Number.isFinite(lastUsage?.inputTokens)) return lastUsage.inputTokens;
    return estimateContextTokens(context);
  }

  /**
   * The system-prompt text(s) for a FRESH session — read fresh from
   * disk on EVERY call, never cached (lib/env/system-prompt.js).
   * @returns {string[]} zero to three prompt texts, in layering order
   *   (package → user settings → project)
   */
  resolveSystemPrompt() {
    return resolveSystemPrompt(this);
  }

  /** {{skill-name}} prefill expansion (lib/env/system-prompt.js). */
  _expandSkillRefs(text) {
    return expandSkillRefs(this, text);
  }

  /** Live endpoint configuration plus endpoint-keyed auth/model cache
   *  (lib/env/endpoints.js). */
  endpointSettings(endpoint) {
    return endpointSettings(this, endpoint);
  }

  /**
   * Re-read one endpoint's persisted settings/auth record from disk and
   * merge it over the live settings tree (lib/env/endpoints.js) — the
   * multi-process refresh IO applies on an auth failure: another
   * process may have rotated the token this process still holds. A
   * vanished file is a no-op, never a settings drop.
   * @param {string} endpoint - endpoint name
   * @returns {Object|undefined} the endpoint's live settings section
   */
  refreshEndpointSettings(endpoint) {
    return refreshEndpointSettings(this, endpoint);
  }

  /**
   * Persist endpoint-keyed auth/model data: creates/updates
   * `auth-<endpoint>.json` holding `{ [endpoint]: data }` (tokens +
   * cached model list) in the endpoint's scope — the project folder
   * ("local") or the effective user-settings folder ("package", the
   * default; the package folder itself is used only when settingsDir is
   * null). Merges into the live settings tree under the endpoint key.
   * @param {string} endpoint - the endpoint name
   * @param {object} data - auth payload and/or cached `models` map
   * @param {{scope?: "local"|"package"}} [options] - storage scope override
   * @returns {object} the merged endpoint section
   */
  authSet(endpoint, data, { scope } = {}) {
    return authSet(this, endpoint, data, { scope });
  }

  /** In-memory-only auth merge (dynamic endpoints; lib/env/auth.js). */
  _mergeAuthInMemory(endpoint, data) {
    return mergeAuthInMemory(this, endpoint, data);
  }

  /** Add/update one configured endpoint and persist it to the scope's
   *  settings file (the user settings folder or namespaced project file). */
  saveEndpoint(name, endpoint, { scope = "package" } = {}) {
    return saveEndpoint(this, name, endpoint, { scope });
  }

  /**
   * Remove an endpoint — the /logout contract: its configuration drops
   * out of the scope's settings file, its auth file
   * is deleted, and every in-memory trace is removed. Dynamic
   * (environment-detected) endpoints clear in-memory only.
   * @param {string} name - endpoint name
   * @returns {{name: string, dynamic: boolean}}
   */
  removeEndpoint(name) {
    return removeEndpoint(this, name);
  }

  /**
   * Run fn inside a WRITE BATCH: every settings-file write it triggers
   * (authSet, saveEndpoint — a login performs several) is held in
   * memory and each file lands ONCE, atomically, when the outermost
   * batch ends. Cloud sync clients never see a partial or repeated
   * update (see lib/env/persist.js). Batches nest.
   * @param {Function} fn
   * @returns {Promise<*>} fn's return value
   */
  batch(fn) {
    return this._writeQueue.batch(fn);
  }

  /** Flush any batched settings writes now (a no-op outside a batch). */
  flushSettings() {
    this._writeQueue.flush();
  }

  /** Select and persist a named TUI theme in the effective settings file. */
  saveTheme(name) {
    if (typeof name !== "string" || name === "" || (name !== "default" && !isPlainObject(this._settings.tui?.themes?.[name]))) {
      throw new TypeError(`unknown TUI theme: ${name}`);
    }
    const file = `${this.settingsDir ?? this.dir}/settings.json`;
    let stored = {};
    try { stored = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    stored.tui = { ...(isPlainObject(stored.tui) ? stored.tui : {}), theme: name };
    writeJsonAtomic(file, stored);
    this._settings.tui = { ...(isPlainObject(this._settings.tui) ? this._settings.tui : {}), theme: name };
    return name;
  }

  /* ------------------------------------------------ registry surfaces */


  /**
   * Register an active Agent. Agent construction owns this call; registration
   * retains the user-facing session until `Agent.close()` expressly removes it.
   * Registration order is preserved.
   * @param {object} agent
   * @returns {object} the registered agent
   * @throws {TypeError} when agent is not an object
   */
  registerAgent(agent) {
    if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) {
      throw new TypeError("Env.registerAgent: agent must be an object");
    }
    if (this._agents.has(agent)) return agent;
    this._agents.add(agent);
    this._emitEvent(ENV_EVENT.AGENT_ADDED, { agent });
    return agent;
  }

  /**
   * Snapshot the active sessions. Closing an Agent removes it synchronously;
   * inactivity and garbage collection never change this lifecycle registry.
   * The TUI and all agent-list consumers must use this canonical list.
   * @returns {object[]}
   */
  agents() {
    return [...this._agents];
  }

  /**
   * Remove an active Agent. `Agent.close()` owns normal
   * lifecycle use; this method exists for Env-owned cleanup only.
   * @param {object} agent
   * @returns {boolean} whether the agent was registered
   */
  removeAgent(agent) {
    if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) {
      throw new TypeError("Env.removeAgent: agent must be an object");
    }
    if (!this._agents.delete(agent)) return false;
    this._emitEvent(ENV_EVENT.AGENT_REMOVED, { agent });
    return true;
  }

  /**
   * Subscribe to a generic Env lifecycle event (distinct from
   * Agent.onEvent's numeric turn events — these are Symbols). The
   * possible `event` values (the Env.ENV_EVENT constants):
   * - `Env.ENV_EVENT.AGENT_ADDED` — an Agent registered with this Env
   * - `Env.ENV_EVENT.AGENT_REMOVED` — an Agent left this Env
   * - `Env.ENV_EVENT.AGENT_START` — an Agent began a run
   * - `Env.ENV_EVENT.AGENT_DONE` — an Agent's run finished (done or error)
   * - `Env.ENV_EVENT.IO_START` — a provider request began (`{io}`)
   * - `Env.ENV_EVENT.IO_DONE` — a provider request finished (`{io, terminal}`)
   * @param {symbol} event - one Env.ENV_EVENT constant (see the list above)
   * @param {(payload: object) => void} callback - AGENT_* payloads carry `{agent}` (AGENT_START/AGENT_DONE add the agent's START/DONE event); IO_* payloads carry `{io}`
   * @returns {number} opaque handle (offEvent removes it)
   */
  onEvent(event, callback) {
    if (typeof callback !== "function") throw new TypeError("Env.onEvent: callback must be a function");
    const handle = ++this._eventHandle;
    const listeners = this._eventCallbacks.get(event) ?? [];
    listeners.push([handle, callback]);
    this._eventCallbacks.set(event, listeners);
    return handle;
  }

  /** Remove a generic Env lifecycle listener by its opaque handle. */
  offEvent(handle) {
    for (const [event, listeners] of this._eventCallbacks) {
      const index = listeners.findIndex(([id]) => id === handle);
      if (index !== -1) {
        listeners.splice(index, 1);
        if (listeners.length === 0) this._eventCallbacks.delete(event);
        return true;
      }
    }
    return false;
  }

  /** @private Emit one generic Env lifecycle event. */
  _emitEvent(event, value) {
    for (const [, callback] of this._eventCallbacks.get(event) ?? []) callback(value);
  }

  /** Effective active-Agent cap for an endpoint/model scope. */
  agentsEndpointLimit(endpoint, model) {
    return agentsEndpointLimit(this, endpoint, model);
  }

  /** Count registered active Agents at an endpoint, optionally one model. */
  agentsAt(endpoint, model) {
    return agentsAt(this, endpoint, model);
  }

  /** Current unreserved active-Agent capacity; never reserves a slot. */
  agentEndpointAvailable(endpoint, model) {
    return agentEndpointAvailable(this, endpoint, model);
  }

  /** Persist an endpoint/model active-Agent cap. */
  agentsEndpointLimitSet(options) {
    return agentsEndpointLimitSet(this, options);
  }

  /** Register and internally complete a basename-keyed protocol class. */
  registerProvider(name, ProviderClass) {
    return registerProvider(this, name, ProviderClass);
  }

  /** @returns {Function|undefined} a communication protocol class by basename */
  provider(name) {
    return provider(this, name);
  }

  /** @returns {string[]} registered communication protocol basenames */
  providerNames() {
    return providerNames(this);
  }

  /**
   * Known endpoint presets offered by the login wizards (lib/env/endpoints.js).
   * @returns {Array<{name: string, label: string, url: string, provider: string, oauth?: object}>}
   */
  knownEndpoints() {
    return knownEndpoints(this);
  }

  /**
   * The scope an endpoint's settings/auth live in: "local" when its
   * configuration came from the namespaced PROJECT settings file,
   * "package" otherwise (user settings or package files).
   * @param {string} name - endpoint name
   * @returns {"package"|"local"}
   */
  endpointScope(name) {
    return endpointScope(this, name);
  }

  /** @returns {Object|undefined} one named endpoint configuration */
  endpoint(name) {
    return endpoint(this, name);
  }

  /**
   * Is an endpoint LOCAL (lib/env/endpoints.js endpointLocal): project-
   * scope configuration or a record publishing `local: true` /
   * `remote: false` — the shared predicate the model-list access
   * policy classifies with.
   * @param {string} name - endpoint name
   * @returns {boolean}
   */
  endpointLocal(name) {
    return endpointLocal(this, name);
  }

  /**
   * Is the endpoint ENVIRONMENT-DEFINED (auto-detected from the process
   * environment)? Dynamic endpoints are never persisted.
   * @param {string} name - endpoint name
   * @returns {boolean}
   */
  isDynamic(name) {
    return isDynamic(this, name);
  }

  /** Endpoint names; secret entries are hidden unless explicitly requested. */
  endpointNames({ includeSecret = false, access = "all" } = {}) {
    return endpointNames(this, { includeSecret, access });
  }

  /** Are LOCAL endpoints exposed to linked-agent spawning? (settings.local ??= true) */
  get local() {
    return this._settings.local ?? true;
  }

  /** Are REMOTE (public) endpoints exposed to linked-agent spawning? (settings.remote ??= true) */
  get remote() {
    return this._settings.remote ?? true;
  }

  /**
   * Register a tool into the flattened callable lookup
   * (lib/env/tool-registry.js — the safe/interactive schema metadata
   * contract lives there).
   * @param {string} name - flattened tool name
   * @param {Function} fn - the callable
   * @param {object} schema - MCP-like {description, inputSchema, safe?, interactive?, sandbox?, onTimeout?}
   * @param {{builtin?: boolean, file?: string}} [options]
   * @returns {Function} fn
   */
  registerTool(name, fn, schema, { builtin = false, file } = {}) {
    return registerTool(this, name, fn, schema, { builtin, file });
  }

  _registerBuiltin(name, fn, schema) {
    return this.registerTool(name, fn, schema, { builtin: true });
  }

  /**
   * Merge a live-status object into a tool's registry entry; /status
   * prints it, the TUI renders it below the status bar.
   * @param {string} name - flattened tool name
   * @param {Object} info - shallow-merged into the existing status
   * @returns {Object} the tool's merged status
   */
  updateToolStatus(name, info) {
    return updateToolStatus(this, name, info);
  }

  /** @returns {Array<{name: string, status: Object}>} tools with a live status object */
  toolStatus() {
    return toolStatus(this);
  }

  /** @returns {string[]} all flattened tool names */
  toolNames() {
    return toolNames(this);
  }

  /**
   * The SAFE VIEW of this environment: one cached facade (a Proxy)
   * whose TOOL surface is limited to read-only (`safe: true`) tools
   * (lib/env/tool-registry.js). A VIEW, not a mode: one Env serves
   * any number of consumers in either mode.
   * @returns {Env}
   */
  get safe() {
    return safeView(this);
  }

  /**
   * The READ-ONLY tools: schemas published with `safe: true`.
   * @returns {string[]}
   */
  safeToolNames() {
    return safeToolNames(this);
  }

  /**
   * The publishable tool catalog. Omitted/`["*"]` = all current tools;
   * `[]` = none; an explicit list exposes only recognized names. A
   * `secret: true` tool is hidden unless `includeSecret` is set.
   * @param {string[]} [names]
   * @param {{includeSecret?: boolean}} [options]
   * @returns {Array} [{name, ...schema}]
   */
  toolSchemas(names, options) {
    return toolSchemas(this, names, options);
  }

  /**
   * The DEFAULTS SCHEMA: every top-level settings key Env (or a
   * loaded tool — see the tools.js module contract's `settingsSchema()`)
   * understands, its default and a one-line description. Discovery
   * only (`ai init`, API.md) — an unknown settings key is never
   * rejected either way.
   * @returns {Object} key -> {default, description}
   */
  defaultsSchema() {
    return defaultsSchema(this);
  }

  /** Protocol roots: installed/package providers, an optional custom package root, and configured paths (never the project folder). */
  defaultProviderRoots() {
    return defaultProviderRoots(this);
  }

  /** Load default-exported provider classes, keyed by each file basename. */
  async loadProviders({ dirs, detect = true } = {}) {
    // Explicit roots are a caller-owned scan (principally tests/embedders).
    if (dirs !== undefined) return loadProviders(this, { dirs, detect });
    // The default package scan is shared with Agent's lazy startup, avoiding
    // duplicate registrations when a host also loads providers explicitly.
    if (!this._defaultProvidersPromise) {
      this._defaultProvidersPromise = loadProviders(this, { detect: false }).catch((error) => {
        this._defaultProvidersPromise = null;
        throw error;
      });
    }
    const loaded = await this._defaultProvidersPromise;
    if (detect && !this._providersDetected) {
      await this.detectEndpoints();
      this._providersDetected = true;
    }
    return loaded;
  }

  /**
   * One endpoint's model MAP. With `refresh`, the endpoint is queried
   * live (a failed query falls back to the cached + static list).
   * @param {string} name - endpoint name
   * @param {Object} [options]
   * @param {boolean} [options.refresh] - query the endpoint live first
   * @param {string} [options.url] - URL override (invocation-only endpoints)
   * @param {AbortSignal} [options.signal] - aborts the live query
   * @returns {Promise<Object>} the model map ({} when nothing is known)
   */
  async endpointModels(name, { refresh = false, url, signal } = {}) {
    return endpointModels(this, name, { refresh, url, signal });
  }

  /**
   * Query EVERY configured endpoint for its available models (parallel,
   * each bounded by `timeout`): the startup cache renewal.
   * @param {Object} [options]
   * @param {number|string} [options.timeout] - per-endpoint cap (default 2s)
   * @returns {Promise<string[]>} the endpoints that answered
   */
  async refreshModels({ timeout = 2000 } = {}) {
    return refreshModels(this, { timeout });
  }

  /**
   * Run provider-owned endpoint probes and fill only absent settings
   * entries. Discoveries marked `dynamic: true` are ENVIRONMENT-DEFINED:
   * never persisted — auth merges in memory only.
   * @param {Object} [options]
   * @param {number} [options.timeout] - per-protocol probe cap (ms)
   * @returns {Promise<string[]>} the added endpoint names
   */
  async detectEndpoints({ timeout = 300 } = {}) {
    return detectEndpoints(this, { timeout });
  }

  /** @param {string} name @returns {boolean} */
  hasTool(name) {
    return hasTool(this, name);
  }

  /**
   * The registry entry for a tool ({fn, schema, builtin?, file?, safe?,
   * interactive?, sandbox?, onTimeout?, status?}), or undefined.
   * @param {string} name
   * @returns {object|undefined}
   */
  toolEntry(name) {
    return toolEntry(this, name);
  }

  /* ------------------------------------------------ tool scan-load */

  /**
   * Tool-folder roots: the installed package and user settings folders,
   * and explicitly configured `settings.tools` roots.
   * @returns {string[]}
   */
  defaultToolRoots() {
    return defaultToolRoots(this);
  }

  /* --------------------------------------------- skills and prompts */

  /**
   * Skill roots, accumulated from the package, settings, configured,
   * environment, and project layers.
   * @returns {string[]}
   */
  defaultSkillRoots() {
    return defaultSkillRoots(this);
  }

  /**
   * Prompt roots, ACCUMULATED the same way as skill roots.
   * @returns {string[]}
   */
  defaultPromptRoots() {
    return defaultPromptRoots(this);
  }

  /**
   * The merged skill catalog as `# Skill Catalog` text. Read fresh
   * from disk on every call.
   * @param {Object} [options]
   * @param {boolean} [options.debug]
   * @param {string[]} [options.roots] - override (tests)
   * @returns {string}
   */
  skillCatalog({ debug = false, roots } = {}) {
    return skillCatalog(this, { debug, roots });
  }

  /**
   * The full bodies of the named skills, each wrapped in
   * `<skill name="...">` tags. Unknown names are skipped, not fatal.
   * @param {string[]} names
   * @param {{roots?: string[]}} [options]
   * @returns {{text: string, unknown: string[]}}
   */
  skillBodies(names, { roots } = {}) {
    return skillBodies(this, names, { roots });
  }

  /**
   * The merged prompt catalog, same shape as skillCatalog().
   * @param {{debug?: boolean, roots?: string[]}} [options]
   * @returns {string}
   */
  promptCatalog({ debug = false, roots } = {}) {
    return promptCatalog(this, { debug, roots });
  }

  /**
   * The merged prompt NAMES (sorted) — completion candidates. Read
   * fresh from disk on every call.
   * @param {{roots?: string[]}} [options]
   * @returns {string[]}
   */
  promptNames({ roots } = {}) {
    return promptNames(this, { roots });
  }

  /**
   * Async prompt names, with the same roots and override semantics.
   * @param {{roots?: string[]}} [options]
   * @returns {Promise<string[]>}
   */
  async promptNamesAsync({ roots } = {}) {
    return promptNamesAsync(this, { roots });
  }

  /**
   * One prompt's body, verbatim (no interpolation). Read fresh from
   * disk on every call.
   * @param {string} name
   * @param {{roots?: string[]}} [options]
   * @returns {string|null} null when unknown
   */
  promptBody(name, { roots } = {}) {
    return promptBody(this, name, { roots });
  }

  /**
   * Tool scan-and-load: import each root's TOP-LEVEL JS modules (the
   * scan is NOT recursive) and publish described-and-exported callables.
   * @param {Object} [options]
   * @param {string[]} [options.dirs] - root override (tests); remembered
   *   for later refreshTools() calls
   * @returns {Promise<string[]>} the published tool names
   */
  async loadTools({ dirs } = {}) {
    return loadTools(this, { dirs });
  }

  /** Recheck dynamic tool eligibility before a model request; does not rescan modules.
   * @returns {Promise<string[]>} currently eligible tool names
   */
  async refreshToolAvailability() {
    return refreshToolAvailability(this);
  }

  /**
   * Rescan the tool roots and rebuild the tool/schema/callable maps.
   * Invoke ONLY between model requests.
   * @returns {Promise<string[]>} the published tool names
   */
  async refreshTools() {
    return refreshTools(this);
  }

  /**
   * The shared tool-refresh revision: bumped on every refreshTools()
   * scan. Tool WRAPPERS stamp their private helper imports with it
   * (`./read/read.js?now=<revision>`) so a helper edit applies on
   * refresh even when the wrapper file itself is unchanged. Tool
   * modules read it WITHOUT loading this library — toolRevision() in
   * lib/env/mcp.js (the tiny runtime, published by the scan); this
   * static remains for library consumers only.
   * @returns {number}
   */
  static toolTimestamp() {
    return currentRevision();
  }

  /**
   * The OS write-sandbox mechanism in effect: "seatbelt", "bwrap",
   * "delegated" (an OUTER jail already confines this process — the
   * wrap is a passthrough), or null (no enforcement — the Agent
   * forces safe mode then). Shared
   * by every tool that opts
   * in with the `sandbox: true` schema metadata — the Agent runs
   * such a tool's forked worker under this kernel write-deny jail.
   * Available to tool modules as the global `Env`.
   * @returns {"seatbelt"|"bwrap"|"delegated"|null}
   */
  static osSandboxKind() {
    return osSandboxKind();
  }

  /**
   * Is OS write-sandbox ENFORCEMENT in effect for this process — our
   * own mechanism (seatbelt on macOS, bwrap on Linux) or an OUTER
   * jail we detected (a nested seatbelt confines us already)?
   * A single probe, cached —
   * it does not repeat. There is NO opt-out: when false the Agent
   * FORCES safe mode — mutation tools run only under active write
   * enforcement, never unjailed by configuration.
   * Available to tool modules as the global `Env`.
   * @returns {boolean}
   */
  static osSandboxAvailable() {
    return osSandboxAvailable();
  }

  /**
   * Wrap a program invocation in the OS write sandbox: the [file,
   * argv] to spawn (the input unchanged when no mechanism applies).
   * Available to tool modules as the global `Env`.
   * @param {string} file - the program to run
   * @param {string[]} args - its arguments
   * @param {string} [cwd] - the working folder writes are limited to
   * @returns {[string, string[]]}
   */
  static osSandboxWrap(file, args, cwd) {
    return osSandboxWrap(file, args, cwd);
  }

  /**
   * Exact flattened lookup + invoke. Missing names are ordinary errors
   * (Agent surfaces them as tool-result errors), never a crash.
   * @param {string} name
   * @param {object} args
   * @param {object} [context] - harness tool context ({question})
   * @returns {Promise<*>} the tool's return value
   */
  async callTool(name, args, context) {
    return callTool(this, name, args, context);
  }
}

// Functions that do not require an environment instance live on the
// same canonical class namespace as its constructor and instance API.
Object.assign(Env, {
  NAMES,
  deepMerge, mergeAuthUpdate, parseDuration, tryDuration, parseModelSelector,
  DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT, TOOL_ON_TIMEOUT_LIMIT,
  DEFAULT_CONTEXT_GUARD_CAP, DEFAULT_CONTEXT_GUARD_TURN_CAP,
  THINKING_LEVELS, DEFAULT_THINKING, resolveEffort, sortEfforts, registryEffortLevels, supportedValues,
  defineProvider, ProviderError, classifyError, depletionError, writeJsonAtomic,
  retryDelay, RETRYABLE_KINDS, awaitTimeout,
  defaultSettingsDir, defaultSessionsDir, isToolModuleFile,
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody, defaultRead, defaultClose, singleShot,
  // the Responses API `web_search` server-tool capability (same
  // namespace as the other OpenAI defaults above)
  openaiWebSearch,
  // The MCP client runtime: the stdio connection pool and its teardown
  // (lib/env/mcp.js). MCP is a core feature — the `mcp` tool connects
  // through Env.mcpPool (module-identity-backed, refresh-safe) and the
  // CLI teardown closes through Env.closeMcpPool(); nothing is parked
  // on globalThis.
  ENV_EVENT, mcpPool, closeMcpPool,
});

export default Env;
