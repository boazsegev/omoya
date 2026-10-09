/**
 * lib/env/settings.js — plain-object predicate and JSON source discovery
 * shared by Env's source graph and trusted extension selection. The graph
 * owns precedence and merge semantics; arrays replace rather than concatenate.
 * Theme files are scanned only when requested from a trusted `themes/` folder.
 */

import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test whether a value is a non-null object other than an array.
 * @param {*} v - the value to test; no default
 * @returns {boolean} whether `v` is a non-null, non-array object
 */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * List sorted names of regular top-level `.json` files in a directory.
 * Reads the directory synchronously; missing or unreadable directories
 * produce an empty list instead of propagating the read error.
 * @param {string} dir - directory path to scan; no default
 * @returns {string[]} sorted JSON file names, or `[]` if the directory cannot be read
 */
/** Asynchronous discovery for startup and polling; missing/unreadable roots are empty. */
export async function scanJsonFilesAsync(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name).sort();
}

/** Asynchronous settings-layer discovery. */
export async function scanSettingsFilesAsync(dir) {
  return (await scanJsonFilesAsync(dir)).filter((name) => name !== "package.json" &&
    !/^(?:package-lock|npm-shrinkwrap|bun\.lock)\.json$/.test(name));
}

/** Asynchronous trusted themes discovery. */
export async function scanThemeFilesAsync(dir) {
  return (await scanJsonFilesAsync(join(dir, "themes"))).map((file) => `themes/${file}`);
}

export function scanJsonFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable folder scans as empty
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

/**
 * List sorted top-level JSON settings files in a layer, excluding package
 * manifests and lockfiles. The directory is read synchronously; if it is
 * missing or unreadable, the result is empty.
 * @param {string} dir - the layer's directory path; no default
 * @returns {string[]} sorted settings file names relative to `dir`
 */
export function scanSettingsFiles(dir) {
  return scanJsonFiles(dir).filter((name) => name !== "package.json" &&
    !/^(?:package-lock|npm-shrinkwrap|bun\.lock)\.json$/.test(name));
}

/**
 * List sorted top-level JSON files in the layer's `themes/` subdirectory,
 * prefixed with `themes/`. Reads synchronously; a missing or unreadable
 * subdirectory produces an empty list. `join` may throw for an invalid path.
 * @param {string} dir - the layer's directory path; no default
 * @returns {string[]} sorted theme file paths relative to `dir`
 */
export function scanThemeFiles(dir) {
  return scanJsonFiles(join(dir, "themes")).map((file) => `themes/${file}`);
}
