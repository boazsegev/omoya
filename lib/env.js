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
 * Env declares its settings sources (lib/env/source-graph.js) on a
 * SettingsStore: package, extension, user and project files plus memory,
 * last wins. Objects merge by key; arrays and scalars replace. Required
 * settings-file parse failures fail startup; other malformed files keep
 * their last good data and are retried by polling. Explicit constructor
 * settings take precedence.
 *
 * Endpoints: everything about an endpoint is `settings.providers[endpoint]`.
 * A login's auth file `auth-<endpoint>.json` holds `{ [endpoint]: data }`
 * mounted at `providers`; only a login (or the user) creates one. Endpoint
 * data with no file, and environment-detected endpoints, stay in memory.
 *
 * Protocols: `providers/*.js` and configured trusted extension roots
 * (package/user scope only — never the project folder) are scanned as
 * default-exported classes importing only lib/context.js;
 * Env completes their static catalog side (lib/env/provider.js) and IO
 * their wire side (lib/io/provider.js).
 *
 * Folders (`env.folders`): the folders that matter to a session, each
 * a typed {kind, title, path} — the project folder (cwd), the harness
 * (package) folder, the user settings folder, the tool roots. The TUI
 * lists them when a fresh session starts.
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathNames } from "./util.js";
import { sourceGraphCreate } from "./env/source-graph.js";
import { SettingsStore } from "./env/settings-store.js";
import { storeSettingsCreate } from "./env/store-settings.js";
import { settingsView } from "./env/settings-view.js";
import { globalSettingsRead, globalSettingsReady, globalSettingsFlush, globalSettingsClose } from "./env/global-settings.js";
import { configuredExtensions } from "./env/extensions.js";
import { defaultSettingsDir, defaultSettingsDirAsync, folderIdentity } from "./env/paths.js";
import { detectEndpoints } from "./env/endpoints.js";
import { login, logout, loginPresets, collectPending } from "./env/login.js";
import { models, connection, collect, modelsChanged, MODELS_CHANGED } from "./env/models.js";
import { registerProvider, loadProviders } from "./env/provider-registry.js";
import { registerTool, toolsList, loadTools, refreshTools, refreshToolAvailability, callTool, defaultToolRoots, validateInitialToolFolders } from "./env/tool-registry.js";
import { defaultsSchema } from "./env/settings-schema.js";
import { skills, prompts, defaultSkillRoots } from "./env/catalogs.js";
import { skillCatalog, promptCatalog, skillSection } from "./env/catalog-text.js";
import { skillNamesNormalize, skillActivation } from "./env/skill-activation.js";
import { extend } from "./env/extend.js";
import { mcpRegister, mcpClose, mcpLogin, mcpPaste, mcpStatus } from "./env/mcp-tools.js";
import Sandbox from "./sandbox.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const ENV_OPTION_KEYS = new Set(["dir", "settingsDir", "cwd", "settings", "sessionsDir", "providers", "toolDirs", "skillDirs", "promptDirs", "themes", "auth"]);
const INIT_OPTION_KEYS = new Set(["providers", "tools", "detect", "models"]);
const ISOLATED = Symbol("isolated Env");
const REGISTERED = Symbol("registered Env");
function optionsAreDefault(options, init) {
  const empty = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === 0;
  return Reflect.ownKeys(options).every((key) => {
    const value = options[key];
    if (key === "init" || value === undefined) return true;
    if (key === "themes" || key === "auth") return value === true;
    if (key === "settings" || key === "providers") return empty(value);
    if (key === "dir") return typeof value === "string" && folderIdentity(value) === folderIdentity(PACKAGE_DIR);
    if (key === "settingsDir") return typeof value === "string" && folderIdentity(value) === folderIdentity(defaultSettingsDir());
    return false;
  }) && [...INIT_OPTION_KEYS].every((key) => init[key] === undefined || init[key] === true);
}
function initOptionsValidate(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Env: initOptions must be an object");
  for (const key of Reflect.ownKeys(options)) if (!INIT_OPTION_KEYS.has(key)) throw new TypeError(`Env: unknown initOptions option ${String(key)}`);
}

