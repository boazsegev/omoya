// Provider protocols are reusable classes; endpoints are named settings.
import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { loadHistory, touchHistory } from "../lib/env/model-history.js";
import OllamaPlugin from "../providers/ollama.js";
import OpenAIPlugin from "../providers/openai.js";
import AnthropicPlugin from "../providers/anthropic.js";
import { listEndpointModels, listModelCandidates } from "../lib/app/shared/catalog.js";
import { resolveModelCombo } from "../lib/app/shared/model-select.js";
import { authSetOf, detect, dynamic, endpointOf, lastPair, mergeInMemory, modelsOf, namesOf, providerAdd, providerNamesOf, providerOf, providersLoad, refresh, registered, reread, settingsOf, toolNames } from "./env-internals.js";

async function readyEnv(options) {
  const { cwd, ...envOptions } = options;
  const env = await Env.open(cwd ?? options.dir, { ...envOptions, init: { providers: false, tools: false, detect: false, models: false } });
  return env;
}

let dir;
const savedSettingsDir = process.env[NAMES.settingsEnv];
beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = mkdtempSync("./ai-tmp/endpoints-");
  // pin the user settings layer to THIS test's folder: dynamic writes
  // (auth files, endpoints) land beside it and never leak across tests
  process.env[NAMES.settingsEnv] = dir;
});
afterEach(async () => {
  const results = await Promise.allSettled(Object.values(Env.envs).filter((env) => env.folder === resolve(dir) || env.folder.startsWith(`${resolve(dir)}/`)).map((env) => env.close()));
  rmSync(dir, { recursive: true, force: true });
  if (savedSettingsDir === undefined) delete process.env[NAMES.settingsEnv];
  else process.env[NAMES.settingsEnv] = savedSettingsDir;
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Endpoint Envs failed to close");
});

/** An auth file as login (or the user) creates it; only those may create auth files. */
const loggedIn = (name, record = {}) => writeFileSync(join(dir, `auth-${name}.json`), JSON.stringify({ [name]: record }));
/** last-model.json as another process saves it: `<endpoint>/<model>` -> ISO timestamp. */
const remembered = (pairs) => writeFileSync(join(dir, "last-model.json"), JSON.stringify(Object.fromEntries(
  pairs.map((pair, index) => [pair, new Date(Date.UTC(2026, 10, 13, 10 - index)).toISOString()]))));

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
    const env = await Env.open(dir, { dir, settings: {
      providers: { "openai-codex": { provider: "openai", url: "https://chatgpt.com/backend-api/codex" } },
    }, init: { detect: false } });
    expect(providerOf(env, "openai")).toBeDefined();
    expect(endpointOf(env, "openai-codex")?.provider).toBe("openai");
    expect(toolNames(env).length).toBeGreaterThan(1);
  });

  test("loads basename-keyed classes from package and configured roots after settings (NEVER the project folder)", async () => {
    const cwd = join(dir, "project");
    const extra = resolve(dir, "extra-extension", "providers");
    mkdirSync(join(dir, "providers"));
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      loadedBeforeProviders: true,
      extensions: { [resolve(dir, "extra-extension")]: true },
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

    const env = await readyEnv({ dir, cwd });
    expect(env.settings.loadedBeforeProviders).toBe(true);
    await providersLoad(env);

    expect(providerNamesOf(env)).toEqual(expect.arrayContaining(["alpha", "gamma", "openai"])); // beta: project root, never scanned
    expect(providerOf(env, "alpha").name).toBe("AlphaProtocol");
    expect(endpointOf(env, "alphaLocal")).toEqual({ provider: "alpha", url: "http://explicit" });
    expect(endpointOf(env, "alphaRemote")).toEqual({ provider: "alpha", url: "http://remote" });
  });

  test("the default class endpoint detector does no work", async () => {
    class QuietProtocol {}
    const env = await readyEnv({ dir, cwd: dir, settings: { providers: {} } });
    providerAdd(env, "quiet", QuietProtocol);
    await detect(env);
    expect(namesOf(env)).toEqual([]);
  });

  test("Ollama and OpenAI protocol classes detect only their known local endpoints", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ models: [] }));
    };
    try {
      const env = await readyEnv({ dir, cwd: dir });
      providerAdd(env, "ollama", OllamaPlugin);
      providerAdd(env, "openai", OpenAIPlugin);
      await detect(env);
      expect(endpointOf(env, "ollama")).toEqual({ provider: "ollama", url: "http://localhost:11434" });
      expect(endpointOf(env, "lm-studio")).toEqual({ provider: "openai", url: "http://localhost:1234/v1" });
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
    const env = await readyEnv({ dir, cwd: dir });
    providerAdd(env, "ollama", OllamaLogin);
    await env.login("new-ollama", { provider: "ollama", url: "http://host" });
    expect(endpointOf(env, "new-ollama").local).toBeUndefined();
    env.settings.providers["remote-ollama"] = { provider: "ollama", url: "https://host" };
    await env.login("remote-ollama", { provider: "ollama", url: "https://host" });
    expect(endpointOf(env, "remote-ollama").remote).toBeUndefined();
    expect(endpointOf(env, "remote-ollama").local).toBeUndefined();
  });

  test("explicit endpoint settings always beat automatic detection", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { ollama: { provider: "ollama", url: "https://remote.example" } },
    } });
    providerAdd(env, "ollama", OllamaPlugin);
    await detect(env);
    expect(endpointOf(env, "ollama")).toEqual({ provider: "ollama", url: "https://remote.example" });
  });

  test("endpoint data without an auth file stays in memory; an existing auth file is updated in place", async () => {
    const env = await readyEnv({
      dir,
      cwd: dir,
      settings: { providers: { remote: { provider: "ollama", url: "https://host" } } },
    });
    authSetOf(env, "remote", { token: "secret", models: { m: null } });
    await env.settingsFlush();
    expect(settingsOf(env, "remote")).toEqual({
      provider: "ollama",
      url: "https://host",
      auth: { token: "secret" },
      models: { m: null },
    });
    expect(existsSync(join(dir, "auth-remote.json"))).toBe(false); // only login creates auth files
    loggedIn("remote", { auth: { token: "old" } });
    await env._sourceGraph.store.poll();
    authSetOf(env, "remote", { token: "rotated", models: { n: null } });
    await env.settingsFlush();
    expect(JSON.parse(readFileSync(join(dir, "auth-remote.json"), "utf8"))).toEqual({
      remote: { auth: { token: "rotated" }, models: { n: null } },
    });
  });
});

