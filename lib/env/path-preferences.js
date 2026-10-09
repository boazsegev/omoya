import { isPlainObject } from "./settings.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Select enabled extra roots from a path-to-boolean settings map.
 * @param {object|undefined} value - Path-to-boolean preferences.
 * @param {string} owner - Settings name used in validation errors.
 * @returns {string[]} Enabled paths in insertion order; does not mutate or retain input.
 * @throws {TypeError} If the map, a key, or a value is invalid; caller must correct the settings before retrying.
 */
export function pathPreferences(value, owner) {
  if (value === undefined) return [];
  if (!isPlainObject(value)) throw new TypeError(`${owner}: expected a path-to-boolean map; migrate legacy arrays to {"path": true} in your settings file (back it up first)`);
  const roots = [];
  for (const [path, enabled] of Object.entries(value)) {
    if (!path.trim() || path.includes("\0") || UNSAFE_KEYS.has(path) || typeof enabled !== "boolean") {
      throw new TypeError(`${owner}: invalid path preference`);
    }
    if (enabled) roots.push(path);
  }
  return roots;
}
