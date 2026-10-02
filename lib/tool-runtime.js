/**
 * lib/tool-runtime.js — the TOOL RUNTIME: the cross-cutting state tool
 * modules share without loading the whole library. A dependency-free
 * leaf: a forked sandbox worker that needs a tool's helper-import stamp
 * imports only this module. Its startup includes the
 * process, OS jail, settings, and one tool module.
 *
 * The refresh revision is published through globalThis so cache-busted
 * tool imports can read the current value:
 *
 *   - toolRevision(): the shared tool-registry refresh revision. The
 *     tool scan (lib/env/tools.js) bumps and publishes it before
 *     importing wrappers; a wrapper stamps its private helper imports
 *     with it (`./guard/paths.js?now=<revision>`) so a helper edit
 *     applies on refresh even when the wrapper file is unchanged.
 */

/**
 * Read the shared tool-refresh revision published by the tool scan.
 *
 * @returns {number} The current revision, or `0` when no revision has been published.
 * @throws {never} Does not throw; reads `globalThis.__AiEnvToolRevision`.
 */
export function toolRevision() {
  return globalThis.__AiEnvToolRevision ?? 0;
}

/**
 * Project ToolInfo records into the model-facing catalog shared by IO and Agent.
 * @param {Map<string, object>} catalog Available tools, already safety/provider-filtered by Env.
 * @param {string[]} [selection] Omitted or ["*"] publishes all; [] publishes none.
 * @returns {Map<string, object>} Fresh name-to-descriptor map; schemas remain shared registry data.
 */
export function publishedTools(catalog, selection) {
  const all = selection === undefined || (Array.isArray(selection) && selection.length === 1 && selection[0] === "*");
  const selected = new Set(Array.isArray(selection) ? selection : []);
  const out = new Map();
  for (const [name, info] of catalog) {
    if (!info.secret && (all || selected.has(name))) out.set(name, { ...info.schema, name });
  }
  return out;
}

/**
 * Default Agent-enforced cap for one tool call, in milliseconds (two minutes).
 * @type {number}
 */
export const DEFAULT_TOOL_TIMEOUT = 120_000;

/**
 * Maximum configurable tool-call timeout, in milliseconds (20 minutes).
 * @type {number}
 */
export const DEFAULT_TOOL_TIMEOUT_LIMIT = 20 * 60_000;

/**
 * Default maximum number of tool calls allowed concurrently.
 * @type {number}
 */
export const DEFAULT_TOOL_CONCURRENCY = 3;

/**
 * Immutable default tool settings: no folders, default timeout and timeout limit,
 * and default concurrency. Folder values are frozen with the settings object.
 * @type {{folders: readonly string[], timeout: number, timeoutLimit: number, concurrency: number}}
 */
export const TOOL_SETTINGS_DEFAULTS = Object.freeze({
  folders: Object.freeze([]),
  timeout: DEFAULT_TOOL_TIMEOUT,
  timeoutLimit: DEFAULT_TOOL_TIMEOUT_LIMIT,
  concurrency: DEFAULT_TOOL_CONCURRENCY,
});

/**
 * Immutable default web-call pacing limit.
 * @type {{calls: number, windowMs: number}}
 */
export const WEB_LIMIT_DEFAULTS = Object.freeze({ calls: 8, windowMs: 40_000 });

/**
 * Immutable default web throttling parameters: initial fraction, incremental
 * fraction, and interval between increments in milliseconds.
 * @type {{startAt: number, step: number, stepMs: number}}
 */
export const WEB_THROTTLE_DEFAULTS = Object.freeze({ startAt: 0.20, step: 0.05, stepMs: 1_000 });
