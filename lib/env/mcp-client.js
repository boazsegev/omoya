/** Env-private stdio MCP transport over one Env's connection pool
 *  (lib/env/mcp-tools.js). Dispatch scopes own cancellation teardown. */
import Sandbox from "../sandbox.js";
import { NAMES } from "../namespace.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT = 30_000;

/** Build the stable connection-pool key shared with the tool status view.
 * @param {string} name MCP server name.
 * @param {{command: string, args?: string[]}} config Server command and optional arguments (defaults to an empty list when absent).
 * @returns {string} Name, command, and joined arguments used as the pool key.
 */
export function mcpKey(name, config) {
  return `${name}${config.command} ${(config.args ?? []).join(" ")}`;
}

/** Get an AbortSignal's reason, supplying the standard cancellation error if absent.
 * @param {AbortSignal} signal Signal to inspect.
 * @returns {*} The signal reason or an Error when no reason is set.
 */
function abortReason(signal) {
  return signal.reason ?? new Error("MCP call cancelled");
}

/** Retain the connection's child process in the calling sandbox, when present.
 * @param {object} conn MCP connection; its child and onStop callback are tracked.
 * @param {object} context Dispatch context; sandbox is optional.
 * @returns {*} The sandbox tracking result, or undefined when no sandbox exists.
 * @throws Propagates errors from sandbox tracking.
 */
function adopt(conn, context) {
  return context?.sandbox?.track(conn.child, { retain: true, group: true, onStop: conn.onStop });
}

/** Adopt a connection for a dispatch scope, then run its task.
 * @param {object} conn MCP connection to retain.
 * @param {object} context Dispatch context (sandbox is optional).
 * @param {Function} task Zero-argument operation to run.
 * @returns {Promise<*>} The task's resolved value.
 * @throws Propagates adoption errors and task rejection.
 */
async function scoped(conn, context, task) {
  // Keep the pooled server adopted until dispatch closes: cancellation may
  // arrive after handshake but before the next RPC starts.
  adopt(conn, context);
  return await task();
}

/** Settle and remove one pending request, if it is still registered.
 * @param {object} conn MCP connection containing pending request state.
 * @param {number|string} id Request identifier.
 * @param {?Error} error Rejection reason, or null/false for success.
 * @param {*} value Resolution value when error is falsy.
 * @returns {void} Does nothing when the identifier is no longer pending.
 * @effects Clears its timeout, removes its abort listener, and resolves or rejects the request.
 */
function finish(conn, id, error, value) {
  const entry = conn.pending.get(id);
  if (!entry) return;
  conn.pending.delete(id);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener("abort", entry.abort);
  if (error) entry.reject(error);
  else entry.resolve(value);
}

/** Buffer newline-delimited JSON-RPC responses and settle matching requests.
 * @param {object} conn MCP connection whose buffer and pending map are updated.
 * @param {string|Buffer} chunk Newly received stdout data.
 * @returns {void} Incomplete lines remain buffered; malformed or notification messages are ignored.
 * @effects Parses response lines and resolves/rejects pending calls through finish.
 */
function receive(conn, chunk) {
  conn.buffer += chunk;
  for (;;) {
    const nl = conn.buffer.indexOf("\n");
    if (nl < 0) return;
    const line = conn.buffer.slice(0, nl).trim();
    conn.buffer = conn.buffer.slice(nl + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.id === undefined || message.id === null) continue;
    finish(conn, message.id, message.error ? new Error(message.error.message ?? JSON.stringify(message.error)) : null, message.result);
  }
}

/** Mark a connection closed, reject pending calls, and optionally stop its process.
 * @param {object} conn MCP connection to close.
 * @param {*} reason Close reason, stringified for future request errors.
 * @param {boolean} [stop=false] Stop the child process group after closing.
 * @returns {void} No-op if already closed.
 * @effects Removes this connection from its pool if still current, rejects all pending requests, and optionally stops the child.
 */
function closeConnection(conn, reason, stop = false) {
  if (conn.closed) return;
  conn.closed = true;
  conn.failure = String(reason);
  if (conn.pool.get(conn.key) === conn) conn.pool.delete(conn.key);
  for (const id of conn.pending.keys()) finish(conn, id, new Error(conn.failure));
  if (stop) void Sandbox.processStop(conn.child, { group: true });
}

/** Spawn and initialize local state/listeners for an MCP stdio server connection.
 * @param {Map} pool Pool that owns the connection.
 * @param {string} name MCP server name, used in diagnostics.
 * @param {string} key Stable pool key.
 * @param {{command: string, args?: string[], env?: object}} config Spawn settings; args defaults to an empty array and env is passed through.
 * @returns {object} New connection state with close and onStop callbacks.
 * @effects Spawns the configured child process, attaches stream/process listeners, and unreferences child and streams when supported.
 * @throws Propagates synchronous spawn/setup errors.
 */