async function envInitialize(env, { providers = true, tools = true, detect = true, models = true } = {}) {
  if (env.closed) throw new Error("Env: cannot open a closed Env");
  await (env._initialized ??= env._initialize({ providers, tools, detect }).catch((error) => {
    env._initialized = undefined;
    throw error;
  }));
  if (env.closed) throw new Error("Env: Env closed during startup");
  if (providers && models && !env._collecting) { env._collecting = true; collect(env); }
  return env;
}
/** Check only Env's top-level vocabulary; settings and provider payloads remain open. */
function envOptionsValidate(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Env: options must be an object");
  for (const key of Reflect.ownKeys(options)) if (!ENV_OPTION_KEYS.has(key)) throw new TypeError(`Env: unknown option ${String(key)}`);
}

/** The process registry: a project folder's identity (its real path) -> its one open Env, in creation order. */
const ENVS = new Map();
/** The open Env of a project folder, whatever path names it (symlinks included). */
const envOf = (cwd) => ENVS.get(folderIdentity(resolve(cwd)));

/**
 * The sole global environment object: settings, auth, providers,
 * tools, and the titled folder surface.
 */
export class Env {
  /** @returns {string} The absolute project folder used by this Env (fixed for its lifetime). */
  get folder() {
    return this._folder;
  }

  /**
   * The project name. A pinned project answers its pin record's derived
   * `settings.projects[folder].name` (the shortest suffix no other pin shares);
   * an unpinned one the shortest suffix no pinned or other open Env's folder
   * shares (conflicts resolve on the first differing parent folders:
   * `fiz/bar/foo`, `faz/bar/foo`); the root folder is `/`.
   * @returns {string}
   */
  get name() {
    const pins = this.constructor.settings.projects;
    if (typeof pins[this._folder]?.name === "string") return pins[this._folder].name;
    const paths = [...new Set([...Object.keys(pins), ...[...ENVS.values()].map((env) => env._folder), this._folder])];
    return pathNames(paths).get(this._folder).join("/");
  }

  /**
   * The Env event vocabulary: Symbol constants for onEvent/offEvent.
   * Env events report what EXISTS in this environment: the native
   * MODELS_CHANGED (models() answers differently — re-read it) and the
   * membership events plugins install (Agent's AGENT_ADDED/AGENT_REMOVED);
   * what an object does is that object's own events.
   * SETTINGS_CHANGED announces changed settings values (once per storage or
   * poll round). SETTINGS_LOADED announces a finished poll round that read
   * files, including equal versions. Reads never emit either.
   */
  static EVENT = { MODELS_CHANGED, SETTINGS_CHANGED: Symbol("settings-updated"), SETTINGS_LOADED: Symbol("settings-loaded") };

  /**
   * The settings aggregator Env builds its settings from (lib/env/settings-store.js):
   * an ordered list of file, folder/glob and memory sources, last wins, with an
   * optional parent store; immediate reads and writes, grouped asynchronous
   * `loaded`/`saved`/`updated` notices. Usable on its own for any JSON settings.
   * Read the [SettingsStore contract and standalone examples](/api/contracts/#settings%20store)
   * for constructor/source specs, precedence, node handles, methods and errors.
   */
  static SettingsStore = SettingsStore;

  /**
   * Live process-global settings from package, extensions and user sources only.
   * `settings.projects` contains pinned records keyed by absolute folder. Each
   * record reads with derived `name` (shortest unique folder suffix) and `folder`;
   * neither derived field nor any name alias is persisted. Pins can be edited
   * here or through an instance's reachable-project settings view. Unlike
   * instance writes, a global write of a new folder pin does not add groups.
   * No project Env is opened or registered. Reads may be partial before static
   * ready(); writes follow the same authorization/defaults/persistence rules as
   * instance settings. Nested views are stable; arrays are detached snapshots.
   * The process owns this facade until static close(); existing project Envs
   * retain their shared sources independently. Configure the settings directory
   * through the namespace environment variable before first access.
   * @returns {Object} Global live settings, including defaults and unknown keys.
   */
  static get settings() { return globalSettingsRead(PACKAGE_DIR); }

