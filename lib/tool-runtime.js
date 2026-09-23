/**
 * lib/tool-runtime.js — the TOOL RUNTIME: the cross-cutting state tool
 * modules share without loading the whole library. A dependency-free
 * leaf: a forked sandbox worker that needs a tool's helper-import stamp
 * or the MCP pool imports only this module. Its startup includes the
 * process, OS jail, settings, and one tool module.
 *
 * Two concerns are shared without loading the whole library. The MCP
 * pool is a module-identity singleton: Bun resolves a cache-busted
 * specifier such as `x.js?now=<n>` and the plain `x.js` to one module
 * instance. The refresh revision is published through globalThis so
 * cache-busted tool imports can read the current value:
 *
 *   - toolRevision(): the shared tool-registry refresh revision. The
 *     tool scan (lib/env/tools.js) bumps and publishes it before
 *     importing wrappers; a wrapper stamps its private helper imports
 *     with it (`./guard/paths.js?now=<revision>`) so a helper edit
 *     applies on refresh even when the wrapper file is unchanged.
 *
 *   - mcpPool / closeMcpPool(): the MCP (Model Context Protocol)
 *     stdio client connection pool and its teardown. MCP is a core
 *     feature: the `mcp` tool opens/uses/reports connections, the
 *     CLI teardown kills them — and a tool refresh re-importing the
 *     tool wrapper reuses the live pool. The pool owns the server
 *     connections, and closeMcpPool() kills every pooled server and
 *     removes its connection. The server children are unref'd at spawn
 *     (the MCP tool), so they do not hold the event loop open.
 */

/**
 * The shared tool-refresh revision, published by the tool scan.
 * @returns {number}
 */
export function toolRevision() {
  return globalThis.__AiEnvToolRevision ?? 0;
}

/** @type {Map<string, object>} key -> connection (see tools/mcp.js) */
export const mcpPool = new Map();

/**
 * Kill every pooled server (process teardown). Idempotent and
 * best-effort: a connection whose child is already gone is simply
 * dropped. Never throws.
 */
export function closeMcpPool() {
  for (const [key, conn] of mcpPool) {
    try { conn.child?.kill?.("SIGKILL"); } catch { /* already gone */ }
    mcpPool.delete(key);
  }
}
