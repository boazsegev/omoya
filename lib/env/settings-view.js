/**
 * lib/env/settings-view.js — `env.settings`, the single LIVE settings
 * view (private to Env).
 *
 * READS walk the merged settings tree; a missing value falls back to
 * the defaults schema (lib/env/settings-schema.js) at the same path, and
 * a top-level entry with `derive` answers its derived value (e.g.
 * `settings.sessions`, the resolved sessions folder).
 *
 * WRITES (`env.settings.a.b = v`, `delete env.settings.a.b`) update the
 * live tree in place and persist ONLY that path, coalesced per tick, to
 * the layer file that owns it:
 *   - the project settings file when it already holds the exact path
 *     (and the key's schema `layers` allow the project);
 *   - else the user settings folder's file holding the longest existing
 *     prefix of the path (settings.json on a tie or when none does);
 *   - never the package folder or an extension (read-only at runtime);
 *     with no user settings folder (settingsDir: null) a write the
 *     project does not own stays in memory.
 * An endpoint's own section (the top-level key named after it) persists
 * through its auth record instead (lib/env/auth.js authSet).
 * Arrays are values: replace them, never mutate them in place.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../namespace.js";
import { isPlainObject, scanSettingsFiles, scanThemeFiles } from "./settings.js";
import { parseJsonc } from "./jsonc.js";
import { defaultsSchema } from "./settings-schema.js";
import { authSet } from "./auth.js";
import { modelsChanged } from "./models-changed.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Make a JSON-compatible plain copy of a value, including views and nested objects.
 * @param {*} value Value to copy.
 * @returns {*} JSON-round-tripped copy for objects; primitives are returned unchanged.
 * @throws {TypeError} If an object cannot be serialized as JSON.
 */
const plain = (value) => (value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);

/**
 * Look up a path in a plain-object tree.
 * @param {object} tree Tree to inspect.
 * @param {string[]} path Keys to follow.
 * @returns {*} The value at the path, or `undefined` if traversal encounters a missing key or non-plain object.
 */
function at(tree, path) {
  let node = tree;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** Cache of materialized defaults, keyed by schema identity. */
const defaultTrees = new WeakMap();
/**
 * Get the schema defaults as a top-level tree, memoized per schema.
 * @param {object} env Environment supplying the defaults schema.
 * @returns {object} Defaults indexed by top-level setting name.
 */
function defaultsOf(env) {
  const schema = defaultsSchema(env);
  let tree = defaultTrees.get(schema);
  if (!tree) defaultTrees.set(schema, tree = Object.fromEntries(Object.entries(schema).map(([key, entry]) => [key, entry?.default])));
  return tree;
}

/**
 * Set a path in a plain-object tree, creating parent objects; `undefined` deletes the leaf.
 * @param {object} tree Tree to mutate.
 * @param {string[]} path Non-empty path of keys.
 * @param {*} value Value to assign, or `undefined` to delete.
 * @returns {void}
 * @effects Mutates `tree` in place.
 */
function assign(tree, path, value) {
  let node = tree;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  const leaf = path.at(-1);
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
}

/**
 * Measure the longest prefix of a path present in a tree.
 * @param {object} tree Tree to inspect.
 * @param {string[]} path Keys to follow.
 * @returns {number} Number of consecutive keys found.
 */
function depthOf(tree, path) {
  let node = tree;
  let depth = 0;
  for (const key of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) break;
    node = node[key];
    depth++;
  }
  return depth;
}

/**
 * Read current settings content, preferring queued writes over a JSONC file.
 * @param {object} env Environment with a write queue.
 * @param {string} file Settings file path.
 * @returns {object|null} Plain parsed content, `{}` if absent/invalid in shape, or `null` if unreadable (so it is not rewritten).
 * @effects Reads the queue and may synchronously read the file.
 */
function readOwned(env, file) {
  const pending = env._writeQueue.peek(file);
  if (pending !== undefined) return isPlainObject(pending) ? pending : {};
  if (!existsSync(file)) return {};
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return null; // an unreadable file is never rewritten
  }
}

/**
 * Select the writable settings file that owns a path.
 * @param {object} env Environment with schema, project directory, and optional settings directory.
 * @param {string[]} path Setting path.
 * @returns {string|null} Owning file path, or `null` when persistence is unavailable.
 * @effects Inspects pending/file contents and scans settings and theme files.
 */
function ownerFile(env, path) {
  const layers = defaultsSchema(env)[path[0]]?.layers;
  if (layers === undefined || layers.includes("project")) {
    const project = join(env.cwd, NAMES.projectSettings);
    const content = readOwned(env, project);
    if (content && depthOf(content, path) === path.length) return project;
  }
  if (env._settingsDir === null) return null;
  const preferred = join(env._settingsDir, "settings.json");
  let best = preferred;
  let bestDepth = depthOf(readOwned(env, preferred) ?? {}, path);
  for (const name of [...scanSettingsFiles(env._settingsDir), ...scanThemeFiles(env._settingsDir)]) {
    if (name === "settings.json" || name.startsWith("auth-")) continue;
    const file = join(env._settingsDir, name);
    const depth = depthOf(readOwned(env, file) ?? {}, path);
    if (depth > bestDepth) [best, bestDepth] = [file, depth];
  }
  return best;
}

