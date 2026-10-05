/** Env-private stdio wire transport. Owns child, framing and pending IDs;
 * protocol era, cancellation notices and tool semantics belong to client.js. */
import Sandbox from "../../sandbox.js";

/** Spawn a server; returns the shared transport API plus test-visible child/pending. */
export function openStdio(name, config) {
  const child = Sandbox.spawn(config.command, config.args ?? [], {
    cwd: config.cwd ?? process.cwd(), env: config.env, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const listeners = new Set();
  let closed = false;
  let reason = "connection closed";
  let buffer = "";
  let stderr = "";
  child.unref?.();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
  child.stdout.setEncoding("utf8");
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", () => {});
  /** Settle a response or interruption exactly once and release request resources. */
  function finish(id, error, message) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    if (error) entry.reject(error);
    else entry.resolve(message);
  }
  /** Write a notification and await the stream's write acknowledgement. */
  function notify(message) {
    if (closed) return Promise.reject(new Error(reason));
    return new Promise((resolve, reject) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });
  }
  /** Close stdin gracefully, escalating if the server does not exit. */
  function close(cause = "connection closed") {
    if (closed) return;
    closed = true;
    reason = String(cause);
    for (const id of pending.keys()) finish(id, new Error(reason));
    for (const fn of listeners) fn(reason);
    child.stdin.end();
    const timer = setTimeout(() => {
      if (child.exitCode === null) void Sandbox.processStop(child, { group: true });
    }, 500);
    timer.unref?.();
  }
  child.on("error", (error) => close(`spawn failed: ${error.message}`));
  child.on("close", (code) => {
    const detail = stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : "";
    close(`server "${name}" exited (code ${code ?? "?"})${detail}`);
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id !== undefined && message.id !== null) finish(message.id, null, message);
    }
  });
  /** Correlate a JSON-RPC request; caller owns any cancellation notification. */
  function request(message, { signal, timeout = 30_000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("MCP call cancelled"));
    if (closed) return Promise.reject(new Error(reason));
    return new Promise((resolve, reject) => {
      const abort = () => finish(message.id, signal.reason ?? new Error("MCP call cancelled"));
      const timer = setTimeout(() => {
        const error = new Error(`mcp: "${name}" ${message.method} timed out after ${timeout}ms`);
        error.timedOut = true;
        finish(message.id, error);
      }, timeout);
      timer.unref?.();
      pending.set(message.id, { resolve, reject, abort, signal, timer });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) finish(message.id, error);
        });
      } catch (error) { finish(message.id, error); }
    });
  }
  return {
    name, request, notify, close, onClose: (fn) => listeners.add(fn),
    get closed() { return closed; }, child, pending,
  };
}
