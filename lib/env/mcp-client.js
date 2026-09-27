/** Env-private stdio MCP transport over one Env's connection pool
 *  (lib/env/mcp-tools.js). Dispatch scopes own cancellation teardown. */
import Sandbox from "../sandbox.js";
import { NAMES } from "../namespace.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT = 30_000;

/** Stable pool identity, shared with the tool's status view. */
export function mcpKey(name, config) {
  return `${name}${config.command} ${(config.args ?? []).join(" ")}`;
}

function abortReason(signal) {
  return signal.reason ?? new Error("MCP call cancelled");
}

function adopt(conn, context) {
  return context?.sandbox?.track(conn.child, { retain: true, group: true, onStop: conn.onStop });
}

async function scoped(conn, context, task) {
  // Keep the pooled server adopted until dispatch closes: cancellation may
  // arrive after handshake but before the next RPC starts.
  adopt(conn, context);
  return await task();
}

function finish(conn, id, error, value) {
  const entry = conn.pending.get(id);
  if (!entry) return;
  conn.pending.delete(id);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener("abort", entry.abort);
  if (error) entry.reject(error);
  else entry.resolve(value);
}

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

function closeConnection(conn, reason, stop = false) {
  if (conn.closed) return;
  conn.closed = true;
  conn.failure = String(reason);
  if (conn.pool.get(conn.key) === conn) conn.pool.delete(conn.key);
  for (const id of conn.pending.keys()) finish(conn, id, new Error(conn.failure));
  if (stop) void Sandbox.processStop(conn.child, { group: true });
}

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

/** Request on an existing connection; remove pending state on timeout/abort/death. */
export function mcpRequest(conn, method, params, timeout, context = {}) {
  return scoped(conn, context, () => send(conn, method, params, timeout, context.signal));
}

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
 * environment in config.env. */
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
