/**
 * lib/env/settings-schema.js — the DEFAULTS SCHEMA (private to Env):
 * every top-level settings key Env understands — its `default` (the
 * settings view's read fallback), a one-line `description` (DISCOVERY:
 * `ai init`, API.md), optional `layers` (the settings layers allowed to
 * set it: "package", "user", "project"; absent = all), and optional
 * `derive(env, value)` (the view answers the derived value instead of
 * the raw one), and optional `file` (the user settings folder file every
 * write of the key persists to). Never enforcement of unknown keys: settings.js merges
 * whatever a JSON file holds regardless.
 *
 * CORE_SETTINGS_SCHEMA seeds the keys owned by Env itself. An Env
 * PLUGIN (Env.extend) contributes the keys its layer owns — Agent's
 * context guard, retry policy, and maxActive. Shared tools policy lives
 * in the core schema; Agent owns execution, Env owns folder discovery.
 * A TOOL module may contribute its own entries
 * through an optional `settingsSchema()` export (see the tools.js
 * module contract). The merged schema (env.settingsSchema()) always reflects
 * exactly what's loaded right now: a tool that stops publishing drops
 * its keys on the next refresh, same as its own tool schema would.
 */

import { join, resolve } from "node:path";
import { NAMES } from "../namespace.js";
import { TOOL_SETTINGS_DEFAULTS, WEB_LIMIT_DEFAULTS, WEB_THROTTLE_DEFAULTS } from "../tool-runtime.js";
import { defaultSettingsDir } from "./paths.js";

/** Settings only the trusted package/user layers may set (never the agent-writable project). */
const TRUSTED = Object.freeze(["package", "user"]);

export const CORE_SETTINGS_SCHEMA = Object.freeze({
  tools: { default: TOOL_SETTINGS_DEFAULTS, description: "Tool policy: folders (extra roots as path -> true/false; package/user only), timeout (default 120s), timeoutLimit (default 20m), concurrency (read-only dispatch group size, default 3). Durations accept milliseconds or unit strings. Project files may set policy but never folders." },
  extensions: { default: {}, layers: TRUSTED, description: "Installed npm package names or existing folder paths (name/path -> true/false) to load as Omoya content roots (JSON settings, providers, tools, skills, prompts, themes). Package/user scope only; project settings cannot add extensions." },
  providers: { default: {}, description: "Manually configured endpoints (name -> {provider, url, model?, timeout?, maxActive?, disabled?, secret?, filter?, ...}; `disabled: true` hides and refuses the endpoint; `filter` is a regex source: non-matching models publish as secret). `providers.tools.<tool>` controls the global default for provider-hosted tools (false lets a same-named package tool serve instead); model and endpoint tool settings override it." },
  mcp: {
    default: {},
    layers: TRUSTED, // a server command spawns an unsandboxed host process
    description: "MCP servers (name -> either {command, args?, env?} or {url, headers?}, plus timeout?, safe?, description?). HTTP requires https or loopback http; optional oauth {clientId?, issuer?} triggers explicit user sign-in with separate user-only token files. Header ${VAR} references use the settings-filtered child environment. Published as `mcp` and `mcp-<name>` — package/settings scope only.",
  },
  projects: {
    default: {},
    layers: TRUSTED, // a project must never pin (serve) other folders
    file: "projects.json",
    description: "Env.settings.projects: global pin records keyed by absolute folder (folder -> {models: {<endpoint>/<model>: ISO timestamp}, description?: string, groups?: {<group>: true}}), kept in the user settings folder's projects.json. A pinned project's newest available model is selected before global last-model memory. Pin reads add derived `name` (shortest unique folder suffix) and `folder`; neither derived field nor any alias persists. Instance env.settings.projects reads reachable records (own folder even when unpinned, plus pins sharing a group) keyed by absolute folder and name aliases pointing to the same records; `this` aliases the own folder record. Both views permit global pin writes through folder keys or name aliases; instance writes may create new folder pins despite its filtered reads. Assigning a new folder pin through env.settings.projects[folder] inherits every true group from that Env's own current global pin, making the new entry reachable; Env.settings.projects writes do not auto-add groups.",
  },
  skills: { default: {}, description: "Extra skill roots (path -> true/false)." },
  prompts: { default: {}, description: "Extra prompt roots (path -> true/false)." },
  sessions: {
    default: undefined,
    // reads answer the resolved absolute folder (created on the first write)
    /**
     * Resolve the session-folder setting for the settings view.
     * @param {object} env - Required environment (no default); uses the project root for project settings/host overrides and settings root otherwise.
     * @param {*} value - Required raw setting value (no default); a non-empty string resolves against its layer root, otherwise the standard sessions folder is used.
     * @returns {string} Absolute session-folder path.
     * @throws {TypeError} If `env` is null or undefined.
     */
    derive: (env, value) => {
      const base = env._settingsDir ?? defaultSettingsDir();
      if (env._sessionsDirOverride !== undefined) return resolve(env.folder, env._sessionsDirOverride);
      return typeof value === "string" && value !== "" ? resolve(env._sessionsBase ?? base, value) : join(base, NAMES.sessionsDir);
    },
    description: "Session log folder (default: <settings folder>/sessions). Relative paths in project settings resolve against the project; package/user settings paths resolve against the settings folder. Reads answer the resolved folder; host Env sessionsDir overrides without persistence.",
  },
  env: { default: {}, description: "Child-process environment (name -> value): inherited KEY/TOKEN/AUTH/OAUTH/PASSWORD/PASS/SECRET names are omitted by default; false removes, true explicitly passes the inherited value, and a non-nullish value sets it. Explicit tool/MCP additions merge last and require caller authorization." },
  theme: { default: undefined, description: "Shared theme selection for TUI and web. Both interfaces inherit it unless a legacy tui.theme or web.theme override is set; selecting a theme in either interface updates this shared value." },
  themes: { default: {}, description: "Named themes (name -> role tokens), shared by the TUI and web. themes/*.json files in the package, extension and user folders and the project's ai-themes/ folder each hold { <name>: {...} } and load here, never at the settings root." },
  tui: {
    default: {
      cursor: { blink: 450, shape: "line" },
      alt: true,
      keys: {},
      mouse: undefined,
      osc52: true,
      scroll: { show: true, track: "│", thumb: "█" },
      theme: "default",
    },
    description: 'Terminal UI settings: cursor {blink, shape}, alt-screen flag (default true; false selects inline when --screen is omitted), key overrides, mouse flag (true managed, false off, unset mode default), OSC 52 clipboard, scrollbar, and legacy theme override (tui.theme overrides shared theme until the next UI selection).',
  },
  web: {
    default: {
      autocomplete: true,
      collapse: { thinking: true, tools: true },
      theme: "system",
      limit: WEB_LIMIT_DEFAULTS,
      throttle: WEB_THROTTLE_DEFAULTS,
    },
    description: 'Web UI and tools: autocomplete, collapse, legacy theme override (web.theme overrides shared theme until the next UI selection); shared limit {calls, windowMs} counts network attempts; throttle {startAt, step, stepMs} starts at 20% occupancy with 1s, adding 1s per 5%; each success pause is capped at half the remaining tool deadline (tools.timeout default 120s, capped by tools.timeoutLimit). Parallel delays overlap. Full-window entry waits only below half the remaining deadline, else returns busy. Collapsed-preview heights come from the TUI theme (<role>.preview.maxRows).',
  },
});

