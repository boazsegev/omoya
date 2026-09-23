import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Env } from "../lib/env.js";
import { loginEndpoint, runLoginWizard } from "../lib/cli.js";

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
  constructor(url, aiio) { this.url = url; this.aiio = aiio; }
  async login({ token }) { return { type: "api_key", token }; }
  async testConnection() { return { models: 1 }; } // login always verifies
  async models() {
    const models = { "model-1": { label: "Model 1" } };
    this.aiio.authSet({ models });
    return models;
  }
  async close() {}
}

describe("loginEndpoint", () => {
  test("package scope writes the endpoint record to its auth file — never settings.json", async () => {
    const env = new Env({ dir, cwd });
    env.registerProvider("wire", LoginProtocol);
    await loginEndpoint(env, {
      name: "remote", provider: "wire", url: "https://remote.test/v1", token: "secret", scope: "package",
    });
    // a login NEVER writes settings.providers: the endpoint's record is
    // its AUTH FILE — provider, url, credentials, and the model cache
    expect(JSON.parse(readFileSync(join(dir, "auth-remote.json"), "utf8")).remote).toEqual({
      provider: "wire", url: "https://remote.test/v1",
      auth: { type: "api_key", token: "secret" }, models: { "model-1": { label: "Model 1" } },
    });
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    // and the auth file AUTO-CATALOGS the endpoint: a fresh environment
    // lists it without any settings.providers entry
    const fresh = new Env({ dir, cwd });
    expect(fresh.endpoint("remote")).toMatchObject({
      provider: "wire", url: "https://remote.test/v1", auth: { token: "secret", type: "api_key" },
    });
    expect(fresh.endpointNames()).toContain("remote");
    expect(fresh.endpointSettings("remote").auth.token).toBe("secret");
  });

  test("local scope writes only the project's namespaced auth file", async () => {
    const env = new Env({ dir, cwd });
    env.registerProvider("wire", LoginProtocol);
    await loginEndpoint(env, {
      name: "local-wire", provider: "wire", url: "http://localhost:9999", token: "local", scope: "local",
    });
    // the project's auth file carries the whole record
    const auth = JSON.parse(readFileSync(join(cwd, projectAuth("local-wire")), "utf8"))["local-wire"];
    expect(auth).toMatchObject({ provider: "wire", url: "http://localhost:9999", auth: { token: "local" } });
    expect(existsSync(join(cwd, NAMES.projectSettings))).toBe(false); // a login never writes providers settings
    const fresh = new Env({ dir, cwd });
    expect(fresh.endpoint("local-wire")).toMatchObject({
      provider: "wire", url: "http://localhost:9999", auth: { token: "local", type: "api_key" },
    });
    expect(fresh.endpointSettings("local-wire").auth.token).toBe("local");
    expect(fresh.endpointScope("local-wire")).toBe("local"); // the project auth layer
  });
});

describe("Env.knownEndpoints (login wizard presets)", () => {
  test("collects protocol-published presets, skips secret protocols, dedupes by name", () => {
    const env = new Env({ dir, cwd });
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
    env.registerProvider("wire-a", WireA);
    env.registerProvider("wire-b", WireB);
    env.registerProvider("secret", Secret);
    expect(env.knownEndpoints()).toEqual([
      { name: "cloud-a", label: "Cloud A", url: "https://a", provider: "wire-a" },
      { name: "dup", label: "dup", url: "https://dup-a", provider: "wire-a" },
    ]);
  });
});

