/** Env-owned skill lookup and normalization; callers own instruction injection. */

/** Normalize requested names without splitting internal whitespace. */
export function skillNamesNormalize(names) {
  if (names === undefined) return [];
  const list = typeof names === "string" ? [names] : names;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) {
    throw new TypeError("skill: names must be a string or an array of strings");
  }
  return [...new Set(list.map((name) => name.trim()).filter(Boolean))];
}

/** Validate the complete request before returning any instructions. */
export function skillActivation(env, names, active = new Set()) {
  const pending = names.filter((name) => !active.has(name));
  if (!names.length) return env.skillCatalog().trimEnd();
  const skills = pending.length ? env.skills() : new Map();
  const unknown = pending.filter((name) => !skills.has(name));
  if (unknown.length) throw new Error(`Unknown skills: ${unknown.join(", ")}. Call skill without names to list available skills.`);
  return {
    result: `Loaded skills: ${names.join(", ")}.`,
    system: pending.map((name) => env.skillSection(skills.get(name))),
  };
}
