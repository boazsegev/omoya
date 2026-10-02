/**
 * lib/cli/exit.js — the shared exit-code contract of the executables
 * (private to CLI).
 */

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
 * Best-effort teardown of environment and HTTP-agent background resources.
 * Calls `env.close()` when available without awaiting its result, then awaits
 * Bun's `getHTTPAgent().closeIdleConnections()` when available; failures
 * thrown by the call or its awaited promise are swallowed. Closing idle
 * connections releases parked keep-alive sockets without interrupting
 * in-flight requests. A promise rejected by an asynchronous `env.close()`
 * is not observed here.
 *
 * @param {object} [env] Environment whose optional `close()` method stops
 *   background work and writes held settings.
 * @returns {Promise<void>} Resolves after the HTTP agent idle connections
 *   close attempt; does not reject for caught teardown failures.
 */
async function closeToolPools(env) {
  try { env?.close?.(); } catch { /* teardown is best-effort */ }
  try { await Bun?.getHTTPAgent?.().closeIdleConnections?.(); } catch { /* best-effort */ }
}

/**
 * Close a command-line library runtime. This is the sole public housekeeping
 * boundary: agents are cancelled, sessions are flushed/closed, and tool-owned
 * background resources are released. Repeated calls are safe.
 *
 * @param {{env?: object, agent?: object}} [runtime={}] Runtime options. `env`
 *   may expose `agents()` and `close()`; agents returned by `env.agents()`
 *   and the explicit `agent` are cancelled and closed once each. If no
 *   runtime is supplied, both options are undefined.
 * @returns {{agent?: object, session: {id: string, file?: string}|null}} The
 *   explicit agent and its context's id/file when present, otherwise a null
 *   session. Starts background-resource teardown without awaiting it.
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
  void closeToolPools(env); // fire-and-forget: closes the Env + the keep-alive agent
  return {
    agent,
    session: agent?.context ? { id: agent.context.id, file: agent.context.file } : null,
  };
}

/**
 * Map a terminal done/error event (or an error-shaped `{kind}`) to the
 * process exit code.
 * @param {{type?: string, kind?: string}} [terminal] Terminal event or
 *   error-shaped object. `type: "done"` takes precedence; otherwise `kind`
 *   selects an error exit code. Omission or an unrecognized kind maps to
 *   `EXIT.usage`.
 * @returns {number} The mapped process exit code; this function is
 *   synchronous and has no side effects.
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
