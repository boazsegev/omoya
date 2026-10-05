import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Env } from "../lib/env.js";
import { bearerChallenge, CLIENT_ID, REDIRECT } from "../lib/env/mcp/oauth.js";

async function fixture({ cimd = true, issuerInResponse = true, clientId, stepUp = false, expire = false } = {}) {
  let port, tokenSeen = [], registrations = 0, tokenRequests = 0, lastTokenFields = null;
  const server = createServer(async (req, res) => {
    const origin = `http://localhost:${port}`;
    const url = new URL(req.url, origin);
    const json = (body, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: cimd, authorization_response_iss_parameter_supported: issuerInResponse });
    if (url.pathname === "/token") {
      const body = await new Response(req).text();
      const fields = new URLSearchParams(body);
      tokenRequests++;
      lastTokenFields = fields;
      if (fields.get("resource") !== `${origin}/mcp` || fields.get("client_id") !== (clientId ?? (cimd ? CLIENT_ID : "registered"))) return json({ error: "invalid_request" }, 400);
      if (fields.get("grant_type") === "authorization_code" && (!fields.get("code_verifier") || fields.get("redirect_uri") !== REDIRECT)) return json({ error: "invalid_request" }, 400);
      const refreshing = fields.get("grant_type") === "refresh_token";
      return json({ access_token: refreshing ? "refreshed" : fields.get("code") === "upgrade" ? "upgraded" : "access",
        refresh_token: refreshing ? "rotated" : "refresh", expires_in: refreshing ? 3600 : expire ? 0 : 3600,
        scope: refreshing ? "read" : fields.get("code") === "upgrade" ? "read write" : "read" });
    }
    if (url.pathname === "/register") { registrations++; return json({ client_id: "registered" }); }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization;
      tokenSeen.push(auth);
      if (!["Bearer access", "Bearer refreshed", "Bearer upgraded"].includes(auth)) return json({}, 401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"` });
      const payload = JSON.parse(await new Response(req).text());
      if (payload.method === "server/discover") return json({ jsonrpc: "2.0", id: payload.id, result: { supportedVersions: ["2026-07-28"], capabilities: { resources: {}, prompts: {} } } });
      if (payload.method === "resources/list") return json({ jsonrpc: "2.0", id: payload.id, result: { resources: [{ uri: "fixture://readme", name: "Readme" }] } });
      if (payload.method === "resources/read") return json({ jsonrpc: "2.0", id: payload.id, result: { contents: [{ uri: "fixture://readme", text: "Hello" }] } });
      if (payload.method === "tools/list") return json({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "picture", inputSchema: { type: "object" } }] } });
      if (payload.method === "tools/call") return json({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "a picture" }, { type: "image", data: "AQID", mimeType: "image/png" }] } });
      if (payload.method === "prompts/list") return json({ jsonrpc: "2.0", id: payload.id, result: { prompts: [{ name: "greet" }] } });
      if (payload.method === "prompts/get") {
        if (stepUp && auth !== "Bearer upgraded") return json({}, 403, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="write", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return json({ jsonrpc: "2.0", id: payload.id, result: { messages: [{ role: "assistant", content: { type: "text", text: "Hello" } }] } });
      }
      return json({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } });
    }
    json({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  port = server.address().port;
  const dir = mkdtempSync("./ai-tmp/mcp-oauth-");
  const env = new Env({ dir, settingsDir: dir, cwd: dir, settings: { mcp: { fixture: { url: `http://localhost:${port}/mcp`, oauth: { ...(clientId ? { clientId, issuer: `http://localhost:${port}` } : {}) } } } } });
  return { env, dir, server, origin: `http://localhost:${port}`, get tokenSeen() { return tokenSeen; }, get registrations() { return registrations; }, get tokenRequests() { return tokenRequests; }, get lastTokenFields() { return lastTokenFields; } };
}
test("changing MCP resource URL cannot reuse another resource's bearer", async () => {
  const f = await fixture();
  try {
    let url;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
    for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
    f.env.mcpPaste(`${REDIRECT}?code=ok&state=${new URL(url).searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`);
    await login;
    const before = f.tokenSeen.length;
    f.env.settings.mcp = { fixture: { url: `${f.origin}/other`, oauth: {} } };
    await f.env.toolCall("tool-refresh", {});
    await expect(f.env.toolCall("mcp", { action: "resources", server: "fixture" })).rejects.toThrow(/MCP HTTP 404/);
    expect(f.tokenSeen.slice(before)).not.toContain("Bearer access");
  } finally { f.env.close(); f.server.close(); }
});
test("near-expiry access token refreshes, rotates token and includes resource", async () => {
  const f = await fixture({ expire: true });
  try {
    let url;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
    for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
    f.env.mcpPaste(`${REDIRECT}?code=ok&state=${new URL(url).searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`);
    await login;
    expect(await f.env.toolCall("mcp", { action: "resources", server: "fixture" })).toContain("fixture://readme");
    expect(f.tokenSeen).toContain("Bearer refreshed");
    expect(f.lastTokenFields.get("grant_type")).toBe("refresh_token");
    expect(f.lastTokenFields.get("resource")).toBe(`${f.origin}/mcp`);
    const file = readdirSync(f.dir).find((name) => name.startsWith("mcp-auth-"));
    expect(JSON.parse(readFileSync(`${f.dir}/${file}`, "utf8")).refresh).toBe("rotated");
  } finally { f.env.close(); f.server.close(); }
});
test("403 insufficient_scope requests explicit union of prior and challenged scopes", async () => {
  const f = await fixture({ stepUp: true });
  try {
    let url;
    const complete = async (code) => {
      url = null;
      const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
      for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
      const authorization = new URL(url);
      f.env.mcpPaste(`${REDIRECT}?code=${code}&state=${authorization.searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`);
      await login;
      return authorization;
    };
    expect((await complete("ok")).searchParams.get("scope")).toBe("read");
    await expect(f.env.toolCall("mcp", { action: "prompt", server: "fixture", name: "greet" })).rejects.toThrow(/needs sign-in/);
    expect(f.env.mcpStatus()[0].state).toBe("needs-sign-in");
    expect((await complete("upgrade")).searchParams.get("scope")).toBe("read write");
    expect(await f.env.toolCall("mcp", { action: "prompt", server: "fixture", name: "greet" })).toContain("Hello");
  } finally { f.env.close(); f.server.close(); }
});
test("configured client ID takes precedence over CIMD", async () => {
  const f = await fixture({ clientId: "pre-registered" });
  try {
    let url;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
    for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
    expect(new URL(url).searchParams.get("client_id")).toBe("pre-registered");
    f.env.mcpPaste(`${REDIRECT}?code=ok&state=${new URL(url).searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`);
    await login;
    expect(f.registrations).toBe(0);
  } finally { f.env.close(); f.server.close(); }
});
test("DCR fallback registers native client when CIMD is unavailable", async () => {
  const f = await fixture({ cimd: false });
  try {
    let url;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
    for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
    expect(new URL(url).searchParams.get("client_id")).toBe("registered");
    f.env.mcpPaste(`${REDIRECT}?code=ok&state=${new URL(url).searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`);
    await login;
    expect(f.registrations).toBe(1);
  } finally { f.env.close(); f.server.close(); }
});
test("advertised response issuer cannot be omitted or changed before token exchange", async () => {
  const f = await fixture();
  try {
    let url;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (value) => { url = value; } });
    for (let n = 0; !url && n < 100; n++) await Bun.sleep(5);
    f.env.mcpPaste(`${REDIRECT}?code=ok&state=${new URL(url).searchParams.get("state")}`);
    await expect(login).rejects.toThrow(/issuer mismatch/);
    expect(f.tokenRequests).toBe(0);
  } finally { f.env.close(); f.server.close(); }
});
test("Bearer challenge parses quoted scope and resource URI", () => {
  expect(bearerChallenge('Bearer resource_metadata="http://localhost/a,b", scope="read write", error="insufficient_scope"')).toEqual({ resource_metadata: "http://localhost/a,b", scope: "read write", error: "insufficient_scope" });
});
test("401 requires explicit sign-in, CIMD gets resource-bound token into user auth; resources/prompts become data", async () => {
  const f = await fixture();
  try {
    await expect(f.env.toolCall("mcp", { action: "resources", server: "fixture" })).rejects.toThrow(/needs sign-in/);
    expect(f.env.mcpStatus()).toEqual([{ name: "fixture", state: "needs-sign-in" }]);
    let authUrl;
    const login = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (url) => { authUrl = url; } });
    for (let n = 0; !authUrl && n < 100; n++) await Bun.sleep(5);
    expect(authUrl).toBeTruthy();
    const authorize = new URL(authUrl);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("resource")).toBe(`${f.origin}/mcp`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.env.mcpPaste(`${REDIRECT}?code=test&state=wrong&iss=${encodeURIComponent(f.origin)}`)).toBe(true);
    await expect(login).rejects.toThrow(/callback\/state mismatch/);
    const retry = f.env.mcpLogin("fixture", { open: () => {}, onAuthUrl: (url) => { authUrl = url; } });
    for (let n = 0; !f.env.mcpPaste(`${REDIRECT}?code=test&state=${new URL(authUrl).searchParams.get("state")}&iss=${encodeURIComponent(f.origin)}`) && n < 100; n++) await Bun.sleep(5);
    await retry;
    expect(f.registrations).toBe(0);
    expect(await f.env.toolCall("mcp", { action: "resources", server: "fixture" })).toContain("fixture://readme");
    expect(await f.env.toolCall("mcp", { action: "resource", server: "fixture", uri: "fixture://readme" })).toContain("Hello");
    expect(await f.env.toolCall("mcp", { action: "prompts", server: "fixture" })).toContain("greet");
    const image = await f.env.toolCall("mcp", { action: "call", server: "fixture", tool: "picture" });
    expect(image.content).toEqual([{ type: "text", text: "a picture" }, { type: "image", content: "AQID", mimetype: "image/png" }]);
    expect(await f.env.toolCall("mcp", { action: "prompt", server: "fixture", name: "greet" })).toContain("[assistant message]");
    expect(f.tokenSeen).toContain("Bearer access");
    f.env.close();
    const restarted = new Env({ dir: f.dir, cwd: f.dir, settingsDir: f.dir,
      settings: { mcp: { fixture: { url: `${f.origin}/mcp`, oauth: {} } } } });
    try {
      expect(await restarted.toolCall("mcp", { action: "resources", server: "fixture" })).toContain("fixture://readme");
    } finally { restarted.close(); }
    const files = readdirSync(f.dir).filter((entry) => entry.startsWith("mcp-auth-"));
    expect(files).toHaveLength(1);
    expect(statSync(`${f.dir}/${files[0]}`).mode & 0o077).toBe(0);
    expect(readFileSync(`${f.dir}/${files[0]}`, "utf8")).toContain("refresh");
    expect(readdirSync(f.dir).filter((entry) => entry === "settings.json")).toHaveLength(0);
  } finally { f.env.close(); f.server.close(); }
});
