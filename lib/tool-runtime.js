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
 * The shared tool-refresh revision, published by the tool scan.
 * @returns {number}
 */
export function toolRevision() {
  return globalThis.__AiEnvToolRevision ?? 0;
}

/** Default Agent-enforced cap for one tool call: two minutes. */
export const DEFAULT_TOOL_TIMEOUT = 120_000;
export const DEFAULT_TOOL_TIMEOUT_LIMIT = 20 * 60_000;
export const DEFAULT_TOOL_CONCURRENCY = 3;
export const TOOL_SETTINGS_DEFAULTS = Object.freeze({
  folders: Object.freeze([]),
  timeout: DEFAULT_TOOL_TIMEOUT,
  timeoutLimit: DEFAULT_TOOL_TIMEOUT_LIMIT,
  concurrency: DEFAULT_TOOL_CONCURRENCY,
});

/** Shared web pacing defaults. */
export const WEB_LIMIT_DEFAULTS = Object.freeze({ calls: 8, windowMs: 40_000 });
export const WEB_THROTTLE_DEFAULTS = Object.freeze({ startAt: 0.20, step: 0.05, stepMs: 1_000 });
