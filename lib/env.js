/**
 * lib/env.js — Env: the sole global environment object.
 *
 * Env is the REGISTRY of what is available to this process: settings,
 * the model catalog (endpoint/model pairs with their caps — env.models()),
 * tools, skills and prompts, and membership events. It builds and keeps
 * that state in the background and persists it; consumers READ state
 * and SUBSCRIBE to changes (Env.EVENT.MODELS_CHANGED), never drive a
 * refresh, a load, or a save. IO opens a pair through env.connection();
 * endpoints come and go through env.login()/env.logout() — the only
 * per-endpoint API. Usage accounting is IO's and Agent's, never Env's.
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
 * Endpoints: a login's record is its auth file `auth-<endpoint>.json`
 * holding `{ [endpoint]: data }` (provider, url, credentials, the cached
 * model list); manual configuration lives at `settings.providers[endpoint]`;
 * environment-detected endpoints persist nothing (lib/env/endpoints.js).
 *
 * Protocols: `providers/*.js` and configured `settings.providerPaths`
 * roots (package/settings scope only — never the project folder) are
 * scanned as default-exported classes importing only lib/context.js;
 * Env completes their static catalog side (lib/env/provider.js) and IO
 * their wire side (lib/io/provider.js).
 *
 * Folders (`env.folders`): the folders that matter to a session, each
 * a typed {kind, title, path} — the project folder (cwd), the harness
 * (package) folder, the user settings folder, the tool roots. The TUI
 * lists them when a fresh session starts.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "./env/settings.js";
import { createWriteQueue } from "./env/persist.js";
import { settingsView } from "./env/settings-view.js";
import { scanAndMergeSettings } from "./env/load.js";
import { configuredExtensions } from "./env/extensions.js";
import { defaultSettingsDir } from "./env/paths.js";
import { detectEndpoints } from "./env/endpoints.js";
import { login, logout, loginPresets, collectPending } from "./env/login.js";
import { models, connection, collect, modelsChanged, MODELS_CHANGED } from "./env/models.js";
import { registerProvider, loadProviders } from "./env/provider-registry.js";
import { registerTool, toolsList, loadTools, refreshTools, refreshToolAvailability, callTool, defaultToolRoots } from "./env/tool-registry.js";
import { defaultsSchema } from "./env/settings-schema.js";
import { skills, prompts, defaultSkillRoots } from "./env/catalogs.js";
import { readSkillResource, listSkillResources } from "./env/skill-resources.js";
import { extend } from "./env/extend.js";
import { mcpRegister, mcpClose } from "./env/mcp-tools.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * The sole global environment object: settings, auth, providers,
 * tools, and the titled folder surface.
 */
export class Env {
  /** @returns {string} The current project folder; assigning changes the project-facing folder/read surface. */
  cwd;
  /**
   * The Env event vocabulary: Symbol constants for onEvent/offEvent.
   * Env events report what EXISTS in this environment: the native
   * MODELS_CHANGED (models() answers differently — re-read it) and the
   * membership events plugins install (Agent's AGENT_ADDED/AGENT_REMOVED);
   * what an object does is that object's own events.
   */
  static EVENT = { MODELS_CHANGED };

  /**
   * Install a higher layer's Env members after the fact (a plugin):
   * `methods`/`getters` land on Env.prototype and run on the env they
   * were reached through (the safe view included); `events` add Symbol
   * keys to Env.EVENT; `settings` add the layer's settings keys to the
   * defaults schema. An existing name throws — plugins extend Env,
   * never override it (lib/env/extend.js).
   * @param {{methods?: Object<string, Function>, getters?: Object<string, Function>, events?: string[], settings?: Object<string, {default: *, description: string}>}} plugin
   * @returns {{EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void}}
   *   the plugin's own event symbols and its (sole) way to emit them
   */
  static extend(plugin) {
    return extend(Env, plugin);
  }

