// Provider protocols are reusable classes; endpoints are named settings.
import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import OllamaPlugin from "../providers/ollama.js";
import OpenAIPlugin from "../providers/openai.js";
import { listEndpointModels, listModelCandidates, loginEndpoint, resolveModelCombo } from "../lib/cli.js";

let dir;
const savedSettingsDir = process.env[NAMES.settingsEnv];
beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = mkdtempSync("./ai-tmp/endpoints-");
  // pin the user settings layer to THIS test's folder: dynamic writes
  // (auth files, endpoints) land beside it and never leak across tests
  process.env[NAMES.settingsEnv] = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSettingsDir === undefined) delete process.env[NAMES.settingsEnv];
  else process.env[NAMES.settingsEnv] = savedSettingsDir;
});

function protocolSource(name, detected = {}) {
  return `
export default class ${name}Protocol {
  static provider = { label: "${name}", capabilities: {} };
  static async detectEndpoints({ settings }) {
    if (settings.loadedBeforeProviders !== true) throw new Error("settings loaded too late");
    return ${JSON.stringify(detected)};
  }
}
`;
}

describe("Env protocol classes and endpoint settings", () => {
  test("create returns a ready Env even when an embedding host sets its own dir", async () => {
    const env = await Env.create({ dir, cwd: dir, settings: {
      providers: { "openai-codex": { provider: "openai", url: "https://chatgpt.com/backend-api/codex" } },
    } }, { detect: false });
    expect(env.provider("openai")).toBeDefined();
    expect(env.endpoint("openai-codex")?.provider).toBe("openai");
    expect(env.toolNames().length).toBeGreaterThan(1);
  });

  test("loads basename-keyed classes from package and configured roots after settings (NEVER the project folder)", async () => {
    const cwd = join(dir, "project");
    const extra = join(dir, "extra-providers");
    mkdirSync(join(dir, "providers"));
    mkdirSync(extra);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      loadedBeforeProviders: true,
      providerPaths: [extra],
      providers: { alphaLocal: { provider: "alpha", url: "http://explicit" } },
    }));
    writeFileSync(join(dir, "providers", "alpha.js"), protocolSource("Alpha", {
      alphaLocal: { provider: "alpha", url: "http://detected-must-not-win" },
      alphaRemote: { provider: "alpha", url: "http://remote" },
    }));
    // SECURITY: a provider class is executable code holding every
    // request and credential — the project folder is never a root
    mkdirSync(join(cwd, "ai-providers"), { recursive: true });
    writeFileSync(join(cwd, "ai-providers", "beta.js"), protocolSource("Beta"));
    writeFileSync(join(extra, "gamma.js"), protocolSource("Gamma"));

    const env = new Env({ dir, cwd });
    expect(env.settings.loadedBeforeProviders).toBe(true);
    await env.loadProviders();

    expect(env.providerNames()).toEqual(expect.arrayContaining(["alpha", "gamma", "openai"])); // beta: project root, never scanned
    expect(env.providers.alpha.name).toBe("AlphaProtocol");
    expect(env.endpoints).toEqual({
      alphaLocal: { provider: "alpha", url: "http://explicit" },
      alphaRemote: { provider: "alpha", url: "http://remote" },
    });
  });

  test("the default class endpoint detector does no work", async () => {
    class QuietProtocol {}
    const env = new Env({ dir, cwd: dir, settings: { providers: {} } });
    env.registerProvider("quiet", QuietProtocol);
    await env.detectEndpoints();
    expect(env.endpoints).toEqual({});
  });

  test("Ollama and OpenAI protocol classes detect only their known local endpoints", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ models: [] }));
    };
    try {
      const env = new Env({ dir, cwd: dir });
      env.registerProvider("ollama", OllamaPlugin);
      env.registerProvider("openai", OpenAIPlugin);
      await env.detectEndpoints();
      expect(env.endpoints).toEqual({
        ollama: { provider: "ollama", url: "http://localhost:11434", local: true },
        "lm-studio": { provider: "openai", url: "http://localhost:1234/v1" },
      });
      expect(calls).toEqual(["http://localhost:11434/api/tags", "http://localhost:1234/v1/models"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("new Ollama endpoints are local unless explicitly remote", () => {
    const env = new Env({ dir, cwd: dir });
    env.saveEndpoint("default-ollama", { provider: "ollama", url: "http://host" });
    env.saveEndpoint("remote-ollama", { provider: "ollama", url: "https://host", remote: true });
    expect(env.endpoint("default-ollama")).toMatchObject({ local: true });
    expect(env.endpointLocal("default-ollama")).toBe(true);
    expect(env.endpoint("remote-ollama").local).toBeUndefined();
    expect(env.endpointLocal("remote-ollama")).toBe(false);
  });

  test("Ollama login marks a new endpoint local unless its prior configuration is remote", async () => {
    class OllamaLogin {
      async login() { return { type: "none" }; }
      async testConnection() { return {}; }
      async models() { return {}; }
      async close() {}
    }
    const env = new Env({ dir, cwd: dir });
    env.registerProvider("ollama", OllamaLogin);
    await loginEndpoint(env, { name: "new-ollama", provider: "ollama", url: "http://host" });
    expect(env.endpoint("new-ollama")).toMatchObject({ local: true });
    env.saveEndpoint("remote-ollama", { provider: "ollama", url: "https://host", remote: true });
    await loginEndpoint(env, { name: "remote-ollama", provider: "ollama", url: "https://host" });
    expect(env.endpoint("remote-ollama")).toMatchObject({ remote: true });
    expect(env.endpoint("remote-ollama").local).toBeUndefined();
  });

  test("explicit endpoint settings always beat automatic detection", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { ollama: { provider: "ollama", url: "https://remote.example" } },
    } });
    env.registerProvider("ollama", OllamaPlugin);
    await env.detectEndpoints();
    expect(env.endpoint("ollama")).toEqual({ provider: "ollama", url: "https://remote.example" });
  });

  test("endpoint auth and model cache persist under the endpoint name", () => {
    const env = new Env({
      dir,
      cwd: dir,
      settings: { providers: { remote: { provider: "ollama", url: "https://host" } } },
    });
    env.authSet("remote", { token: "secret", models: { m: null } });
    expect(env.endpointSettings("remote")).toEqual({
      provider: "ollama",
      url: "https://host",
      auth: { token: "secret" },
      models: { m: null },
    });
    expect(JSON.parse(readFileSync(join(dir, "auth-remote.json"), "utf8"))).toEqual({
      remote: { provider: "ollama", url: "https://host", auth: { token: "secret" }, models: { m: null } },
    });
  });
});

