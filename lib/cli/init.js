// Namespaced project settings template generation — `ai --init`.
// Every known settings key (env.settingsSchema() — core Env keys
// plus every loaded tool's own contribution) is written commented
// out (JSONC, see lib/env/jsonc.js), so starting from the template
// can never conflict with a setting the user later uncomments.

import { existsSync, writeFileSync } from "node:fs";
import { NAMES } from "../namespace.js";
import { join } from "node:path";

/**
 * Render the project settings template from the settings schema exposed by `env`.
 * Emits one commented-out line per known key in sorted order, using its default
 * as the placeholder (`null` if undefined) and its description as a trailing comment.
 * @param {{settingsSchema: () => Record<string, {default?: unknown, description?: string}>}} env
 *   Environment whose `settingsSchema()` supplies the keys, defaults, and descriptions.
 * @returns {string} Complete JSONC template text, ending with a newline.
 * @throws {Error} Propagates an error thrown while obtaining the settings schema.
 */
export function renderSettingsTemplate(env) {
  const schema = env.settingsSchema();
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
 * Write a namespaced settings template to the project settings path under `env.cwd`.
 * Refuses to replace an existing file unless `options.force` is true.
 * @param {{cwd: string, settingsSchema: () => Record<string, {default?: unknown, description?: string}>}} env
 *   Environment providing the project directory and settings schema for rendering.
 * @param {{force?: boolean}} [options={}] Write options; `force` defaults to `false`.
 * @returns {string} Path of the written settings file.
 * @throws {Error} If the file already exists and force is false, or if rendering or
 *   writing the template fails. An existing file is not overwritten on the refusal path.
 */
export function writeSettingsTemplate(env, { force = false } = {}) {
  const file = join(env.cwd, NAMES.projectSettings);
  if (existsSync(file) && !force) {
    throw new Error(`${file} already exists (pass force to overwrite)`);
  }
  writeFileSync(file, renderSettingsTemplate(env));
  return file;
}
