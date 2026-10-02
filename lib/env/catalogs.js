/**
 * lib/env/catalogs.js — skills and prompts (private to Env):
 * ACCUMULATED roots (the package folder is always included, never
 * replaced by settings) and the merged name -> entry Maps
 * (env.skills()/env.prompts()). Read fresh from disk on every call;
 * formatting (catalog text, <skill> sections) belongs to Agent.
 */

import { delimiter, join } from "node:path";
import { NAMES } from "../namespace.js";
import { listSkills, listPrompts } from "./registry.js";
import { dedupeFolders } from "./paths.js";

/**
 * Skill roots, ACCUMULATED in layer order (unlike tool roots, the
 * package folder is ALWAYS included, never replaced by
 * settings.skills — see lib/env/registry.js for how same-named
 * skills across roots override/explicitly compose; lib/env/paths.js for the layer
 * conventions): `<env._dir>/skills`, `<settingsDir>/skills`,
 * configured/environment roots, and the namespaced project skills
 * folder. A folder already listed
 * under an earlier layer appears once (resolved-path dedup).
 * @param {object} env Environment state. Reads `_dir`, optional `_extensionRoots`, `_settingsDir`, `_settings.skills`, and `cwd`.
 * @returns {string[]} Deduplicated skill-root paths, in layer order.
 * @throws {TypeError} If required environment fields are missing or invalid for path construction.
 */
export function defaultSkillRoots(env) {
  const roots = [join(env._dir, "skills"), ...(env._extensionRoots ?? []).map((root) => join(root, "skills"))];
  if (env._settingsDir !== null) roots.push(join(env._settingsDir, "skills"));
  if (env._settings.skills !== undefined) roots.push(...[].concat(env._settings.skills));
  if (process.env[NAMES.skillsEnv]) roots.push(...process.env[NAMES.skillsEnv].split(delimiter).filter(Boolean));
  roots.push(join(env.cwd, NAMES.projectSkillsDir));
  return dedupeFolders(roots);
}

/**
 * Prompt roots, ACCUMULATED the same way as skill roots: package,
 * settings, configured/environment, and namespaced project folders.
 * @param {object} env Environment state. Reads `_dir`, optional `_extensionRoots`, `_settingsDir`, `_settings.prompts`, and `cwd`.
 * @returns {string[]} Deduplicated prompt-root paths, in layer order.
 * @throws {TypeError} If required environment fields are missing or invalid for path construction.
 */
export function defaultPromptRoots(env) {
  const roots = promptRootCandidates(env);
  return dedupeFolders(roots);
}

/**
 * Build prompt-root candidates in package, extension, settings, configured/environment, and project order.
 * @param {object} env Environment state; reads `_dir`, optional `_extensionRoots`, `_settingsDir`, `_settings.prompts`, and `cwd`.
 * @returns {string[]} Candidate prompt-root paths, before deduplication.
 * @throws {TypeError} If required environment fields are missing or invalid for path construction.
 */
function promptRootCandidates(env) {
  const roots = [join(env._dir, "prompts"), ...(env._extensionRoots ?? []).map((root) => join(root, "prompts"))];
  if (env._settingsDir !== null) roots.push(join(env._settingsDir, "prompts"));
  if (env._settings.prompts !== undefined) roots.push(...[].concat(env._settings.prompts));
  if (process.env[NAMES.promptsEnv]) roots.push(...process.env[NAMES.promptsEnv].split(delimiter).filter(Boolean));
  roots.push(join(env.cwd, NAMES.projectPromptsDir));
  return roots;
}

/**
 * Convert a parsed registry entry to its immutable public catalog shape, normalizing description whitespace and defaulting absent description/body to empty strings.
 * @param {object} entry Registry entry; reads `name`, `description`, `file`, `source`, and optional `parsed.body`.
 * @returns {{name: *, description: string, file: *, source: *, body: *}} Frozen published entry.
 * @throws {TypeError} If the entry is nullish or cannot supply fields needed by the conversion.
 */
function publish(entry) {
  return Object.freeze({
    name: entry.name,
    description: String(entry.description ?? "").replace(/\s+/g, " ").trim(),
    file: entry.file,
    source: entry.source,
    body: entry.parsed?.body ?? "",
  });
}

/**
 * Filter to parsed entries, sort them by name, publish them, and index them in a Map by name.
 * @param {Map<string, object>} entries Registry entries keyed by name; only values with a truthy `parsed` field are included.
 * @returns {Map<string, object>} Name-sorted map of frozen published entries.
 * @throws {TypeError} If entries is not an iterable map-like value or an included entry cannot be published.
 */
function sorted(entries) {
  return new Map([...entries.values()].filter((entry) => entry.parsed).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [entry.name, publish(entry)]));
}

/**
 * The merged skills, read fresh from disk using configured roots or the default accumulated roots.
 * @param {object} env Environment state; reads optional `_skillDirs` and, when absent/nullish, fields used by `defaultSkillRoots`.
 * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>} Name-sorted published skills.
 * @throws {Error} Propagates registry filesystem/parsing errors and errors from root construction.
 */
export function skills(env) {
  return sorted(listSkills(env._skillDirs ?? defaultSkillRoots(env)));
}

/**
 * The merged prompts, read fresh from disk using configured roots or the default accumulated roots.
 * @param {object} env Environment state; reads optional `_promptDirs` and, when absent/nullish, fields used by `defaultPromptRoots`.
 * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>} Name-sorted published prompts.
 * @throws {Error} Propagates registry filesystem/parsing errors and errors from root construction.
 */
export function prompts(env) {
  return sorted(listPrompts(env._promptDirs ?? defaultPromptRoots(env)));
}
