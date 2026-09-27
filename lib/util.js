/**
 * lib/util.js — dependency-free utilities. Duration values: a millisecond numeral OR a string
 * with a time unit identifier ("500ms", "20s", "5m", "1.5h"). Used for
 * every timeout setting (CLI --timeout, provider metadata, settings).
 */

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse a duration: a positive millisecond numeral or a unit string
 * ("500ms", "20s", "5m", "1.5h").
 * @param {number|string|undefined|null} value
 * @returns {number|undefined} milliseconds (undefined passes through)
 * @throws {Error} on a non-positive or unparseable value
 */
export function durationParse(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`duration must be a positive number of milliseconds, got ${value}`);
    }
    return value;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(value));
  if (!m) {
    throw new Error(`invalid duration "${value}" (milliseconds, or a unit: 500ms, 20s, 5m, 1h)`);
  }
  const ms = Number(m[1]) * UNITS[(m[2] ?? "ms").toLowerCase()];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`duration must be positive, got "${value}"`);
  }
  return ms;
}

/** durationParse that never throws — invalid/empty input is undefined. */
export function durationTry(value) {
  try {
    return durationParse(value);
  } catch {
    return undefined;
  }
}

/**
 * Decode a JWT's claims (no signature verification — the token came
 * from the provider's own token endpoint). Null when the token is not a
 * JWT at all (an opaque API key).
 * @param {string} token
 * @returns {object|null}
 */
export function jwtClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The ChatGPT account id an OpenAI-issued OAuth JWT carries, or
 * undefined. Codex backend requests send it as `chatgpt-account-id`
 * (org accounts 401 without it); other tokens never carry the claim.
 * Shared by Env's OpenAI catalog defaults and IO's OpenAI wire.
 * @param {string} token
 * @returns {string|undefined}
 */
export function openaiAccountId(token) {
  const id = jwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Does an endpoint target the ChatGPT Codex backend? Its preset marks
 * `verify: "jwt"`; manual endpoints match by URL. The backend demands
 * `store: false`, a present `instructions` field, the experimental
 * responses dialect, and a versioned model catalog.
 * @param {string} url - the endpoint base URL
 * @param {object} [settings] - the endpoint settings view
 * @returns {boolean}
 */
export function openaiCodexBackend(url, settings) {
  return settings?.verify === "jwt" || String(url ?? "").includes("chatgpt.com/backend-api");
}

// ---- child-process environment (the process-spawning tools and Env's MCP
// servers): the INHERITED process.env passes the settings stages
//   "env-allow":  an array of names — keep ONLY those (arrays only;
//                 true/false/absent skips the stage);
//   "env-refuse": an array of names — drop them (same skip rule). The
//                 package settings refuse the known AI API keys so a
//                 model-driven command or MCP server never inherits
//                 provider secrets; layers CONCATENATE arrays, so a
//                 user/project layer EXTENDS the list (false skips it);
// explicit additions (the bash tool's `env` argument, an MCP server
// config's `env` map) merge LAST and are never filtered.

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
