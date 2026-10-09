/**
 * lib/app/cli/exit.js — the shared exit-code contract of the executables
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
 * Await environment and HTTP-agent teardown, retaining any release errors.
 * Closing idle connections releases parked keep-alive sockets without interrupting in-flight requests.
 *
 * @param {object} [env] Environment whose optional `close()` method stops
 *   background work and writes held settings.
 * @returns {Promise<void>} Resolves after both release attempts; rejects with AggregateError when either fails.
 */
async function closeToolPools(env) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => env?.close?.()),
    Promise.resolve().then(() => Bun?.getHTTPAgent?.().closeIdleConnections?.()),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "CLI resources failed to close");
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
 * @returns {Promise<{agent?: object, session: {id: string, file?: string}|null}>} The
 *   explicit agent and its context's id/file when present, otherwise a null
 *   session. Resolves after owned teardown; rejects after all releases when cleanup fails.
 */
export async function close({ env, agent } = {}) {
  const members = typeof env?.agents === "function" ? env.agents() : (agent ? [agent] : []);
  const seen = new Set([...members, agent].filter(Boolean));
  const errors = [];
  for (const member of seen) {
    for (const release of [() => member.cancel?.(), () => member.close?.()]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
  }
  try { await closeToolPools(env); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "CLI runtime failed to close");
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
