/**
 * lib/env/catalogs.js — skill and prompt catalogs (private to Env):
 * ACCUMULATED roots (the package folder is always included, never
 * replaced by settings) and the merged catalog/body readers. Read
 * fresh from disk on every call.
 */

import { delimiter, join, resolve } from "node:path";
import { NAMES } from "../namespace.js";
import { realpath } from "node:fs/promises";
import { listSkills, listPrompts, listPromptsAsync } from "./registry.js";
import { dedupeFolders } from "./paths.js";

/**
 * Skill roots, ACCUMULATED in layer order (unlike tool roots, the
 * package folder is ALWAYS included, never replaced by
 * settings.skills — see lib/env/registry.js for how same-named
 * skills across roots merge; lib/env/paths.js for the layer
 * conventions): `<env.dir>/skills`, `<settingsDir>/skills`,
 * configured/environment roots, and the namespaced project skills
 * folder. A folder already listed
 * under an earlier layer appears once (resolved-path dedup).
 * @param {object} env
 * @returns {string[]}
 */
export function defaultSkillRoots(env) {
  const roots = [join(env.dir, "skills")];
  if (env.settingsDir !== null) roots.push(join(env.settingsDir, "skills"));
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
  const roots = [join(env.dir, "prompts")];
  if (env.settingsDir !== null) roots.push(join(env.settingsDir, "prompts"));
  if (env._settings.prompts !== undefined) roots.push(...[].concat(env._settings.prompts));
  if (process.env[NAMES.promptsEnv]) roots.push(...process.env[NAMES.promptsEnv].split(delimiter).filter(Boolean));
  roots.push(join(env.cwd, NAMES.projectPromptsDir));
  return roots;
}

async function dedupeFoldersAsync(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || dir === "") continue;
    let identity;
    try { identity = await realpath(dir); } catch { identity = resolve(dir); }
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(dir);
  }
  return out;
}

/** Async prompt roots: same layers and realpath dedup as defaultPromptRoots(). */
export async function defaultPromptRootsAsync(env) {
  return dedupeFoldersAsync(promptRootCandidates(env));
}

/**
 * The merged skill catalog as `# Skill Catalog` text (one
 * `- \`name\` — description` line per skill; `debug` appends each
 * skill's source root(s)). Read fresh from disk on every call.
 * @param {object} env
 * @param {Object} [options]
 * @param {boolean} [options.debug]
 * @param {string[]} [options.roots] - override (tests)
 * @returns {string}
 */
export function skillCatalog(env, { debug = false, roots } = {}) {
  const entries = [...listSkills(roots ?? defaultSkillRoots(env)).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  let text = `# Skill Catalog\n\nUse the \`skill\` tool (or \`${NAMES.namespace}-skills <name...>\`) to load one or more skills' full content.\n\n`;
  for (const entry of entries) {
    const description = String(entry.description ?? "").replace(/\s+/g, " ").trim();
    text += `- \`${entry.name}\`${description ? ` — ${description}` : ""}${debug ? ` (${entry.source})` : ""}\n`;
  }
  return text.trimEnd() + "\n";
}

/**
 * The full bodies of the named skills, each wrapped in
 * `<skill name="...">` tags. Unknown names are skipped, not fatal.
 * @param {object} env
 * @param {string[]} names
 * @param {{roots?: string[]}} [options]
 * @returns {{text: string, bodies: string[], unknown: string[]}}
 */
export function skillBodies(env, names, { roots } = {}) {
  const entries = listSkills(roots ?? defaultSkillRoots(env));
  const sections = [];
  const unknown = [];
  for (const name of names) {
    const entry = entries.get(name);
    if (!entry?.parsed) {
      unknown.push(name);
      continue;
    }
    sections.push(`<skill name="${entry.name}">\n${entry.parsed.body}\n</skill>`);
  }
  return {
    text: sections.length > 0 ? sections.join("\n\n") + "\n" : "",
    bodies: sections.map((section) => `${section}\n`),
    unknown,
  };
}

/**
 * The merged prompt NAMES (sorted) — the REPL's `/` completion
 * candidates. Read fresh from disk on every call.
 * @param {object} env
 * @param {{roots?: string[]}} [options]
 * @returns {string[]}
 */
export function promptNames(env, { roots } = {}) {
  return [...listPrompts(roots ?? defaultPromptRoots(env)).values()]
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Async counterpart of promptNames(), suitable for interactive completion. */
export async function promptNamesAsync(env, { roots } = {}) {
  const entries = await listPromptsAsync(roots ?? await defaultPromptRootsAsync(env));
  return [...entries.values()].map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}

/**
 * The merged prompt catalog, same shape as skillCatalog().
 * @param {object} env
 * @param {{debug?: boolean, roots?: string[]}} [options]
 * @returns {string}
 */
export function promptCatalog(env, { debug = false, roots } = {}) {
  const entries = [...listPrompts(roots ?? defaultPromptRoots(env)).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  let text = "# Prompt Catalog\n\nType `//<name>` in the REPL to load one into the input area.\n\n";
  for (const entry of entries) {
    const description = String(entry.description ?? "").replace(/\s+/g, " ").trim();
    text += `- \`${entry.name}\`${description ? ` — ${description}` : ""}${debug ? ` (${entry.source})` : ""}\n`;
  }
  return text.trimEnd() + "\n";
}

/**
 * One prompt's body, verbatim (no interpolation) — the caller appends
 * any trailing data itself. Read fresh from disk on every call.
 * @param {object} env
 * @param {string} name
 * @param {{roots?: string[]}} [options]
 * @returns {string|null} null when unknown
 */
export function promptBody(env, name, { roots } = {}) {
  const entry = listPrompts(roots ?? defaultPromptRoots(env)).get(name);
  return entry?.parsed ? entry.parsed.body : null;
}