describe("ambient API-key endpoint detection", () => {
  test("OPENAI_API_KEY configures a DYNAMIC openai endpoint — in memory only, never persisted", async () => {
    const env = new Env({ dir, cwd: dir });
    await env.loadProviders({ dirs: [join(dir, "none")], detect: false });
    env.registerProvider("openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      const added = await env.detectEndpoints();
      expect(added).toContain("openai"); // lm-studio may co-detect when it runs locally
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(env.endpoint("openai")).toEqual({ provider: "openai", url: "https://api.openai.com/v1" });
    // the key never lands in the endpoint config — it lives in the auth namespace
    expect(env.endpointSettings("openai").auth.token).toBe("sk-ambient");
    // environment-defined: dynamic, and NOTHING is written to disk
    expect(env.isDynamic("openai")).toBe(true);
    expect(existsSync(join(dir, "auth-openai.json"))).toBe(false);
  });

  test("XAI_API_KEY configures a dynamic xai endpoint (pi's environment naming)", async () => {
    const env = new Env({ dir, cwd: dir });
    env.registerProvider("openai", OpenAIPlugin);
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-ambient";
    try {
      const added = await env.detectEndpoints();
      expect(added).toContain("xai");
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    expect(env.endpoint("xai")).toEqual({ provider: "openai", url: "https://api.x.ai/v1" });
    expect(env.endpointSettings("xai").auth.token).toBe("xai-ambient");
    expect(env.isDynamic("xai")).toBe(true);
    expect(existsSync(join(dir, "auth-xai.json"))).toBe(false);
  });

  test("AZURE_OPENAI_API_KEY needs AZURE_OPENAI_BASE_URL to configure azure-openai", async () => {
    const env = new Env({ dir, cwd: dir });
    env.registerProvider("openai", OpenAIPlugin);
    const savedKey = process.env.AZURE_OPENAI_API_KEY;
    const savedUrl = process.env.AZURE_OPENAI_BASE_URL;
    process.env.AZURE_OPENAI_API_KEY = "az-key";
    delete process.env.AZURE_OPENAI_BASE_URL;
    try {
      const added = await env.detectEndpoints();
      expect(added).not.toContain("azure-openai"); // no base URL: no endpoint
      process.env.AZURE_OPENAI_BASE_URL = "https://res.openai.azure.com/openai/v1";
      const added2 = await env.detectEndpoints();
      expect(added2).toContain("azure-openai");
      expect(env.endpoint("azure-openai").url).toBe("https://res.openai.azure.com/openai/v1");
    } finally {
      if (savedKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = savedKey;
      if (savedUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
      else process.env.AZURE_OPENAI_BASE_URL = savedUrl;
    }
  });

  test("an existing openai endpoint is never overridden by the environment", async () => {
    const env = new Env({
      dir, cwd: dir,
      settings: { providers: { openai: { provider: "openai", url: "https://custom/v1" } } },
    });
    env.registerProvider("openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      await env.detectEndpoints();
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(env.endpoint("openai").url).toBe("https://custom/v1");
    expect(env.endpointSettings("openai").token).toBeUndefined();
  });
});

describe("endpointModels / refreshModels (startup model-cache renewal)", () => {
  const wireEnv = (behavior) => {
    const env = new Env({
      dir,
      cwd: dir,
      settings: {
        providers: {
          live: { provider: "wire", url: "http://live" },
          dead: { provider: "wire", url: "http://dead" },
          manual: { provider: "wire", url: "http://manual", models: { fixed: { label: "Fixed" } } },
        },
      },
    });
    class Wire {
      static provider = {};
      constructor(url, aiio) { this.url = url; this.aiio = aiio; }
      async models() { return behavior(this); }
      async close() {}
    }
    env.registerProvider("wire", Wire);
    return env;
  };

  test("refreshModels queries every endpoint and renews each cache", async () => {
    const seen = [];
    const env = wireEnv((self) => {
      seen.push(self.url);
      if (self.url === "http://dead") throw new Error("unreachable");
      const models = { [`m@${self.url}`]: null };
      self.aiio.authSet({ models });
      return models;
    });
    const answered = await env.refreshModels();
    expect(seen.sort()).toEqual(["http://dead", "http://live", "http://manual"]);
    expect(answered.sort()).toEqual(["dead", "live", "manual"]); // fallbacks count as answered
    expect(env.endpointSettings("live").models).toEqual({ "m@http://live": null });
    // the manual endpoint's fetched map merged over its static config list
    expect(env.endpointSettings("manual").models).toEqual({
      fixed: { label: "Fixed" },
      "m@http://manual": null,
    });
  });

  test("a failing endpoint keeps its stale cached list", async () => {
    const env = wireEnv(() => { throw new Error("down"); });
    env.authSet("dead", { models: { stale: { label: "Stale" } } });
    await env.refreshModels();
    expect(env.endpointSettings("dead").models).toEqual({ stale: { label: "Stale" } });
  });

  test("endpointModels without refresh reads cache + static config only", async () => {
    let queried = 0;
    const env = wireEnv(() => { queried++; return { live: null }; });
    const models = await env.endpointModels("manual");
    expect(queried).toBe(0);
    expect(models).toEqual({ fixed: { label: "Fixed" } });
    expect(await env.endpointModels("nowhere")).toEqual({});
  });
});

describe("secret endpoints and models", () => {
  test("stay unpublished while an explicit endpoint/model combo resolves", async () => {
    const env = new Env({
      dir,
      cwd: dir,
      settings: {
        providers: { test: { provider: "test", url: "test://script", secret: true } },
        test: { models: { "test-model": { label: "Test Model", secret: true } } },
      },
    });
    env.registerProvider("test", class TestProtocol {});

    expect(listModelCandidates(env)).toEqual([]);
    expect(listEndpointModels(env)).toEqual([]);
    expect(await resolveModelCombo("test/test-model", env)).toEqual({ endpoint: "test", model: "test-model" });
  });
});

describe("Env.refreshEndpointSettings (multi-process auth rotation)", () => {
  test("a changed auth file merges over the stale in-memory record", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.saveEndpoint("acme", { provider: "ollama", url: "http://x" });
    env.authSet("acme", { auth: { type: "token", token: "old-token" } });
    expect(env.endpointSettings("acme").auth.token).toBe("old-token");
    // another process rotates the token on disk (its own auth file write)
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    const section = env.refreshEndpointSettings("acme");
    expect(section.auth.token).toBe("new-token");
    expect(env.endpointSettings("acme").auth.token).toBe("new-token");
    expect(env.endpointSettings("acme").url).toBe("http://x"); // connection config survives
  });

  test("the settings.json providers entry's auth section is re-read too", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.saveEndpoint("acme", { provider: "ollama", url: "http://x" });
    env.authSet("acme", { auth: { type: "token", token: "old-token" } });
    // another process wrote BOTH files (saveEndpoint + authSet)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" } },
      acme: { auth: { type: "token", token: "newer-token" } },
    }));
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    const section = env.refreshEndpointSettings("acme");
    // the settings file's own section wins over the auth file (layer order)
    expect(section.auth.token).toBe("newer-token");
  });

  test("a vanished auth file is a no-op, never a settings drop", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.saveEndpoint("acme", { provider: "ollama", url: "http://x" });
    env.authSet("acme", { auth: { type: "token", token: "old-token" } });
    rmSync(join(dir, "auth-acme.json"));
    const section = env.refreshEndpointSettings("acme");
    expect(section.auth.token).toBe("old-token"); // live settings survive
    expect(env.endpointSettings("acme").url).toBe("http://x");
  });

  test("a dynamic (environment-detected) endpoint has nothing to re-read", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.endpoints.dyn = { provider: "ollama", url: "http://x" };
    env._dynamicEndpoints.add("dyn");
    env._mergeAuthInMemory("dyn", { auth: { type: "token", token: "env-token" } });
    const section = env.refreshEndpointSettings("dyn");
    expect(section.auth.token).toBe("env-token"); // unchanged, no disk read
  });
});

