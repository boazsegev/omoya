/* Extension packages are explicit, read-only content roots. Only trusted
 * package/user settings can select them; project settings cannot add code. */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isPlainObject, scanSettingsFilesAsync } from "./settings.js";
import { folderIdentityAsync } from "./paths.js";
import { parseJsonc } from "./jsonc.js";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Find an installed npm package by walking upward from the configured base directories.
 * @param {string} name - Validated npm package name to locate.
 * @param {string[]} bases - Directories from which to search ancestor `node_modules` folders.
 * @returns {Promise<string>} The matching package root directory.
 * @throws {Error} If a package manifest cannot be read or parsed, or no matching package is installed.
 */
async function packageRoot(name, bases) {
  for (const base of bases) {
    for (let dir = resolve(base);; dir = dirname(dir)) {
      const candidates = [join(dir, "node_modules", name)];
      if (basename(dir) === "node_modules") candidates.push(join(dir, name));
      for (const root of candidates) {
        try {
          const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
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
 * Normalize a trusted layer's extension selection.
 * @param {object} selection - Package names or folder paths mapped to booleans.
 * @returns {Map<string, boolean>} Ordered validated selections; input is not mutated or retained.
 * @throws {TypeError} If a name or value is invalid.
 */
function extensionSelection(selection) {
  if (!isPlainObject(selection)) {
    throw new TypeError('Env: extensions must be a name/path-to-boolean map; migrate legacy arrays to {"name": true} in your settings file (back it up first)');
  }
  const selected = new Map();
  for (const [name, enabled] of Object.entries(selection)) {
    if (!name.trim() || name.includes("\0") || ["__proto__", "constructor", "prototype"].includes(name)) {
      throw new TypeError("Env: invalid extension name or folder path");
    }
    if (typeof enabled !== "boolean") {
      throw new TypeError(`Env: extension ${name} must be a boolean`);
    }
    selected.set(name, enabled);
  }
  return selected;
}

/**
 * Resolve enabled package names or existing folders to unique extension roots.
 * @param {object|undefined} names - npm name/folder → boolean map; undefined selects none.
 * @param {object} options - Resolution locations.
 * @param {string} options.dir - Optional package directory used as a search base.
 * @param {string} options.settingsDir - Optional settings directory, searched before `dir`.
 * @returns {Promise<string[]>} Deduplicated package root paths in selection order; inputs are not mutated.
 * @throws {TypeError} If a selection contains invalid names or non-boolean values.
 * @throws {Error} If an enabled package is not installed or its manifest cannot be read or parsed.
 */
export async function extensionRoots(names, { dir, settingsDir }) {
  if (names === undefined) return [];
  const seen = new Set();
  const roots = [];
  for (const [name, enabled] of extensionSelection(names)) {
    if (!enabled) continue;
    const bases = [settingsDir, dir].filter(Boolean);
    // Explicit paths resolve relative to the trusted settings folder; npm names
    // are looked up only when no selected folder exists.
    const direct = isAbsolute(name) || name.startsWith(".") || name.includes("/") && !name.startsWith("@");
    const candidates = isAbsolute(name) ? [[name, null]] : bases.map((base) => [resolve(base, name), base]);
    let folder;
    for (const [candidate, base] of candidates) {
      try {
        if (!(await stat(candidate)).isDirectory()) continue;
        const actual = await realpath(candidate);
        if (base !== null) {
          const displacement = relative(await realpath(base), actual);
          if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
            throw new TypeError(`Env: extension ${name}: path escapes trusted settings folder`);
          }
        }
        folder = actual;
        break;
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    if (!folder && (direct || !PACKAGE_NAME.test(name))) throw new TypeError(`Env: extension ${name}: folder does not exist or is not a directory`);
    const root = folder ?? await packageRoot(name, bases);
    const id = await folderIdentityAsync(root);
    if (seen.has(id)) continue;
    seen.add(id);
    roots.push(root);
  }
  return roots;
}

/**
 * Read trusted settings layers to select executable extensions before merging extension settings.
 * Project settings files are not consulted; malformed non-primary settings files are skipped.
 * @param {object} options - Trusted settings and directory context.
 * @param {string} options.dir - Optional project directory whose settings layers are scanned.
 * @param {string} options.settingsDir - Optional trusted settings directory, searched after `dir`.
 * @param {object} options.settings - Optional already-loaded trusted settings merged last.
 * @returns {Promise<string[]>} Deduplicated installed extension package roots.
 * @throws {Error} If a `settings.json` file cannot be parsed or a selected package cannot be resolved.
 */
export async function configuredExtensions({ dir, settingsDir, settings }) {
  const selected = new Map();
  const apply = (selection) => {
    for (const [name, enabled] of extensionSelection(selection)) selected.set(name, enabled);
  };
  for (const root of [dir, settingsDir].filter(Boolean)) {
    for (const name of await scanSettingsFilesAsync(root)) {
      const file = join(root, name);
      let data;
      try {
        const text = await readFile(file, "utf8");
        data = text.trim() ? parseJsonc(text) : {};
      } catch (error) {
        if (name !== "settings.json") continue;
        throw new Error(`Env: ${file} parse failure: ${error.message}`, { cause: error });
      }
      if (isPlainObject(data) && Object.hasOwn(data, "extensions")) apply(data.extensions);
    }
  }
  if (isPlainObject(settings) && Object.hasOwn(settings, "extensions")) apply(settings.extensions);
  return await extensionRoots(Object.fromEntries(selected), { dir, settingsDir });
}
