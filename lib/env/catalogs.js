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
 * skills across roots merge; lib/env/paths.js for the layer
 * conventions): `<env._dir>/skills`, `<settingsDir>/skills`,
 * configured/environment roots, and the namespaced project skills
 * folder. A folder already listed
 * under an earlier layer appears once (resolved-path dedup).
 * @param {object} env
 * @returns {string[]}
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
 * @param {object} env
 * @returns {string[]}
 */
export function defaultPromptRoots(env) {
  const roots = promptRootCandidates(env);
  return dedupeFolders(roots);
}

function promptRootCandidates(env) {
  const roots = [join(env._dir, "prompts"), ...(env._extensionRoots ?? []).map((root) => join(root, "prompts"))];
  if (env._settingsDir !== null) roots.push(join(env._settingsDir, "prompts"));
  if (env._settings.prompts !== undefined) roots.push(...[].concat(env._settings.prompts));
  if (process.env[NAMES.promptsEnv]) roots.push(...process.env[NAMES.promptsEnv].split(delimiter).filter(Boolean));
  roots.push(join(env.cwd, NAMES.projectPromptsDir));
  return roots;
}

/** A catalog entry as published: name, description, file, source root(s), body. */
function publish(entry) {
  return Object.freeze({
    name: entry.name,
    description: String(entry.description ?? "").replace(/\s+/g, " ").trim(),
    file: entry.file,
    source: entry.source,
    body: entry.parsed?.body ?? "",
  });
}

/** A name-sorted Map of published entries. */
function sorted(entries) {
  return new Map([...entries.values()].filter((entry) => entry.parsed).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [entry.name, publish(entry)]));
}

/**
 * The merged skills, read fresh from disk.
 * @param {object} env
 * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>}
 */
export function skills(env) {
  return sorted(listSkills(env._skillDirs ?? defaultSkillRoots(env)));
}

/**
 * The merged prompts, read fresh from disk (same entry shape as skills()).
 * @param {object} env
 * @returns {Map<string, {name: string, description: string, file: string, source: string, body: string}>}
 */
export function prompts(env) {
  return sorted(listPrompts(env._promptDirs ?? defaultPromptRoots(env)));
}