  /**
   * Await complete initial global settings discovery, without starting providers,
   * models, tools or a project Env. Safe before or after loading; use this barrier
   * rather than waiting for a possibly already-fired SETTINGS_LOADED event.
   * @returns {Promise<Object>} The same live view as static Env.settings.
   * @throws {Error} Startup/discovery failure; repair sources, await static close(), and retry.
   */
  static ready() { return globalSettingsReady(PACKAGE_DIR); }

  /**
   * Persist pending global settings edits; reads/writes are already immediate.
   * @returns {Promise<void>} Resolves after persistence; rejects on write failure (retry safe).
   */
  static settingsFlush() { return globalSettingsFlush(PACKAGE_DIR); }

  /**
   * Release only the static global settings facade, awaiting pending I/O. Does
   * not close registered project Envs. Repeated/concurrent calls are idempotent;
   * the next static settings/ready access after completion acquires fresh state.
   * @returns {Promise<void>} Resolves after release or rejects on persistence failure.
   */
  static close() { return globalSettingsClose(); }

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
   * The registered project Envs by project folder — at most one per canonical
   * folder. Non-default embedding Envs from Env.open(path, options) never enter
   * this registry. close() deregisters project Envs. A frozen snapshot per read.
   * @returns {Readonly<Object<string, Env>>} absolute folder -> Env
   */
  static get envs() {
    return Object.freeze(Object.assign(Object.create(null), Object.fromEntries([...ENVS.values()].map((env) => [env._folder, env]))));
  }

