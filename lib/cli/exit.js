/**
 * lib/cli/exit.js — the shared exit-code contract of the executables
 * (private to CLI).
 */

import Env from "../env.js";

/** Exit codes shared by the command-line tools. */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  auth: 2,
  network: 3,
  provider: 4,
  malformed: 5,
  cancelled: 130,
});

/**
 * Process teardown for background resources. MCP is a core feature, so
 * its pool lives in the core (the Env façade — no global hand-off). The
 * pooled server children are also unref'd at spawn, so they can never
 * BLOCK the exit; this call is the tidy fast kill. Best-effort; never
 * throws. The Bun HTTP keep-alive agent is closed too: the startup
 * model-catalog refresh (cli-run.js's refreshModels) fires one fetch
 * per configured endpoint, and the platform's agent then PARKS those
 * sockets ESTABLISHED for reuse — ref'd handles that hold the event
 * loop open after the run resolves. `Agent.closeIdleConnections()`
 * (Bun ≥1.3) destroys only the idle parked sockets; any request still
 * in flight is untouched.
 */
async function closeToolPools() {
  try { Env.closeMcpPool(); } catch { /* teardown is best-effort */ }
  try { await Bun?.getHTTPAgent?.().closeIdleConnections?.(); } catch { /* best-effort */ }
}

/**
 * Close a command-line library runtime. This is the sole public housekeeping
 * boundary: agents are cancelled, sessions are flushed/closed, and tool-owned
 * background resources are released. Repeated calls are safe.
 *
 * @param {{env?: object, agent?: object}} [runtime]
 * @returns {{agent?: object, session?: {id: string, file?: string}|null}}
 */
export function close({ env, agent } = {}) {
  const members = typeof env?.agents === "function" ? env.agents() : (agent ? [agent] : []);
  const seen = new Set();
  for (const member of [...members, agent].filter(Boolean)) {
    if (seen.has(member)) continue;
    seen.add(member);
    try { member.cancel?.(); } catch { /* teardown is best-effort */ }
    try { member.close?.(); } catch { /* teardown is best-effort */ }
  }
  void closeToolPools(); // fire-and-forget: closes MCP + the keep-alive agent
  return {
    agent,
    session: agent?.session ? { id: agent.session.id, file: agent.session.file } : null,
  };
}

/**
 * Map a terminal done/error event (or an error-shaped `{kind}`) to the
 * process exit code.
 * @param {{type?: string, kind?: string}} [terminal]
 * @returns {number}
 */
export function exitCodeFor(terminal) {
  if (terminal?.type === "done") return EXIT.ok;
  switch (terminal?.kind) {
    case "auth": return EXIT.auth;
    case "network": return EXIT.network;
    case "provider": return EXIT.provider;
    case "malformed": return EXIT.malformed;
    case "cancelled": return EXIT.cancelled;
    default: return EXIT.usage;
  }
}
