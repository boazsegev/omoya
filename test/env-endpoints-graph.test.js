import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Env } from "../lib/env.js";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import { endpoint, endpointNames, endpointSettings, detectEndpoints } from "../lib/env/endpoints.js";

function fixture(data = {}) {
  const root = mkdtempSync("ai-tmp/endpoint-graph-fixture-");
  const graph = sourceGraphCreate({ dir: root, cwd: root, settingsDir: null, settings: data });
  const env = { _sourceGraph: graph, _dynamicEndpoints: new Set(), _endpointScopes: new Map(),
    _settingsAccess: { read: (path) => path[0] === "providers" && path[1] === "tools" ? {} : undefined },
    _providers: {}, _modelsCache: null,
    _eventCallbacks: new Map(), settings: { projects: {} }, _dir: root, _settingsDir: null, cwd: root };
  return { env, store: graph.settings, async close() { await graph.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("graph auth records register without a duplicate endpoint registry", async () => {
  const cwd = mkdtempSync("ai-tmp/endpoint-graph-");
  class Protocol {
    static async login({ token }) { return { token }; }
    static async testConnection() { return true; }
    static async models() { return { m: {} }; }
  }
  const env = await Env.open(cwd, { dir: cwd, settingsDir: null, providers: { openai: Protocol } });
  try {
    await env.ready();
    await env.login("alpha", { provider: "openai", url: "https://example.test", token: "a" }, { scope: "package" });
    const connection = env.connection("alpha/m", { remember: false });
    expect(connection.url).toBe("https://example.test");
    expect(connection.settings.auth.token).toBe("a");
    expect(env.models().get("alpha/m")?.listed).toBe(true);
  } finally { await env.close(); rmSync(cwd, { recursive: true, force: true }); }
});

test("environment-only scanner runs once per Env while live probes and settings additions refresh", async () => {
  const f = fixture();
  let scans = 0, probes = 0;
  f.env._providers.openai = {
    detectEnvironment: async () => { scans++; return { key: { provider: "openai", url: "https://key", dynamic: true, auth: { token: "initial" } } }; },
    detect: async () => { probes++; return { local: { provider: "openai", url: `http://local/${probes}`, dynamic: true } }; },
  };
  try {
    await detectEndpoints(f.env);
    f.store.replace({ providers: { added: { provider: "openai", url: "https://settings" } } });
    await detectEndpoints(f.env);
    expect(scans).toBe(1);
    expect(probes).toBe(2);
    expect(endpoint(f.env, "local").url).toBe("http://local/2");
    expect(endpoint(f.env, "added").url).toBe("https://settings");
    expect(endpointSettings(f.env, "key").auth.token).toBe("initial");
  } finally { await f.close(); }
});

test("configured connection wins detected facts while dynamic removal restores the placeholder", async () => {
  const f = fixture({ providers: { alpha: { provider: "openai", url: "https://configured", filter: "^m" } } });
  f.env._providers.openai = { detect: async () => ({ alpha: { provider: "openai", url: "https://detected", auth: { token: "key" }, dynamic: true } }) };
  try {
    expect(await detectEndpoints(f.env)).toEqual([]);
    expect(endpoint(f.env, "alpha").url).toBe("https://configured");
    expect(endpointSettings(f.env, "alpha").auth.token).toBe("key");
    f.env._providers.openai.detect = async () => ({});
    await detectEndpoints(f.env);
    expect(endpoint(f.env, "alpha").url).toBe("https://configured");
    expect(endpointSettings(f.env, "alpha").auth).toBeUndefined();
  } finally { await f.close(); }
});

test("static discovery keeps a probed endpoint in memory without marking it dynamic", async () => {
  const f = fixture();
  f.env._providers.openai = { detect: async () => ({ alpha: { provider: "openai", url: "https://static", auth: { token: "key" } } }) };
  try {
    expect(await detectEndpoints(f.env)).toEqual(["alpha"]);
    expect(f.env._dynamicEndpoints.has("alpha")).toBe(false);
    expect(f.env._sourceGraph.runtime.own(["providers", "alpha", "auth", "token"])).toBe("key"); // never an auth file
  } finally { await f.close(); }
});

test("discovery replaces rotated credentials and drops vanished dynamic endpoints", async () => {
  const f = fixture();
  let key = "one";
  f.env._providers.openai = { detect: async () => key ? { alpha: { provider: "openai", url: "https://detected", auth: { token: key }, dynamic: true } } : {} };
  try {
    expect(await detectEndpoints(f.env)).toEqual(["alpha"]);
    key = "two";
    expect(await detectEndpoints(f.env)).toEqual([]);
    expect(endpointSettings(f.env, "alpha").auth.token).toBe("two");
    key = "";
    await detectEndpoints(f.env);
    expect(endpointNames(f.env)).toEqual([]);
  } finally { await f.close(); }
});
