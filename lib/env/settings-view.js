import { settingsStoreView } from "./store-view.js";

/**
 * Return Env's live, path-stable settings proxy. The access adapter owns
 * authorization, defaults, derived values, and persistence. This view owns no
 * files or timers. Arrays are snapshots and must be replaced to persist them.
 * @param {object} env Env owning a source graph and settings access adapter.
 * @returns {object} Live proxy, retained by Env until close.
 * @throws {TypeError} If the graph or adapter is unavailable.
 */
export function settingsView(env) {
  if (!env?._sourceGraph?.store || !env._settingsAccess) throw new TypeError("Env.settings: settings source unavailable");
  return env._settingsView ??= settingsStoreView(env._sourceGraph.store, {
    read: (path) => env._settingsAccess.read(path),
    write: (path, value) => value === undefined
      ? env._settingsAccess.delete(path)
      : env._settingsAccess.write(path, value),
    canonicalPath: (path) => env._settingsAccess.canonicalPath(path),
  });
}
