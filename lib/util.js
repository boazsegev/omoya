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

// Child processes inherit ordinary variables. Credential-like names are
// withheld by default; settings.env explicitly removes, passes through, or
// sets a name. Explicit tool/MCP additions are caller-owned and merge last.
const CREDENTIAL_ENV_NAME = /(?:^|[^a-zA-Z])(?:KEY|TOKEN|AUTH|OAUTH|PASSWORD|PASS|SECRET)(?=$|[^a-zA-Z])/i;
const UNSAFE_ENV_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Test whether an environment variable name is credential-like: a KEY, TOKEN, AUTH, OAUTH,
 * PASSWORD, PASS, or SECRET segment delimited by non-letters (`MY_API_KEY`, `DB_PASS_2`), case-insensitive.
 * @param {string} name - Environment variable name; no default is applied.
 * @returns {boolean} Whether child processes withhold the inherited name by default.
 * @throws {*} If string conversion of `name` invokes user-defined code that throws.
 */
export function credentialEnvName(name) {
  return CREDENTIAL_ENV_NAME.test(name);
}

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
  const out = Object.create(null);
  for (const [name, value] of Object.entries(env)) {
    if (UNSAFE_ENV_NAMES.has(name)) throw new TypeError("env: unsafe name");
    if (value === null || value === undefined) continue; // absent
    out[name] = String(value);
  }
  return out;
}

/**
 * Build a child environment, filtering inherited credential-like variable names by default.
 * `settings.env` maps names to false (remove), true (retain the inherited value, including
 * a credential-like one), or an explicit non-nullish value (set). Explicit additions merge
 * last and are never filtered; the caller must authorize them. Does not mutate process.env.
 * @param {*} settings - Live settings tree, optional; `env` must be a name-to-value object.
 * @param {*} [additions] - Explicit additions accepted by {@link sanitizeEnv}; defaults to `undefined` when omitted.
 * @returns {Object<string, string>} A new environment object with string-valued additions.
 * @throws {TypeError} If additions are not an object or are an array; value coercion errors can also propagate from {@link sanitizeEnv}.
 */
export function childEnv(settings, additions) {
  const base = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !credentialEnvName(name) && !UNSAFE_ENV_NAMES.has(name)));
  const policy = settings?.env;
  if (policy !== undefined && (policy === null || typeof policy !== "object" || Array.isArray(policy))) {
    throw new TypeError("settings.env must be a name-to-value object");
  }
  if (policy !== undefined) {
    for (const [name, value] of Object.entries(policy)) {
      if (UNSAFE_ENV_NAMES.has(name)) throw new TypeError("settings.env: unsafe name");
      if (value === false) delete base[name];
      else if (value === true) {
        if (Object.hasOwn(process.env, name)) base[name] = process.env[name];
      } else if (value !== null && value !== undefined) base[name] = String(value);
    }
  }
  return { ...base, ...sanitizeEnv(additions) };
}

// ---- folder names (Env.envs names, web project URLs)

/** Path separators: slash or backslash. */
const SEPARATORS = new RegExp("[\\\\" + "/]+");

/**
 * Name each folder by its shortest path suffix no other folder shares: a
 * name conflict resolves on the first differing parent folders (projects
 * `fiz/bar/foo` and `faz/bar/foo` share `bar/foo`, so both keep one more folder).
 * The root folder, or a path with no unique suffix, is named by its full path.
 * @param {string[]} paths - Absolute folder paths.
 * @param {(segment: string) => boolean} [reserved] - First name segments to avoid (a deeper suffix is used).
 * @returns {Map<string, string[]>} path -> name segments (join with a slash for display).
 */
export function pathNames(paths, reserved = () => false) {
  const entries = paths.map((path) => ({ path, segments: String(path).split(SEPARATORS).filter(Boolean) }));
  // Count distinct paths per suffix once, rather than scanning every other
  // project for every candidate name (notably on web startup with many pins).
  const suffixes = new Map();
  for (const { path, segments } of entries) {
    let suffix = "";
    for (let depth = 1; depth <= segments.length; depth++) {
      suffix = `${segments.at(-depth)}\u0000${suffix}`;
      let owners = suffixes.get(suffix);
      if (!owners) { owners = new Set(); suffixes.set(suffix, owners); }
      owners.add(path);
    }
  }
  const names = new Map();
  for (const { path, segments } of entries) {
    let depth = 1;
    let suffix = "";
    while (depth <= segments.length) {
      suffix = `${segments.at(-depth)}\u0000${suffix}`;
      if (!reserved(segments.at(-depth)) && suffixes.get(suffix).size === 1) break;
      depth++;
    }
    names.set(path, depth > segments.length ? [path] : segments.slice(-depth));
  }
  return names;
}
