/**
 * lib/env/settings-schema.js — the DEFAULTS SCHEMA (private to Env):
 * every top-level settings key Env understands — its `default` (the
 * settings view's read fallback), a one-line `description` (DISCOVERY:
 * `ai init`, API.md), optional `layers` (the settings layers allowed to
 * set it: "package", "user", "project"; absent = all), and optional
 * `derive(env, value)` (the view answers the derived value instead of
 * the raw one). Never enforcement of unknown keys: settings.js merges
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
  tools: { default: TOOL_SETTINGS_DEFAULTS, description: "Tool policy: folders (extra roots, array; package/user settings only), timeout (default 120s), timeoutLimit (default 20m), concurrency (read-only dispatch group size, default 3). Durations accept milliseconds or unit strings. Project files may set policy but never folders." },
  providerPaths: { default: undefined, layers: TRUSTED, description: "Extra provider-class roots (string or array) — package/settings scope only." },
  extensions: { default: [], layers: TRUSTED, description: "Installed npm package names to load as Omoya content roots (JSON settings, providers, tools, skills, prompts, themes). Package/user scope only; project settings cannot add extensions." },
  providers: { default: {}, description: "Manually configured endpoints (name -> {provider, url, model?, timeout?, maxActive?, secret?, filter?, ...}; `filter` is a regex source: non-matching models publish as secret)." },
  mcp: {
    default: {},
    layers: TRUSTED, // a server command spawns an unsandboxed host process
    description: "MCP servers (name -> {command, args?, env?, timeout?, safe?, description?}) published as the `mcp` tool and `mcp-<name>` shortcuts — package/settings scope only, never the project folder.",
  },
  skills: { default: undefined, description: "Extra skill roots (string or array)." },
  prompts: { default: undefined, description: "Extra prompt roots (string or array)." },
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
      if (env._sessionsDirOverride !== undefined) return resolve(env.cwd, env._sessionsDirOverride);
      return typeof value === "string" && value !== "" ? resolve(env._sessionsBase ?? base, value) : join(base, NAMES.sessionsDir);
    },
    description: "Session log folder (default: <settings folder>/sessions). Relative paths in project settings resolve against the project; package/user settings paths resolve against the settings folder. Reads answer the resolved folder; host Env sessionsDir overrides without persistence.",
  },
  providerTools: { default: {}, description: "Provider built-in tools by name (e.g. web-search): false opts a tool out (its same-named package tool serves instead); also per endpoint <endpoint>.tools.<name> and per model <endpoint>.models.<model>.tools.<name> (first explicit boolean wins, model first)." },
  "env-allow": { default: undefined, description: "Child-process env allowlist for sandboxed tools/MCP servers — keep ONLY these names." },
  "env-refuse": { default: undefined, description: "Child-process env blocklist for sandboxed tools/MCP servers — drop these names." },
  tui: {
    default: {
      cursor: { blink: 450, shape: "line" },
      alt: true,
      keys: {},
      mouse: undefined,
      osc52: true,
      scroll: { show: true, track: "│", thumb: "█" },
      theme: "default",
      themes: {},
    },
    description: 'Terminal UI settings: cursor {blink, shape}, alt-screen flag (default true; false selects inline when --screen is omitted), key overrides, mouse flag (true managed, false off, unset mode default), OSC 52 clipboard, scrollbar, and theme selection (tui.theme overrides global theme) plus named themes.',
  },
  web: {
    default: {
      autocomplete: true,
      collapse: { thinking: true, tools: true },
      theme: "system",
      limit: WEB_LIMIT_DEFAULTS,
      throttle: WEB_THROTTLE_DEFAULTS,
    },
    description: 'Web UI and tools: autocomplete, collapse, theme (web.theme overrides global theme, independent of tui.theme); shared limit {calls, windowMs} counts network attempts; throttle {startAt, step, stepMs} starts at 20% occupancy with 1s, adding 1s per 5%; each success pause is capped at half the remaining tool deadline (tools.timeout default 120s, capped by tools.timeoutLimit). Parallel delays overlap. Full-window entry waits only below half the remaining deadline, else returns busy. Collapsed-preview heights come from the TUI theme (<role>.preview.maxRows).',
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
