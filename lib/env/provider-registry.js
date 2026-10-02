/**
 * lib/env/provider-registry.js — the protocol-class registry (private
 * to Env): basename-keyed provider classes, scan-loaded from the
 * package providers/, the project ai-providers/, and configured
 * roots, internally completed through lib/env/provider.js (defineProvider).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { defineProvider } from "./provider.js";
import { detectEndpoints } from "./endpoints.js";

// Provider implementations belong to this installed library, not to a
// caller-selected settings/configuration directory (`Env.dir`).
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Register a provider class under its basename and complete it with the
 * library's provider defaults unless it is already marked as original.
 *
 * @param {object} env Environment whose private provider registry is updated.
 * @param {string} name Provider basename used as the registry key.
 * @param {Function} ProviderClass Provider constructor/class to register.
 * @returns {Function} The registered (possibly completed) provider class.
 * @throws {Error} If a provider is already registered under `name`.
 * @throws {Error} If `ProviderClass` cannot be completed by `defineProvider`.
 */
export function registerProvider(env, name, ProviderClass) {
  if (env._providers[name]) throw new Error(`Env: duplicate provider "${name}"`);
  const completed = ProviderClass?.original ? ProviderClass : defineProvider(ProviderClass, { name });
  env._providers[name] = completed;
  return completed;
}

/**
 * Look up a registered communication protocol class by basename.
 *
 * @param {object} env Environment whose provider registry is queried.
 * @param {string} name Provider basename to look up.
 * @returns {Function|undefined} The registered class, or `undefined` if absent.
 */
export function provider(env, name) {
  return env._providers[name];
}

/**
 * List the basenames of all currently registered communication protocols.
 *
 * @param {object} env Environment whose provider registry is queried.
 * @returns {string[]} Registered provider basenames in object-key order.
 */
export function providerNames(env) {
  return Object.keys(env._providers);
}

/**
 * Compute the ordered roots scanned for provider implementations. The
 * installed library's `providers/` is always first, followed by the distinct
 * environment package root, extension roots, and configured provider paths;
 * duplicate paths are removed while preserving first occurrence. Project
 * roots are intentionally excluded because provider classes are executable
 * credential-handling code.
 *
 * @param {object} env Environment supplying package, extension, and settings
 *   roots (`_dir`, `_extensionRoots`, and `_settings.providerPaths`).
 * @returns {string[]} Unique provider directory paths in scan order.
 */
export function defaultProviderRoots(env) {
  const roots = [join(PACKAGE_DIR, "providers")];
  if (env._dir !== PACKAGE_DIR) roots.push(join(env._dir, "providers"));
  roots.push(...(env._extensionRoots ?? []).map((root) => join(root, "providers")));
  if (env._settings.providerPaths !== undefined) {
    roots.push(...[].concat(env._settings.providerPaths));
  }
  return [...new Set(roots)];
}

/**
 * Load default-exported provider classes from the selected directories, using
 * each `.js` filename without its extension as the registry key. Missing or
 * unreadable directories are skipped; files are imported in sorted order.
 * Constructor-supplied overrides are left untouched. Unless disabled, endpoint
 * detection runs after loading. Imports, registration, or endpoint detection
 * may reject the returned promise with their underlying errors.
 *
 * @param {object} env Environment whose registry and overrides are used.
 * @param {object} [options={}] Loading options.
 * @param {string[]} [options.dirs] Directories to scan; defaults to
 *   {@link defaultProviderRoots} for `env`.
 * @param {boolean} [options.detect=true] Whether to run endpoint detection
 *   after loading.
 * @returns {Promise<string[]>} Promise resolving to basenames loaded during
 *   this call, in scan order.
 */
export async function loadProviders(env, { dirs, detect = true } = {}) {
  const loaded = [];
  for (const providersDir of dirs ?? defaultProviderRoots(env)) {
    let entries;
    try {
      entries = readdirSync(providersDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const name = file.slice(0, -3);
      if (env._providerOverrides?.has(name)) continue; // a constructor-supplied class wins
      const mod = await import(pathToFileURL(join(providersDir, file)).href);
      registerProvider(env, name, mod.default);
      loaded.push(name);
    }
  }
  if (detect) await detectEndpoints(env);
  return loaded;
}
