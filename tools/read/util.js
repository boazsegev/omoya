/**
 * tools/read/util.js — INTERNAL shared helpers of the `read` tool
 * (never a tool itself: the scan is not recursive).
 */

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