describe("loginEndpoint connection verification", () => {
  test("a failed connection test rolls the endpoint back and fails loudly", async () => {
    const env = new Env({ dir, cwd });
    class DeadProtocol extends LoginProtocol {
      async testConnection() {
        const error = new Error("HTTP 401 Unauthorized");
        error.status = 401;
        throw error;
      }
    }
    env.registerProvider("dead", DeadProtocol);
    await expect(loginEndpoint(env, {
      name: "dead-end", provider: "dead", url: "https://dead.test/v1", token: "bad", scope: "package",
    })).rejects.toThrow(/connection test failed for dead-end.*401/);
    expect(env.endpoint("dead-end")).toBeUndefined(); // rolled back
  });

  test("a null-returning verifier leaves the login best-effort", async () => {
    const env = new Env({ dir, cwd });
    class QuietProtocol {
      static provider = { label: "Q" };
      constructor(url, aiio) { this.url = url; this.aiio = aiio; }
      async login() { return { type: "none" }; }
      async testConnection() { return null; } // nothing to verify
      async close() {}
    }
    env.registerProvider("quiet", QuietProtocol);
    const result = await loginEndpoint(env, {
      name: "quiet-end", provider: "quiet", url: "test://quiet", scope: "package",
    });
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

  const wizardEnv = () => {
    const env = new Env({ dir, cwd });
    class WireA extends LoginProtocol {
      static provider = { label: "A" };
      static knownEndpoints = [
        { name: "cloud-a", label: "Cloud A", url: "https://cloud-a/v1" },
        { name: "cloud-b", label: "Cloud B", url: "https://cloud-b/v1" },
      ];
    }
    env.registerProvider("wire-a", WireA);
    env.registerProvider("wire-b", class WireB extends LoginProtocol {
      static provider = { label: "B" };
    });
    return env;
  };

  test("a numbered known endpoint supplies protocol, name, and URL", async () => {
    const env = wizardEnv();
    const { result, output } = wizard(env, ["2", "", "", "", "tok-1"]);
    const login = await result;
    expect(output()).toContain("Known endpoints:");
    expect(output()).toContain("Manual endpoint (enter URL)");
    expect(login.name).toBe("cloud-b");
    expect(login.endpoint).toEqual({ provider: "wire-a", url: "https://cloud-b/v1" });
    expect(login.auth).toEqual({ type: "api_key", token: "tok-1" });
    expect(env.endpoint("cloud-b")).toEqual({ provider: "wire-a", url: "https://cloud-b/v1" });
  });

  test("the manual option asks protocol and URL — new endpoints are the point", async () => {
    const env = wizardEnv();
    const { result } = wizard(env, ["m", "wire-b", "my-endpoint", "https://new.example/v1", "local", ""]);
    const login = await result;
    expect(login.name).toBe("my-endpoint");
    expect(login.endpoint).toEqual({ provider: "wire-b", url: "https://new.example/v1" });
    expect(login.scope).toBe("local");
  });

  test("an unknown numbered choice fails", async () => {
    const env = wizardEnv();
    const { result } = wizard(env, ["9", ""]);
    await expect(result).rejects.toThrow(/unknown endpoint choice/);
  });
});

describe("Env.knownEndpoints oauth extras + endpointScope", () => {
  test("a preset's oauth descriptor rides along (the wizards drive browser sign-in from it)", () => {
    const env = new Env({ dir, cwd });
    env.registerProvider("wire", class Wire {
      static provider = { label: "W" };
      static knownEndpoints = [
        { name: "cloud", label: "Cloud", url: "https://cloud/v1", oauth: { label: "Cloud OAuth", clientId: "c1" } },
      ];
    });
    const [preset] = env.knownEndpoints();
    expect(preset.oauth).toEqual({ label: "Cloud OAuth", clientId: "c1" });
    expect(preset.provider).toBe("wire");
  });

  test("endpointScope reports where the endpoint lives (local settings beat package)", () => {
    const env = new Env({ dir, cwd });
    expect(env.endpointScope("nowhere")).toBe("package"); // unknown defaults to package
    env.endpoints["proj"] = { provider: "wire", url: "https://x" };
    env._endpointScopes.set("proj", "local"); // what a local settings.json scan records
    expect(env.endpointScope("proj")).toBe("local");
  });

  test("a verified login clears a stale loginRequired mark", async () => {
    const env = new Env({ dir, cwd });
    env.registerProvider("wire", LoginProtocol);
    env.authSet("wire", { loginRequired: true });
    const login = await loginEndpoint(env, { name: "wire", provider: "wire", url: "https://x", token: "tok" });
    expect(login.verified).toEqual({ models: 1 }); // testConnection's report
    expect(env.endpointSettings("wire").loginRequired).toBe(false);
  });
});