describe("ambient API-key endpoint detection", () => {
  test("OPENAI_API_KEY configures a DYNAMIC openai endpoint — in memory only, never persisted", async () => {
    const env = await readyEnv({ dir, cwd: dir });
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
      const env = await readyEnv({ dir, cwd: dir });
      providerAdd(env, "anthropic", AnthropicPlugin);
      await detect(env);
      expect(listModelCandidates(env)).toContain("anthropic/claude-opus-5");
      expect(settingsOf(env, "anthropic").auth.workspaceId).toBe("wrkspc_team");
      expect(existsSync(join(dir, "auth-anthropic.json"))).toBe(false);
      await detect(env);
      expect(settingsOf(env, "anthropic").auth.token).toBe("sk-ant-multi");
      expect(existsSync(join(dir, "auth-anthropic.json"))).toBe(false);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
      else process.env.ANTHROPIC_WORKSPACE_ID = savedWorkspace;
    }
  });

  test("XAI_API_KEY configures a dynamic xai endpoint (pi's environment naming)", async () => {
    const env = await readyEnv({ dir, cwd: dir });
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
    const env = await readyEnv({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const savedKey = process.env.AZURE_OPENAI_API_KEY;
    const savedUrl = process.env.AZURE_OPENAI_BASE_URL;
    process.env.AZURE_OPENAI_API_KEY = "az-key";
    delete process.env.AZURE_OPENAI_BASE_URL;
    try {
      const added = await detect(env);
      expect(added).not.toContain("azure-openai"); // no base URL: no endpoint
      process.env.AZURE_OPENAI_BASE_URL = "https://res.openai.azure.com/openai/v1";
      await env.close();
      const fresh = await readyEnv({ dir, cwd: dir });
      providerAdd(fresh, "openai", OpenAIPlugin);
      const added2 = await detect(fresh);
      expect(added2).toContain("azure-openai");
      expect(endpointOf(fresh, "azure-openai").url).toBe("https://res.openai.azure.com/openai/v1");
    } finally {
      if (savedKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = savedKey;
      if (savedUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
      else process.env.AZURE_OPENAI_BASE_URL = savedUrl;
    }
  });

  test("an existing openai endpoint is never overridden by the environment", async () => {
    const env = await readyEnv({
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
  const wireEnv = async (behavior) => {
    const env = await readyEnv({
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
    const env = await wireEnv((self) => {
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
    const env = await wireEnv(() => { throw new Error("down"); });
    authSetOf(env, "dead", { models: { stale: { label: "Stale" } } });
    await refresh(env);
    expect(settingsOf(env, "dead").models).toEqual({ stale: { label: "Stale" } });
  });

  test("endpointModels without refresh reads cache + static config only", async () => {
    let queried = 0;
    const env = await wireEnv(() => { queried++; return { live: null }; });
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
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { cloud: { filter: "^keep" } },
    } });
    providerAdd(env, "wire", class Wire {
      static provider = {};
      static async models() { return { "keep-1": null, drop: { label: "Drop" } }; }
    });
    env._dynamicEndpoints.add("cloud");
    env._sourceGraph.detectionSet("cloud", { provider: "wire", url: "http://adopted" });
    expect(endpointOf(env, "cloud")).toEqual({ provider: "wire", url: "http://adopted", filter: "^keep" });
    const models = await modelsOf(env, "cloud", { refresh: true });
    expect(models).toEqual({ "keep-1": null, drop: { label: "Drop", secret: true } }); // the preference's filter applies
    expect(settingsOf(env, "cloud").models["keep-1"]).toBeNull(); // the cache refreshed in memory (dynamic: no file)
    expect(existsSync(join(dir, "auth-cloud.json"))).toBe(false);
    // the placeholder alone still resolves NOTHING (it is not an endpoint)
    await env.close();
    const bare = await readyEnv({ dir, cwd: dir, settings: { providers: { cloud: { filter: "^keep" } } } });
    expect(endpointOf(bare, "cloud")).toEqual({ filter: "^keep" });
    expect(namesOf(bare)).toEqual([]);
  });
});

describe("secret endpoints and models", () => {
  test("stay unpublished while an explicit endpoint/model combo resolves", async () => {
    const env = await readyEnv({
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

  test("endpointSettings marks non-matching models secret; matching metadata survives", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "(luna|sol|astra)", models: MODELS } },
    } });
    const { models } = settingsOf(env, "codex");
    expect(models["gpt-6-sol"]).toEqual({ label: "Sol" });
    expect(models["gpt-6-astra"]).toEqual({ label: "Astra" });
    expect(models["gpt-5.6-luna"]).toBeNull();
    expect(models["gpt-5-pro"]).toEqual({ label: "Pro", secret: true });
    // the stored config is untouched — the filter is a view
    expect(env.settings.providers.codex.models["gpt-5-pro"]).toEqual({ label: "Pro" });
    // endpoint() is the effective CONNECTION view: settings-cache
    // fields (models) live on endpointSettings only
    expect(endpointOf(env, "codex")).toEqual({ provider: "openai", url: "http://x", filter: "(luna|sol|astra)" });
  });

  test("menus/completions/combo-resolution hide filtered-out models through the secret path", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "(luna|sol|astra)", models: MODELS } },
    } });
    providerAdd(env, "openai", class OpenAIProtocol {});
    expect(listEndpointModels(env)).toEqual([{ name: "codex", models: ["gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol"] }]);
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
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { live: { provider: "wire", url: "http://live", filter: "^keep" } },
    } });
    class Wire {
      static provider = {};
      static async models() { return { "keep-me": null, drop: { label: "Drop" } }; }
    }
    providerAdd(env, "wire", Wire);
    const models = await modelsOf(env, "live", { refresh: true });
    await env.settingsFlush();
    expect(models).toEqual({ "keep-me": null, drop: { label: "Drop", secret: true } });
    // the in-memory cache stores the FULL list; only the view is filtered; no auth file
    expect(env._sourceGraph.runtime.own(["providers", "live", "models"])).toEqual({ "keep-me": null, drop: { label: "Drop" } });
    expect(existsSync(join(dir, "auth-live.json"))).toBe(false);
    expect(settingsOf(env, "live").models.drop).toEqual({ label: "Drop", secret: true });
  });

  test("an invalid filter regex is a no-op, never a broken endpoint", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "([", models: MODELS } },
    } });
    expect(settingsOf(env, "codex").models).toEqual(MODELS);
  });

  test("the last-model memory rejects a now-filtered-out selection", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { codex: { provider: "openai", url: "http://x", filter: "astra$", models: MODELS } },
    } });
    remembered(["codex/gpt-5-pro"]);
    await loadHistory(env);
    expect(lastPair(env)).toBeNull();
    remembered(["codex/gpt-6-astra"]);
    await loadHistory(env);
    expect(lastPair(env)).toBe("codex/gpt-6-astra");
  });
});

