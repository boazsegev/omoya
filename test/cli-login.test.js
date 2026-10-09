import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Env } from "../lib/env.js";
import CLI, { runLoginWizard } from "../lib/app/cli.js";
import { providerAdd, scope } from "./env-internals.js";
import Gemini from "../providers/gemini.js";

test("CLI facade excludes Env, OAuth, and internal helper duplicates", () => {
  for (const name of ["loginEndpoint", "logoutEndpoint", "defaultUrl", "tokensToAuth", "parseAuthorizationInput", "oauthPasteOnly", "runOAuthFlow", "completeOAuthPaste", "refreshOAuthTokens", "renderSettingsTemplate", "resolveToolArgs", "resolveCliToolArgs", "unwrapToolResult", "formatToolResult", "execute"]) {
    expect(CLI[name]).toBeUndefined();
  }
  expect(typeof CLI.runLoginWizard).toBe("function");
});

let dir, cwd;
const projectAuth = (name) => `${NAMES.projectAuthPrefix}${name}.json`;
const savedSettingsDir = process.env[NAMES.settingsEnv];
beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = mkdtempSync("./ai-tmp/login-");
  cwd = join(dir, "project");
  mkdirSync(cwd);
  // pin the user settings layer to THIS test's folder (dynamic writes)
  process.env[NAMES.settingsEnv] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSettingsDir === undefined) delete process.env[NAMES.settingsEnv];
  else process.env[NAMES.settingsEnv] = savedSettingsDir;
});

class LoginProtocol {
  static provider = { label: "Login", capabilities: {} };
  static login({ token }) { return { type: "api_key", token }; }
  static async testConnection() { return { models: 1 }; } // login always verifies
  static async models() { return { "model-1": { label: "Model 1" } }; }
}

describe("Env.login", () => {
  test("package scope writes the endpoint record to its auth file — never settings.json", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    providerAdd(env, "wire", LoginProtocol);
    await env.login("remote", { provider: "wire", url: "https://remote.test/v1", token: "secret" }, { scope: "package" });
    // a login NEVER writes settings.providers: the endpoint's record is
    // its AUTH FILE — provider, url, credentials, and the model cache
    expect(JSON.parse(readFileSync(join(dir, "auth-remote.json"), "utf8")).remote).toEqual({
      provider: "wire", url: "https://remote.test/v1",
      auth: { type: "api_key", token: "secret" }, models: { "model-1": { label: "Model 1" } },
    });
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    // and the auth file AUTO-CATALOGS the endpoint: a fresh environment
    // lists it without any settings.providers entry
    await env.close();
    const fresh = await Env.open(cwd, { dir, init: { providers: false }, providers: { wire: LoginProtocol } });
    await fresh.ready();
    const connection = fresh.connection("remote/model-1", { remember: false });
    expect(connection.url).toBe("https://remote.test/v1");
    expect(connection.Protocol.original).toBe(LoginProtocol);
    expect(connection.settings.auth.token).toBe("secret");
    expect(fresh.models().has("remote/model-1")).toBe(true);
  });

  test("local scope writes only the project's namespaced auth file", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    providerAdd(env, "wire", LoginProtocol);
    await env.login("local-wire", { provider: "wire", url: "http://localhost:9999", token: "local" }, { scope: "local" });
    // the project's auth file carries the whole record
    const auth = JSON.parse(readFileSync(join(cwd, projectAuth("local-wire")), "utf8"))["local-wire"];
    expect(auth).toMatchObject({ provider: "wire", url: "http://localhost:9999", auth: { token: "local" } });
    expect(existsSync(join(cwd, NAMES.projectSettings))).toBe(false); // a login never writes providers settings
    await env.close();
    const fresh = await Env.open(cwd, { dir, init: { providers: false }, providers: { wire: LoginProtocol } });
    await fresh.ready();
    const connection = fresh.connection("local-wire/model-1", { remember: false });
    expect(connection.url).toBe("http://localhost:9999");
    expect(connection.settings.auth.token).toBe("local");
    expect(scope(fresh, "local-wire")).toBe("local"); // the project auth layer
  });
});

