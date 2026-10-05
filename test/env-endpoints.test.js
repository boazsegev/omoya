// Provider protocols are reusable classes; endpoints are named settings.
import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import OllamaPlugin from "../providers/ollama.js";
import OpenAIPlugin from "../providers/openai.js";
import AnthropicPlugin from "../providers/anthropic.js";
import { listEndpointModels, listModelCandidates, loginEndpoint, resolveModelCombo } from "../lib/cli.js";
import { authSetOf, batch, detect, dynamic, endpointOf, lastPair, mergeInMemory, modelsOf, namesOf, providerAdd, providerNamesOf, providerOf, providersLoad, refresh, registered, remember, reread, settingsOf, toolNames } from "./env-internals.js";

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
  static async detect({ settings }) {
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
    expect(providerOf(env, "openai")).toBeDefined();
    expect(endpointOf(env, "openai-codex")?.provider).toBe("openai");
    expect(toolNames(env).length).toBeGreaterThan(1);
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
    await providersLoad(env);

    expect(providerNamesOf(env)).toEqual(expect.arrayContaining(["alpha", "gamma", "openai"])); // beta: project root, never scanned
    expect(env._providers.alpha.name).toBe("AlphaProtocol");
    expect(env._endpoints).toEqual({
      alphaLocal: { provider: "alpha", url: "http://explicit" },
      alphaRemote: { provider: "alpha", url: "http://remote" },
    });
  });

  test("the default class endpoint detector does no work", async () => {
    class QuietProtocol {}
    const env = new Env({ dir, cwd: dir, settings: { providers: {} } });
    providerAdd(env, "quiet", QuietProtocol);
    await detect(env);
    expect(env._endpoints).toEqual({});
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
      providerAdd(env, "ollama", OllamaPlugin);
      providerAdd(env, "openai", OpenAIPlugin);
      await detect(env);
      expect(env._endpoints).toEqual({
        ollama: { provider: "ollama", url: "http://localhost:11434" },
        "lm-studio": { provider: "openai", url: "http://localhost:1234/v1" },
      });
      expect(calls).toEqual(["http://localhost:11434/api/tags", "http://localhost:1234/v1/models"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("Ollama login publishes no local/remote classification", async () => {
    class OllamaLogin {
      static login() { return { type: "none" }; }
      static async testConnection() { return {}; }
      static async models() { return {}; }
    }
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "ollama", OllamaLogin);
    await loginEndpoint(env, { name: "new-ollama", provider: "ollama", url: "http://host" });
    expect(endpointOf(env, "new-ollama").local).toBeUndefined();
    env.settings.providers["remote-ollama"] = { provider: "ollama", url: "https://host" };
    await loginEndpoint(env, { name: "remote-ollama", provider: "ollama", url: "https://host" });
    expect(endpointOf(env, "remote-ollama").remote).toBeUndefined();
    expect(endpointOf(env, "remote-ollama").local).toBeUndefined();
  });

  test("explicit endpoint settings always beat automatic detection", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { ollama: { provider: "ollama", url: "https://remote.example" } },
    } });
    providerAdd(env, "ollama", OllamaPlugin);
    await detect(env);
    expect(endpointOf(env, "ollama")).toEqual({ provider: "ollama", url: "https://remote.example" });
  });

  test("endpoint auth and model cache persist under the endpoint name", () => {
    const env = new Env({
      dir,
      cwd: dir,
      settings: { providers: { remote: { provider: "ollama", url: "https://host" } } },
    });
    authSetOf(env, "remote", { token: "secret", models: { m: null } });
    expect(settingsOf(env, "remote")).toEqual({
      provider: "ollama",
      url: "https://host",
      auth: { token: "secret" },
      models: { m: null },
    });
    expect(JSON.parse(readFileSync(join(dir, "auth-remote.json"), "utf8"))).toEqual({
      remote: { auth: { token: "secret" }, models: { m: null } },
    });
  });
});

