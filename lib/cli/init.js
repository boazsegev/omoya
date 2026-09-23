// Namespaced project settings template generation — `ai --init`.
// Every known settings key (env.defaultsSchema() — core Env keys
// plus every loaded tool's own contribution) is written commented
// out (JSONC, see lib/env/jsonc.js), so starting from the template
// can never conflict with a setting the user later uncomments.

import { existsSync, writeFileSync } from "node:fs";
import { NAMES } from "../namespace.js";
import { join } from "node:path";

/**
 * Render the template text: one commented-out line per known key,
 * sorted, its default (or `null` when there isn't one) as the
 * placeholder value and its description as a trailing comment.
 * @param {object} env
 * @returns {string} the file's full text (trailing newline)
 */
export function renderSettingsTemplate(env) {
  const schema = env.defaultsSchema();
  const lines = Object.keys(schema).sort().map((key) => {
    const { default: def, description } = schema[key];
    const value = JSON.stringify(def === undefined ? null : def);
    return `  // ${JSON.stringify(key)}: ${value},${description ? ` // ${description}` : ""}`;
  });
  return [
    "{",
    `  // ${NAMES.projectSettings} — every setting Env knows about, commented out.`,
    "  // Uncomment a line and give it a real value to override the default.",
    "  // See API.md's \"Settings defaults schema\" for the live list.",
    "",
    ...lines,
    "}",
    "",
  ].join("\n");
}

/**
 * Write a fresh namespaced settings template into the project folder
 * (env.cwd). Refuses to overwrite an existing file unless `force`.
 * @param {object} env
 * @param {{force?: boolean}} [options]
 * @returns {string} the written file's path
 */
export function writeSettingsTemplate(env, { force = false } = {}) {
  const file = join(env.cwd, NAMES.projectSettings);
  if (existsSync(file) && !force) {
    throw new Error(`${file} already exists (pass force to overwrite)`);
  }
  writeFileSync(file, renderSettingsTemplate(env));
  return file;
}
