/** Skill activation: atomic validation, context-idempotent injection, no disk writes. */
import Env from "../lib/env.js";

function activation(env, names, context) {
  return env.skillLoad(names, { active: context?.loadedSkills?.() });
}

/**
 * List or atomically activate named skills. Active names succeed without reinjection,
 * even after disk edits; edits apply in the next context. No context means no active state.
 * @param {{names?: string|string[]}} args Requested names; trim, preserve internal spaces, deduplicate.
 * @param {object} context Agent capabilities (Env and context-local loadedSkills query).
 * @returns {Promise<string|{result: string, system: string[]}>} Catalog or activation payload.
 * @throws {Error} Invalid arguments/unknown names/registry failure; no instructions are injected.
 */
export async function skill({ names } = {}, context) {
  if (context?.env) return activation(context.env, names, context);
  const env = await Env.open(context?.agent?.folder ?? process.cwd(), {
    init: { providers: false, tools: false, detect: false, models: false },
  });
  try { return activation(env, names, context); }
  finally { await env.close(); }
}

export function toolDescription() {
  return { skill: {
    safe: true,
    description: "Load relevant skills before starting a task and follow their instructions. Omit names to list available skills; pass an array of catalog names to load them.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      names: {
        type: "array", items: { type: "string" },
        description: "Skill names to load, e.g. [\"api-design\"]. Omit to list the catalog.",
      },
    } },
  } };
}
