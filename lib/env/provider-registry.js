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

// Provider implementations belong to this installed library, not to a
// caller-selected settings/configuration directory (`Env.dir`).
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Register and internally complete a basename-keyed provider class. */
export function registerProvider(env, name, ProviderClass) {
  if (env.providers[name]) throw new Error(`Env: duplicate provider "${name}"`);
  const completed = ProviderClass?.original ? ProviderClass : defineProvider(ProviderClass, { name });
  env.providers[name] = completed;
  return completed;
}

/** @returns {Function|undefined} a communication protocol class by basename */
export function provider(env, name) {
  return env.providers[name];
}

/** @returns {string[]} registered communication protocol basenames */
export function providerNames(env) {
  return Object.keys(env.providers);
}

/** Protocol roots: the installed library's providers/ ALWAYS comes first,
 * followed by an optional caller package root and configured provider paths
 * (package/settings scope ONLY — project `providerPaths` is stripped in
 * load.js). `Env.dir` selects settings/package data; it must not make the
 * installed built-in protocols disappear. The PROJECT folder is NEVER a
 * protocol root because provider classes are executable credential-handling
 * code (the same trust rule as tool roots). */
export function defaultProviderRoots(env) {
  const roots = [join(PACKAGE_DIR, "providers")];
  if (env.dir !== PACKAGE_DIR) roots.push(join(env.dir, "providers"));
  if (env._settings.providerPaths !== undefined) {
    roots.push(...[].concat(env._settings.providerPaths));
  }
  return [...new Set(roots)];
}

/** Load default-exported provider classes, keyed by each file basename. */
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
      const mod = await import(pathToFileURL(join(providersDir, file)).href);
      registerProvider(env, name, mod.default);
      loaded.push(name);
    }
  }
  if (detect) await env.detectEndpoints();
  return loaded;
}
