/**
 * lib/env/system-prompt.js — the seeded system prompt (private to
 * Env): resolveSystemPrompt (the LAYERING, same order as the
 * settings scan — the package folder, then the user settings folder,
 * then the project folder) and the {{skill-name}} prefill expansion.
 * Read fresh from disk on EVERY call, never cached — editing a source
 * before a session starts (or before the next /new) takes effect
 * immediately.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSkills } from "./registry.js";

/** Read a UTF-8 file, or null on failure — a bad system-prompt source
 *  degrades to "no prompt" rather than crashing a live session. */
export function readFileSyncSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The system-prompt text(s) for a FRESH session, in LAYERING ORDER
 * (the same order the settings scan accumulates: package → user
 * settings → project):
 *   1. `settings.system` when set — an existing file path is read as
 *      the prompt body, anything else is used as inline text verbatim.
 *      Falls back (when unset) to the PACKAGE folder's AGENTS.md
 *      (`<dir>/AGENTS.md` — the harness folder);
 *   2. the USER SETTINGS folder's AGENTS.md
 *      (`<settingsDir>/AGENTS.md`) when present (the layer is skipped
 *      when settingsDir is null);
 *   3. ALWAYS also the project folder's OWN AGENTS.md
 *      (`env.cwd/AGENTS.md`) when present.
 * A file already contributing an earlier layer never repeats (the
 * same file path layers once). The texts seed as consecutive system
 * messages, which the Agent's append-merge folds into ONE leading
 * system message.
 * SKILL PREFILL: a `{{skill-name}}` handlebars reference in any
 * source is replaced with that skill's content (wrapped in
 * `<skill name="...">` tags, exactly like the `skill` tool's
 * payloads) — but ONLY when the skill exists in the merged catalog
 * (defaultSkillRoots); an unknown name stays as written, verbatim.
 * @param {object} env
 * @returns {string[]} zero to three prompt texts, in layering order
 */
export function resolveSystemPrompt(env) {
  const texts = [];
  const seen = new Set();
  const pushFile = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const text = readFileSyncSafe(file);
    if (text !== null) texts.push(text);
  };
  const packageAgents = join(env.dir, "AGENTS.md");
  const configured = env._settings.system;
  if (typeof configured === "string" && configured.trim() !== "") {
    if (existsSync(configured)) {
      seen.add(configured);
      const text = readFileSyncSafe(configured);
      if (text !== null) texts.push(text);
    } else {
      texts.push(configured);
    }
  } else {
    pushFile(packageAgents);
  }
  if (env.settingsDir !== null && env.settingsDir !== undefined) {
    pushFile(join(env.settingsDir, "AGENTS.md"));
  }
  pushFile(join(env.cwd, "AGENTS.md"));
  return texts.map((text) => expandSkillRefs(env, text));
}

/**
 * Replace every `{{skill-name}}` handlebars reference with the named
 * skill's content (a `<skill name="...">` section, matching
 * skillBodies). Single pass (a skill body's own `{{...}}` is never
 * re-expanded); unknown names stay verbatim. The registry is
 * consulted only when the text actually carries a reference.
 * @param {object} env
 * @param {string} text
 * @returns {string}
 */
export function expandSkillRefs(env, text) {
  if (typeof text !== "string" || !text.includes("{{")) return text;
  let skills = null; // lazy: scanned at most once per call
  return text.replace(/\{\{([A-Za-z0-9][A-Za-z0-9 _.-]*)\}\}/g, (match, name) => {
    skills ??= listSkills(env.defaultSkillRoots());
    const entry = skills.get(name.trim());
    return entry?.parsed
      ? `<skill name="${entry.name}">\n${entry.parsed.body}\n</skill>`
      : match;
  });
}