describe("partial providers entries (endpoint preferences placeholders)", () => {
  test("unknown settings keys do not create endpoints without a url or provider", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
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
    const env = await readyEnv({ dir, cwd: dir, settings: {
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
    const env = await readyEnv({ dir, cwd: dir, settings: {
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
    // The initial environment connection remains fixed for this Env.
    await detect(env);
    expect(namesOf(env)).toContain("xai");
    expect(endpointOf(env, "xai")).toMatchObject({ filter: "^grok-4", provider: "openai" });
  });

  test("a full configured entry adopts its environment twin, own connection fields winning", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { ollama: { provider: "ollama", url: "https://remote.example", maxActive: 2 } },
    } });
    providerAdd(env, "ollama", OllamaPlugin);
    await detect(env);
    // unchanged by detection when the local server is absent; when it
    // answers, the entry's own URL keeps winning over the environment's
    expect(settingsOf(env, "ollama").url).toBe("https://remote.example");
    expect(settingsOf(env, "ollama").maxActive).toBe(2);
  });

  test("a preferences entry merges over the auth-file record of a logged-in endpoint", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
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

  test("provider-only endpoints register without a URL; command alone does not", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
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
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { pipe: { url: "http://localhost:9999/v1" } },
    } });
    expect(namesOf(env)).toContain("pipe");
    expect(settingsOf(env, "pipe").provider).toBeUndefined(); // fallback applies at use
    providerAdd(env, "openai", OpenAIPlugin);
    const models = await modelsOf(env, "pipe"); // no crash without a protocol fetch
    expect(models).toEqual({});
  });

  test("last-model memory follows the environment connection of a preferences entry", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { xai: { filter: "^grok" } },
    } });
    providerAdd(env, "openai", OpenAIPlugin);
    remembered(["xai/grok-4"]);
    await loadHistory(env);
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
  test("a changed auth file merges over the stale in-memory record", async () => {
    const env = await readyEnv({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    authSetOf(env, "acme", { auth: { type: "token", token: "old-token" } });
    await env.settingsFlush();
    expect(settingsOf(env, "acme").auth.token).toBe("old-token");
    // another process rotates the token on disk (its own auth file write)
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    await env._sourceGraph.store.poll();
    const section = await reread(env, "acme");
    expect(section.auth.token).toBe("new-token");
    expect(settingsOf(env, "acme").auth.token).toBe("new-token");
    expect(settingsOf(env, "acme").url).toBe("http://x"); // connection config survives
  });

  test("the settings.json providers entry's auth section is re-read too", async () => {
    const env = await readyEnv({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    // This process's graph write lands synchronously before the external write.
    authSetOf(env, "acme", { auth: { type: "token", token: "old-token" } });
    await env.settingsFlush();
    // another process wrote BOTH files (saveEndpoint + authSet)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" } },
      acme: { auth: { type: "token", token: "newer-token" } },
    }));
    writeFileSync(join(dir, "auth-acme.json"), JSON.stringify({
      acme: { auth: { type: "token", token: "new-token" } },
    }));
    await env._sourceGraph.store.poll();
    const section = await reread(env, "acme");
    // The endpoint auth file is the higher-priority owner of credentials.
    expect(section.auth.token).toBe("new-token");
  });

  test("a vanished auth file drops its credentials but preserves connection settings", async () => {
    const env = await readyEnv({ dir, cwd: dir, settingsDir: dir });
    env.settings.providers.acme = { provider: "ollama", url: "http://x" };
    loggedIn("acme", { auth: { type: "token", token: "old-token" } });
    await env._sourceGraph.store.poll();
    expect(settingsOf(env, "acme").auth.token).toBe("old-token");
    rmSync(join(dir, "auth-acme.json"));
    await env._sourceGraph.store.poll();
    const section = await reread(env, "acme");
    expect(section?.auth?.token).toBeUndefined(); // deleted credentials must not linger
    expect(settingsOf(env, "acme").url).toBe("http://x");
  });

  test("a dynamic (environment-detected) endpoint has nothing to re-read", async () => {
    const env = await readyEnv({ dir, cwd: dir, settingsDir: dir });
    env._sourceGraph.detectionSet("dyn", { provider: "ollama", url: "http://x" });
    env._dynamicEndpoints.add("dyn");
    mergeInMemory(env, "dyn", { auth: { type: "token", token: "env-token" } });
    expect(settingsOf(env, "dyn").auth.token).toBe("env-token"); // detection memory, no disk read
  });
});