  /**
   * Create a ready-to-use environment. Construction loads synchronous
   * settings first; this factory then loads the asynchronous provider and
   * tool registries, so callers never receive a half-initialized Env, and
   * starts the BACKGROUND model collection (context windows, live model
   * lists): models() answers grow as data arrives, each change emits
   * Env.EVENT.MODELS_CHANGED, and env.modelsReady settles after the first
   * pass. Short-lived hosts that never read models pass `models: false`.
   *
   * @param {ConstructorParameters<typeof Env>[0]} [options]
   * @param {{providers?: boolean, tools?: boolean, detect?: boolean, models?: boolean}} [initOptions]
   * @returns {Promise<Env>}
   */
  static async create(options, initOptions = {}) {
    const { providers = true, tools = true, detect = true, models = true } = initOptions;
    const env = new Env(options);
    if (providers) await env._providersLoad({ detect });
    if (tools) await loadTools(env, { dirs: env._toolDirs });
    if (providers && models) collect(env);
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
   *   the system prompt's project-local AGENTS.md layer (env.systemPrompt())
   * @param {Object} [options.settings] - explicit settings, merged LAST (override)
   * @param {string} [options.sessionsDir] - ephemeral session log folder for this Env only; relative to cwd, overrides configured sessions without writing settings. Must be a non-empty path.
   * @param {Object<string, Function>} [options.providers] - extra provider
   *   classes by name (embedders, tests); they take precedence over a
   *   scanned class of the same name
   * @param {string[]} [options.toolDirs] - the tool roots Env.create scans
   *   instead of the default ones (embedders, tests)
   * @param {string[]} [options.skillDirs] - the skill roots read instead
   *   of the accumulated default layers (embedders, tests)
   * @param {string[]} [options.promptDirs] - the prompt roots, likewise
   * @param {boolean} [options.themes=false] - scan trusted theme roots; application hosts opt in without mutating shared constructor state
   * @param {boolean} [options.auth=true] - retain credentials from settings layers; false strips all nested auth fields for reduced tool-worker environments (not filesystem read confinement)
   */
  constructor({ dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings, sessionsDir, providers, toolDirs, skillDirs, promptDirs, themes = false, auth = true } = {}) {
    if (sessionsDir !== undefined && (typeof sessionsDir !== "string" || sessionsDir.trim() === "")) {
      throw new TypeError("Env: sessionsDir must be a non-empty path");
    }
    this._sessionsDirOverride = sessionsDir;
    this._dir = dir;
    this.cwd = cwd;
    this._settingsDir = settingsDir === undefined ? defaultSettingsDir() : settingsDir;
    if (this._settingsDir !== null) mkdirSync(this._settingsDir, { recursive: true }); // dynamic writes must never fail on a missing folder
    this._endpointScopes = new Map();
    this._dynamicEndpoints = new Set(); // environment-detected, never persisted
    this._writeQueue = createWriteQueue(); // atomic, batch-coalesced settings writes
    this._extensionRoots = configuredExtensions({ dir, settingsDir: this._settingsDir, settings });
    const { merged, scopes, authSections, sessionsBase } = scanAndMergeSettings({
      dir,
      extensionRoots: this._extensionRoots,
      cwd,
      settingsDir: this._settingsDir,
      settings,
      loadThemes: themes === true,
    });
    this._sessionsBase = sessionsBase;
    // Reduced worker environments must not reload credentials from scanned files.
    this._settings = auth ? merged : JSON.parse(JSON.stringify(merged, (key, value) => key === "auth" ? undefined : value));
    for (const [name, scope] of scopes) this._endpointScopes.set(name, scope);
    // the live endpoint map IS settings.providers (one object: a settings
    // write under providers and the registry stay the same record)
    if (!isPlainObject(this._settings.providers)) this._settings.providers = {};
    this._endpoints = this._settings.providers;
    // This provenance distinguishes a user's providers entry from an
    // endpoint object introduced later by a host or authSet(). An entry
    // may be PARTIAL — {filter}, {maxActive}: it is the user's
    // preferences for the name, kept for whatever completes it (an
    // auth file, environment detection, a future login), never a
    // shadow over them.
    this._configuredEndpoints = new Set(Object.keys(this._endpoints));
    // Environment connections detection derived for CONFIGURED names
    // (the union, not a shadow): endpointSettings() merges a record
    // here under the preferences entry; the entry itself never
    // mutates, so dropping it restores the plain detected endpoint.
    this._dynamicConnections = new Map();
    // AUTH-FILE endpoints auto-catalog: a package or namespaced project
    // auth file carrying provider+url is the endpoint's SELF-CONTAINED
    // record — no settings.providers entry is required. With a manual
    // providers entry (complete or a preferences placeholder) the auth
    // record stays in the endpoint's settings section instead:
    // endpointSettings() merges it under the user's preferences.
    for (const [name, scope] of authSections ?? []) {
      if (!this._endpointScopes.has(name)) this._endpointScopes.set(name, scope);
      const section = isPlainObject(this._settings[name]) ? this._settings[name] : {};
      if (this._endpoints[name] === undefined && typeof section.provider === "string" && typeof section.url === "string") {
        this._endpoints[name] = { ...section };
      }
    }


    // Registry surfaces — protocols are basename-keyed classes;
    // endpoints are the live settings.providers map built above.
    this._providers = Object.create(null);
    this._providerOverrides = new Set(Object.keys(providers ?? {}));
    for (const [name, Protocol] of Object.entries(providers ?? {})) registerProvider(this, name, Protocol);
    this._defaultProvidersPromise = null; // shared lazy default-provider load
    this._tools = new Map(); // flattened name -> { fn, schema, builtin?, file?, safe?, onTimeout? }
    this._toolRoots = null; // resolved by loadTools(); default on demand
    this._toolDirs = toolDirs; // the caller's tool roots (Env.create)
    this._skillDirs = skillDirs; // the caller's skill/prompt roots (override)
    this._promptDirs = promptDirs;
    this._eventCallbacks = new Map();
    this._eventHandle = 0;

    // Built-in tools are always registered and survive refreshTools()
    // rebuilds. Availability selection still decides whether a model
    // sees them.
    this._registerBuiltin("tool-refresh", async () => {
      const names = await refreshTools(this);
      return { refreshed: true, tools: names };
    }, {
      description:
        "Rescan the tool folders and rebuild the tool registry. Added, " +
        "changed, and removed tools apply from the next request. Call after you add / edit a tool.",
      inputSchema: { type: "object", properties: {} },
    });
    // MCP servers (settings.mcp): the `mcp` tool and its per-server
    // shortcuts over this Env's client pool (lib/env/mcp-tools.js)
    mcpRegister(this);
  }

  /**
   * Release what this Env runs in the background: pending model-list
   * retries stop, every MCP server it started is killed, and held
   * settings writes reach disk. Idempotent; never throws. A closed Env
   * stays readable (and an MCP call reconnects).
   */
  close() {
    for (const ticket of this._modelRetries?.values() ?? []) clearTimeout(ticket.timer);
    this._modelRetries?.clear();
    mcpClose(this);
    try { this._writeQueue.drain(); } catch { /* teardown is best-effort */ }
  }

  /**
   * The LIVE settings view (lib/env/settings-view.js): reads apply the
   * defaults schema and derived values (`settings.sessions` is the
   * resolved sessions folder); assigning or deleting a key persists
   * only that change, coalesced per tick, to the layer file that owns it
   * (never the package folder). Nested data is live shared state. Arrays must
   * currently be replaced to trigger persistence/events; their in-place
   * mutation semantics remain under consideration.
   * @returns {Object}
   */
  get settings() {
    return settingsView(this);
  }

  /**
   * The folders that matter to a session, computed from current state
   * (the project folder follows `cwd`): exactly one `project` and one
   * `harness` (the package folder in use), the user `settings` folder
   * unless disabled, then each tool root.
   * @returns {ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>}
   */
  get folders() {
    const tools = [...new Set(this._toolRoots ?? defaultToolRoots(this))];
    return Object.freeze([
      { kind: "project", title: "project folder", path: this.cwd },
      { kind: "harness", title: "harness folder", path: this._dir },
      ...(this._settingsDir === null ? [] : [{ kind: "settings", title: "settings folder", path: this._settingsDir }]),
      ...tools.map((path) => ({ kind: "tools", title: "tool folder", path })),
    ].map((folder) => Object.freeze(folder)));
  }

  /**
   * Subscribe to an Env event (distinct from Agent.onEvent's numeric
   * events — these are Symbols). Env events report MEMBERSHIP only; each
   * is an Env.EVENT key a plugin installed (Env.extend) — Agent's
   * AGENT_ADDED/AGENT_REMOVED ({agent}).
   * @param {symbol} event - one Env.EVENT constant
   * @param {(payload: object) => void} callback
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

  /**
   * Remove the listener registered with {@link onEvent}.
   * @param {number} handle - opaque handle returned by onEvent
   * @returns {boolean} true if a listener was removed; otherwise false
   */
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

  /**
   * Emit an Env event to its current listeners; listener exceptions propagate.
   * @private
   * @param {symbol} event - event key
   * @param {object} value - payload supplied to each callback
   * @returns {void}
   */
  _emitEvent(event, value) {
    for (const [, callback] of this._eventCallbacks.get(event) ?? []) callback(value);
  }

  /**
   * Register a tool into the flattened callable lookup
   * (lib/env/tool-registry.js — the safe/interactive schema metadata
   * contract lives there).
   * @param {string} name - flattened tool name
   * @param {Function} fn - the callable
   * @param {object} schema - MCP-like {description, inputSchema, safe?, interactive?, sandbox?, onTimeout?, readOnly?}; readOnly(args) classifies optional mutating invocations as sequential barriers.
   * @param {{builtin?: boolean, file?: string}} [options]
   * @returns {Function} fn
   */
  toolAdd(name, fn, schema, { builtin = false, file } = {}) {
    return registerTool(this, name, fn, schema, { builtin, file });
  }

  /**
   * Register a built-in tool, marking it to survive tool-registry refreshes.
   * @private
   * @param {string} name - flattened tool name
   * @param {Function} fn - callable implementation
   * @param {object} schema - tool metadata and input schema
   * @returns {Function} the registered callable
   */
  _registerBuiltin(name, fn, schema) {
    return this.toolAdd(name, fn, schema, { builtin: true });
  }

  /**
   * The DEFAULTS SCHEMA: every top-level settings key Env (or a
   * loaded tool — see the tools.js module contract's `settingsSchema()`)
   * understands, its default and a one-line description. Discovery
   * only (`ai init`, API.md) — an unknown settings key is never
   * rejected either way.
   * @returns {Object} key -> {default, description}
   */
  settingsSchema() {
    return defaultsSchema(this);
  }

  /** @private Load default-exported provider classes, keyed by each file
   *  basename (Env.create; tests pass explicit roots). */
  async _providersLoad({ dirs, detect = true } = {}) {
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
      await detectEndpoints(this);
      this._providersDetected = true;
      modelsChanged(this);
    }
    return loaded;
  }

