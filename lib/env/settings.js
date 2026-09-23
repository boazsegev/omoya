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

/** @param {*} v @returns {boolean} a non-null, non-array object */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Objects merge recursively; arrays concatenate; scalar collisions take
 * the later value (incidental read order — not a precedence mechanism).
 * @param {*} a
 * @param {*} b
 * @returns {*} the merged value
 */
export function deepMerge(a, b) {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const key of Object.keys(b)) {
      out[key] = key in out ? deepMerge(out[key], b[key]) : b[key];
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  return b;
}

/**
 * The top-level *.json file names of a folder, sorted; a missing or
 * unreadable folder scans as empty.
 * @param {string} dir
 * @returns {string[]}
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
 * A layer's THEME files: the top-level *.json names of its `themes/`
 * subfolder, prefixed `themes/`, sorted; a missing or unreadable
 * subfolder scans as empty. One fixed subfolder, one level deep — see
 * the file header for why this never generalizes to "any subfolder".
 * @param {string} dir - the layer's folder
 * @returns {string[]} paths relative to `dir`
 */
export function scanThemeFiles(dir) {
  return scanJsonFiles(join(dir, "themes")).map((file) => `themes/${file}`);
}