describe("ambient API-key endpoint detection", () => {
  test("OPENAI_API_KEY configures a DYNAMIC openai endpoint — in memory only, never persisted", async () => {
    const env = new Env({ dir, cwd: dir });
    await providersLoad(env, { dirs: [join(dir, "none")], detect: false });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      const added = await detect(env);
      expect(added).toContain("openai"); // lm-studio may co-detect when it runs locally
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(endpointOf(env, "openai")).toEqual({ provider: "openai", url: "https://api.openai.com/v1" });
    // the key never lands in the endpoint config — it lives in the auth namespace
    expect(settingsOf(env, "openai").auth.token).toBe("sk-ambient");
    // environment-defined: dynamic, and NOTHING is written to disk
    expect(dynamic(env, "openai")).toBe(true);
    expect(existsSync(join(dir, "auth-openai.json"))).toBe(false);
  });

  test("an auto-detected Anthropic key and workspace are process-only and leave no residue", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedWorkspace = process.env.ANTHROPIC_WORKSPACE_ID;
    process.env.ANTHROPIC_API_KEY = "sk-ant-multi";
    process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_team";
    try {
      const env = new Env({ dir, cwd: dir });
      providerAdd(env, "anthropic", AnthropicPlugin);
      await detect(env);
      expect(listModelCandidates(env)).toContain("anthropic/claude-opus-5");
      expect(settingsOf(env, "anthropic").auth.workspaceId).toBe("wrkspc_team");
      expect(existsSync(join(dir, "auth-anthropic.json"))).toBe(false);
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_WORKSPACE_ID;
      await detect(env);
      expect(env._endpoints.anthropic).toBeUndefined();
      expect(env._settings.anthropic).toBeUndefined();
      expect(existsSync(join(dir, "auth-anthropic.json"))).toBe(false);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
      else process.env.ANTHROPIC_WORKSPACE_ID = savedWorkspace;
    }
  });

  test("XAI_API_KEY configures a dynamic xai endpoint (pi's environment naming)", async () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-ambient";
    try {
      const added = await detect(env);
      expect(added).toContain("xai");
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    expect(endpointOf(env, "xai")).toEqual({ provider: "openai", url: "https://api.x.ai/v1" });
    expect(settingsOf(env, "xai").auth.token).toBe("xai-ambient");
    expect(dynamic(env, "xai")).toBe(true);
    expect(existsSync(join(dir, "auth-xai.json"))).toBe(false);
  });

  test("AZURE_OPENAI_API_KEY needs AZURE_OPENAI_BASE_URL to configure azure-openai", async () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const savedKey = process.env.AZURE_OPENAI_API_KEY;
    const savedUrl = process.env.AZURE_OPENAI_BASE_URL;
    process.env.AZURE_OPENAI_API_KEY = "az-key";
    delete process.env.AZURE_OPENAI_BASE_URL;
    try {
      const added = await detect(env);
      expect(added).not.toContain("azure-openai"); // no base URL: no endpoint
      process.env.AZURE_OPENAI_BASE_URL = "https://res.openai.azure.com/openai/v1";
      const added2 = await detect(env);
      expect(added2).toContain("azure-openai");
      expect(endpointOf(env, "azure-openai").url).toBe("https://res.openai.azure.com/openai/v1");
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
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      await detect(env);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(endpointOf(env, "openai").url).toBe("https://custom/v1");
    expect(settingsOf(env, "openai").token).toBeUndefined();
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
      static async models({ url }) { return behavior({ url }); }
    }
    providerAdd(env, "wire", Wire);
    return env;
  };

  test("refreshModels queries every endpoint and renews each cache", async () => {
    const seen = [];
    const env = wireEnv((self) => {
      seen.push(self.url);
      if (self.url === "http://dead") throw new Error("unreachable");
      return { [`m@${self.url}`]: null };
    });
    const answered = await refresh(env);
    expect(seen.sort()).toEqual(["http://dead", "http://live", "http://manual"]);
    expect(answered.sort()).toEqual(["dead", "live", "manual"]); // fallbacks count as answered
    expect(settingsOf(env, "live").models).toEqual({ "m@http://live": null });
    // the manual endpoint's fetched map merged over its static config list
    expect(settingsOf(env, "manual").models).toEqual({
      fixed: { label: "Fixed" },
      "m@http://manual": null,
    });
  });

  test("a failing endpoint keeps its stale cached list", async () => {
    const env = wireEnv(() => { throw new Error("down"); });
    authSetOf(env, "dead", { models: { stale: { label: "Stale" } } });
    await refresh(env);
    expect(settingsOf(env, "dead").models).toEqual({ stale: { label: "Stale" } });
  });

  test("endpointModels without refresh reads cache + static config only", async () => {
    let queried = 0;
    const env = wireEnv(() => { queried++; return { live: null }; });
    const models = await modelsOf(env, "manual");
    expect(queried).toBe(0);
    expect(models).toEqual({ fixed: { label: "Fixed" } });
    expect(await modelsOf(env, "nowhere")).toEqual({});
  });

  test("a preferences placeholder rides the ADOPTED environment connection (endpoint() is the effective connection view)", async () => {
    // The rule: a providers entry with neither `url` nor `provider` is
    // not an endpoint — it is a user PREFERENCE for the endpoint a
    // later detection adopts. Env decides the merge ONCE (endpoint()):
    // the adopted connection's protocol/URL show through while the
    // preference's own fields win. Reading the placeholder raw fell
    // back to the OpenAI default at no URL — "no models" for an
    // env-key anthropic.
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { cloud: { filter: "^keep" } },
    } });
    providerAdd(env, "wire", class Wire {
      static provider = {};
      static async models() { return { "keep-1": null, drop: { label: "Drop" } }; }
    });
    env._dynamicEndpoints.add("cloud");
    env._dynamicConnections.set("cloud", { provider: "wire", url: "http://adopted" });
    expect(endpointOf(env, "cloud")).toEqual({ provider: "wire", url: "http://adopted", filter: "^keep" });
    const models = await modelsOf(env, "cloud", { refresh: true });
    expect(models).toEqual({ "keep-1": null, drop: { label: "Drop", secret: true } }); // the preference's filter applies
    expect(settingsOf(env, "cloud").models["keep-1"]).toBeNull(); // the cache refreshed in memory (dynamic: no file)
    expect(existsSync(join(dir, "auth-cloud.json"))).toBe(false);
    // the placeholder alone still resolves NOTHING (it is not an endpoint)
    env.close();
    const bare = new Env({ dir, cwd: dir, settings: { providers: { cloud: { filter: "^keep" } } } });
    expect(endpointOf(bare, "cloud")).toEqual({ filter: "^keep" });
    expect(namesOf(bare)).toEqual([]);
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
    providerAdd(env, "test", class TestProtocol {});

    expect(listModelCandidates(env)).toEqual([]);
    expect(listEndpointModels(env)).toEqual([]);
    expect(await resolveModelCombo("test/test-model", env)).toBe("test/test-model");
  });
});

