import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../lib/namespace.js";
import { Env } from "../lib/env.js";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { providerAdd } from "./env-internals.js";

// Regression: browser sign-in must verify and persist credentials rather than
// reporting success for an unverified in-memory login that leaves the endpoint
// marked sign-in required. Also covers adopting the selected endpoint.

let dir, cwd, server, tokenUrl;
const savedSettingsDir = process.env[NAMES.settingsEnv];

class OAuthProtocol {
  static provider = { label: "OAuth", capabilities: {} };
  static login({ token }) { return { type: "api_key", token }; }
  static async testConnection() { return { models: 1 }; }
  static async models() { return { "model-1": { label: "Model 1" } }; }
  static knownEndpoints = [];
}

beforeEach(async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = mkdtempSync("./ai-tmp/web-oauth-");
  cwd = join(dir, "project");
  mkdirSync(cwd);
  process.env[NAMES.settingsEnv] = dir;
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  tokenUrl = `http://127.0.0.1:${server.address().port}/token`;
  // A non-loopback redirect URI makes the flow paste-only: no listener, the
  // endpoint.oauth-paste packet (completeOAuthPaste) is the completion channel.
  OAuthProtocol.knownEndpoints = [{
    name: "wire-oauth", label: "Wire OAuth", provider: "wire", url: "https://wire.test/v1",
    oauth: {
      label: "Wire OAuth", clientId: "client-1",
      authorizeUrl: "https://wire.test/authorize", tokenUrl,
      redirectUri: "https://wire.test/callback", scope: "scope-1",
    },
  }];
});

afterEach(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedSettingsDir === undefined) delete process.env[NAMES.settingsEnv];
  else process.env[NAMES.settingsEnv] = savedSettingsDir;
});

const waitFor = async (sent, predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = sent.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
};

test("web endpoint.oauth sign-in completes and the attached agent adopts the endpoint", async () => {
  const env = await Env.open(cwd, { dir, init: { providers: false } });
  await env.ready();
  providerAdd(env, "wire", OAuthProtocol);
  env.settings.providers["wire-oauth"] = { provider: "wire", url: "https://wire.test/v1", models: { "model-1": {} } };
  env.connection("wire-oauth/model-1", { remember: false }).authSet({ loginRequired: true });
  const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
  const sent = [];
  const ws = { readyState: WebSocket.OPEN, send: (json) => sent.push(JSON.parse(json)) };
  try {
    await workspace.open(ws);
    await workspace.message(ws, JSON.stringify({ type: "endpoint.oauth", name: "wire-oauth" }));
    const urlPacket = await waitFor(sent, (packet) => packet.type === "oauth" && packet.state === "url");
    expect(urlPacket).toBeDefined();
    const state = new URL(urlPacket.url).searchParams.get("state");
    expect(typeof state).toBe("string");
    await workspace.message(ws, JSON.stringify({ type: "endpoint.oauth-paste", input: `code-1#${state}` }));
    const outcome = await waitFor(sent, (packet) => packet.type === "oauth" && (packet.state === "done" || packet.state === "error"));
    if (outcome?.state !== "done") throw new Error(outcome?.text ?? "no OAuth outcome");
    expect(outcome?.text).toContain("signed in: wire-oauth");
    expect(env.connection("wire-oauth/model-1", { remember: false }).settings.loginRequired).not.toBe(true);
    // Successful sign-in is verified and saved in the user auth file.
    expect(JSON.parse(readFileSync(join(dir, "auth-wire-oauth.json"), "utf8"))["wire-oauth"]).toMatchObject({
      provider: "wire", url: "https://wire.test/v1",
      auth: { type: "oauth", access: "access-1", refresh: "refresh-1" },
    });
  } finally {
    workspace.close(ws);
    workspace.stop();
    await env.close();
  }
});