  /**
   * The model catalog: every known endpoint/model pair with its state
   * already computed (lib/env/models.js ModelInfo — caps, secret,
   * loginRequired, lastUsed, plugin capacity fields). The Map and outer
   * records are snapshots, but nested capability values may reference shared
   * environment/provider state. Mutate deliberately; this is not a defensive
   * deep copy. Re-read on Env.EVENT.MODELS_CHANGED.
   * @param {boolean} [secret=false] - include hidden pairs (flagged `secret`)
   * @returns {Map<string, object>} `endpoint/model` -> ModelInfo
   */
  models(secret = false) {
    return models(this, secret);
  }

  /**
   * Settles when the background collection's first pass has answered
   * (one-shot hosts: list models, resolve an endpoint-only selector) —
   * including the lists of in-memory logins, fetched now on demand.
   * Resolved at once when no collection runs.
   * @returns {Promise<void>}
   */
  get modelsReady() {
    collectPending(this); // an in-memory login's list is fetched on demand
    return this._modelsReady ?? Promise.resolve();
  }

  /**
   * IO's handle on one pair: {endpoint, model, Protocol, url, settings,
   * authSet(data), authReload(current)} (lib/env/models.js). An unknown
   * endpoint, or a model its non-empty catalog lacks, throws.
   * @param {string} selector - `<endpoint>/<model>`
   * @param {{remember?: boolean}} [options] - remember (default): record the
   *   pair as last used (Agent passes remember: !this.parent)
   * @returns {object}
   */
  connection(selector, { remember = true } = {}) {
    return connection(this, selector, { remember });
  }