describe("endpoint model filter (providers.<name>.filter)", () => {
  const MODELS = {
    "gpt-6-sol": { label: "Sol" },
    "gpt-6-astra": { label: "Astra" },
    "gpt-5.6-luna": null,
    "gpt-5-pro": { label: "Pro" },
  };

  test("endpointSettings marks non-matching models secret; matching metadata survives", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "(luna|sol|astra)", models: MODELS } },
    } });
    const { models } = settingsOf(env, "codex");
    expect(models["gpt-6-sol"]).toEqual({ label: "Sol" });
    expect(models["gpt-6-astra"]).toEqual({ label: "Astra" });
    expect(models["gpt-5.6-luna"]).toBeNull();
    expect(models["gpt-5-pro"]).toEqual({ label: "Pro", secret: true });
    // the stored config is untouched — the filter is a view
    expect(env._endpoints.codex.models["gpt-5-pro"]).toEqual({ label: "Pro" });
    // endpoint() is the effective CONNECTION view: settings-cache
    // fields (models) live on endpointSettings only
    expect(endpointOf(env, "codex")).toEqual({ provider: "openai", url: "http://x", filter: "(luna|sol|astra)" });
  });

  test("menus/completions/combo-resolution hide filtered-out models through the secret path", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "(luna|sol|astra)", models: MODELS } },
    } });
    providerAdd(env, "openai", class OpenAIProtocol {});
    expect(listEndpointModels(env)).toEqual([{ name: "codex", models: ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-luna"] }]);
    const candidates = listModelCandidates(env);
    expect(candidates).toContain("codex/gpt-6-sol");
    expect(candidates).not.toContain("gpt-5-pro");
    expect(candidates).not.toContain("codex/gpt-5-pro");
    // a filtered-out model is unknown as a bare id, but an explicit
    // endpoint/model combo still resolves (same rule as secret models)
    expect(await resolveModelCombo("gpt-5-pro", env)).toBeUndefined();
    expect(await resolveModelCombo("codex/gpt-5-pro", env)).toBe("codex/gpt-5-pro");
  });

  test("a live models() refresh is filtered the same way", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { live: { provider: "wire", url: "http://live", filter: "^keep" } },
    } });
    class Wire {
      static provider = {};
      static async models() { return { "keep-me": null, drop: { label: "Drop" } }; }
    }
    providerAdd(env, "wire", Wire);
    const models = await modelsOf(env, "live", { refresh: true });
    expect(models).toEqual({ "keep-me": null, drop: { label: "Drop", secret: true } });
    // the persisted cache stores the FULL list; only the view is filtered
    expect(JSON.parse(readFileSync(join(dir, "auth-live.json"), "utf8")).live.models).toEqual({ "keep-me": null, drop: { label: "Drop" } });
    expect(settingsOf(env, "live").models.drop).toEqual({ label: "Drop", secret: true });
  });

  test("an invalid filter regex is a no-op, never a broken endpoint", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "([", models: MODELS } },
    } });
    expect(settingsOf(env, "codex").models).toEqual(MODELS);
  });

  test("the last-model memory rejects a now-filtered-out selection", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "astra$", models: MODELS } },
    } });
    writeFileSync(join(dir, "last-model.json"), JSON.stringify({ endpoint: "codex", model: "gpt-5-pro" }));
    expect(lastPair(env)).toBeNull();
    writeFileSync(join(dir, "last-model.json"), JSON.stringify({ endpoint: "codex", model: "gpt-6-astra" }));
    expect(lastPair(env)).toBe("codex/gpt-6-astra");
  });
});

