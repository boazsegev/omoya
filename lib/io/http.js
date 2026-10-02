/**
 * lib/io/http.js — default HTTP backend (private to IO; OpenAI-spec-compatible transport).
 *
 * Transport-only defaults; the two translators (context2msg/msg2events)
 * are always provider-supplied. Default `msg` convention: the
 * `[headers, body]` array — headers a plain object, body the JSON
 * payload (nil when the request carries none, e.g. GET-style streaming).
 *
 * - defaultConnect(url, aiio) -> {url, aiio} (stateless HTTP; the
 *   connection-scoped owner closes over its aiio)
 * - defaultSend(connection, msg) composes
 *   sendHeaders(connection, msg[0]) + sendBody(connection, msg[1])
 * - defaultRead(connection) -> Promise<msg | nil> — the ONLY reading
 *   contract: blocking-await, resolves with the next whole native
 *   message, nil at end-of-stream. Line-delimited JSON over the Response
 *   body stream: SSE `data:` prefixes are stripped, framing lines
 *   (`event:`, `id:`, `retry:`, `:` comments) are skipped, and the
 *   `[DONE]` sentinel ends the stream, so one reader serves both
 *   OpenAI-style SSE and Ollama-style NDJSON. No push mode.
 * - defaultClose(connection) — teardown for cancellation and completion.
 *
 * Errors are thrown raw (TypeError from fetch, HttpStatusError, JSON
 * SyntaxError); IO classifies them into the auth/network/provider/
 * malformed taxonomy. Non-HTTP transports must implement their own
 * buffering `read` — this reader expects this module's connection shape.
 */

