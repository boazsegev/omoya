/**
 * lib/util.js — dependency-free utilities. Duration values: a millisecond numeral OR a string
 * with a time unit identifier ("500ms", "20s", "5m", "1.5h"). Used for
 * every timeout setting (CLI --timeout, provider metadata, settings).
 */

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse a duration as a positive number of milliseconds.
 * Numeric values are returned unchanged; strings accept an optional unit (`ms`, `s`, `m`, or `h`),
 * with omitted units interpreted as milliseconds. `undefined` and `null` pass through as `undefined`.
 * @param {number|string|undefined|null} value - Duration to parse; no default is applied.
 * @returns {number|undefined} Milliseconds, or `undefined` for a nullish input.
 * @throws {Error} If a supplied duration is non-finite, non-positive, or does not match the accepted format.
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

/**
 * Parse a duration like {@link durationParse}, returning `undefined` instead of propagating any error.
 * @param {number|string|undefined|null} value - Duration to parse; no default is applied.
 * @returns {number|undefined} Milliseconds, or `undefined` for nullish or invalid input.
 * @throws {never} Errors from parsing are caught and suppressed.
 */
export function durationTry(value) {
  try {
    return durationParse(value);
  } catch {
    return undefined;
  }
}

/**
 * Decode the payload segment of a JWT without verifying its signature; intended for tokens obtained
 * from the provider's own token endpoint. Returns `null` for non-string/non-JWT input or decoding/JSON errors.
 * @param {string} token - Token to inspect; no default is applied.
 * @returns {*} The JSON-decoded payload value (normally an object), or `null` if it cannot be decoded.
 * @throws {never} Decoding and JSON parse errors are caught and converted to `null`.
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
 * Get the ChatGPT account ID carried in the OpenAI auth claim of a token's decoded JWT payload.
 * Codex backend requests send it as `chatgpt-account-id` (organization accounts can return 401 without it);
 * other tokens do not carry this claim. Shared by Env's OpenAI catalog defaults and IO's OpenAI wire.
 * @param {string} token - Token whose JWT payload is inspected; no default is applied.
 * @returns {string|undefined} A non-empty account ID when present as a string, otherwise `undefined`.
 * @throws {never} JWT decoding failures are suppressed by {@link jwtClaims}.
 */
export function openaiAccountId(token) {
  const id = jwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Determine whether an endpoint targets the ChatGPT Codex backend. The preset is recognized by
 * `settings.verify === "jwt"`; otherwise manual endpoints are matched by URL substring. This backend demands
 * `store: false`, a present `instructions` field, the experimental responses dialect, and a versioned model catalog.
 * @param {string} url - Endpoint base URL; nullish values are treated as an empty string; no default is applied.
 * @param {object} [settings] - Endpoint settings view; defaults effectively to `undefined` when omitted.
 * @returns {boolean} Whether the endpoint is recognized as the Codex backend.
 * @throws {*} If URL string conversion or reading `settings.verify` invokes user-defined code that throws.
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
 * Sanitize explicit environment additions by omitting nullish values and stringifying the rest.
 * @param {*} env - Object of environment-variable names to values; `null`/`undefined` mean no additions, with no default applied.
 * @returns {Object<string, string>} A new object containing string values.
 * @throws {TypeError} If `env` is a non-object or an array; property access or value coercion errors can also propagate.
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
 * Build a child-process environment from `process.env`, applying configured allow/refuse filters and then
 * merging explicit additions last (additions are never filtered). The parent environment is not modified.
 * @param {*} settings - Live settings tree; defaults effectively to `undefined` when omitted. Array-valued `env-allow`
 *   keeps only listed names; array-valued `env-refuse` removes listed names.
 * @param {*} [additions] - Explicit additions accepted by {@link sanitizeEnv}; defaults to `undefined` when omitted.
 * @returns {Object<string, string>} A new environment object with string-valued additions.
 * @throws {TypeError} If additions are not an object or are an array; value coercion errors can also propagate from {@link sanitizeEnv}.
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