describe("partial providers entries (endpoint preferences placeholders)", () => {
  test("unknown settings keys do not create endpoints without a url or provider", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: {
        "kimi-coding2": { fetch: false }, kimi2: { fetch: false }, ollama: { maxActive: 2 },
        pending: { cmd: "future" }, real: { provider: "openai" }, custom: { url: "https://example.test" },
      },
    } });
    expect(namesOf(env)).toEqual(["real", "custom"]);
    expect(registered(env, "kimi2")).toBe(false);
    expect(endpointOf(env, "kimi2")).toEqual({ fetch: false });
  });

  test("a bare preferences entry is not a registered endpoint — and never shadows detection", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { ollama: { maxActive: 2 }, future: { filter: "x" } },
    } });
    providerAdd(env, "ollama", OllamaPlugin);
    // no URL anywhere: nothing registers, menus stay empty
    expect(namesOf(env)).toEqual([]);
    expect(listEndpointModels(env)).toEqual([]);
    expect(await resolveModelCombo("future/some-model", env)).toBeUndefined();
    // detection ADOPTS the preferences instead of being shadowed
    const added = await detect(env);
    if (added.includes("ollama")) { // a local server is running
      expect(dynamic(env, "ollama")).toBe(true);
      expect(settingsOf(env, "ollama")).toMatchObject({
        provider: "ollama", url: "http://localhost:11434", maxActive: 2,
      });
      expect(namesOf(env)).toContain("ollama");
      // the preferences entry itself never mutated
      expect(endpointOf(env, "ollama")).toEqual({ maxActive: 2 });
    }
    expect(namesOf(env)).not.toContain("future"); // still a placeholder
  });

  test("an ambient-key endpoint adopts the same-named preferences entry", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { xai: { filter: "^grok-4" } },
    } });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-ambient";
    try {
      const added = await detect(env);
      expect(added).not.toContain("xai"); // adopted, not added
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    expect(dynamic(env, "xai")).toBe(true);
    expect(namesOf(env)).toContain("xai");
    expect(settingsOf(env, "xai")).toMatchObject({
      provider: "openai", url: "https://api.x.ai/v1", filter: "^grok-4",
    });
    expect(settingsOf(env, "xai").auth.token).toBe("xai-ambient");
    // nothing persisted: neither the connection nor the key
    expect(existsSync(join(dir, "auth-xai.json"))).toBe(false);
    // the key gone: the environment connection drops, the preferences stay
    await detect(env);
    expect(namesOf(env)).not.toContain("xai");
    expect(endpointOf(env, "xai")).toEqual({ filter: "^grok-4" });
  });

  test("a full configured entry adopts its environment twin, own connection fields winning", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { ollama: { provider: "ollama", url: "https://remote.example", maxActive: 2 } },
    } });
    providerAdd(env, "ollama", OllamaPlugin);
    await detect(env);
    // unchanged by detection when the local server is absent; when it
    // answers, the entry's own URL keeps winning over the environment's
    expect(settingsOf(env, "ollama").url).toBe("https://remote.example");
    expect(settingsOf(env, "ollama").maxActive).toBe(2);
  });

  test("a preferences entry merges over the auth-file record of a logged-in endpoint", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { codex: { filter: "(luna|sol|astra)" } },
    } });
    authSetOf(env, "codex", {
      provider: "openai", url: "https://chatgpt.com/backend-api/codex",
      auth: { token: "tok" }, models: { "gpt-6-sol": null, "gpt-5-pro": null },
    });
    const settings = settingsOf(env, "codex");
    expect(settings).toMatchObject({
      provider: "openai", url: "https://chatgpt.com/backend-api/codex", filter: "(luna|sol|astra)",
    });
    expect(settings.auth.token).toBe("tok");
    expect(settings.models["gpt-6-sol"]).toBeNull();
    expect(settings.models["gpt-5-pro"]).toEqual({ secret: true });
    expect(namesOf(env)).toContain("codex"); // the auth record completes it
  });

  test("provider-only endpoints register without a URL; command alone does not", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: {
        claude: { provider: "claude" }, // a pipe/CLI protocol needs no URL
        localcmd: { provider: "acme", cmd: "acme --serve" },
        cmdonly: { cmd: "acme --serve" },
        prefs: { maxActive: 1 }, // preferences only: not registered
      },
    } });
    expect(namesOf(env)).toEqual(["claude", "localcmd"]);
    expect(registered(env, "prefs")).toBe(false);
    expect(registered(env, "cmdonly")).toBe(false);
    expect(registered(env, "claude")).toBe(true);
  });

  test("a url-only entry resolves the built-in OpenAI protocol fallback", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { pipe: { url: "http://localhost:9999/v1" } },
    } });
    expect(namesOf(env)).toContain("pipe");
    expect(settingsOf(env, "pipe").provider).toBeUndefined(); // fallback applies at use
    providerAdd(env, "openai", OpenAIPlugin);
    const models = await modelsOf(env, "pipe"); // no crash without a protocol fetch
    expect(models).toEqual({});
  });

  test("last-model memory follows the environment connection of a preferences entry", async () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { xai: { filter: "^grok" } },
    } });
    providerAdd(env, "openai", OpenAIPlugin);
    writeFileSync(join(dir, "last-model.json"), JSON.stringify({ endpoint: "xai", model: "grok-4" }));
    expect(lastPair(env)).toBeNull(); // placeholder: no connection, no memory
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-ambient";
    try {
      authSetOf(env, "xai", { models: { "grok-4": null } }); // in-memory cache, dynamic-style
      await detect(env);
      expect(lastPair(env)).toBe("xai/grok-4");
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
  });
});

