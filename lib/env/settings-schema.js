/**
 * lib/env/settings-schema.js — the DEFAULTS SCHEMA (private to Env):
 * every top-level settings key Env understands, its default and a
 * one-line description — for DISCOVERY (`ai init`, API.md), never
 * enforcement: an unknown key is never rejected, settings.js merges
 * whatever a JSON file holds regardless.
 *
 * CORE_SETTINGS_SCHEMA seeds the keys owned by Env itself (this
 * folder's siblings — tool-timeout.js, context-guard.js,
 * the tui engines). A TOOL module may contribute its own entries
 * through an optional `settingsSchema()` export (see the tools.js
 * module contract) — `mcp` is one (tools/mcp.js owns that key, not
 * Env). The merged schema (env.defaultsSchema()) always reflects
 * exactly what's loaded right now: a tool that stops publishing drops
 * its keys on the next refresh, same as its own tool schema would.
 */

export const CORE_SETTINGS_SCHEMA = Object.freeze({
  tools: { default: undefined, description: "Extra tool-folder roots (string or array) — package/settings scope only." },
  providerPaths: { default: undefined, description: "Extra provider-class roots (string or array) — package/settings scope only." },
  providers: { default: {}, description: "Manually configured endpoints (name -> {provider, url, model?, timeout?, maxActive?, secret?, ...})." },
  skills: { default: undefined, description: "Extra skill roots (string or array)." },
  prompts: { default: undefined, description: "Extra prompt roots (string or array)." },
  toolTimeout: { default: 120_000, description: "Default per-tool-call timeout, in ms (a tool's own schema `timeout` overrides it)." },
  toolTimeoutLimit: { default: 20 * 60_000, description: "The hard cap a tool's own `timeout` may not exceed, in ms." },
  contextGuardCap: { default: 0.9, description: "Fraction of the context window that trips the runaway guard and ends the turn." },
  contextGuardTurnCap: { default: 0.4, description: "Fraction of the context window a SINGLE turn may consume before the guard trips." },
  maxActive: { default: 4, description: "Global concurrent-IO cap." },
  maxAttempts: { default: 3, description: "Provider-request attempts per turn: the first write plus retries of retryable failures (network/provider/auth)." },
  retryBase: { default: 2000, description: "The first request-retry delay in ms; each next attempt waits twice as long." },
  retryMax: { default: 30_000, description: "The request-retry delay ceiling in ms." },
  modelAccess: { default: "all", description: 'Model-list exposure policy: "local", "remote", or "all".' },
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
    description: 'Terminal UI settings: cursor {blink, shape}, alt-screen flag, key overrides, mouse flag (true managed, false off, unset mode default), OSC 52 clipboard, scrollbar, and named themes.',
  },
  web: {
    default: {
      autocomplete: true,
      collapse: { thinking: true, tools: true },
      toolLines: 6,
      theme: "system",
    },
    description: 'Web UI settings: slash autocomplete, default collapse of thinking/tool blocks, tool-output line cap, and theme ("system"|"light"|"dark").',
  },
});

/**
 * The merged defaults schema: CORE_SETTINGS_SCHEMA plus every loaded
 * tool's own contributed entries (env._toolSettingsSchema, rebuilt on
 * every tool scan/refresh — see lib/env/tool-registry.js).
 * @param {object} env
 * @returns {Object} key -> {default, description}
 */
export function defaultsSchema(env) {
  return { ...CORE_SETTINGS_SCHEMA, ...(env._toolSettingsSchema ?? {}) };
}
