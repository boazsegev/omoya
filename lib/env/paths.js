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
 * Resolve the user settings directory in compatibility order: the first
 * non-empty supported environment override, an existing legacy `.ai-settings`
 * directory, then the namespace home directory. Creates the selected override
 * or fallback directory recursively; dynamic settings are stored there.
 * @returns {string} The resolved absolute settings-directory path.
 * @throws {Error} If resolving, checking, or creating the selected directory
 *   fails (for example, due to filesystem permissions or a non-directory path).
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

/**
 * Return a directory's deduplication identity: its real path when it exists
 * (resolving symlinks), or its resolved absolute path otherwise. This fallback
 * allows missing directories to be deduplicated as well.
 * @param {string} dir Directory path to identify; relative paths resolve from
 *   the current working directory.
 * @returns {string} Real or resolved absolute directory path.
 */
export function folderIdentity(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Remove duplicate directory paths while preserving the first occurrence and
 * input order. Non-string entries and empty strings are skipped; identity is
 * determined by {@link folderIdentity}.
 * @param {Array<string|null|undefined>} dirs Directory paths to deduplicate.
 * @returns {string[]} The retained original path strings in input order.
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

/**
 * Check whether a filesystem path currently exists.
 * @param {string} dir Path to check; relative paths resolve from the current
 *   working directory.
 * @returns {boolean} Whether the path exists. Filesystem errors are treated as
 *   a non-existent path by `existsSync`.
 */
export function folderExists(dir) {
  return existsSync(dir);
}
