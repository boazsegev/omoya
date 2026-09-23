/**
 * lib/env/openai-codex.js — JWT and Codex-backend helpers (private to
 * Env's OpenAI defaults): decode an OpenAI-issued OAuth JWT's claims
 * (no signature verification — the token just came from the provider's
 * own token endpoint), extract the ChatGPT account id the codex
 * backend demands as a header, and recognize the codex backend (which
 * rejects the Responses API defaults: it demands `store: false`, a
 * present `instructions` field, and the experimental dialect).
 */

/**
 * Decode a JWT's claims. Returns null when the token is not a JWT at
 * all (an opaque API key).
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
 * The ChatGPT account id an OpenAI-issued OAuth JWT carries (the
 * namespaced auth claim), or undefined. Codex backend requests need
 * it as the `chatgpt-account-id` header (org accounts 401 without
 * it); other endpoints never carry the claim, so nothing is sent.
 * @param {string} token
 * @returns {string|undefined}
 */
export function accountIdOf(token) {
  const id = jwtClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * True when the connection targets the ChatGPT Codex backend
 * (chatgpt.com/backend-api/codex — the OAuth preset marks it
 * `verify: "jwt"` because it has no GET /models). That backend
 * rejects the Responses API defaults: it demands `store: false`
 * (stateless — nothing may be retained server-side) and a present
 * `instructions` field, and speaks the experimental responses dialect.
 * @param {object} connection
 * @returns {boolean}
 */
export function isCodexBackend(connection) {
  const settings = connection?.aiio?.settings ?? {};
  return settings.verify === "jwt" ||
    String(connection?.baseUrl ?? "").includes("chatgpt.com/backend-api");
}
