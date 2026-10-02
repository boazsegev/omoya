/**
 * lib/cli/oauth.js — OAuth sign-in for endpoint login (private to
 * CLI), modeled on pi's on-boarding flow. Two grant shapes, picked
 * by the preset's descriptor:
 *
 * A. AUTHORIZATION CODE + PKCE (the default — descriptor carries
 *    `authorizeUrl`): PKCE (S256) + a random state, a loopback HTTP
 *    server on the redirect URI's port, the system browser, the
 *    HEADLESS FALLBACK (the user pastes the final redirect URL —
 *    completeOAuthPaste(), the TUI's /endpoint-oauth-paste), then the
 *    code exchange at the token URL.
 * B. DEVICE AUTHORIZATION (RFC 8628 — descriptor carries
 *    `deviceAuthorizationUrl`; the Kimi Code subscription flow): the
 *    device code request returns a user code + verification URL (the
 *    browser opens it, headless users go anywhere), and the token
 *    URL is POLLED until the user approves, the code expires, or the
 *    sign-in is denied. No loopback server, no paste fallback — the
 *    code IS the channel.
 *
 * A provider declares its flow on a login-wizard endpoint preset:
 *   A: { oauth: { label, clientId, authorizeUrl, tokenUrl, redirectUri,
 *                 scope, extraAuthorizeParams?, tokenFormat?,
 *                 tokenIncludesState? } }
 *      Optional knobs the helper ADAPTS to (defaults reproduce the
 *      plain PKCE flow): `tokenFormat` "form" (default) or "json"
 *      picks the code-exchange body encoding; `tokenIncludesState`
 *      sends the flow's state in the exchange (some servers bind the
 *      code to it); a NON-loopback `redirectUri` (a provider-hosted
 *      callback page that shows the code) makes the flow PASTE-ONLY —
 *      no listener is opened, the pasted `code#state` is the channel
 *      (oauthPasteOnly() tells a wizard which prompt to show).
 *   B: { oauth: { label, clientId, deviceAuthorizationUrl, tokenUrl,
 *                 scope?, pollInterval? } }
 * tokensToAuth() maps the token response to the stored auth payload
 * ({type:"oauth", access, refresh, expires} — `token` mirrors `access`
 * so the wire layer's bearer auth works unchanged).
 */

import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

/**
 * Encode bytes as unpadded base64url text.
 * @param {Buffer|Uint8Array|string} bytes - Input passed through `Buffer.from`.
 * @returns {string} Base64url-encoded value with trailing padding removed.
 */
