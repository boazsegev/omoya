/** Skill activation: atomic validation, context-idempotent injection, no disk writes. */
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";

function normalizeSkillNames(names) {
  if (names === undefined) return [];
  const list = typeof names === "string" ? [names] : names;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) {
    throw new TypeError("skill: names must be a string or an array of strings");
  }
  return [...new Set(list.map((name) => name.trim()).filter(Boolean))];
}

function activation(env, names, context) {
  const active = context?.loadedSkills?.() ?? new Set();
  const pending = names.filter((name) => !active.has(name));
  const skills = pending.length || !names.length ? env.skills() : new Map();
  if (!names.length) return Agent.skillCatalog(skills).trimEnd();
  const unknown = pending.filter((name) => !skills.has(name));
  if (unknown.length) throw new Error(`Unknown skills: ${unknown.join(", ")}. Call skill without names to list available skills.`);
  return {
    result: `Loaded skills: ${names.join(", ")}.`,
    system: pending.map((name) => Agent.skillSection(skills.get(name))),
  };
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
  const list = normalizeSkillNames(names);
  const env = context?.env ?? new Env();
  try { return activation(env, list, context); }
  finally { if (!context?.env) env.close(); }
}

export function toolDescription() {
  return { skill: {
    safe: true,
    description: "List skills or atomically activate named skills. Already active skills succeed without reloading; disk edits apply next session.",
    inputSchema: { type: "object", properties: {
      names: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "One skill name or an array; trim surrounding whitespace, preserve internal spaces, deduplicate. Omit/empty lists the catalog.",
      },
    } },
  } };
}
