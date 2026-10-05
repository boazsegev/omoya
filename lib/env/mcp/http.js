/** Env-private Streamable HTTP wire transport. Owns fetch, SSE and legacy
 * session header; client.js owns era selection, retries and cancel notices. */
const SAFE_VALUE = /^[\x20-\x7e]*$/;
const SENTINEL = /^=\?base64\?.*\?=$/;

/** Encode unsafe or sentinel-shaped header values per the MCP header rules. */
export function headerValue(value) {
  const text = String(value);
  return !SAFE_VALUE.test(text) || text.trim() !== text || SENTINEL.test(text)
    ? `=?base64?${Buffer.from(text).toString("base64")}?=` : text;
}

/** Parse request-scoped SSE events; ignore comments and unrelated notices. */
async function readSse(response, id) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lines = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          if (lines.length) {
            let message;
            try { message = JSON.parse(lines.join("\n")); } catch { /* unrelated event */ }
            if (message?.id === id) return message;
          }
          lines = [];
        } else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) {
        if (buffer.startsWith("data:")) lines.push(buffer.replace(/\r$/, "").slice(5).replace(/^ /, ""));
        if (lines.length) {
          let message;
          try { message = JSON.parse(lines.join("\n")); } catch { /* no matching result */ }
          if (message?.id === id) return message;
        }
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  throw new Error("MCP SSE stream ended without a matching response");
}

/** Create a transport; each request declares its protocol version in options. */
export function openHttp(config) {
  const listeners = new Set();
  const active = new Set();
  let closed = false;
  let sessionId = null;
  let sessionVersion = "2025-06-18";
  const headers = config.headers ?? {};
  const auth = config.oauth;
  let currentBearer = null;
  function close() {
    if (closed) return;
    closed = true;
    if (sessionId) {
      const closing = new Headers(headers);
      if (currentBearer) closing.set("Authorization", `Bearer ${currentBearer}`);
      closing.set("Mcp-Session-Id", sessionId);
      closing.set("MCP-Protocol-Version", sessionVersion);
      void fetch(config.url, { method: "DELETE", headers: closing, redirect: "error" }).catch(() => {});
    }
    for (const controller of active) controller.abort();
    for (const fn of listeners) fn("connection closed");
  }
  /** Fetch a JSON-RPC POST and correlate its JSON or SSE response. */
  async function request(message, { signal, timeout = 30_000, protocolVersion, parameterHeaders = {} } = {}) {
    if (closed) throw new Error("connection closed");
    if (signal?.aborted) throw signal.reason ?? new Error("MCP call cancelled");
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      const error = new Error(`mcp: ${message.method} timed out after ${timeout}ms`);
      error.timedOut = true;
      controller.abort(error);
    }, timeout);
    timer.unref?.();
    try {
      const outgoing = new Headers(headers);
      const bearer = await auth?.bearer(controller.signal);
      if (bearer) { currentBearer = bearer; outgoing.set("Authorization", `Bearer ${bearer}`); }
      outgoing.set("Accept", "application/json, text/event-stream");
      outgoing.set("Content-Type", "application/json");
      outgoing.set("MCP-Protocol-Version", protocolVersion ?? "2026-07-28");
      outgoing.set("Mcp-Method", message.method);
      if (message.params?.name !== undefined || message.params?.uri !== undefined) {
        outgoing.set("Mcp-Name", headerValue(message.params.name ?? message.params.uri));
      }
      for (const [key, value] of Object.entries(parameterHeaders)) outgoing.set(`Mcp-Param-${key}`, headerValue(value));
      const hasSession = Boolean(sessionId && message.method !== "initialize");
      if (hasSession) outgoing.set("Mcp-Session-Id", sessionId);
      const response = await fetch(config.url, {
        method: "POST", headers: outgoing, body: JSON.stringify(message),
        signal: controller.signal, redirect: "error",
      });
      if (response.status === 404 && hasSession) {
        sessionId = null;
        const error = new Error("MCP session expired");
        error.sessionExpired = true;
        throw error;
      }
      if (message.method === "initialize" && response.ok) {
        sessionId = response.headers.get("Mcp-Session-Id");
        sessionVersion = protocolVersion ?? sessionVersion;
      }
      if (message.id === undefined && response.status === 202) return null;
      // Authorization failures carry the actionable Bearer challenge in headers;
      // do not wait for a potentially unbounded SSE error body.
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`MCP HTTP ${response.status}`);
        error.status = response.status;
        error.wwwAuthenticate = response.headers.get("WWW-Authenticate");
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      const contentType = response.headers.get("content-type") ?? "";
      let data;
      if (contentType.includes("text/event-stream")) data = await readSse(response, message.id);
      else {
        const text = await response.text();
        try { data = JSON.parse(text); } catch { data = null; }
      }
      if (!response.ok) {
        const error = new Error(data?.error?.message ?? `MCP HTTP ${response.status}`);
        error.status = response.status;
        error.wwwAuthenticate = response.headers.get("WWW-Authenticate");
        error.rpcError = data?.error;
        throw error;
      }
      if (data?.id !== message.id) throw new Error(`MCP HTTP response ID mismatch for ${message.method}`);
      return data;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted && controller.signal.reason?.timedOut) {
        const timeoutError = controller.signal.reason;
        timeoutError.transportFailure = true;
        throw timeoutError;
      }
      if (!signal?.aborted && !error.status && !error.sessionExpired && !closed &&
        !(error instanceof TypeError && /header/i.test(error.message))) error.transportFailure = true;
      if (error.status >= 500) error.transportFailure = true;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      active.delete(controller);
    }
  }
  /** Notification POSTs are acknowledged before callers proceed. */
  function notify(message, options) { return request(message, options); }
  return {
    request, notify, close, cancelsByClose: true,
    onClose: (fn) => listeners.add(fn), get closed() { return closed; },
    get sessionId() { return sessionId; },
  };
}
