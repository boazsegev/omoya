/**
 * tools/guard/env.js — the child-process ENVIRONMENT layer, shared
 * by the process-spawning tools (bash, mcp — never a tool itself:
 * the tool scan is not recursive). Two concerns:
 *
 *   - sanitizeEnv: validate and coerce EXPLICIT additions (the bash
 *     tool's `env` argument, an MCP server config's `env` map) — a
 *     plain object of NAME: value; values are stringified (a child
 *     process environment is strings only), null/undefined entries
 *     are absent;
 *
 *   - childEnv: build the environment a spawned child INHERITS —
 *     process.env passed through the settings allow/refuse stages,
 *     with the explicit additions merged LAST (an explicit addition
 *     always lands; the stages govern the INHERITED environment,
 *     never the deliberate one):
 *       "env-allow":  an array of names — keep ONLY those (the
 *                     whitelist stage; performed ONLY for arrays —
 *                     true/false/absent skips the stage);
 *       "env-refuse": an array of names — drop them (the blacklist
 *                     stage; same skip rule). The package settings
 *                     refuse the known AI API keys so a model-driven
 *                     command or MCP server never inherits provider
 *                     secrets. Settings layers CONCATENATE arrays,
 *                     so a user/project layer EXTENDS the list — or
 *                     sets a scalar (false) to skip the stage.
 */

/**
 * Validate and coerce an explicit env-additions object.
 * @param {*} env - NAME: value additions (null/undefined = none)
 * @returns {Object<string, string>}
 */
export function sanitizeEnv(env) {
  if (env === null || env === undefined) return {};
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("env must be a plain object of NAME: value pairs");
  }
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === null || value === undefined) continue; // absent
    out[name] = String(value);
  }
  return out;
}

/**
 * The environment for a spawned child: the inherited process.env
 * after the settings allow/refuse stages, plus the explicit
 * additions (merged last, never filtered).
 * @param {*} settings - the live settings tree (may be undefined)
 * @param {*} [additions] - explicit env additions (sanitizeEnv input)
 * @returns {Object<string, string>}
 */
export function childEnv(settings, additions) {
  let base = { ...process.env };
  const allow = settings?.["env-allow"];
  if (Array.isArray(allow)) {
    const keep = new Set(allow);
    base = Object.fromEntries(Object.entries(base).filter(([name]) => keep.has(name)));
  }
  const refuse = settings?.["env-refuse"];
  if (Array.isArray(refuse)) {
    for (const name of refuse) delete base[name];
  }
  return { ...base, ...sanitizeEnv(additions) };
}