  /**
   * Acquire a fully initialized Env for a project folder. With no options, concurrent
   * callers share the canonical folder's registered Env; each caller owns a close()
   * obligation. Options that retain constructor/startup defaults (including {})
   * also reuse the canonical Env. Meaningful overrides create an isolated Env,
   * never registered or returned by a path-only lookup. `path` is
   * authoritative; options.cwd is not accepted. `options.init` controls startup
   * (providers/tools/detect/models default true); models collection begins in the
   * background and modelsReady awaits its first pass. Explicit options.settings
   * overlay persisted configuration in a per-Env memory node: writes to owned
   * override keys remain ephemeral; writes to other keys follow normal settings
   * ownership and may persist. Inputs are not mutated; constructor settings are
   * copied into the store, while provider/root references follow constructor rules.
   * @param {string} path Project folder, relative or absolute; aliases share filesystem identity.
   * @param {object} [options] Constructor options other than cwd, plus optional init settings.
   * @returns {Promise<Env>} Ready Env; caller must await close() when finished.
   * @throws {TypeError|Error} Invalid path/options or startup failure. Failed new Envs
   *   close before rejection; after fixing input or disk state, retry is safe.
   */
  static async open(path, options) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("Env.open: path must be a non-empty string");
    const cwd = resolve(path);
    if (options !== undefined) {
      if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Env.open: options must be an object");
      for (const key of Reflect.ownKeys(options)) {
        if (key === "cwd" || (key !== "init" && !ENV_OPTION_KEYS.has(key))) throw new TypeError(`Env.open: unknown option ${String(key)}`);
      }
      const { init = {}, ...constructorOptions } = options;
      initOptionsValidate(init);
      if (!optionsAreDefault(options, init)) {
        const env = new Env({ ...constructorOptions, cwd }, ISOLATED);
        try { return await envInitialize(env, init); }
        catch (error) { try { await env.close(); } catch { /* retain startup failure */ } throw error; }
      }
    }
    const existing = envOf(cwd);
    const env = existing ?? new Env({ cwd }, REGISTERED);
    try { return await envInitialize(env); }
    catch (error) { if (!existing) { try { await env.close(); } catch { /* retain startup failure */ } } throw error; }
  }

  /**
   * Internal construction; public consumers acquire a ready Env with Env.open(path, options).
   * Build the environment: assemble layered source nodes (the
   * package folder, user settings folder, and namespaced project
   * files — see lib/env/source-graph.js), seed the titled folder surface,
   * register the built-in tools. Providers and tools load afterwards
   * (loadProviders/loadTools).
   * @param {Object} [options]
   * @param {string} [options.dir] - package folder to scan (default: this package's root)
   * @param {string|null} [options.settingsDir] - the USER SETTINGS
   *   folder (default: the namespace setting or namespace home folder,
   *   created when missing) — scanned after the package folder and the target
   *   of every dynamic settings write; null disables the layer
   *   (embedded/test hosts)
   * @param {string} [options.cwd] - the PROJECT folder (default: process.cwd()); constructor-internal, not the Env.folder property —
   *   separate from `dir` so a test (or an embedding host) can isolate
   *   both independently; consumed by the folder surface below and by
   *   the system prompt's project-local AGENTS.md layer (env.systemPrompt())
   * @param {Object} [options.settings] - explicit settings, merged LAST (override)
   * @param {string} [options.sessionsDir] - ephemeral session log folder for this Env only; relative to cwd, overrides configured sessions without writing settings. Must be a non-empty path.
   * @param {Object<string, Function>} [options.providers] - extra provider
   *   classes by name (embedders, tests); they take precedence over a
   *   scanned class of the same name
   * @param {string[]} [options.toolDirs] - the tool roots initialization scans
   *   instead of the default ones (embedders, tests)
   * @param {string[]} [options.skillDirs] - the skill roots read instead
   *   of the accumulated default layers (embedders, tests)
   * @param {string[]} [options.promptDirs] - the prompt roots, likewise
   * @param {boolean} [options.themes=true] - load theme files under settings.themes from package, extension, user, and project roots; false opts out
   * @param {boolean} [options.auth=true] - retain credentials from settings layers; false strips all nested auth fields for reduced tool-worker environments (not filesystem read confinement)
   * @throws {TypeError} Invalid options container or unknown own top-level keys (including symbols) before registration or settings work; settings/provider payload keys remain open.
   */
  constructor(options = {}, acquisition) {
    if (acquisition !== REGISTERED && acquisition !== ISOLATED) throw new TypeError("Env: use await Env.open(path, options)");
    envOptionsValidate(options);
    const { dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings, sessionsDir, providers, toolDirs, skillDirs, promptDirs, themes = true, auth = true } = options;
    if (sessionsDir !== undefined && (typeof sessionsDir !== "string" || sessionsDir.trim() === "")) {
      throw new TypeError("Env: sessionsDir must be a non-empty path");
    }
    validateInitialToolFolders(settings);
    this._folder = resolve(cwd);
    this._folderKey = folderIdentity(this._folder);
    this._registered = acquisition !== ISOLATED;
    if (this._registered && ENVS.has(this._folderKey)) throw new Error(`Env: ${this._folder} already has an open Env (Env.envs; Env.open returns it)`);
    try {
    this._sessionsDirOverride = sessionsDir;
    this._dir = dir;
    this._settingsDir = settingsDir === undefined ? defaultSettingsDir() : settingsDir;
    this._authEnabled = auth === true; // reduced worker environments must not load MCP auth files either
    // Directory creation and extension discovery run at the async startup barrier.
    this._endpointScopes = new Map();
    this._dynamicEndpoints = new Set(); // environment-detected, never persisted
    const settingsDirReady = settingsDir === undefined ? defaultSettingsDirAsync() : Promise.resolve(settingsDir);
    const extensionRootsReady = (async () => configuredExtensions({ dir, settingsDir: await settingsDirReady, settings }))();
    this._extensionRoots = [];
    this._sourceGraph = sourceGraphCreate({ dir, extensionRoots: extensionRootsReady,
      cwd: this._folder, settingsDir: this._settingsDir,
      settings: settings ?? {},
      themes: themes === true, auth: this._authEnabled });
    this._settingsAccess = storeSettingsCreate(this, this._sourceGraph.store, this._sourceGraph);
    // Session resolution follows the source that currently owns the value;
    // graph scope is queried on each read so file reloads remain live.
    Object.defineProperty(this, "_sessionsBase", {
      configurable: true,
      get: () => (this._closedSessionsScope ?? this._sourceGraph.sessionsScope()) === "local" ? this._folder : undefined,
    });

    // Registry surfaces — protocols are basename-keyed classes.
    this._providers = Object.create(null);
    this._providerOverrides = new Set(Object.keys(providers ?? {}));
    for (const [name, Protocol] of Object.entries(providers ?? {})) registerProvider(this, name, Protocol);
    this._defaultProvidersPromise = null; // shared lazy default-provider load
    this._tools = new Map(); // flattened name -> { fn, schema, builtin?, file?, safe?, onTimeout? }
    this._toolRoots = null; // resolved by loadTools(); default on demand
    this._toolDirs = toolDirs; // the caller's tool roots
    this._skillDirs = skillDirs; // the caller's skill/prompt roots (override)
    this._promptDirs = promptDirs;
    this._eventCallbacks = new Map();
    this._eventHandle = 0;
    // The store groups its notices: one `updated` per storage or poll round,
    // one `loaded` per poll round that read files (value-equal versions included).
    this._settingsSubscription = this._sourceGraph.store.on("updated", () => {
      if (this.closed) return;
      modelsChanged(this);
      this._emitEvent(Env.EVENT.SETTINGS_CHANGED, {});
    });
    this._settingsLoadSubscription = this._sourceGraph.store.on("loaded", () => {
      if (!this.closed) this._emitEvent(Env.EVENT.SETTINGS_LOADED, {});
    });
    this._readyPromise = null;
    this._closePromise = null;
    this._readyOptions = { settingsDirReady, extensionRootsReady };

    // Built-in tools are always registered and survive refreshTools()
    // rebuilds. Availability selection still decides whether a model
    // sees them.
    this._registerBuiltin("tool-refresh", async () => {
      const names = await refreshTools(this);
      await this._hooksRefresh?.();
      return { refreshed: true, tools: names };
    }, {
      description:
        "Reload available tools after adding, editing, or removing a tool. " +
        "Changes apply from the next request.",
      inputSchema: { type: "object", properties: {} },
    });
    // MCP servers (settings.mcp): the `mcp` tool and its per-server
    // shortcuts over this Env's client pool (lib/env/mcp-tools.js)
    mcpRegister(this);
    if (this._registered) ENVS.set(this._folderKey, this); // isolated embeddings never enter path lookup
    // Kick off disk discovery for synchronous users (e.g. TUI subscribers).
    // A caller requiring initialized sources awaits ready() for errors.
    void this.ready().catch(() => {});
    } catch (error) {
      this._settingsSubscription?.();
      this._settingsLoadSubscription?.();
      this._settingsAccess?.close();
      void this._sourceGraph?.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Complete asynchronous folder discovery and graph startup once. The constructor
   * exposes cached, possibly incomplete settings immediately; await this for
   * complete startup settings. SETTINGS_CHANGED announces changed values;
   * SETTINGS_LOADED announces completed discovery/reload batches after all
   * detected files and their effective settings views finish loading.
   * @returns {Promise<Env>} This environment after its source graph is ready.
   */
  async ready() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = (async () => {
      const { settingsDirReady, extensionRootsReady } = this._readyOptions;
      this._settingsDir = await settingsDirReady;
      if (this._settingsDir !== null) await mkdir(this._settingsDir, { recursive: true });
      await this._sourceGraph.ready();
      this._extensionRoots = await extensionRootsReady;
      modelsChanged(this);
      return this;
    })();
    return this._readyPromise;
  }

  /**
   * Start explicit browser OAuth for a configured HTTP MCP server; never invoked by a tool call.
   * @param {string} name Configured MCP server name.
   * @param {{onAuthUrl?: Function, onLog?: Function, signal?: AbortSignal, open?: Function}} [options] Progress callbacks and cancellation.
   * @returns {Promise<{name: string}>} Signed-in server identity; rejects on discovery, registration, callback or token error.
   */
  mcpLogin(name, options) { return mcpLogin(this, name, options); }
  /**
   * Supply a complete loopback redirect URL to a pending MCP OAuth flow.
   * @param {string} input Complete callback URL with code, state and optional issuer.
   * @returns {boolean} Whether a sign-in flow accepted the callback input.
   */
  mcpPaste(input) { return mcpPaste(this, input); }
  /**
   * List configured MCP server connection and sign-in states; exposes no credentials.
   * @returns {Array<{name: string, state: string}>} Live per-server state.
   */
  mcpStatus() { return mcpStatus(this); }

  /**
   * Release what this Env runs in the background: pending model-list
   * retries stop, every MCP server it started is killed, and its settings
   * subscription and source graph close. Idempotent; rejects after cleanup if an owned release fails. A closed Env
   * leaves Env.envs (env.closed) but stays readable; it does not start
   * new MCP connections or create new agents.
   * @returns {Promise<void>} Resolves after owned teardown and pending settings persistence; concurrent/repeated calls await the same outcome.
   * @throws {Error|AggregateError} One or more release failures, after all releases have been attempted.
   */
  async close() {
    if (this._closePromise) return this._closePromise;
    if (this._registered && ENVS.get(this._folderKey) === this) ENVS.delete(this._folderKey);
    const subscription = this._settingsSubscription;
    const loadSubscription = this._settingsLoadSubscription;
    this._settingsSubscription = null;
    this._settingsLoadSubscription = null;
    this._closePromise = (async () => {
      const releases = [
        () => subscription?.(), () => loadSubscription?.(),
        () => { for (const ticket of this._modelRetries?.values() ?? []) clearTimeout(ticket.timer); this._modelRetries?.clear(); },
        () => this._settingsAccess?.close(),
        () => { if (this._sourceGraph && this._closedSessionsScope === undefined) this._closedSessionsScope = this._sourceGraph.sessionsScope(); },
        () => mcpClose(this), () => this._sourceGraph?.close(), () => this._modelsReady,
      ];
      const results = await Promise.allSettled(releases.map(async (release) => release()));
      let agents;
      try { agents = await Promise.allSettled((this.agents?.() ?? []).map(async (agent) => Sandbox.backgroundStopAll(agent))); }
      catch (error) { agents = [{ status: "rejected", reason: error }]; }
      const errors = [...results, ...agents].filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Env failed to close");
    })();
    return this._closePromise;
  }

  /** @returns {boolean} whether close() has run (the Env left Env.envs). */
  get closed() {
    return this._registered ? ENVS.get(this._folderKey) !== this : this._closePromise !== null;
  }

  /**
   * The LIVE settings view (lib/env/settings-view.js): reads apply the
   * defaults schema and derived values (`settings.sessions` is the
   * resolved sessions folder); assigning or deleting a key persists
   * only that change to the writable owner in memory immediately; file-backed
   * updates coalesce and persist asynchronously. Await settingsFlush() for
   * durability or write errors. Nested objects are path-stable live views;
   * arrays are detached snapshots: replace the whole array to persist and emit events;
   * in-place edits of a returned array do not change the Env.
   * `settings.projects` reads as a live view of reachable project records,
   * keyed by absolute folder and by name aliases pointing to the SAME records.
   * It includes this Env's own folder even when unpinned, plus pinned projects
   * sharing a group. `projects.this` aliases this Env's own folder record.
   * Writes through folder keys or name aliases edit global pins, including new
   * folder pins; the reachable filter restricts reads, not writes. Assigning
   * `settings.projects[folder]` for a new pin inherits every true group from
   * this Env's own current global pin, making the new entry reachable. Global
   * `Env.settings.projects` writes do not auto-add groups. Each returned record
   * has derived `name` and `folder`; aliases and derived fields are never
   * persisted. `Env.settings.projects` also permits global pin edits.
   * @returns {Object}
   */
  get settings() {
    return settingsView(this);
  }

  /**
   * Wait for queued settings writes in this Env's shared and project file nodes.
   * Assignments update the live view immediately; this explicit barrier makes
   * their latest values durable or rejects on a file write error.
   * @returns {Promise<void>} Settles after outstanding writes complete.
   */
  settingsFlush() {
    return this._sourceGraph.flush();
  }

  /**
   * The folders that matter to a session, computed from current state
   * (the project folder follows `folder`): exactly one `project` and one
   * `harness` (the package folder in use), the user `settings` folder
   * unless disabled, then each tool root.
   * @returns {ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>}
   */
  get folders() {
    const tools = [...new Set(this._toolRoots ?? defaultToolRoots(this))];
    return Object.freeze([
      { kind: "project", title: "project folder", path: this.folder },
      { kind: "harness", title: "harness folder", path: this._dir },
      ...(this._settingsDir === null ? [] : [{ kind: "settings", title: "settings folder", path: this._settingsDir }]),
      ...tools.map((path) => ({ kind: "tools", title: "tool folder", path })),
    ].map((folder) => Object.freeze(folder)));
  }

  /**
   * Subscribe to an Env Symbol event. Env reports settings/model changes
   * and plugin membership changes; Agent reports its own request/tool events.
   * Membership plugins add Env.EVENT constants such as AGENT_ADDED and
   * AGENT_REMOVED, whose payload is {agent}.
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

  /** Initialize owned registries for acquisition and an Agent's lazy implicit Env. @private */
  async _initialize({ providers = true, tools = true, detect = true } = {}) {
    await this.ready();
    if (providers) await this._providersLoad({ detect });
    if (tools) await loadTools(this, { dirs: this._toolDirs });
    await this._hooksRefresh?.();
  }

  /** @private Load default-exported provider classes, keyed by each file
   *  basename (Env.open; tests pass explicit roots). */
  async _providersLoad({ dirs, detect = true } = {}) {
    await this.ready();
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
    if (this._implicitInit) return this._implicitInit().then(async () => {
      if (!this._modelsReady) collect(this);
      collectPending(this);
      await this._modelsReady;
    });
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
   * @param {{provider: string, url: string, token?: string, auth?: object, oauth?: object}} config
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
   * `directories` lists the skill's resource folders in layer order (later
   * layers override earlier ones); tools must not show them to models.
   * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string, directories: string[]}>}
   */
  skills() {
    return skills(this);
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
   * Validate named skills and return their instruction payload without injecting it.
   * @param {string|string[]} [names] Names to load; omitted lists the catalog.
   * @param {{active?: Set<string>}} [options={}] Names already active in the caller's Context; neither retained nor mutated.
   * @returns {string|{result: string, system: string[]}} Detached catalog text or a complete activation payload.
   * @throws {TypeError|Error} Invalid names or unknown skills; correct the complete request before retrying. No partial payload is returned.
   * @effects Reads the current skill catalog; performs no context or file mutation.
   */
  skillLoad(names, { active = new Set() } = {}) {
    return skillActivation(this, skillNamesNormalize(names), active);
  }

  /**
   * Format this environment's current skill catalog as Markdown.
   * @param {{debug?: boolean}} [options={}] Include source roots when debug is true.
   * @returns {string} Detached catalog text; reads entries without retaining or mutating them.
   * @effects Reads skill files; repeated calls reflect current catalog contents.
   */
  skillCatalog(options = {}) {
    return skillCatalog(this.skills(), options);
  }

  /**
   * Format this environment's current prompt catalog as Markdown.
   * @param {{debug?: boolean}} [options={}] Include source roots when debug is true.
   * @returns {string} Detached catalog text; reads entries without retaining or mutating them.
   * @effects Reads prompt files; repeated calls reflect current catalog contents.
   */
  promptCatalog(options = {}) {
    return promptCatalog(this.prompts(), options);
  }

  /**
   * Format a skill entry for injection into a Context.
   * @param {{name: string, body: string}} skill Entry returned by skills().
   * @returns {string} Detached skill section; input is neither mutated nor retained.
   * @throws {TypeError} If the entry lacks a string name; pass a catalog entry before retrying.
   * @effects None; repeated calls with the same entry return the same text.
   */
  skillSection(skill) {
    return skillSection(skill);
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
    await this._implicitInit?.();
    await refreshToolAvailability(this);
    return toolsList(this, safe, selector);
  }

  /**
   * Invoke one tool (lib/env/tool-registry.js). The context is handed to
   * the tool as its second argument; Env reads: `safe` (refuse a tool
   * that is not read-only), `selector` + `io` (the pair's provider tool
   * serves first; undefined falls through to the global tool), `signal`
   * and `deadline`, and adds `statusSet(info)` — the tool's own live
   * status. When context.agent is supplied, the optional Agent plugin's
   * private _toolContextCreate hook supplies missing tool capabilities.
   * Missing names are ordinary errors, never a crash.
   * @param {string} name
   * @param {object} args
   * @param {object} [context]
   * @returns {Promise<*>} the tool's return value
   */
  async toolCall(name, args, context) {
    await this._implicitInit?.();
    const dispatchContext = context?.agent && this._toolContextCreate
      ? await this._toolContextCreate(name, context)
      : context;
    return callTool(this, name, args, dispatchContext);
  }
}

export default Env;
