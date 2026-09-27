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
    layers: TRUSTED,
    // reads answer the resolved absolute folder (created on the first write)
    derive: (env, value) => {
      const base = env._settingsDir ?? defaultSettingsDir();
      return typeof value === "string" && value !== "" ? resolve(base, value) : join(base, NAMES.sessionsDir);
    },
    description: "Session log folder (default: <settings folder>/sessions; relative paths resolve against the settings folder) — package/settings scope only, so an agent can never rewrite its own log. Reads answer the resolved folder.",
  },
  modelAccess: { default: "all", description: 'Model-list exposure policy: "local", "remote", or "all".' },
  providerTools: { default: {}, description: "Provider built-in tools by name (e.g. web-search): false opts a tool out (its same-named package tool serves instead); also per endpoint <endpoint>.tools.<name> and per model <endpoint>.models.<model>.tools.<name> (first explicit boolean wins, model first)." },
  "env-allow": { default: undefined, description: "Child-process env allowlist for sandboxed tools/MCP servers — keep ONLY these names." },
  "env-refuse": { default: undefined, description: "Child-process env blocklist for sandboxed tools/MCP servers — drop these names." },
  tui: {
    default: {
      cursor: { blink: 450, shape: "line" },
      alt: false,
      keys: {},
      mouse: undefined,
      osc52: true,
      scroll: { show: true, track: "│", thumb: "█" },
      theme: "default",
      themes: {},
    },
    description: 'Terminal UI settings: cursor {blink, shape}, alt-screen flag, key overrides, mouse flag (true managed, false off, unset mode default), OSC 52 clipboard, scrollbar, and theme selection (tui.theme overrides global theme) plus named themes.',
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
 * Add an Env plugin's settings entries; an existing key throws — a
 * plugin never redefines a setting it does not own.
 * @param {Object} entries - key -> {default, description}
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
 * The merged defaults schema: CORE_SETTINGS_SCHEMA, the Env plugins'
 * entries (settingsSchemaAdd), plus every loaded
 * tool's own contributed entries (env._toolSettingsSchema, rebuilt on
 * every tool scan/refresh — see lib/env/tool-registry.js).
 * @param {object} env
 * @returns {Object} key -> {default, description}
 */
export function defaultsSchema(env) {
  const tools = env._toolSettingsSchema ?? NO_TOOLS;
  let schema = merged.get(tools);
  if (!schema) merged.set(tools, schema = Object.freeze({ ...CORE_SETTINGS_SCHEMA, ...PLUGIN_SETTINGS_SCHEMA, ...tools }));
  return schema;
}

/** The setting keys the agent-writable PROJECT layer may not set (schema `layers`). */
export function projectRefusedKeys() {
  return Object.entries({ ...CORE_SETTINGS_SCHEMA, ...PLUGIN_SETTINGS_SCHEMA })
    .filter(([, entry]) => Array.isArray(entry?.layers) && !entry.layers.includes("project"))
    .map(([key]) => key);
}