describe("Env.endpointPresets (login wizard presets)", () => {
  test("collects protocol-published presets, skips secret protocols, dedupes by name", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    class WireA {
      static provider = { label: "A" };
      static knownEndpoints = [
        { name: "cloud-a", label: "Cloud A", url: "https://a" },
        { name: "dup", url: "https://dup-a" }, // label falls back to the name
        { name: "bad" }, // no url: dropped
      ];
    }
    class WireB {
      static provider = { label: "B" };
      static knownEndpoints = [{ name: "dup", url: "https://dup-b" }]; // first protocol wins
    }
    class Secret {
      static provider = { label: "S", secret: true };
      static knownEndpoints = [{ name: "hidden", url: "https://hidden" }];
    }
    providerAdd(env, "wire-a", WireA);
    providerAdd(env, "wire-b", WireB);
    providerAdd(env, "secret", Secret);
    expect(env.loginPresets()).toEqual([
      { name: "cloud-a", label: "Cloud A", url: "https://a", provider: "wire-a" },
      { name: "dup", label: "dup", url: "https://dup-a", provider: "wire-a" },
    ]);
  });
});

describe("Env.login connection verification", () => {
  test("a failed connection test rolls the endpoint back and fails loudly", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    class DeadProtocol extends LoginProtocol {
      static async testConnection() {
        const error = new Error("HTTP 401 Unauthorized");
        error.status = 401;
        throw error;
      }
    }
    providerAdd(env, "dead", DeadProtocol);
    await expect(env.login("dead-end", { provider: "dead", url: "https://dead.test/v1", token: "bad" }, { scope: "package" })).rejects.toThrow(/connection test failed for dead-end.*401/);
    expect(() => env.connection("dead-end/model-1", { remember: false })).toThrow(/unknown endpoint/);
    expect([...env.models(true).keys()].some((key) => key.startsWith("dead-end/"))).toBe(false);
    expect(existsSync(join(dir, "auth-dead-end.json"))).toBe(false);
  });

  test("a null-returning verifier leaves the login best-effort", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    class QuietProtocol {
      static provider = { label: "Q" };
      static login() { return { type: "none" }; }
      static async testConnection() { return null; } // nothing to verify
    }
    providerAdd(env, "quiet", QuietProtocol);
    const result = await env.login("quiet-end", { provider: "quiet", url: "test://quiet" }, { scope: "package" });
    expect(result.endpoint).toEqual({ provider: "quiet", url: "test://quiet" });
  });
});

describe("runLoginWizard", () => {
  /** Feed the wizard scripted answers (drip-fed one per macrotask — a
   *  bulk end() would emit every line before the next question()
   *  registers its listener); collect its output. */
  const wizard = (env, answers) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const done = runLoginWizard(env, { input, output });
    (async () => {
      for (const answer of answers) {
        input.write(`${answer}\n`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      input.end();
    })();
    return { result: done, output: () => text };
  };

  const wizardEnv = async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    class WireA extends LoginProtocol {
      static provider = { label: "A" };
      static knownEndpoints = [
        { name: "cloud-a", label: "Cloud A", url: "https://cloud-a/v1" },
        { name: "cloud-b", label: "Cloud B", url: "https://cloud-b/v1", note: "bills extra credits, not the plan" },
      ];
    }
    providerAdd(env, "wire-a", WireA);
    providerAdd(env, "wire-b", class WireB extends LoginProtocol {
      static provider = { label: "B" };
    });
    await env.ready();
    return env;
  };

  test("a numbered known endpoint supplies protocol, name, and URL", async () => {
    const env = await wizardEnv();
    const { result, output } = wizard(env, ["2", "", "", "", "tok-1"]);
    const login = await result;
    expect(output()).toContain("Known endpoints:");
    expect(output()).toContain("Manual endpoint (enter URL)");
    expect(login.name).toBe("cloud-b");
    expect(login.endpoint).toEqual({ provider: "wire-a", url: "https://cloud-b/v1" });
    expect(login.auth).toEqual({ type: "api_key", token: "tok-1" });
    const connection = env.connection("cloud-b/model-1", { remember: false });
    expect(connection.url).toBe("https://cloud-b/v1");
    expect(connection.settings.auth).toEqual(login.auth);
  });

  test("the manual option asks protocol and URL — new endpoints are the point", async () => {
    const env = await wizardEnv();
    const { result } = wizard(env, ["m", "wire-b", "my-endpoint", "https://new.example/v1", "local", ""]);
    const login = await result;
    expect(login.name).toBe("my-endpoint");
    expect(login.endpoint).toEqual({ provider: "wire-b", url: "https://new.example/v1" });
    expect(login.scope).toBe("local");
  });

  test("a preset's note prints with its entry — the caveat is part of the choice", async () => {
    const env = await wizardEnv();
    const { result, output } = wizard(env, ["2", "", "", "", "tok-1"]);
    await result;
    expect(output()).toContain("note: bills extra credits, not the plan");
  });

  test("an unknown numbered choice fails", async () => {
    const env = await wizardEnv();
    const { result } = wizard(env, ["9", ""]);
    await expect(result).rejects.toThrow(/unknown endpoint choice/);
  });
});

