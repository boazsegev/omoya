/**
 * lib/env/paths.js — the harness's folder conventions (private to
 * Env/Agent): the USER SETTINGS layer and the sessions folder.
 *
 * The scanning layers (settings JSON, tools, skills, prompts), in
 * order — see lib/env/source-graph.js, catalogs.js, tool-registry.js:
 *   1. the PACKAGE folder (no prefix): *.json, themes/*.json, tools/,
 *      skills/, prompts/, hooks/*.js; (installed extensions add the same
 *      trusted kinds between package and user);
 *   2. the USER SETTINGS folder — environment override, existing legacy
 *      namespace home, or namespace home default (created when missing; no prefix): *.json,
 *      themes/*.json, tools/, skills/, prompts/, hooks/*.js — DYNAMIC settings (auth
 *      files, new endpoints, the last-used combo) are SAVED here — the
 *      package folder is treated as read-only at runtime;
 *   3. the namespace skill/prompt environment folders when defined
 *      (delimiter-separated lists);
 *   4. the PROJECT folder (cwd), namespace-prefixed settings/auth files
 *      ONLY (never a full folder scan), plus namespace skill/prompt
 *      folders — NEVER project tool/provider/hook folders (executable
 *      trust; tool/provider roots resolve through lib/env/tool-registry.js
 *      and provider-registry.js; hook roots live only in package, user
 *      settings and installed extensions — lib/agent/hooks.js).
 * A folder already scanned under an earlier layer is never scanned
 * twice (resolved-path dedup — e.g. the environment skill root pointing
 * at the settings `skills/` folder scans once).
 * Sessions live in the namespace session folder under settings.
 * The namespace prefix lets a project ignore harness artifacts while
 * unprefixed package/settings folders stay separate from project files.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NAMES } from "../namespace.js";

/**
 * Resolve the settings folder synchronously: an environment override, an
 * existing legacy folder, or the namespace home. Agrees with the async
 * resolver below, which also creates the selected folder.
 * @returns {string} The resolved absolute settings-directory path.
 * @throws {TypeError} If path resolution receives an invalid value.
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
    return resolved;
  }

  const legacy = resolve(join(homedir(), ".ai-settings"));
  if (existsSync(legacy)) return legacy;
  return resolve(join(homedir(), NAMES.settingsHome));
}

/** Resolve/create the default settings directory without blocking the event loop. */
export async function defaultSettingsDirAsync() {
  const configured = [process.env[NAMES.settingsEnv], process.env[`${NAMES.NAMESPACE}_SETTINGS`],
    process.env.AI_SETTINGS_DIR, process.env.AI_SETTINGS]
    .find((value) => typeof value === "string" && value.trim() !== "");
  if (configured !== undefined) {
    const selected = resolve(configured);
    await mkdir(selected, { recursive: true });
    return selected;
  }
  const legacy = resolve(join(homedir(), ".ai-settings"));
  try {
    if ((await stat(legacy)).isDirectory()) return legacy;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const fallback = resolve(join(homedir(), NAMES.settingsHome));
  await mkdir(fallback, { recursive: true });
  return fallback;
}

/** Filesystem identity for asynchronous source discovery. */
export async function folderIdentityAsync(dir) {
  try { return await realpath(dir); }
  catch (error) { if (error.code === "ENOENT") return resolve(dir); throw error; }
}

/** Synchronous folder identity, retained for non-startup catalog callers. */
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