/** HTTP response carrying a non-2xx status. */
export class HttpStatusError extends Error {
  /**
   * Build the error from a non-2xx response (the body's first 200
   * characters ride in the message).
   * @param {number} status
   * @param {string} statusText
   * @param {string} [body] Response text, if available.
   * @param {Headers} [headers] Response headers.
   * @returns {void}
   */
  constructor(status, statusText, body, headers) {
    super(`HTTP ${status} ${statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * Create a stateless HTTP connection descriptor.
 * @param {string} url Request URL.
 * @param {object} aiio IO owner/configuration retained by the connection.
 * @returns {{url: string, aiio: object}} Connection descriptor.
 */
export function defaultConnect(url, aiio) {
  return { url, aiio };
}

/**
 * Store request headers on the connection for the subsequent fetch.
 * @param {object} connection Connection descriptor; mutated with requestHeaders.
 * @param {object|null|undefined} headers Plain-object request headers; nullish values default to `{}`.
 * @returns {Promise<void>}
 */
export async function defaultSendHeaders(connection, headers) {
  connection.requestHeaders = headers ?? {};
}

/**
 * Completes the request: POSTs the JSON body (nil body -> no payload)
 * and stores the Response for defaultRead. Fetch and JSON serialization errors
 * propagate; non-2xx responses throw HttpStatusError after reading response text.
 * @param {object} connection Connection descriptor; response/request state is mutated.
 * @param {*} body JSON-serializable payload; nullish values send no payload.
 * @returns {Promise<void>}
 */
export async function defaultSendBody(connection, body) {
  const init = {
    method: "POST",
    headers: connection.requestHeaders ?? {},
    signal: connection.signal ?? connection.aiio?.requestSignal,
  };
  if (body != null) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(connection.url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpStatusError(response.status, response.statusText, text, response.headers);
  }
  connection.response = response;
}

/**
 * Send one message by storing headers and POSTing its body (`msg = [headers, body]`).
 * Non-array messages are treated as body-only. Errors from sending propagate.
 * @param {object} connection Connection descriptor, mutated with request/response state.
 * @param {Array|*} msg Header/body pair, or a body-only message.
 * @returns {Promise<void>}
 */
export async function defaultSend(connection, msg) {
  const [headers, body] = Array.isArray(msg) ? msg : [undefined, msg];
  await defaultSendHeaders(connection, headers);
  await defaultSendBody(connection, body);
}

/**
 * Blocking-await line reader: resolves the next whole line-delimited
 * JSON message, nil at end-of-stream.
 * Requires a previously stored response body; read/JSON errors propagate.
 * @param {object} connection Connection with response body; decoder, reader, buffer are retained on it.
 * @returns {Promise<object|null>} Next parsed message, or null at stream end/[DONE].
 * @throws {Error} If called before a response is available.
 * @throws {SyntaxError} If a data line contains invalid JSON.
 */
export async function defaultRead(connection) {
  if (!connection.response?.body) {
    throw new Error("defaultRead: no response — read before send");
  }
  connection._decoder ??= new TextDecoder();
  connection._reader ??= connection.response.body.getReader();
  connection._buffer ??= "";
  for (;;) {
    const nl = connection._buffer.indexOf("\n");
    if (nl >= 0) {
      const line = connection._buffer.slice(0, nl);
      connection._buffer = connection._buffer.slice(nl + 1);
      const msg = parseLine(line);
      if (msg === SKIP) continue;
      return msg; // object, or null at [DONE]
    }
    const { done, value } = await connection._reader.read();
    if (done) {
      const line = connection._buffer;
      connection._buffer = "";
      const msg = parseLine(line);
      if (msg === SKIP) return null; // stream ends clean
      return msg;
    }
    // Transport consumers may monitor raw byte progress independently of JSON line framing.
    connection._onChunk?.(value);
    connection._buffer += connection._decoder.decode(value, { stream: true });
  }
}

const SKIP = Symbol("skip");

/**
 * Parse one NDJSON/SSE data line, ignoring blank and SSE framing lines.
 * @param {string} line Raw line without its line-feed delimiter.
 * @returns {object|null|symbol} Parsed JSON value, null for `[DONE]`, or SKIP for framing.
 * @throws {SyntaxError} If the payload is not valid JSON.
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return SKIP;
  // SSE framing lines carry no payload: `event:` type hints (the JSON's
  // own `type` field already drives msg2events), `id:`/`retry:` fields,
  // and `:` keep-alive comments — parsing them as JSON is the
  // "Unexpected identifier" malformed-data regression
  if (trimmed.startsWith("event:") || trimmed.startsWith("id:") ||
      trimmed.startsWith("retry:") || trimmed.startsWith(":")) return SKIP;
  const payload = trimmed.startsWith("data:")
    ? trimmed.slice(5).trim()
    : trimmed;
  if (payload === "[DONE]") return null;
  return JSON.parse(payload); // SyntaxError -> classified malformed by IO
}

/**
 * fetch bounded by a wall-clock deadline AND a fast connect: the caller's abort
 * signal plus a RACED rejection at `deadline` (a bare AbortSignal is not enough
 * — a fetch that never settles must still lose the race and throw), and a 3s
 * fail-fast on a stuck connect. This is the single timeout discipline every
 * provider web request (Kimi, Anthropic, …) shares — roll no bespoke
 * AbortController+setTimeout in a provider.
 *
 * @param {Function} fetchImpl fetch-compatible implementation
 * @param {string|URL} url request target
 * @param {object} init fetch init; may carry the caller's abort signal
 * @param {{deadline?: number, connectTimeoutMs?: number}} [options={}] deadline is
 *   a Date.now() epoch ms; connectTimeoutMs defaults to 3000; omit deadline and
 *   disable connect timeout for an unbounded (caller-signal-only) request.
 * @returns {Promise<Response>} Response from the fetch implementation.
 * @throws {Error} If the deadline passes, connect times out, or fetch fails/cancels.
 */
export async function fetchWithDeadline(fetchImpl, url, init, { deadline, connectTimeoutMs = 3_000 } = {}) {
  let timer;
  const cap = Number.isFinite(deadline)
    ? new Promise((_, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(new Error("web request deadline passed")); return; }
      timer = setTimeout(() => reject(new Error("web request timed out")), remaining);
      timer.unref?.();
    })
    : null;
  try {
    const request = fetchWithDeadlineConnect(fetchImpl, url, init, connectTimeoutMs);
    return await (cap ? Promise.race([request, cap]) : request);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply a connect-phase timeout to a fetch-compatible request.
 * @param {Function} fetchImpl Fetch-compatible implementation.
 * @param {string|URL} url Request target.
 * @param {object} init Fetch init; its signal is combined with an owned abort signal.
 * @param {number} connectTimeoutMs Timeout in milliseconds; non-finite/non-positive disables it.
 * @returns {Promise<Response>} Fetch response promise.
 * @throws {Error} Rejects when the connection times out or the fetch fails/cancels.
 */
async function fetchWithDeadlineConnect(fetchImpl, url, init, connectTimeoutMs) {
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer;
  const connectLimit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("web-search connection timed out");
      error.code = "connect_timeout";
      controller.abort(error); // only the owned controller can close the connection
      reject(error);
    }, connectTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error("request cancelled");
      return fetchImpl(url, { ...init, signal });
    }), connectLimit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cancel the response body stream and mark the connection closed; safe to repeat.
 * Cancellation errors are suppressed.
 * @param {object|null|undefined} connection Connection descriptor, if present.
 * @returns {Promise<void>}
 */
export async function defaultClose(connection) {
  try {
    if (connection?._reader) {
      await connection._reader.cancel().catch(() => {});
    } else {
      await connection?.response?.body?.cancel()?.catch(() => {});
    }
  } catch { /* already closed */ }
  if (connection) connection.closed = true;
}