describe("Gemini Developer API OAuth login", () => {
  test("owned OAuth client and project persist, verify catalog and survive reopening", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    providerAdd(env, "gemini", Gemini);
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      expect(url).toContain("/v1beta/models");
      expect(init.headers.authorization).toBe("Bearer own-access");
      expect(init.headers["x-goog-user-project"]).toBe("own-project");
      return Response.json({ models: [{ name: "models/gemini-demo", supportedGenerationMethods: ["generateContent"] }] });
    };
    const oauth = { clientId: "own-client", clientSecret: "own-secret", projectId: "own-project", tokenUrl: "https://oauth2.googleapis.com/token" };
    try {
      const login = await env.login("gemini-oauth", { provider: "gemini", url: "https://generativelanguage.googleapis.com/v1beta", oauth,
        auth: { type: "oauth", token: "own-access", refresh: "own-refresh" } }, { scope: "package" });
      expect(login.verified.models).toBe(1);
      const persisted = JSON.parse(readFileSync(join(dir, "auth-gemini-oauth.json"), "utf8"))["gemini-oauth"];
      expect(persisted.oauth.projectId).toBe("own-project");
      expect(persisted.oauth.clientSecret).toBe("own-secret");
      expect(persisted.auth.refresh).toBe("own-refresh");
      await env.close();
      const fresh = await Env.open(cwd, { dir, init: { providers: false }, providers: { gemini: Gemini } });
      await fresh.ready();
      expect(fresh.connection("gemini-oauth/gemini-demo", { remember: false }).settings.oauth.projectId).toBe("own-project");
      await fresh.close();
    } finally { globalThis.fetch = original; await env.close(); }
  });
  test("OAuth preset refuses API-key login before persistence", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false }, providers: { gemini: Gemini } });
    try {
      await expect(env.login("gemini-oauth", { provider: "gemini", url: "https://generativelanguage.googleapis.com/v1beta",
        token: "key" }, { scope: "package" })).rejects.toThrow(/requires OAuth/);
      expect(existsSync(join(dir, "auth-gemini-oauth.json"))).toBe(false);
    } finally { await env.close(); }
  });
  test("rejects OAuth without an owned client and project before persistence", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false }, providers: { gemini: Gemini } });
    try {
      await expect(env.login("gemini-oauth", { provider: "gemini", url: "https://generativelanguage.googleapis.com/v1beta",
        auth: { type: "oauth", token: "borrowed" } }, { scope: "package" })).rejects.toThrow(/own Desktop client/);
      expect(existsSync(join(dir, "auth-gemini-oauth.json"))).toBe(false);
    } finally { await env.close(); }
  });
});

describe("Env.endpointPresets oauth extras + endpointScope", () => {
  test("a preset's oauth descriptor rides along (the wizards drive browser sign-in from it)", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    providerAdd(env, "wire", class Wire {
      static provider = { label: "W" };
      static knownEndpoints = [
        { name: "cloud", label: "Cloud", url: "https://cloud/v1", oauth: { label: "Cloud OAuth", clientId: "c1" } },
      ];
    });
    const [preset] = env.loginPresets();
    expect(preset.oauth).toEqual({ label: "Cloud OAuth", clientId: "c1" });
    expect(preset.provider).toBe("wire");
  });

  test("endpointScope reports where the endpoint lives (local settings beat package)", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ providers: { proj: { provider: "wire", url: "https://package" } } }));
    writeFileSync(join(cwd, NAMES.projectSettings), JSON.stringify({ providers: { proj: { url: "https://local" } } }));
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    expect(scope(env, "nowhere")).toBe("package");
    expect(scope(env, "proj")).toBe("local");
    expect(env.connection("proj/model-1", { remember: false }).url).toBe("https://local");
  });

  test("a verified login clears a stale loginRequired mark", async () => {
    const env = await Env.open(cwd, { dir, init: { providers: false } });
    await env.ready();
    providerAdd(env, "wire", LoginProtocol);
    env.settings.providers.wire = { provider: "wire", url: "https://x" };
    env.connection("wire/model-1", { remember: false }).authSet({ loginRequired: true });
    const login = await env.login("wire", { provider: "wire", url: "https://x", token: "tok" }, { scope: "package" });
    expect(login.verified).toEqual({ models: 1 }); // testConnection's report
    expect(env.connection("wire/model-1", { remember: false }).settings.loginRequired).not.toBe(true); // the login's file supersedes memory
  });
});
