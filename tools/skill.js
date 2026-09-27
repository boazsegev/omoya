/**
 * tools/skill.js — the `skill` tool: load domain skills into the
 * conversation from Env's accumulated package/settings/configured/
 * environment/project skill roots — env.skills(), lib/env/catalogs.js).
 * The calling Env (context.env) answers; a forked worker without one
 * builds a throwaway Env purely to read settings and resolve roots.
 * Skills are re-scanned from disk on every call (no caching), so a
 * skill added mid-session shows up without a restart.
 *
 * The answer stays BRIEF by design: loading returns "Loaded skills:
 * <names>." (naming any requested names still unavailable, or
 * refusing outright when none of them are), and with no names the
 * skill catalog itself. The skill PAYLOADS never bloat the tool
 * result — they are returned as { result, system }, and the harness
 * appends them as a system message right after the tool result
 * (lib/agent.js), before any queued user messages.
 *
 * Read-only (safe: true): skills are reference material — safe-mode
 * Agents may load them.
 */

import Env from "../lib/env.js";
import Agent from "../lib/agent.js";

/**
 * Load skills into the conversation, or list the catalog.
 * @param {Object} [args]
 * @param {string[]} [args.names] - skills to load; omitted/empty lists the catalog
 * @returns {Promise<string|{result: string, system: string[]}>}
 */
export async function skill({ names } = {}, context) {
  const env = context?.env ?? new Env(); // cheap: settings scan only, no providers/tools load
  const skills = env.skills();
  const list = Array.isArray(names) ? names.map(String).filter((n) => n.trim() !== "") : [];
  if (list.length === 0) {
    return Agent.skillCatalog(skills).trimEnd(); // the skill list IS the answer
  }
  const unknown = list.filter((name) => !skills.has(name));
  const bodies = list.filter((name) => skills.has(name)).map((name) => Agent.skillSection(skills.get(name)));
  if (bodies.length === 0) return "No requested skills are available. Call skill with no names to list available skills, then try again.";
  const loaded = list.filter((n) => !unknown.includes(n));
  const result = unknown.length > 0
    ? `Loaded skills: ${loaded.join(", ")}. Call skill with no names to find the unavailable skills.`
    : `Loaded skills: ${loaded.join(", ")}.`;
  // Each skill payload joins the conversation as its own system
  // message; the answer itself stays one line.
  return { result, system: bodies };
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
