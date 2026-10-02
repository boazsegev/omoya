/**
 * lib/agent/catalogs.js — how skills and prompts read as TEXT (private
 * to Agent; published as Agent.skillCatalog / Agent.promptCatalog /
 * Agent.skillSection). Env publishes the entries (env.skills(),
 * env.prompts(): name -> {name, description, file, source, body}); the
 * model-facing and human-facing wording lives here.
 */

import { NAMES } from "../namespace.js";

/**
 * Format catalog entries as one Markdown list item per map value.
 * @param {Map<string, {name: string, description?: string, source: string}>} entries - Entries from the environment's skill or prompt catalog.
 * @param {boolean} debug - Include each entry's source in parentheses when true.
 * @returns {string} The formatted list, with a trailing newline when nonempty.
 */
function lines(entries, debug) {
  return [...entries.values()]
    .map((entry) => `- \`${entry.name}\`${entry.description ? ` — ${entry.description}` : ""}${debug ? ` (${entry.source})` : ""}\n`)
    .join("");
}

/**
 * The `# Skill Catalog` text.
 * @param {Map<string, {name: string, description?: string, source: string}>} skills - Entries returned by `env.skills()`.
 * @param {{debug?: boolean}} [options] - Catalog formatting options.
 * @param {boolean} [options.debug=false] - Include each skill's source in the listing.
 * @returns {string} The heading and formatted skill listing, ending in one newline.
 */
export function skillCatalog(skills, { debug = false } = {}) {
  const head = `# Skill Catalog\n\nUse the \`skill\` tool (or \`${NAMES.namespace}-skills <name...>\`) to load one or more skills' full content.\n\n`;
  return `${head}${lines(skills, debug)}`.trimEnd() + "\n";
}

/**
 * The `# Prompt Catalog` text.
 * @param {Map<string, {name: string, description?: string, source: string}>} prompts - Entries returned by `env.prompts()`.
 * @param {{debug?: boolean}} [options] - Catalog formatting options.
 * @param {boolean} [options.debug=false] - Include each prompt's source in the listing.
 * @returns {string} The heading and formatted prompt listing, ending in one newline.
 */
export function promptCatalog(prompts, { debug = false } = {}) {
  const head = "# Prompt Catalog\n\nType `//<name>` in the REPL to load one into the input area.\n\n";
  return `${head}${lines(prompts, debug)}`.trimEnd() + "\n";
}

/**
 * One skill's full content as the model reads it.
 * @param {{name: string, body: string}} skill - Skill name and content to embed.
 * @returns {string} The `<skill>` wrapper containing the supplied name and body verbatim.
 */
export function skillSection(skill) {
  const name = skill.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<skill name="${name}">\n${skill.body}\n</skill>`;
}