describe("Env.endpointSettingsRefresh (multi-process auth rotation)", () => {
  test("a changed auth file merges over the stale in-memory record", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    authSetOf(env, "acme", { auth: { type: "token", token: "old-token" } });
    expect(settingsOf(env, "acme").auth.token).toBe("old-token");
    // another process rotates the token on disk (its own auth file write)
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    const section = reread(env, "acme");
    expect(section.auth.token).toBe("new-token");
    expect(settingsOf(env, "acme").auth.token).toBe("new-token");
    expect(settingsOf(env, "acme").url).toBe("http://x"); // connection config survives
  });

  test("the settings.json providers entry's auth section is re-read too", async () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    await Promise.resolve(); // this process's write lands before the other process writes
    authSetOf(env, "acme", { auth: { type: "token", token: "old-token" } });
    // another process wrote BOTH files (saveEndpoint + authSet)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" } },
      acme: { auth: { type: "token", token: "newer-token" } },
    }));
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    const section = reread(env, "acme");
    // the settings file's own section wins over the auth file (layer order)
    expect(section.auth.token).toBe("newer-token");
  });

  test("a vanished auth file is a no-op, never a settings drop", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    authSetOf(env, "acme", { auth: { type: "token", token: "old-token" } });
    rmSync(join(dir, "auth-acme.json"));
    const section = reread(env, "acme");
    expect(section.auth.token).toBe("old-token"); // live settings survive
    expect(settingsOf(env, "acme").url).toBe("http://x");
  });

  test("a dynamic (environment-detected) endpoint has nothing to re-read", () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    env._endpoints.dyn = { provider: "ollama", url: "http://x" };
    env._dynamicEndpoints.add("dyn");
    mergeInMemory(env, "dyn", { auth: { type: "token", token: "env-token" } });
    const section = reread(env, "dyn");
    expect(section.auth.token).toBe("env-token"); // unchanged, no disk read
  });
});