function openConnection(pool, name, key, config) {
  const child = Sandbox.spawn(config.command, config.args ?? [], {
    cwd: process.cwd(), env: config.env, stdio: ["pipe", "pipe", "pipe"],
  });
  const conn = { pool, name, key, child, buffer: "", nextId: 0, pending: new Map(), tools: null, closed: false, failure: null };
  conn.close = (reason = "connection closed") => closeConnection(conn, reason, true);
  conn.onStop = () => closeConnection(conn, "MCP server stopped by dispatch");
  child.unref?.();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => receive(conn, chunk));
  let stderr = "";
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on?.("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", () => {});
  child.on("error", (error) => closeConnection(conn, `spawn failed: ${error.message}`));
  child.on("close", (code) => closeConnection(conn, `server "${name}" exited (code ${code ?? "?"})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
  return conn;
}

/** Send one JSON-RPC request and await its response or failure.
 * @param {object} conn Open MCP connection.
 * @param {string} method JSON-RPC method name.
 * @param {*} params Method parameters.
 * @param {number} timeout Timeout in milliseconds.
 * @param {AbortSignal} [signal] Optional cancellation signal; defaults to no signal.
 * @returns {Promise<*>} Response result.
 * @throws Rejects for cancellation, a closed connection, timeout, stream/write error, or connection failure.
 * @effects Registers pending request state and an abort listener; writes a newline-delimited JSON-RPC message and cleans state when settled.
 */
function send(conn, method, params, timeout, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (conn.closed) return Promise.reject(new Error(conn.failure ?? "connection closed"));
  const id = ++conn.nextId;
  return new Promise((resolve, reject) => {
    const abort = () => finish(conn, id, abortReason(signal));
    const timer = setTimeout(() => finish(conn, id, new Error(`mcp: "${conn.name}" ${method} timed out after ${timeout}ms`)), timeout);
    timer.unref?.();
    conn.pending.set(id, { resolve, reject, timer, signal, abort });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || conn.closed) {
      finish(conn, id, signal?.aborted ? abortReason(signal) : new Error(conn.failure));
      return;
    }
    try {
      conn.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error) finish(conn, id, error);
      });
    } catch (error) { finish(conn, id, error); }
  });
}

/** Request on an existing connection; remove pending state on timeout/abort/death.
 * @param {object} conn Existing MCP connection.
 * @param {string} method JSON-RPC method name.
 * @param {*} params Method parameters.
 * @param {number} timeout Timeout in milliseconds.
 * @param {object} [context={}] Dispatch context; signal is optional and sandbox adoption is performed when available.
 * @returns {Promise<*>} The JSON-RPC result.
 * @throws Rejects when cancelled, timed out, disconnected, or when writing/request handling fails; adoption errors also propagate.
 * @effects Retains the child in the provided sandbox for the dispatch and sends the request.
 */
export function mcpRequest(conn, method, params, timeout, context = {}) {
  return scoped(conn, context, () => send(conn, method, params, timeout, context.signal));
}

/** Await a shared connection handshake while allowing only this caller to abort its wait.
 * @param {object} conn MCP connection with a handshake promise.
 * @param {object} context Dispatch context; optional signal cancels this wait.
 * @returns {Promise<object>} The initialized connection.
 * @throws Rejects if the caller's signal aborts or the shared handshake fails.
 * @effects Adds and removes a one-shot abort listener when a signal is supplied; does not cancel the shared handshake.
 */
function waitForHandshake(conn, context) {
  const signal = context.signal;
  if (!signal) return conn.handshake;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    conn.handshake.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/** Connect lazily through `pool`, sharing handshake while isolating each
 * caller's abort. The caller supplies the settings-filtered child
 * environment in config.env.
 * @param {Map} pool Connection pool keyed by mcpKey.
 * @param {string} name MCP server name.
 * @param {{command: string, args?: string[], env?: object, timeout?: number}} config Spawn settings and optional handshake timeout; args defaults to an empty array, and a missing/invalid/nonpositive timeout uses 30 seconds.
 * @param {object} [context={}] Dispatch context; optional signal aborts this caller's wait, and optional sandbox retains the child.
 * @returns {Promise<object>} The connected and initialized MCP connection.
 * @throws Rejects on caller cancellation, handshake failure, or adoption failure; synchronous spawn/setup errors may also throw.
 * @effects Creates and pools a child connection when absent/closed, performs the shared initialize handshake, and retains it in the caller's sandbox when supplied.
 */
export async function mcpConnect(pool, name, config, context = {}) {
  if (context.signal?.aborted) throw abortReason(context.signal);
  const key = mcpKey(name, config);
  let conn = pool.get(key);
  if (!conn || conn.closed) {
    conn = openConnection(pool, name, key, config);
    pool.set(key, conn);
    const current = conn;
    const timeout = Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT;
    current.handshake = send(current, "initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: NAMES.agentName, version: "1" },
    }, timeout).then(() => {
      if (current.closed) throw new Error(current.failure);
      current.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return current;
    }).catch((error) => {
      current.close(`mcp: server "${name}" handshake failed: ${error.message}`);
      throw new Error(`mcp: server "${name}" handshake failed: ${error.message}`);
    });
  }
  return scoped(conn, context, () => waitForHandshake(conn, context));
}
