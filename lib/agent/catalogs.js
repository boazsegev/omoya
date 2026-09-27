/**
 * lib/agent/catalogs.js — how skills and prompts read as TEXT (private
 * to Agent; published as Agent.skillCatalog / Agent.promptCatalog /
 * Agent.skillSection). Env publishes the entries (env.skills(),
 * env.prompts(): name -> {name, description, file, source, body}); the
 * model-facing and human-facing wording lives here.
 */

import { NAMES } from "../namespace.js";

/** One `- \`name\` — description` line per entry (`debug` appends its source). */
function lines(entries, debug) {
  return [...entries.values()]
    .map((entry) => `- \`${entry.name}\`${entry.description ? ` — ${entry.description}` : ""}${debug ? ` (${entry.source})` : ""}\n`)
    .join("");
}

/**
 * The `# Skill Catalog` text.
 * @param {Map<string, {name: string, description: string, source: string}>} skills - env.skills()
 * @param {{debug?: boolean}} [options]
 * @returns {string}
 */
export function skillCatalog(skills, { debug = false } = {}) {
  const head = `# Skill Catalog\n\nUse the \`skill\` tool (or \`${NAMES.namespace}-skills <name...>\`) to load one or more skills' full content.\n\n`;
  return `${head}${lines(skills, debug)}`.trimEnd() + "\n";
}

/**
 * The `# Prompt Catalog` text.
 * @param {Map<string, {name: string, description: string, source: string}>} prompts - env.prompts()
 * @param {{debug?: boolean}} [options]
 * @returns {string}
 */
export function promptCatalog(prompts, { debug = false } = {}) {
  const head = "# Prompt Catalog\n\nType `//<name>` in the REPL to load one into the input area.\n\n";
  return `${head}${lines(prompts, debug)}`.trimEnd() + "\n";
}

/**
 * One skill's full content as the model reads it.
 * @param {{name: string, body: string}} skill
 * @returns {string} `<skill name="...">\n<body>\n</skill>`
 */
export function skillSection(skill) {
  return `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
}