describe("Env.removeEndpoint (logout)", () => {
  test("a configured endpoint: settings.json entry and auth file go, memory forgets", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" }, keep: { provider: "ollama", url: "http://y" } },
    }));
    const env = new Env({ dir, cwd: dir });
    env.authSet("acme", { token: "t-1", models: { m: null } });
    expect(existsSync(join(dir, "auth-acme.json"))).toBe(true);

    const result = env.removeEndpoint("acme");
    expect(result).toEqual({ name: "acme", dynamic: false });
    expect(env.endpoint("acme")).toBeUndefined();
    expect(env.endpointSettings("acme")).toEqual({});
    expect(existsSync(join(dir, "auth-acme.json"))).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(onDisk.providers.acme).toBeUndefined();
    expect(onDisk.providers.keep).toEqual({ provider: "ollama", url: "http://y" }); // untouched
    // a settings write is atomic: no temp file is left behind
    expect(existsSync(join(dir, "settings.json.tmp-" + process.pid))).toBe(false);
  });

  test("saveEndpoint then removeEndpoint in one batch leaves no endpoint files or pending config", async () => {
    const env = new Env({ dir, cwd: dir });
    await env.batch(() => {
      env.saveEndpoint("temporary", { provider: "ollama", url: "http://temporary" });
      env.removeEndpoint("temporary");
    });
    expect(env.endpoint("temporary")).toBeUndefined();
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "auth-temporary.json"))).toBe(false);
  });

  test("a dynamic (environment-detected) endpoint: memory-only removal, no files touched", async () => {
    const env = new Env({ dir, cwd: dir });
    env.registerProvider("openai", OpenAIPlugin);
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-key";
    try {
      await env.detectEndpoints();
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    expect(env.isDynamic("xai")).toBe(true);
    const result = env.removeEndpoint("xai");
    expect(result.dynamic).toBe(true);
    expect(env.endpoint("xai")).toBeUndefined();
    expect(env.isDynamic("xai")).toBe(false);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "auth-xai.json"))).toBe(false);
  });

  test("an unknown endpoint is an ordinary error", () => {
    const env = new Env({ dir, cwd: dir });
    expect(() => env.removeEndpoint("nope")).toThrow(/unknown endpoint "nope"/);
  });

  test("logoutEndpoint requires a name and routes to Env", async () => {
    const { logoutEndpoint } = await import("../lib/cli.js");
    const env = new Env({ dir, cwd: dir, settings: { providers: { acme: { provider: "ollama", url: "http://x" } } } });
    expect(() => logoutEndpoint(env, "")).toThrow(/endpoint name/);
    expect(logoutEndpoint(env, "acme").name).toBe("acme");
    expect(env.endpoint("acme")).toBeUndefined();
  });
});

describe("batched settings writes (lib/env/persist.js)", () => {
  test("authSet inside a batch defers; each file lands ONCE at the batch's end", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-acme.json");
    await env.batch(async () => {
      env.authSet("acme", { token: "t-1" });
      expect(existsSync(file)).toBe(false); // still in memory
      env.authSet("acme", { token: "t-2", models: { m: null } });
      expect(existsSync(file)).toBe(false);
      expect(env.endpointSettings("acme").auth.token).toBe("t-2"); // live view updated
    });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).acme).toEqual({ auth: { token: "t-2" }, models: { m: null } });
  });

  test("nested batches flush at the OUTERMOST end only", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-nest.json");
    await env.batch(async () => {
      await env.batch(async () => {
        env.authSet("nest", { token: "deep" });
      });
      expect(existsSync(file)).toBe(false); // the inner batch did not flush
    });
    expect(JSON.parse(readFileSync(file, "utf8")).nest.auth.token).toBe("deep");
  });

  test("a batch that throws still flushes the writes that landed before the error", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-err.json");
    await expect(env.batch(async () => {
      env.authSet("err", { token: "t" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(JSON.parse(readFileSync(file, "utf8")).err.auth.token).toBe("t");
  });
});