describe("Env.endpointRemove (logout)", () => {
  test("a configured endpoint: settings.json entry and auth file go, memory forgets", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" }, keep: { provider: "ollama", url: "http://y" } },
    }));
    const env = new Env({ dir, cwd: dir });
    authSetOf(env, "acme", { token: "t-1", models: { m: null } });
    expect(existsSync(join(dir, "auth-acme.json"))).toBe(true);

    const result = env.logout("acme");
    expect(result).toEqual({ name: "acme", dynamic: false });
    expect(endpointOf(env, "acme")).toBeUndefined();
    expect(settingsOf(env, "acme")).toEqual({});
    expect(existsSync(join(dir, "auth-acme.json"))).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(onDisk.providers.acme).toBeUndefined();
    expect(onDisk.providers.keep).toEqual({ provider: "ollama", url: "http://y" }); // untouched
    // a settings write is atomic: no temp file is left behind
    expect(existsSync(join(dir, "settings.json.tmp-" + process.pid))).toBe(false);
  });

  test("an endpoint written and removed in one tick leaves no endpoint files or pending config", async () => {
    const env = new Env({ dir, cwd: dir });
    env.settings.providers.temporary = { provider: "ollama", url: "http://temporary" };
    env.logout("temporary");
    await Promise.resolve();
    expect(endpointOf(env, "temporary")).toBeUndefined();
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "auth-temporary.json"))).toBe(false);
  });

  test("detection removes a stale persisted record of a dynamic endpoint", async () => {
    // a build that persisted environment-detected endpoints left
    // auth-openai.json behind: its self-contained record would
    // resurrect the endpoint after OPENAI_API_KEY is removed
    writeFileSync(join(dir, "auth-openai.json"), JSON.stringify({
      openai: { provider: "openai", url: "https://api.openai.com/v1", auth: { type: "api_key", token: "sk-stale" } },
    }));
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    expect(endpointOf(env, "openai")?.url).toBe("https://api.openai.com/v1"); // auto-cataloged from the file
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-stale"; // unchanged since the buggy build persisted it
    try {
      const added = await detect(env);
      expect(added).not.toContain("openai"); // the stale record kept the slot
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(existsSync(join(dir, "auth-openai.json"))).toBe(false); // cleaned
    expect(dynamic(env, "openai")).toBe(true);
    expect(settingsOf(env, "openai").auth.token).toBe("sk-stale"); // the environment re-derives it
  });

  test("a persisted record that DIFFERS from the environment is an explicit login — never claimed", async () => {
    writeFileSync(join(dir, "auth-openai.json"), JSON.stringify({
      openai: { provider: "openai", url: "https://api.openai.com/v1", auth: { type: "api_key", token: "sk-mine" } },
    }));
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      const added = await detect(env);
      expect(added).not.toContain("openai"); // the explicit record keeps the slot
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(existsSync(join(dir, "auth-openai.json"))).toBe(true); // untouched
    expect(dynamic(env, "openai")).toBe(false);
    expect(settingsOf(env, "openai").auth.token).toBe("sk-mine"); // the user's token wins
  });

  test("a dynamic endpoint drops out of the live map when the environment key is removed", async () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      await detect(env);
      expect(dynamic(env, "openai")).toBe(true);
      delete process.env.OPENAI_API_KEY;
      const added = await detect(env); // a fresh probe without the key
      expect(added).not.toContain("openai");
      expect(endpointOf(env, "openai")).toBeUndefined();
      expect(env._settings.openai).toBeUndefined(); // no in-memory auth left behind
      expect(existsSync(join(dir, "auth-openai.json"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  test("authSet on a dynamic endpoint merges in memory only — no auth file ever", async () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      await detect(env);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    const file = join(dir, "auth-openai.json");
    expect(dynamic(env, "openai")).toBe(true);
    expect(existsSync(file)).toBe(false);
    // providers call authSet blindly: a model-catalog refresh and a
    // credential update on an env-key endpoint must stay memory-only
    authSetOf(env, "openai", { models: { gpt: null } });
    authSetOf(env, "openai", { auth: { token: "sk-rotated" } });
    expect(settingsOf(env, "openai").models.gpt).toBeNull();
    expect(settingsOf(env, "openai").auth.token).toBe("sk-rotated");
    expect(existsSync(file)).toBe(false);
    // a write batch must not turn the update into a file either
    await batch(env, () => authSetOf(env, "openai", { models: { gpt2: null } }));
    expect(existsSync(file)).toBe(false);
  });

  test("a dynamic (environment-detected) endpoint: memory-only removal, no files touched", async () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-key";
    try {
      await detect(env);
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    expect(dynamic(env, "xai")).toBe(true);
    const result = env.logout("xai");
    expect(result.dynamic).toBe(true);
    expect(endpointOf(env, "xai")).toBeUndefined();
    expect(dynamic(env, "xai")).toBe(false);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "auth-xai.json"))).toBe(false);
  });

  test("an unknown endpoint is an ordinary error", () => {
    const env = new Env({ dir, cwd: dir });
    expect(() => env.logout("nope")).toThrow(/unknown endpoint "nope"/);
  });

  test("logoutEndpoint requires a name and routes to Env", async () => {
    const { logoutEndpoint } = await import("../lib/cli.js");
    const env = new Env({ dir, cwd: dir, settings: { providers: { acme: { provider: "ollama", url: "http://x" } } } });
    expect(() => logoutEndpoint(env, "")).toThrow(/endpoint name/);
    expect(logoutEndpoint(env, "acme").name).toBe("acme");
    expect(endpointOf(env, "acme")).toBeUndefined();
  });
});

