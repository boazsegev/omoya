import { isPlainObject } from "./settings.js";
import { SettingsStore } from "./settings-store.js";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key) {
  return typeof key === "string" && key.length > 0 && !UNSAFE_KEYS.has(key);
}

/**
 * Create a live, path-stable Proxy over the effective settings in a SettingsStore.
 * `read(path)` may supply defaults or derived values; `write(path, value)` may
 * route writes through application-specific rules. Both callbacks receive a new
 * array of string keys and run synchronously. By default reads use store.read,
 * writes and deletes use store.write (undefined deletes). With a custom writer,
 * deletion calls write(path, undefined); the writer owns deletion semantics.
 *
 * Plain-object descendants are views, cached by path, not mutable snapshots.
 * Arrays and other values are returned as values; replace them with assignment
 * rather than mutating them in place. JSON serialization uses a non-enumerable
 * virtual toJSON hook to obtain one plain cached snapshot at this view's path.
 * An explicitly stored non-undefined toJSON value takes precedence over the hook.
 * Serialization before readiness may reflect incomplete cached state. Custom readers own the lifetime/isolation
 * of values they return. The adapter retains the store and callbacks for the
 * lifetime of the returned view, but does not subscribe to changes or own/close
 * the store. Enumeration, membership, and descriptors reflect current reads;
 * undefined values are absent. Invalid/unsafe read keys are absent, while writes
 * and deletes of such keys throw TypeError. No-op deletes of valid absent keys
 * are delegated to the writer. Callback errors propagate; retry safety depends
 * on the writer. Creating the view has no I/O; each property operation invokes
 * the callbacks synchronously and may have their side effects.
 *
 * @param {SettingsStore} store Settings source, retained but not owned.
 * @param {{read?: (path: string[]) => unknown, write?: (path: string[], value: unknown) => void, canonicalPath?: (path: string[]) => string[]}} [options={}] Optional synchronous accessors; canonicalPath groups aliases under one cached view.
 * @returns {object} Root live settings view; nested views retain stable identity.
 * @throws {TypeError} If the store or accessors are invalid, or on unsafe writes/deletes.
 */
export function settingsStoreView(store, { read, write, canonicalPath } = {}) {
  if (!(store instanceof SettingsStore)) throw new TypeError("SettingsStoreView: invalid store");
  if (read !== undefined && typeof read !== "function") throw new TypeError("SettingsStoreView: read must be a function");
  if (write !== undefined && typeof write !== "function") throw new TypeError("SettingsStoreView: write must be a function");
  if (canonicalPath !== undefined && typeof canonicalPath !== "function") throw new TypeError("SettingsStoreView: canonicalPath must be a function");

  const readAt = read ?? ((path) => store.read(path));
  const writeAt = write ?? ((path, value) => store.write(path, value));
  const views = new Map();

  function viewAt(path) {
    path = canonicalPath?.(path) ?? path;
    const id = JSON.stringify(path);
    if (views.has(id)) return views.get(id);

    const childPath = (key) => [...path, key];
    const valueAt = (key) => {
      if (!isSafeKey(key)) return undefined;
      const nextPath = childPath(key);
      const value = readAt(nextPath);
      return isPlainObject(value) ? viewAt(nextPath) : value;
    };
    const toJSON = () => readAt([...path]);
    const view = new Proxy({}, {
      get: (_target, key) => {
        const value = valueAt(key);
        return key === "toJSON" && value === undefined ? toJSON : value;
      },
      set: (_target, key, value) => {
        if (!isSafeKey(key)) throw new TypeError("SettingsStoreView: invalid key");
        writeAt(childPath(key), value);
        return true;
      },
      deleteProperty: (_target, key) => {
        if (!isSafeKey(key)) throw new TypeError("SettingsStoreView: invalid key");
        writeAt(childPath(key), undefined);
        return true;
      },
      has: (_target, key) => valueAt(key) !== undefined,
      ownKeys: () => {
        const current = readAt([...path]);
        if (!isPlainObject(current)) return [];
        return Object.keys(current).filter((key) => isSafeKey(key) && valueAt(key) !== undefined);
      },
      getOwnPropertyDescriptor: (_target, key) => {
        const value = valueAt(key);
        return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
      },
      defineProperty: () => false,
    });
    views.set(id, view);
    return view;
  }

  return viewAt([]);
}