function base64url(bytes) {
  return Buffer.from(bytes).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a PKCE verifier and its S256 challenge using cryptographic randomness.
 * @returns {{verifier: string, challenge: string}} The base64url verifier and challenge.
 * @throws {Error} If the platform's cryptographic random or digest operation fails.
 */
export function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Build the authorization endpoint URL from a PKCE flow descriptor.
 * @param {object} descriptor - OAuth preset fields, including `authorizeUrl`, `clientId`, `redirectUri`, `scope`, and optional `extraAuthorizeParams`.
 * @param {{state: string, challenge: string}} params - Flow state and PKCE challenge.
 * @returns {string} The complete URL with standard OAuth/PKCE query parameters and extra parameters applied.
 * @throws {TypeError} If the authorization URL or parameter values cannot be used to construct a URL.
 */
export function authorizeUrl(descriptor, { state, challenge }) {
  const url = new URL(descriptor.authorizeUrl);
  url.searchParams.set("client_id", descriptor.clientId);
  url.searchParams.set("redirect_uri", descriptor.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", descriptor.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(descriptor.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Parse pasted authorization input: a full redirect URL
 * (`...?code=…&state=…`), `code#state`, or a bare code.
 * @param {string} input - Pasted full redirect URL, `code#state`, or bare code; nullish values are treated as empty text.
 * @returns {{code?: string, state?: string}} Parsed non-empty code and/or state; empty input yields an empty object.
 * @effects Trims the input and attempts URL parsing; malformed URL input is then interpreted as the short form.
 */
export function parseAuthorizationInput(input) {
  const value = String(input ?? "").trim();
  if (value === "") return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch { /* not a URL */ }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code: code || undefined, state: state || undefined };
  }
  return { code: value };
}

/**
 * Attempt to open a URL in the platform's system browser as a detached process.
 * @param {string} url - URL to open.
 * @returns {boolean} `true` if the process was spawned, otherwise `false`; later child-process errors are ignored.
 * @effects Spawns `open`, `cmd /c start`, or `xdg-open` according to the platform.
 */
export function openInBrowser(url) {
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine whether a redirect URI names one of the supported loopback hosts.
 * @param {string} redirectUri - URI whose hostname is checked.
 * @returns {boolean} `true` for `localhost`, `127.0.0.1`, or `::1`; malformed URIs and other hosts return `false`.
 */
function isLoopback(redirectUri) {
  try {
    const host = new URL(redirectUri).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Determine whether a flow is paste-only: an authorization-code flow with
 * a non-loopback redirect URI, where the provider-hosted callback displays
 * the code instead of delivering it to a local listener.
 * @param {object} descriptor - The endpoint preset's `oauth` block.
 * @returns {boolean} `true` when there is no string device-authorization URL and the string redirect URI is not loopback.
 */
export function oauthPasteOnly(descriptor) {
  return typeof descriptor?.deviceAuthorizationUrl !== "string" &&
    typeof descriptor?.redirectUri === "string" && !isLoopback(descriptor.redirectUri);
}

/**
 * POST one request to the descriptor's token endpoint, encoding fields as
 * form-urlencoded by default or JSON when `tokenFormat` is `"json"`.
 * @param {object} descriptor - OAuth descriptor; supplies `tokenUrl` and optional `tokenFormat`.
 * @param {object} fields - Request fields to encode in the POST body.
 * @param {{signal?: AbortSignal}} [options={}] - Optional fetch abort signal.
 * @returns {Promise<object>} Resolves with the parsed JSON token response.
 * @throws {Error} If the response is not successful; includes its HTTP status and up to 200 response-text characters.
 * @throws {TypeError|SyntaxError} If fetch fails or a successful response is not valid JSON.
 */
async function postTokenRequest(descriptor, fields, { signal } = {}) {
  const json = descriptor.tokenFormat === "json";
  const response = await fetch(descriptor.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Exchange an authorization code for tokens using the PKCE verifier.
 * Includes `state` only when `descriptor.tokenIncludesState === true` and state is provided.
 * @param {object} descriptor - OAuth descriptor with token endpoint, client ID, redirect URI, and optional state-inclusion setting.
 * @param {{code: string, verifier: string, state?: string}} credentials - Authorization code, PKCE verifier, and optional state.
 * @returns {Promise<object>} Resolves with the parsed token response from the token endpoint.
 * @throws {Error|TypeError|SyntaxError} Propagates token-request HTTP, fetch, or JSON parsing failures.
 */
async function exchangeCode(descriptor, { code, verifier, state }) {
  return postTokenRequest(descriptor, {
    grant_type: "authorization_code",
    code,
    ...(descriptor.tokenIncludesState === true && state !== undefined ? { state } : {}),
    redirect_uri: descriptor.redirectUri,
    client_id: descriptor.clientId,
    code_verifier: verifier,
  });
}

/**
 * Refresh stored OAuth credentials without repeating browser or device authorization.
 * The response may omit `refresh_token`; callers can preserve the prior value when mapping it with `tokensToAuth`.
 * @param {object} descriptor - OAuth descriptor containing a string `tokenUrl` and the client ID.
 * @param {string} refresh - Non-empty stored refresh token.
 * @param {{signal?: AbortSignal}} [options={}] - Optional fetch abort signal.
 * @returns {Promise<object>} Resolves with the parsed token response.
 * @throws {Error} If the token URL or refresh token is missing/invalid, or the endpoint returns a non-success status.
 * @throws {TypeError|SyntaxError} If fetch fails or the successful response is not valid JSON.
 */
export async function refreshOAuthTokens(descriptor, refresh, { signal } = {}) {
  if (typeof descriptor?.tokenUrl !== "string" || typeof refresh !== "string" || refresh === "") {
    throw new Error("OAuth refresh requires a token URL and refresh token");
  }
  return postTokenRequest(descriptor, {
    grant_type: "refresh_token", refresh_token: refresh, client_id: descriptor.clientId,
  }, { signal });
}

/* -------------------------------------------------- the pending flow */

let pendingPaste = null; // resolve(input) of the in-flight flow, if any

/**
 * Feed pasted authorization input (a redirect URL, `code#state`, or code) to the current authorization-code flow.
 * @param {string} input - User-pasted authorization input passed to the waiting flow for parsing.
 * @returns {boolean} `true` if a flow was waiting and was resumed, otherwise `false`.
 * @effects Clears the pending paste resolver before invoking it; does not affect device-authorization flows.
 */
export function completeOAuthPaste(input) {
  if (!pendingPaste) return false;
  const resolve = pendingPaste;
  pendingPaste = null;
  resolve(input);
  return true;
}

/**
 * Run one OAuth sign-in, selecting device authorization when the descriptor
 * has a string `deviceAuthorizationUrl`, otherwise authorization code + PKCE.
 * @param {object} descriptor - The endpoint preset's `oauth` block for the selected grant.
 * @param {object} [options={}] - Flow options forwarded to the selected implementation.
 * @param {(url: string) => void} [options.onAuthUrl] - Called with the URL the user must visit; browser opening is attempted separately.
 * @param {(line: string) => void} [options.onLog] - Called with progress messages; defaults to a no-op.
 * @param {AbortSignal} [options.signal] - Signal used to cancel the sign-in where supported.
 * @param {(url: string) => boolean} [options.open] - Browser-opening function; defaults to `openInBrowser`.
 * @returns {Promise<object>} Resolves with the provider's token response.
 * @throws {Error|TypeError|SyntaxError} Propagates flow, network, endpoint, parsing, cancellation, expiry, denial, or state-validation failures.
 * @effects May open a browser, invoke progress callbacks, and perform OAuth network requests; authorization-code flows also use a temporary loopback listener or wait for pasted input.
 */
export async function runOAuthFlow(descriptor, options = {}) {
  if (typeof descriptor?.deviceAuthorizationUrl === "string") {
    return runDeviceFlow(descriptor, options); // grant shape B (RFC 8628)
  }
  return runAuthorizationCodeFlow(descriptor, options); // grant shape A (PKCE)
}

/**
 * Grant shape B: the RFC 8628 DEVICE AUTHORIZATION flow — the device
 * code request returns a user code and a verification URL; the token
 * URL is polled until approval, expiry, or denial. This flow does not use
 * a loopback listener or the paste fallback.
 * @param {object} descriptor - Device-flow OAuth descriptor with `deviceAuthorizationUrl`, `tokenUrl`, `clientId`, and optional `scope`, `pollInterval`, and `label`.
 * @param {object} [options={}] - Flow callbacks and cancellation settings.
 * @param {(url: string) => void} [options.onAuthUrl] - Called with the verification URL after the browser-opening attempt.
 * @param {(line: string) => void} [options.onLog=() => {}] - Receives progress and user instructions; defaults to a no-op.
 * @param {AbortSignal} [options.signal] - Signal checked for cancellation between polls and passed to requests.
 * @param {(url: string) => boolean} [options.open=openInBrowser] - Browser opener for the verification URL.
 * @returns {Promise<object>} Resolves with the token response after approval.
 * @throws {Error} For failed/malformed device authorization, cancellation, expiry, denial, or a non-retryable token-poll response.
 * @throws {TypeError} If fetch or callbacks fail; transient HTTP 5xx poll responses are retried until expiry.
 * @effects Opens (or attempts to open) the verification URL, calls supplied callbacks, and makes device-code and polling HTTP requests.
 */
async function runDeviceFlow(descriptor, { onAuthUrl, onLog = () => {}, signal, open = openInBrowser } = {}) {
  /** POST device-flow form fields and return status plus best-effort parsed JSON.
   * @param {string} url - Device authorization or token endpoint URL.
   * @param {object} fields - Form fields to submit.
   * @returns {Promise<{status: number, ok: boolean, json: object|null}>} HTTP result; invalid/non-JSON response bodies produce `json: null`.
   * @effects Performs a fetch POST using form-urlencoded encoding and the enclosing flow's abort signal.
   */
  const post = async (url, fields) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
      signal,
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, json };
  };
  const start = await post(descriptor.deviceAuthorizationUrl, {
    client_id: descriptor.clientId,
    ...(descriptor.scope ? { scope: descriptor.scope } : {}),
  });
  if (!start.ok || typeof start.json?.device_code !== "string") {
    throw new Error(`device authorization failed (HTTP ${start.status}): ${JSON.stringify(start.json)?.slice(0, 200) ?? ""}`);
  }
  const device = start.json;
  const verification = device.verification_uri_complete ?? device.verification_uri;
  if (typeof verification !== "string" || typeof device.user_code !== "string") {
    throw new Error("device authorization response is missing the verification data");
  }
  const opened = open(verification);
  onAuthUrl?.(verification);
  onLog(opened
    ? `browser opened for ${descriptor.label ?? "sign-in"} — approve the code there: ${device.user_code}`
    : `open ${device.verification_uri ?? verification} and enter the code: ${device.user_code}`);
  if (device.verification_uri && device.verification_uri_complete) {
    onLog(`verification: ${device.verification_uri} — code: ${device.user_code}`);
  }
  let interval = Number.isFinite(device.interval) && device.interval > 0
    ? device.interval
    : (descriptor.pollInterval ?? 5);
  const expiresMs = (Number.isFinite(device.expires_in) && device.expires_in > 0 ? device.expires_in : 900) * 1000;
  const deadline = Date.now() + expiresMs;
  onLog("waiting for the sign-in to be approved…");
  for (;;) {
    if (signal?.aborted) throw new Error("sign-in cancelled");
    if (Date.now() > deadline) throw new Error("device authorization expired — start the login again");
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const poll = await post(descriptor.tokenUrl, {
      client_id: descriptor.clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (poll.ok && typeof poll.json?.access_token === "string") return poll.json;
    const error = poll.json?.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const next = poll.json?.interval; // the server may name its own pace; RFC default: +5s
      interval = Number.isFinite(next) && next > 0 ? next : interval + 5;
      continue;
    }
    if (error === "expired_token") throw new Error("device authorization expired — start the login again");
    if (error === "access_denied") throw new Error("sign-in was denied");
    if (poll.status >= 500) continue; // transient: keep polling until the deadline
    throw new Error(`device token poll failed (HTTP ${poll.status})${typeof error === "string" ? `: ${error}` : ""}`);
  }
}

/**
 * Grant shape A: PKCE + browser, with the LOOPBACK listener when the
 * redirect URI is one (the browser lands the code on it) and the paste
 * fallback always (headless use; the ONLY channel when the redirect is
 * a provider-hosted callback page — see oauthPasteOnly). Resolves the
 * token response.
 * @param {object} descriptor - Authorization-code OAuth descriptor with authorization/token URLs, client ID, redirect URI, and scope.
 * @param {object} [options={}] - Flow callbacks and cancellation settings.
 * @param {(url: string) => void} [options.onAuthUrl] - Called with the authorization URL after the browser-opening attempt.
 * @param {(line: string) => void} [options.onLog=() => {}] - Receives progress and user instructions; defaults to a no-op.
 * @param {AbortSignal} [options.signal] - Signal that cancels the flow by rejecting its wait.
 * @param {(url: string) => boolean} [options.open=openInBrowser] - Browser opener for the authorization URL.
 * @returns {Promise<object>} Resolves with the token response after code exchange.
 * @throws {Error} For listener startup, cancellation, missing code, state mismatch, or token-exchange failures.
 * @effects Attempts to open a browser, calls callbacks, waits for loopback or pasted authorization input, posts the token exchange, and closes any loopback listener on completion/failure.
 */
async function runAuthorizationCodeFlow(descriptor, { onAuthUrl, onLog = () => {}, signal, open = openInBrowser } = {}) {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");
  const url = authorizeUrl(descriptor, { state, challenge });
  const pasteOnly = oauthPasteOnly(descriptor);

  const opened = open(url);
  onAuthUrl?.(url);
  onLog(opened
    ? `browser opened for ${descriptor.label ?? "sign-in"} — complete the sign-in there`
    : `open this URL in a browser: ${url}`);

  const listener = pasteOnly ? null : loopbackListener(descriptor.redirectUri);
  const pasted = new Promise((resolve) => { pendingPaste = resolve; });
  const aborted = new Promise((_, reject) => {
    if (signal) {
      signal.addEventListener("abort", () => reject(new Error("sign-in cancelled")), { once: true });
    }
  });

  try {
    if (listener) await listener.listening;
    onLog(pasteOnly
      ? "waiting for the code — paste what the sign-in page shows (code#state)"
      : "waiting for sign-in… (headless? paste the redirect URL — the flow accepts it too)");
    const result = await Promise.race([
      ...(listener ? [listener.callback] : []),
      pasted.then((input) => {
        const parsed = parseAuthorizationInput(input);
        if (!parsed.code) throw new Error("no authorization code in the pasted input");
        return parsed;
      }),
      aborted,
    ]);
    if (result.state !== undefined && result.state !== state) {
      throw new Error("sign-in state mismatch — start the login again");
    }
    return await exchangeCode(descriptor, { code: result.code, verifier, state });
  } finally {
    pendingPaste = null;
    listener?.close();
  }
}

/**
 * Start a loopback HTTP listener for the redirect URI, resolving the code and returned state delivered by the browser.
 * @param {string} redirectUri - Loopback redirect URI; its port (default 80) and pathname are used to bind and match callbacks.
 * @returns {{listening: Promise<void>, callback: Promise<{code: string, state: string|null}>, close: () => void}} Startup promise, one callback-result promise, and a server-close function.
 * @throws {TypeError} If `redirectUri` cannot be parsed as a URL.
 * @throws {Error} The `listening` or `callback` promise rejects on server errors; callback rejects when the matching redirect contains no code.
 * @effects Binds an HTTP server to `127.0.0.1` at the redirect port, serves matching callback requests, and requires callers to invoke `close()` to stop it.
 */
function loopbackListener(redirectUri) {
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port || 80);
  const expectedPath = redirect.pathname || "/";
  let server;
  const callback = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url, `http://localhost:${port}`);
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (reqUrl.pathname !== expectedPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h2>Sign-in complete — you can close this tab and return to the terminal.</h2></body></html>");
      if (!code) {
        reject(new Error(`sign-in redirect carried no code (${reqUrl.searchParams.get("error") ?? "unknown"})`));
        return;
      }
      resolve({ code, state: returnedState });
    });
    server.on("error", reject);
  });
  const listening = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(port, "127.0.0.1");
  });
  return { listening, callback, close: () => server.close() };
}

