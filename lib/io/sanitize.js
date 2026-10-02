/**
 * lib/io/sanitize.js — the outgoing request sanitizer (private to IO).
 */

import { ProviderError } from "./provider-error.js";

/**
 * Normalize connector output to a `[headers, body]` pair. If `msg` is an
 * array, its first two elements are treated as headers and body; otherwise,
 * `msg` is treated as the body and headers are absent. Missing or null
 * headers become an empty plain object; header values that are undefined,
 * null, or functions are omitted, and all other values are converted to
 * strings. An absent or null body becomes `null`; other bodies must be
 * JSON-serializable.
 * @param {*} msg Connector output; defaults to no value when omitted (an
 *   omitted value is treated as the body and normalized to `null`).
 * @returns {[Object<string, string>, *]} Sanitized headers and body.
 * @throws {ProviderError} With type `malformed` if headers are not an object
 *   (or are an array), or if the body cannot be JSON-stringified. The error
 *   for an unserializable body includes the underlying cause message.
 * @effects Does not mutate `msg`; reads header entries and attempts to
 *   JSON-stringify the body for validation.
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
 * Return the request body's UTF-8 JSON byte length as it would be sent on the
 * wire, before transport compression. A null or undefined body has size zero.
 * @param {*} body A JSON-serializable body, or null/undefined; defaults to
 *   undefined when omitted, which has size zero.
 * @returns {number} The encoded byte count, or zero for a nullish body.
 * @throws {TypeError} If JSON serialization fails or produces a value that
 *   `Buffer.byteLength` cannot measure (for example, `JSON.stringify` returns
 *   undefined for a non-nullish top-level value).
 * @effects JSON-stringifies non-nullish bodies; does not mutate the body.
 */
export function bodyBytes(body) {
  if (body === null || body === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}