  /**
   * The login presets every non-secret provider publishes ({name, label,
   * url, provider, oauth?, note?, ...}).
   * @returns {object[]}
   */
  loginPresets() {
    return loginPresets(this);
  }

  /**
   * Log an endpoint in — one transaction (lib/env/login.js): credentials
   * (`auth`, else the provider shapes `token`), then with a `scope` the
   * endpoint persists, is verified (the provider's connection test, then
   * `verify(models)` over its new catalog entries) and its models are
   * fetched — any failure rolls memory and files back. Without a scope
   * the registration is in-memory only (an invocation-only endpoint);
   * its models arrive in the background.
   * @param {string} name - the endpoint name
   * @param {{provider: string, url: string, token?: string, auth?: object}} config
   * @param {{scope?: "package"|"local", verify?: (models: Map<string, object>) => *}} [options]
   * @returns {Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>}
   */
  login(name, config, options) {
    return login(this, name, config, options);
  }

  /**
   * Remove an endpoint (the /logout contract): its configuration and auth
   * files go with every in-memory trace; an environment-detected endpoint
   * clears in memory only.
   * @param {string} name
   * @returns {{name: string, dynamic: boolean}}
   */
  logout(name) {
    return logout(this, name);
  }

  /* --------------------------------------------- skills and prompts */