describe("batched settings writes (lib/env/persist.js)", () => {
  test("auth files contain only auth-owned updates, never copied provider preferences", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { acme: {
        provider: "ollama", url: "http://configured", filter: "^keep", maxActive: 2,
        models: { keep: { secret: true, label: "User label" } },
      } },
    } });
    authSetOf(env, "acme", {
      auth: { token: "t" },
      models: { keep: { label: "Live label" } },
    });
    expect(JSON.parse(readFileSync(join(dir, "auth-acme.json"), "utf8"))).toEqual({
      acme: {
        auth: { token: "t" },
        models: { keep: { label: "Live label" } },
      },
    });
    expect(settingsOf(env, "acme")).toMatchObject({
      provider: "ollama", url: "http://configured", filter: "^keep", maxActive: 2,
      auth: { token: "t" }, models: { keep: { label: "User label", secret: true } },
    });
  });

  test("authSet inside a batch defers; each file lands ONCE at the batch's end", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-acme.json");
    await batch(env, async () => {
      authSetOf(env, "acme", { token: "t-1" });
      expect(existsSync(file)).toBe(false); // still in memory
      authSetOf(env, "acme", { token: "t-2", models: { m: null } });
      expect(existsSync(file)).toBe(false);
      expect(settingsOf(env, "acme").auth.token).toBe("t-2"); // live view updated
    });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).acme).toEqual({ auth: { token: "t-2" }, models: { m: null } });
  });

  test("nested batches flush at the OUTERMOST end only", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-nest.json");
    await batch(env, async () => {
      await batch(env, async () => {
        authSetOf(env, "nest", { token: "deep" });
      });
      expect(existsSync(file)).toBe(false); // the inner batch did not flush
    });
    expect(JSON.parse(readFileSync(file, "utf8")).nest.auth.token).toBe("deep");
  });

  test("a batch that throws still flushes the writes that landed before the error", async () => {
    const env = new Env({ dir, cwd: dir });
    const file = join(dir, "auth-err.json");
    await expect(batch(env, async () => {
      authSetOf(env, "err", { token: "t" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(JSON.parse(readFileSync(file, "utf8")).err.auth.token).toBe("t");
  });
});

describe("last-model.json history (8 newest combos)", () => {
  const historyEnv = () => new Env({ dir, cwd: dir, settings: {
    providers: {
      codex: { provider: "openai", url: "http://x", models: { "gpt-5-pro": null, "gpt-6-astra": null } },
      xai: { provider: "openai", url: "http://y", models: { "grok-4": null } },
    },
  } });
  const readFile = () => JSON.parse(readFileSync(join(dir, "last-model.json"), "utf8"));

  test("a legacy single-combo record migrates and keeps selecting", () => {
    const env = historyEnv();
    writeFileSync(join(dir, "last-model.json"), JSON.stringify({ endpoint: "codex", model: "gpt-6-astra" }));
    expect(lastPair(env)).toBe("codex/gpt-6-astra");
  });

  test("selection walks to the first AVAILABLE entry — removed endpoints are skipped", () => {
    const env = historyEnv();
    writeFileSync(join(dir, "last-model.json"), JSON.stringify([
      { endpoint: "gone", model: "m-1", ts: "2026-11-13T10:00:00.000Z" },
      { endpoint: "xai", model: "grok-4", ts: "2026-11-13T09:00:00.000Z" },
      { endpoint: "codex", model: "gpt-5-pro", ts: "2026-11-13T08:00:00.000Z" },
    ]));
    expect(lastPair(env)).toBe("xai/grok-4");
  });

  test("a placeholder endpoint is skipped in favor of an older registered one", () => {
    const env = new Env({ dir, cwd: dir, settings: {
      providers: { xai: { filter: "^grok" }, codex: { provider: "openai", url: "http://x" } },
    } });
    writeFileSync(join(dir, "last-model.json"), JSON.stringify([
      { endpoint: "xai", model: "grok-4", ts: "2026-11-13T10:00:00.000Z" },
      { endpoint: "codex", model: "gpt-5-pro", ts: "2026-11-13T09:00:00.000Z" },
    ]));
    expect(lastPair(env)).toBe("codex/gpt-5-pro");
  });

  test("remembering adds, refreshes and re-sorts, and evicts the oldest past 8", async () => {
    const env = historyEnv();
    remember(env, { endpoint: "codex", model: "gpt-5-pro" });
    remember(env, { endpoint: "xai", model: "grok-4" });
    let entries = readFile();
    expect(entries.map(({ endpoint, model }) => `${endpoint}/${model}`)).toEqual(["xai/grok-4", "codex/gpt-5-pro"]);
    expect(entries.every(({ ts }) => typeof ts === "string" && !Number.isNaN(Date.parse(ts)))).toBe(true);
    // re-selecting the older combo refreshes its timestamp and re-sorts
    await new Promise((resolve) => setTimeout(resolve, 5)); // a measurable gap
    remember(env, { endpoint: "codex", model: "gpt-5-pro" });
    entries = readFile();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ endpoint: "codex", model: "gpt-5-pro" });
    expect(Date.parse(entries[0].ts)).toBeGreaterThan(Date.parse(entries[1].ts));
    // fill past the 8-entry cap: the oldest combo is evicted
    writeFileSync(join(dir, "last-model.json"), JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({
        endpoint: "codex", model: `m-${i}`, ts: `2026-11-13T0${i}:00:00.000Z`,
      })),
    ));
    remember(env, { endpoint: "xai", model: "grok-4" });
    entries = readFile();
    expect(entries).toHaveLength(8);
    expect(entries[0]).toMatchObject({ endpoint: "xai", model: "grok-4" });
    expect(entries.map(({ model }) => model)).not.toContain("m-0");
    expect(entries.at(-1)).toMatchObject({ model: "m-1" });
  });

  test("malformed entries are dropped and the newest valid one wins", () => {
    const env = historyEnv();
    writeFileSync(join(dir, "last-model.json"), JSON.stringify([
      { endpoint: "", model: "m" },
      { model: "no-endpoint", ts: "2026-11-13T11:00:00.000Z" },
      "garbage",
      { endpoint: "xai", model: "grok-4", ts: "2026-11-13T09:00:00.000Z" },
    ]));
    expect(lastPair(env)).toBe("xai/grok-4");
  });
});
