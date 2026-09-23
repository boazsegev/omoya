/**
 * tools/read/util.js — INTERNAL shared helpers of the `read` tool
 * (never a tool itself: the scan is not recursive).
 */

/** Validate an optional integer argument. */
export function intArg(value, name, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** base64: true encodes the final text result as base64 TEXT. */
export function encodeIf(base64, result) {
  return base64 ? `[base64]\n${Buffer.from(result, "utf8").toString("base64")}` : result;
}

/**
 * info:true summary — metadata + what the query would have returned.
 * `extra` (FILE-specific: characters/lines of the whole file, never a
 * folder's — a directory's own byte size and no text content to
 * count) prints right after size, before the timestamps.
 * @param {string} path
 * @param {import("node:fs").Stats} stat
 * @param {"file"|"folder"} kind
 * @param {string} query
 * @param {{characters?: number, lines?: number}} [extra]
 */
export function infoBlock(path, stat, kind, query, extra) {
  const more = extra
    ? `characters: ${extra.characters}\nlines: ${extra.lines}\n`
    : "";
  return `info for ${path}:\n` +
    `type: ${kind}\n` +
    `size: ${stat.size} bytes\n` +
    more +
    `created: ${stat.birthtime.toISOString()}\n` +
    `modified: ${stat.mtime.toISOString()}\n` +
    `the requested ${query}`;
}