/**
 * Determine whether a top-level setting belongs to an endpoint auth record.
 * @param {object} env Environment containing endpoint registries.
 * @param {string} key Top-level setting key.
 * @returns {boolean} Whether the key is an endpoint-owned section.
 */
function endpointSection(env, key) {
  return env._endpointScopes.has(key) || env._dynamicEndpoints.has(key) ||
    (isPlainObject(env._endpoints?.[key]) && key !== "providers");
}

/**
 * Apply a setting write to the live tree and, when applicable, queue its persisted delta.
 * @param {object} env Environment whose settings, auth, models, and write queue are updated.
 * @param {string[]} path Setting path.
 * @param {*} value Value to write; `undefined` deletes the path.
 * @returns {void}
 * @effects Mutates settings, may update auth state, notify model changes, and defer a file write.
 * @throws {TypeError} For unsafe keys or attempts to set a derived setting.
 * @throws {Error} Propagates errors from serialization or auth/model update operations.
 */
function write(env, path, value) {
  if (path.some((key) => typeof key !== "string" || UNSAFE_KEYS.has(key))) {
    throw new TypeError(`Env.settings: invalid key path ${JSON.stringify(path)}`);
  }
  if (defaultsSchema(env)[path[0]]?.derive) {
    throw new TypeError(`Env.settings: "${path[0]}" is derived; set its source setting instead`);
  }
  value = plain(value);
  if (JSON.stringify(at(env._settings, path)) === JSON.stringify(value)) return; // nothing changes
  if (path.length > 1 && endpointSection(env, path[0])) {
    const [name, field] = path;
    if (path.length === 2) authSet(env, name, { [field]: value });
    else {
      const next = plain(at(env._settings, [name, field]) ?? {});
      assign(next, path.slice(2), value);
      authSet(env, name, { [field]: next });
    }
    return;
  }
  assign(env._settings, path, plain(value));
  modelsChanged(env); // filters, access policy, and caps are settings
  const file = ownerFile(env, path);
  if (file === null) return;
  const content = readOwned(env, file);
  if (content === null) return;
  const next = plain(content);
  assign(next, path, value);
  env._writeQueue.defer(file, next);
}

/**
 * The live view of one settings path, cached per environment and path. Reads combine live values with schema defaults; writes and deletes are routed through the settings persistence rules.
 * @param {object} env Environment providing settings state, schema, and write queue.
 * @param {string[]} [path=[]] Path to view; defaults to the root settings object.
 * @returns {object} Proxy view supporting property reads, writes, deletes, key enumeration, and membership checks.
 * @effects Initializes/updates the environment's view cache; property writes may mutate settings, update auth/model state, and queue persistence.
 * @throws {TypeError} On writes using unsafe keys or targeting derived settings.
 */
export function settingsView(env, path = []) {
  const key = path.join("\0");
  env._settingsViews ??= new Map();
  const cached = env._settingsViews.get(key);
  if (cached) return cached;
  const nodes = () => [at(env._settings, path), at(defaultsOf(env), path)];
  const read = (prop) => {
    if (path.length === 0) {
      const entry = defaultsSchema(env)[prop];
      if (typeof entry?.derive === "function") return entry.derive(env, at(env._settings, [prop]));
    }
    const raw = at(env._settings, [...path, prop]);
    const fallback = at(defaultsOf(env), [...path, prop]);
    if (isPlainObject(raw) || (raw === undefined && isPlainObject(fallback))) return settingsView(env, [...path, prop]);
    if (raw !== undefined) return raw;
    // Global descent: an explicit top-level theme supplies either app's
    // theme only when that app has not selected its own value.
    if (prop === "theme" && path.length === 1 && (path[0] === "tui" || path[0] === "web")) {
      const global = at(env._settings, ["theme"]);
      if (global !== undefined) return global;
    }
    return fallback;
  };
  const keys = () => {
    const [raw, fallback] = nodes();
    const own = new Set([...(isPlainObject(raw) ? Object.keys(raw) : []), ...(isPlainObject(fallback) ? Object.keys(fallback) : [])]);
    if (path.length === 0) {
      for (const [name, entry] of Object.entries(defaultsSchema(env))) if (entry?.derive) own.add(name);
    }
    return [...own].filter((name) => read(name) !== undefined);
  };
  const view = new Proxy({}, {
    get: (_target, prop) => (typeof prop === "symbol" ? undefined : read(prop)),
    set: (_target, prop, value) => {
      write(env, [...path, prop], value);
      return true;
    },
    deleteProperty: (_target, prop) => {
      write(env, [...path, prop], undefined);
      return true;
    },
    has: (_target, prop) => typeof prop === "string" && read(prop) !== undefined,
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      const value = read(prop);
      return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty: () => false,
  });
  env._settingsViews.set(key, view);
  return view;
}