/** Settings entries contributed by Env plugins (settingsSchemaAdd). */
const PLUGIN_SETTINGS_SCHEMA = {};
/** The merged schema per tool-schema object (rebuilt when either side changes). */
let merged = new WeakMap();
const NO_TOOLS = {};

/**
 * Add settings entries contributed by an Env plugin.
 * @param {Object<string, {default: *, description: string}>} entries - Required mapping of setting keys to schema entries (no default).
 * @returns {undefined} No value is returned.
 * @throws {TypeError} If `entries` is null or undefined, or any key already exists in the core schema or was added by a previous plugin.
 * @effects Adds the entries to the shared plugin schema and invalidates the merged-schema cache.
 */
export function settingsSchemaAdd(entries) {
  for (const key of Object.keys(entries)) {
    if (Object.hasOwn(CORE_SETTINGS_SCHEMA, key) || Object.hasOwn(PLUGIN_SETTINGS_SCHEMA, key)) {
      throw new TypeError(`Env.extend: setting "${key}" already exists`);
    }
  }
  Object.assign(PLUGIN_SETTINGS_SCHEMA, entries);
  merged = new WeakMap();
}

/**
 * Return the merged defaults schema for core settings, Env plugins, and loaded tools.
 * Tool-contributed entries are read from `env._toolSettingsSchema`; the result is rebuilt when that schema object changes.
 * @param {object} env - Required environment whose tool-contributed settings schema is included (no default).
 * @returns {Object<string, Object>} Frozen mapping of setting keys to schema entries.
 * @throws {TypeError} If `env` is null or undefined.
 * @effects Caches the merged schema by tool-schema object identity; does not mutate `env` or its tool schema.
 */
export function defaultsSchema(env) {
  const tools = env._toolSettingsSchema ?? NO_TOOLS;
  let schema = merged.get(tools);
  if (!schema) merged.set(tools, schema = Object.freeze({ ...CORE_SETTINGS_SCHEMA, ...PLUGIN_SETTINGS_SCHEMA, ...tools }));
  return schema;
}

/**
 * Return core and plugin setting keys that the agent-writable project layer may not set.
 * @returns {string[]} Setting keys whose schema entry has a `layers` array that excludes `project`.
 * @effects Does not modify the schema or returned key list after creation.
 */
export function projectRefusedKeys() {
  return Object.entries({ ...CORE_SETTINGS_SCHEMA, ...PLUGIN_SETTINGS_SCHEMA })
    .filter(([, entry]) => Array.isArray(entry?.layers) && !entry.layers.includes("project"))
    .map(([key]) => key);
}