/**
 * Map a provider token response to the stored OAuth auth payload. `token` mirrors
 * `access` so bearer-auth wire code needs no OAuth awareness.
 * @param {object} tokens - Provider response; requires a non-empty string `access_token`, with optional `refresh_token` and finite `expires_in`.
 * @param {object} [previous={}] - Prior auth payload; its non-empty string `refresh` is retained if the response omits a usable refresh token.
 * @returns {{type: string, access: string, token: string, refresh?: string, expires?: number}} Auth payload; `expires` is the current time plus `expires_in` seconds when finite.
 * @throws {Error} If the response has no non-empty string `access_token`.
 * @effects Reads the current wall-clock time when `expires_in` is finite.
 */
export function tokensToAuth(tokens, previous = {}) {
  if (typeof tokens?.access_token !== "string" || tokens.access_token === "") {
    throw new Error("token response carried no access_token");
  }
  const auth = { type: "oauth", access: tokens.access_token, token: tokens.access_token };
  if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== "") {
    auth.refresh = tokens.refresh_token;
  } else if (typeof previous.refresh === "string" && previous.refresh !== "") {
    auth.refresh = previous.refresh;
  }
  if (Number.isFinite(tokens.expires_in)) {
    auth.expires = Date.now() + tokens.expires_in * 1000;
  }
  return auth;
}
