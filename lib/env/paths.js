/**
 * lib/env/paths.js — the harness's folder conventions (private to
 * Env/Agent): the USER SETTINGS layer and the sessions folder.
 *
 * The scanning layers (settings JSON, tools, skills, prompts), in
 * order — see lib/env/load.js, catalogs.js, tool-registry.js:
 *   1. the PACKAGE folder (no prefix): *.json, themes/*.json, tools/,
 *      skills/, prompts/;
 *   2. the USER SETTINGS folder — environment override, existing legacy
 *      namespace home, or namespace home default (created when missing; no prefix): *.json,
 *      themes/*.json, tools/, skills/, prompts/ — DYNAMIC settings (auth
 *      files, new endpoints, the last-used combo) are SAVED here — the
 *      package folder is treated as read-only at runtime;
 *   3. the namespace skill/prompt environment folders when defined
 *      (delimiter-separated lists);
 *   4. the PROJECT folder (cwd), namespace-prefixed settings/auth files
 *      ONLY (never a full folder scan), plus namespace skill/prompt
 *      folders — NEVER project tool/provider folders (executable
 *      trust; tool/provider roots live in the package and the
 *      settings folder — lib/env/tool-registry.js defaultToolRoots,
 *      lib/env/provider-registry.js defaultProviderRoots).
 * A folder already scanned under an earlier layer is never scanned
 * twice (resolved-path dedup — e.g. the environment skill root pointing
 * at the settings `skills/` folder scans once).
 * Sessions live in the namespace session folder under settings.
 * The namespace prefix lets a project ignore harness artifacts while
 * unprefixed package/settings folders stay separate from project files.
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NAMES } from "../namespace.js";

/**
 * The namespace user settings folder, resolved in compatibility order:
 * environment overrides, an existing legacy `.ai-settings` home, then the
 * namespace home (created when missing). Dynamic settings land here.
 * @returns {string} the resolved absolute path
 */
export function defaultSettingsDir() {
  const configured = [
    process.env[NAMES.settingsEnv], // OMOYA_SETTINGS_DIR
    process.env[`${NAMES.NAMESPACE}_SETTINGS`], // OMOYA_SETTINGS
    process.env.AI_SETTINGS_DIR,
    process.env.AI_SETTINGS,
  ].find((value) => typeof value === "string" && value.trim() !== "");
  if (configured !== undefined) {
    const resolved = resolve(configured);
    mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  const home = homedir();
  const legacy = join(home, ".ai-settings");
  if (existsSync(legacy) && statSync(legacy).isDirectory()) return resolve(legacy);

  const fallback = resolve(join(home, NAMES.settingsHome));
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** The namespace sessions folder under settings (created when missing). */
export function defaultSessionsDir() {
  const dir = join(defaultSettingsDir(), NAMES.sessionsDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A folder's dedup identity: its REAL path when it exists (symlinks
 * resolve — iCloud-synced and aliased folders compare equal), its
 * resolved absolute path otherwise. Missing folders scan as empty but
 * still dedup.
 * @param {string} dir
 * @returns {string}
 */
export function folderIdentity(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Drop folders already seen under an earlier layer (null/undefined
 * entries are skipped first), preserving order.
 * @param {Array<string|null|undefined>} dirs
 * @returns {string[]}
 */
export function dedupeFolders(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || dir === "") continue;
    const id = folderIdentity(dir);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(dir);
  }
  return out;
}

/** @param {string} dir @returns {boolean} */
export function folderExists(dir) {
  return existsSync(dir);
}
