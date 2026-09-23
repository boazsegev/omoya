/**
 * lib/io/sanitize.js — the outgoing request sanitizer (private to IO).
 */

import Env from "../env.js";
const { ProviderError } = Env;

/**
 * Sanitize the connector's outgoing msg into the [headers, body]
 * convention: headers a plain object with string-valued entries
 * (undefined/null/function entries dropped, values stringified), body
 * JSON-serializable or nil. Throws ProviderError("malformed") on
 * unserializable connector output.
 * @param {*} msg
 * @returns {[object, *]} sanitized [headers, body]
 */
export function sanitizeRequest(msg) {
  const [headers, body] = Array.isArray(msg) ? msg : [undefined, msg];

  const cleanHeaders = {};
  if (headers !== undefined && headers !== null) {
    if (typeof headers !== "object" || Array.isArray(headers)) {
      throw new ProviderError("malformed", "sanitize: headers must be a plain object");
    }
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null || typeof value === "function") {
        continue;
      }
      cleanHeaders[key] = typeof value === "string" ? value : String(value);
    }
  }

  const cleanBody = body ?? null;
  if (cleanBody !== null) {
    try {
      JSON.stringify(cleanBody);
    } catch (cause) {
      throw new ProviderError("malformed", `sanitize: body not JSON-serializable — ${cause.message}`);
    }
  }
  return [cleanHeaders, cleanBody];
}

/**
 * The request body's size in bytes as it would go on the wire (UTF-8
 * JSON, BEFORE any transport compression) — 0 for a nil body.
 * @param {*} body - a sanitized (JSON-serializable) body or null
 * @returns {number}
 */
export function bodyBytes(body) {
  if (body === null || body === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}