  /**
   * Effective skills, read fresh from package/settings/configured/environment/
   * project layers. Later bodies override; {{name}} and {{name[L1-L2]}}
   * explicitly compose bodies (self references use the previous definition).
   * Line ranges are 1-based/inclusive over expanded bodies, excluding metadata.
   * Unknown placeholders remain literal; cycles/invalid known ranges throw.
   * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>}
   */
  skills() {
    return skills(this);
  }

  /**
   * List available skill-relative identifiers when path is omitted, or read
   * an existing resource (last existing layer wins). Metadata listings are not
   * required for reads. No activation, writes, or execution. Listings exclude
   * SKILL.md, observed symlinks, and installation paths. The caller owns returned
   * bytes. Reads are fresh, bounded to 16 MiB, O(catalog scan + layers + file bytes),
   * and retry-safe.
   * @param {string} name Skill name; surrounding whitespace is trimmed.
   * @param {string} [path] Forward-slash relative resource filename; omit to list.
   * @returns {Promise<Buffer|string[]>} Exact file bytes or sorted identifiers.
   * @throws {Error} Unknown/missing/unreadable resource, invalid path, observed
   * symlink, non-regular file, or size limit; fix input/access before retrying.
   */
  skillResource(name, path) {
    return path === undefined
      ? listSkillResources(this._skillDirs ?? defaultSkillRoots(this), name)
      : readSkillResource(this._skillDirs ?? defaultSkillRoots(this), name, path);
  }

  /**
   * The merged prompts (same layers; a later same-named prompt
   * replaces an earlier one), read fresh from disk — same entry shape.
   * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>}
   */
  prompts() {
    return prompts(this);
  }

  /**
   * The tool catalog: name -> ToolInfo ({name, schema, safe, trusted,
   * sandbox, secret, interactive, builtin, file?, storage?, status?,
   * onTimeout?, detect?, readOnly?} — never the callable). Nested schemas/status values
   * are shared live registry data, not defensive copies; mutating them can
   * affect all consumers without a refresh/event. Dynamic availability is
   * rechecked first (concurrent callers share one check). With a
   * selector, that pair's provider tools (`provider: true`) shadow a
   * global tool of the same name.
   * @param {boolean} [safe=false] - read-only (`safe: true`) tools only
   * @param {string} [selector] - `<endpoint>/<model>`
   * @returns {Promise<Map<string, object>>}
   */
  async tools(safe = false, selector) {
    await refreshToolAvailability(this);
    return toolsList(this, safe, selector);
  }

  /**
   * Invoke one tool (lib/env/tool-registry.js). The context is handed to
   * the tool as its second argument; Env reads: `safe` (refuse a tool
   * that is not read-only), `selector` + `io` (the pair's provider tool
   * serves first; undefined falls through to the global tool), `signal`
   * and `deadline`, and adds `statusSet(info)` — the tool's own live
   * status. Missing names are ordinary errors, never a crash.
   * @param {string} name
   * @param {object} args
   * @param {object} [context]
   * @returns {Promise<*>} the tool's return value
   */
  async toolCall(name, args, context) {
    return callTool(this, name, args, context);
  }
}

export default Env;