describe("Env.endpointRemove (logout)", () => {
  test("a configured endpoint: settings.json entry and auth file go, memory forgets", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { acme: { provider: "ollama", url: "http://x" }, keep: { provider: "ollama", url: "http://y" } },
    }));
    loggedIn("acme", { auth: { token: "t-1" }, models: { m: null } });
    const env = await readyEnv({ dir, cwd: dir });

    const result = env.logout("acme");
    await env.settingsFlush();
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

  test("an endpoint written and removed immediately leaves no endpoint files or config", async () => {
    const env = await readyEnv({ dir, cwd: dir });
    env.settings.providers.temporary = { provider: "ollama", url: "http://temporary" };
    env.logout("temporary");
    expect(endpointOf(env, "temporary")).toBeUndefined();
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, "auth-temporary.json"))).toBe(false);
  });

  test("a persisted record that DIFFERS from the environment is an explicit login — never claimed", async () => {
    writeFileSync(join(dir, "auth-openai.json"), JSON.stringify({
      openai: { provider: "openai", url: "https://api.openai.com/v1", auth: { type: "api_key", token: "sk-mine" } },
    }));
    const env = await readyEnv({ dir, cwd: dir });
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

  test("a detected process key remains stable across repeated detection", async () => {
    const env = await readyEnv({ dir, cwd: dir });
    providerAdd(env, "openai", OpenAIPlugin);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      await detect(env);
      expect(dynamic(env, "openai")).toBe(true);
      delete process.env.OPENAI_API_KEY;
      const added = await detect(env);
      expect(added).not.toContain("openai");
      expect(endpointOf(env, "openai")?.provider).toBe("openai");
      expect(settingsOf(env, "openai").auth?.token).toBe("sk-ambient");
      expect(existsSync(join(dir, "auth-openai.json"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  test("authSet on a dynamic endpoint merges in memory only — no auth file ever", async () => {
    const env = await readyEnv({ dir, cwd: dir });
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
    // Further dynamic updates must remain memory-only too.
    authSetOf(env, "openai", { models: { gpt2: null } });
    expect(existsSync(file)).toBe(false);
  });

  test("a dynamic (environment-detected) endpoint: memory-only removal, no files touched", async () => {
    const env = await readyEnv({ dir, cwd: dir });
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

  test("an unknown endpoint is an ordinary error", async () => {
    const env = await readyEnv({ dir, cwd: dir });
    expect(() => env.logout("nope")).toThrow(/unknown endpoint "nope"/);
  });

  test("Env.logout requires a name", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: { providers: { acme: { provider: "ollama", url: "http://x" } } } });
    expect(() => env.logout("")).toThrow(/endpoint name/);
    expect(env.logout("acme").name).toBe("acme");
    expect(endpointOf(env, "acme")).toBeUndefined();
  });
});

describe("graph-backed auth persistence", () => {
  test("auth files contain only auth-owned updates, never copied provider preferences", async () => {
    loggedIn("acme");
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { acme: {
        provider: "ollama", url: "http://configured", filter: "^keep", maxActive: 2,
        models: { keep: { secret: true, label: "User label" } },
      } },
    } });
    authSetOf(env, "acme", {
      auth: { token: "t" },
      models: { keep: { label: "Live label" } },
    });
    await env.settingsFlush();
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

  test("successive auth updates persist immediately, replacing a rotated token without dropping models", async () => {
    loggedIn("acme");
    const env = await readyEnv({ dir, cwd: dir });
    const file = join(dir, "auth-acme.json");
    authSetOf(env, "acme", { token: "t-1", models: { m: null } });
    await env.settingsFlush();
    expect(JSON.parse(readFileSync(file, "utf8")).acme.auth.token).toBe("t-1");
    authSetOf(env, "acme", { token: "t-2" });
    await env.settingsFlush();
    expect(settingsOf(env, "acme").auth.token).toBe("t-2");
    expect(JSON.parse(readFileSync(file, "utf8")).acme).toEqual({ auth: { token: "t-2" }, models: { m: null } });
  });

  test("an invalid auth update leaves the already-persisted record intact", async () => {
    loggedIn("err");
    const env = await readyEnv({ dir, cwd: dir });
    const file = join(dir, "auth-err.json");
    authSetOf(env, "err", { token: "t" });
    await env.settingsFlush();
    expect(() => authSetOf(env, "err", JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/unsafe/);
    expect(JSON.parse(readFileSync(file, "utf8")).err.auth.token).toBe("t");
    expect({}.polluted).toBeUndefined();
  });
});

describe("last-model.json history (8 newest pairs)", () => {
  const historyEnv = () => readyEnv({ dir, cwd: dir, settings: {
    providers: {
      codex: { provider: "openai", url: "http://x", models: { "gpt-5-pro": null, "gpt-6-astra": null } },
      xai: { provider: "openai", url: "http://y", models: { "grok-4": null } },
    },
  } });
  const stored = () => Object.entries(JSON.parse(readFileSync(join(dir, "last-model.json"), "utf8")))
    .sort((left, right) => right[1].localeCompare(left[1]));

  test("a stored pair keeps selecting", async () => {
    const env = await historyEnv();
    remembered(["codex/gpt-6-astra"]);
    await loadHistory(env);
    expect(lastPair(env)).toBe("codex/gpt-6-astra");
  });

  test("an older array file is discarded at startup", async () => {
    writeFileSync(join(dir, "last-model.json"), JSON.stringify([{ endpoint: "codex", model: "gpt-5-pro", ts: "2026-11-13T10:00:00.000Z" }]));
    const env = await historyEnv();
    expect(existsSync(join(dir, "last-model.json"))).toBe(false);
    expect(lastPair(env)).toBeNull();
  });

  test("selection walks to the first AVAILABLE pair — removed endpoints are skipped", async () => {
    const env = await historyEnv();
    remembered(["gone/m-1", "xai/grok-4", "codex/gpt-5-pro"]);
    await loadHistory(env);
    expect(lastPair(env)).toBe("xai/grok-4");
  });

  test("a placeholder endpoint is skipped in favor of an older registered one", async () => {
    const env = await readyEnv({ dir, cwd: dir, settings: {
      providers: { xai: { filter: "^grok" }, codex: { provider: "openai", url: "http://x" } },
    } });
    remembered(["xai/grok-4", "codex/gpt-5-pro"]);
    await loadHistory(env);
    expect(lastPair(env)).toBe("codex/gpt-5-pro");
  });

  test("remembering adds, refreshes and re-sorts, and evicts the oldest past 8", async () => {
    const env = await historyEnv();
    await touchHistory(env, { endpoint: "codex", model: "gpt-5-pro" });
    await touchHistory(env, { endpoint: "xai", model: "grok-4" });
    let entries = stored();
    expect(entries.map(([pair]) => pair)).toEqual(["xai/grok-4", "codex/gpt-5-pro"]);
    await new Promise((resolve) => setTimeout(resolve, 5)); // a measurable gap
    await touchHistory(env, { endpoint: "codex", model: "gpt-5-pro" }); // refreshes and re-sorts
    entries = stored();
    expect(entries.map(([pair]) => pair)).toEqual(["codex/gpt-5-pro", "xai/grok-4"]);
    expect(Date.parse(entries[0][1])).toBeGreaterThan(Date.parse(entries[1][1]));
    remembered(Array.from({ length: 8 }, (_, index) => `codex/m-${index}`)); // m-0 newest, m-7 oldest
    await loadHistory(env);
    await touchHistory(env, { endpoint: "xai", model: "grok-4" });
    entries = stored();
    expect(entries).toHaveLength(8);
    expect(entries[0][0]).toBe("xai/grok-4");
    expect(entries.map(([pair]) => pair)).not.toContain("codex/m-7");
  });

  test("malformed entries are dropped and the newest valid one wins", async () => {
    const env = await historyEnv();
    writeFileSync(join(dir, "last-model.json"), JSON.stringify({
      "no-slash": "2026-11-13T11:00:00.000Z", "/model": "2026-11-13T11:00:00.000Z", "codex/gpt-5-pro": "not a date",
      "xai/grok-4": "2026-11-13T09:00:00.000Z",
    }));
    await loadHistory(env);
    expect(lastPair(env)).toBe("xai/grok-4");
  });
});
