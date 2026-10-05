/* Env-private MCP OAuth controller: discovery, browser sign-in, and user-only credentials. */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, lstatSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { openInBrowser, generatePKCE } from "../../cli/oauth.js";

export const CLIENT_ID = "https://omoya.ai/oauth/client.json";
export const REDIRECT = "http://localhost:8765/oauth/callback";
const MAX_METADATA = 65536;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const token = (size = 24) => randomBytes(size).toString("base64url");
const secureUrl = (raw) => {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error("MCP OAuth URL must be HTTPS or loopback HTTP without credentials/fragment");
  return url;
};
export function canonical(raw) {
  const url = secureUrl(raw);
  // Preserve path, including meaningful trailing slashes, and query as part of the resource identity.
  return url.pathname === "/" && !url.search ? url.origin : url.href;
}
/** Parse RFC 6750 Bearer challenges, including escaped quoted values. */
export function bearerChallenge(header = "") {
  const start = /(?:^|,)\s*Bearer\s+/i.exec(header);
  if (!start) return {};
  const out = {};
  const remainder = header.slice(start.index + start[0].length);
  const pairs = /([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))\s*(?:,|$)/g;
  for (const match of remainder.matchAll(pairs)) out[match[1]] = match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, "$1");
  return out;
}
/** Strict bounded metadata fetch, no redirects or forwarded bearer token. */
async function metadata(url, signal) {
  secureUrl(url);
  const response = await fetch(url, { signal, redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OAuth metadata HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_METADATA) throw new Error("OAuth metadata too large");
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_METADATA) throw new Error("OAuth metadata too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function issuerUrls(raw) {
  const url = secureUrl(raw);
  const path = url.pathname.replace(/^\/|\/$/g, "");
  return ["oauth-authorization-server", "openid-configuration"].map((kind) => `${url.origin}/.well-known/${kind}${path ? `/${path}` : ""}`)
    .concat(path ? [`${url.origin}/${path}/.well-known/openid-configuration`] : []);
}
async function discover(resource, challenge, signal) {
  const url = new URL(resource);
  const path = url.pathname.replace(/^\/|\/$/g, "");
  const locations = challenge.resource_metadata ? [challenge.resource_metadata]
    : [`${url.origin}/.well-known/oauth-protected-resource${path ? `/${path}` : ""}`, `${url.origin}/.well-known/oauth-protected-resource`];
  if (challenge.resource_metadata && new URL(challenge.resource_metadata).origin !== url.origin) throw new Error("MCP resource metadata URL must share the server origin");
  let document;
  for (const location of locations) {
    try { document = await metadata(location, signal); break; } catch (error) { if (challenge.resource_metadata || signal?.aborted) throw error; }
  }
  if (!document || typeof document.resource !== "string" || canonical(document.resource) !== resource || !Array.isArray(document.authorization_servers) || !document.authorization_servers.length) throw new Error("Invalid MCP protected resource metadata");
  const issuers = document.authorization_servers.map((issuer) => {
    if (typeof issuer !== "string") throw new Error("Invalid OAuth issuer");
    secureUrl(issuer);
    return issuer; // RFC 8414 and RFC 9207 require exact string comparison, not URL normalization.
  });
  return { document, issuers };
}
async function discoverIssuer(issuer, signal) {
  for (const url of issuerUrls(issuer)) {
    let document;
    try { document = await metadata(url, signal); } catch (error) { if (signal?.aborted) throw error; continue; }
    if (document.issuer !== issuer) throw new Error("OAuth metadata issuer mismatch");
    if (!document.code_challenge_methods_supported?.includes("S256")) throw new Error("OAuth server does not advertise PKCE S256");
    for (const key of ["authorization_endpoint", "token_endpoint"]) secureUrl(document[key]);
    return document;
  }
  throw new Error("OAuth authorization-server metadata unavailable");
}
function authPath(env, name, resource, issuer) {
  if (!env._settingsDir || env._authEnabled === false) throw new Error("MCP OAuth credentials are unavailable in this environment");
  const digest = createHash("sha256").update(JSON.stringify([name, resource, issuer])).digest("hex");
  return join(env._settingsDir, `mcp-auth-${digest}.json`);
}
function readAuth(env, name, resource, issuer) {
  const path = authPath(env, name, resource, issuer);
  if (lstatSync(env._settingsDir).isSymbolicLink()) throw new Error("MCP auth folder is an unsafe path");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077) throw new Error("MCP OAuth credential file has unsafe permissions");
  const record = JSON.parse(readFileSync(path, "utf8"));
  return record.name === name && record.resource === resource && record.issuer === issuer && typeof record.access === "string" && record.access ? record : null;
}
function saveAuth(env, record) {
  const path = authPath(env, record.name, record.resource, record.issuer);
  mkdirSync(env._settingsDir, { recursive: true, mode: 0o700 });
  if (lstatSync(env._settingsDir).isSymbolicLink()) throw new Error("MCP auth folder is an unsafe path");
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).mode & 0o077)) throw new Error("MCP credential target has unsafe permissions");
  const tmp = `${path}.${token(8)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record));
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}
async function postToken(document, fields, signal) {
  const response = await fetch(document.token_endpoint, { method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields) });
  if (!response.ok) throw new Error(`OAuth token exchange failed (HTTP ${response.status})`);
  const result = await response.json();
  if (typeof result.access_token !== "string" || !result.access_token) throw new Error("OAuth token exchange returned no access token");
  return result;
}
function tokenRecord(base, result) {
  return { ...base, access: result.access_token, refresh: result.refresh_token || base.refresh,
    expires: Number.isFinite(result.expires_in) ? Date.now() + result.expires_in * 1000 : null,
    scopes: [...new Set([...(base.scopes ?? []), ...(typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : [])])] };
}
function callbackWait(expected, signal) {
  let server, resolve, reject;
  const received = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Listener startup may fail before received is awaited; consume a cancellation rejection.
  received.catch(() => {});
  server = createServer((request, response) => {
    const url = new URL(request.url, REDIRECT);
    if (request.method !== "GET" || url.pathname !== new URL(REDIRECT).pathname || request.headers.host !== new URL(REDIRECT).host) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/plain" }).end("Return to Omoya to complete sign-in.");
    resolve(url.href);
  });
  const ready = new Promise((yes, no) => {
    server.once("error", (error) => no(error.code === "EADDRINUSE"
      ? new Error("MCP OAuth callback port 8765 is occupied; stop the other listener and try again") : error));
    server.listen(8765, "127.0.0.1", yes);
  });
  const abort = () => reject(new Error("MCP sign-in cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  return { ready, received, finish: (url) => resolve(url), close: () => { signal?.removeEventListener("abort", abort); server.close(); }, expected };
}
export function createMcpAuth(env, name, config, publish) {
  const resource = canonical(config.url);
  let challenge = {}, discovered = null, record = null, pending = null, refreshing = null, needLogin = false, requestedScopes = [];
  const instruction = () => `MCP ${name} needs sign-in; run om --mcp-login ${name}`;
  async function discovery(signal) {
    if (discovered) return discovered;
    const resourceDoc = await discover(resource, challenge, signal);
    const issuer = config.oauth?.issuer ?? resourceDoc.issuers[0];
    if (!resourceDoc.issuers.includes(issuer)) throw new Error("Configured MCP OAuth issuer not advertised by resource");
    const document = await discoverIssuer(issuer, signal);
    discovered = { issuer, document, resourceDoc: resourceDoc.document };
    record = readAuth(env, name, resource, issuer);
    return discovered;
  }
  async function refresh(signal) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const { document } = await discovery(signal);
      if (!record?.refresh) throw new Error(instruction());
      const result = await postToken(document, { grant_type: "refresh_token", refresh_token: record.refresh,
        client_id: record.clientId, resource }, signal);
      record = tokenRecord(record, result);
      saveAuth(env, record);
      return record;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function bearer(signal) {
    if (needLogin) throw new Error(instruction());
    if (env._authEnabled === false) return null;
    if (!discovered) {
      // Reload persisted credentials only after validating the issuer from resource metadata.
      // A server that has not challenged yet may not publish metadata: probe it unauthenticated.
      try { await discovery(signal); } catch (error) { if (signal?.aborted || /unsafe permissions|unsafe path/.test(error.message)) throw error; return null; }
    }
    if (!record) return null;
    if (record.expires && record.expires < Date.now() + 30_000) {
      try { await refresh(signal); } catch { needLogin = true; publish?.(); throw new Error(instruction()); }
    }
    return record.access;
  }
  function challenged(error) {
    if (error.status !== 401 && error.status !== 403) return false;
    const next = bearerChallenge(error.wwwAuthenticate);
    if (error.status === 403 && next.error !== "insufficient_scope") return false;
    challenge = next;
    needLogin = true; publish?.();
    error.message = instruction();
    return true;
  }
  async function clientId(document, issuer, signal) {
    if (config.oauth?.clientId) return config.oauth.clientId;
    if (document.client_id_metadata_document_supported === true) return CLIENT_ID;
    if (!document.registration_endpoint) throw new Error("MCP OAuth needs a registered client ID (configure mcp.<name>.oauth.clientId)");
    secureUrl(document.registration_endpoint);
    if (record?.registration === "dcr" && record?.clientId && record.issuer === issuer) return record.clientId;
    const response = await fetch(document.registration_endpoint, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Omoya MCP Client",
        redirect_uris: [REDIRECT], application_type: "native", token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    if (!response.ok) throw new Error(`MCP OAuth client registration failed (HTTP ${response.status})`);
    const registered = await response.json();
    if (typeof registered.client_id !== "string" || !registered.client_id) throw new Error("MCP OAuth registration returned no client ID");
    return registered.client_id;
  }
  async function login({ onAuthUrl, onLog, signal, open = openInBrowser } = {}) {
    if (pending) throw new Error("MCP sign-in already in progress");
    if (env._authEnabled === false) throw new Error("MCP OAuth is unavailable in reduced environments");
    const { issuer, document, resourceDoc } = await discovery(signal);
    const id = await clientId(document, issuer, signal);
    const scopes = [...new Set([...requestedScopes, ...(record?.scopes ?? []), ...((challenge.scope ?? resourceDoc.scopes_supported?.join(" ") ?? "").split(/\s+/).filter(Boolean))])];
    requestedScopes = scopes;
    const state = token(), { verifier, challenge: codeChallenge } = generatePKCE();
    const url = new URL(document.authorization_endpoint);
    url.search = ""; // metadata endpoint query parameters cannot override authorization parameters
    for (const [key, value] of Object.entries({ response_type: "code", client_id: id, redirect_uri: REDIRECT,
      code_challenge: codeChallenge, code_challenge_method: "S256", state, resource })) url.searchParams.set(key, value);
    if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
    pending = callbackWait(state, signal);
    try {
      await pending.ready;
      onAuthUrl?.(url.href); onLog?.("Open the sign-in URL and complete authorization.");
      open?.(url.href);
      const raw = await pending.received;
      const callback = new URL(raw);
      if (callback.origin !== new URL(REDIRECT).origin || callback.pathname !== new URL(REDIRECT).pathname || callback.searchParams.get("state") !== state) throw new Error("MCP OAuth callback/state mismatch");
      const iss = callback.searchParams.get("iss");
      if ((document.authorization_response_iss_parameter_supported === true && !iss) || (iss && iss !== issuer)) throw new Error("MCP OAuth response issuer mismatch");
      if (callback.searchParams.has("error")) throw new Error("MCP OAuth authorization denied");
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("MCP OAuth callback has no code");
      const result = await postToken(document, { grant_type: "authorization_code", code, client_id: id,
        redirect_uri: REDIRECT, code_verifier: verifier, resource }, signal);
      record = tokenRecord({ name, resource, issuer, clientId: id, scopes,
        ...(id !== CLIENT_ID && !config.oauth?.clientId ? { registration: "dcr" } : {}) }, result);
      saveAuth(env, record);
      needLogin = false; publish?.();
      return { name };
    } finally { pending.close(); pending = null; }
  }
  return { bearer, challenged, login, paste: (url) => { if (!pending) return false; pending.finish(url); return true; },
    get needsLogin() { return needLogin; }, get resource() { return resource; } };
}
