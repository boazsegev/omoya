/**
 * lib/env/settings.js — settings scan-and-merge helpers (private to Env).
 *
 * Every top-level JSON file of the package folder merges into one
 * settings tree: objects deep-merge, arrays concatenate, scalar
 * collisions follow incidental read order (file ordering is NOT a
 * precedence mechanism). A layer may additionally scan its `themes/`
 * subfolder (scanThemeFiles): theme files are JSON settings like any
 * other, but a DEDICATED subfolder keeps palettes out of the top-level
 * scan — and the scan is restricted to exactly that one name, so a
 * folder's tools/sessions/scratch subfolders never leak into settings.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Test whether a value is a non-null object other than an array.
 * @param {*} v - the value to test; no default
 * @returns {boolean} whether `v` is a non-null, non-array object
 */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge two values without mutating either input: objects merge recursively,
 * arrays concatenate, and otherwise the value from `b` replaces the value
 * from `a`. Unsafe keys encountered in `b` are skipped during object merges.
 * @param {*} a - the earlier value; no default
 * @param {*} b - the later value; no default
 * @returns {*} the merged value
 */
export function deepMerge(a, b) {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const key of Object.keys(b)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], b[key]) : b[key];
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  return b;
}

/**
 * List sorted names of regular top-level `.json` files in a directory.
 * Reads the directory synchronously; missing or unreadable directories
 * produce an empty list instead of propagating the read error.
 * @param {string} dir - directory path to scan; no default
 * @returns {string[]} sorted JSON file names, or `[]` if the directory cannot be read
 */
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
