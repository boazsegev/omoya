/* Extension packages are explicit, read-only content roots. Only trusted
 * package/user settings can select them; project settings cannot add code. */
import { readFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { deepMerge, isPlainObject, scanSettingsFiles } from "./settings.js";
import { parseJsonc } from "./jsonc.js";
import { folderIdentity } from "./paths.js";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

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

/** Read only trusted layers to select executable extensions, before merging extension settings. */
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
