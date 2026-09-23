/**
 * tools/skill.js — the `skill` tool: load domain skills into the
 * conversation from Env's accumulated package/settings/configured/
 * environment/project skill roots — see
 * Env.defaultSkillRoots / lib/env/registry.js). Self-contained: a
 * tool receives no live Env instance (only the `args` it's called
 * with — see lib/env.js callTool), so it builds its own throwaway one
 * purely to read settings.json and resolve roots; roots are re-scanned
 * from disk on every call (no caching), so a skill added mid-session
 * shows up without a restart.
 *
 * The answer stays BRIEF by design: loading returns "skill loading:
 * <names>" (or "skill not found: <names>"), and with no names the
 * skill catalog itself. The skill PAYLOADS never bloat the tool
 * result — they are returned as { result, system }, and the harness
 * appends them as a system message right after the tool result
 * (lib/agent.js), before any queued user messages.
 *
 * Read-only (safe: true): skills are reference material — safe-mode
 * Agents may load them.
 */

import Env from "../lib/env.js";

/**
 * Load skills into the conversation, or list the catalog.
 * @param {Object} [args]
 * @param {string[]} [args.names] - skills to load; omitted/empty lists the catalog
 * @returns {Promise<string|{result: string, system: string[]}>}
 */
export async function skill({ names } = {}) {
  const env = new Env(); // cheap: settings scan only, no providers/tools load
  const list = Array.isArray(names) ? names.map(String).filter((n) => n.trim() !== "") : [];
  if (list.length === 0) {
    return env.skillCatalog().trimEnd(); // the skill list IS the answer
  }
  const { bodies, unknown } = env.skillBodies(list);
  if (bodies.length === 0) return "No requested skills are available. Call skill with no names to list available skills, then try again.";
  const loaded = list.filter((n) => !unknown.includes(n));
  const result = unknown.length > 0
    ? `Loaded skills: ${loaded.join(", ")}. Call skill with no names to find the unavailable skills.`
    : `Loaded skills: ${loaded.join(", ")}.`;
  // Each skill payload joins the conversation as its own system
  // message; the answer itself stays one line.
  return { result, system: bodies.map((body) => body.trimEnd()) };
}

export function toolDescription() {
  return {
    skill: {
      // READ-ONLY: published as safe (safe-mode Agents may load skills)
      safe: true,
      description: "List available skills or load skills for the current task.",
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "skill names to load (one or more); omit to list the catalog",
          },
        },
      },
    },
  };
}
