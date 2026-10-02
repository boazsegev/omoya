/* Extension packages are explicit, read-only content roots. Only trusted
 * package/user settings can select them; project settings cannot add code. */
import { readFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { deepMerge, isPlainObject, scanSettingsFiles } from "./settings.js";
import { parseJsonc } from "./jsonc.js";
import { folderIdentity } from "./paths.js";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Find an installed npm package by walking upward from the configured base directories.
 * @param {string} name - Validated npm package name to locate.
 * @param {string[]} bases - Directories from which to search ancestor `node_modules` folders.
 * @returns {string} The matching package root directory.
 * @throws {Error} If a package manifest cannot be read or parsed, or no matching package is installed.
 */
function packageRoot(name, bases) {
  for (const base of bases) {
    for (let dir = resolve(base);; dir = dirname(dir)) {
      const candidates = [join(dir, "node_modules", name)];
      if (basename(dir) === "node_modules") candidates.push(join(dir, name));
      for (const root of candidates) {
        try {
          const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
          if (manifest.name === name) return root;
        } catch (error) {
          if (error?.code !== "ENOENT") throw new Error(`Env: extension ${name}: ${error.message}`, { cause: error });
        }
      }
      if (dir === parse(dir).root) break;
    }
  }
  throw new Error(`Env: extension ${name} not installed; install it in the settings or Omoya package folder`);
}

/**
 * Resolve configured package names to unique installed extension roots.
 * @param {string[]|undefined} names - npm package names; `undefined` selects no extensions.
 * @param {object} options - Resolution locations.
 * @param {string} options.dir - Optional project directory used as a package search base.
 * @param {string} options.settingsDir - Optional settings directory, searched before `dir`.
 * @returns {string[]} Deduplicated package root paths in input order.
 * @throws {TypeError} If `names` is not an array of valid npm package names.
 * @throws {Error} If a requested package is not installed or its manifest cannot be read or parsed.
 */
export function extensionRoots(names, { dir, settingsDir }) {
  if (names === undefined) return [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !PACKAGE_NAME.test(name))) {
    throw new TypeError("Env: extensions must be an array of npm package names");
  }
  const seen = new Set();
  return names.map((name) => packageRoot(name, [settingsDir, dir].filter(Boolean)))
    .filter((root) => {
      const id = folderIdentity(root);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

/**
 * Read trusted settings layers to select executable extensions before merging extension settings.
 * Project settings files are not consulted; malformed non-primary settings files are skipped.
 * @param {object} options - Trusted settings and directory context.
 * @param {string} options.dir - Optional project directory whose settings layers are scanned.
 * @param {string} options.settingsDir - Optional trusted settings directory, searched after `dir`.
 * @param {object} options.settings - Optional already-loaded trusted settings merged last.
 * @returns {string[]} Deduplicated installed extension package roots.
 * @throws {Error} If a `settings.json` file cannot be parsed or a selected package cannot be resolved.
 */
export function configuredExtensions({ dir, settingsDir, settings }) {
  let names = [];
  for (const root of [dir, settingsDir].filter(Boolean)) {
    for (const name of scanSettingsFiles(root)) {
      const file = join(root, name);
      let data;
      try { data = parseJsonc(readFileSync(file, "utf8")); } catch (error) {
        if (name !== "settings.json") continue;
        throw new Error(`Env: ${file} parse failure: ${error.message}`, { cause: error });
      }
      if (isPlainObject(data) && Object.hasOwn(data, "extensions")) names = deepMerge(names, data.extensions);
    }
  }
  if (isPlainObject(settings) && Object.hasOwn(settings, "extensions")) names = deepMerge(names, settings.extensions);
  return extensionRoots(names, { dir, settingsDir });
}
