/**
 * tools/read/mime-detection.js — INTERNAL helper of the `read` tool
 * (never a tool itself: the scan is not recursive). Media-type
 * detection: the file EXTENSION map answers first (cheap, reliable for
 * known types); only an unknown extension falls back to sniffing magic
 * bytes; application/octet-stream when neither knows.
 */

import Context from "../../lib/context.js";
const { MIME_BY_EXTENSION, detectMime: detectContextMime } = Context;

/**
 * @param {Object} options
 * @param {string} [options.path] - file path (the extension answers first)
 * @param {Buffer|Uint8Array} [options.buffer] - bytes for magic-byte sniffing
 * @returns {string} the detected media type
 */
export function detectMime({ path, buffer } = {}) {
  return detectContextMime({ path, buffer });
}
