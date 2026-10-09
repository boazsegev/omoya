import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import { login } from "../lib/env/login.js";

const releases = [];
afterEach(async () => {
  const errors = [];
  for (const release of releases.splice(0).reverse()) {
    try { await release(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Login graphs failed to close");
});
function fixture({ fail = false } = {}) {
  const root = mkdtempSync(join("ai-tmp", "login-graph-"));
  const user = join(root, "user");
  const project = join(root, "project");
  mkdirSync(user); mkdirSync(project);
  const graph = sourceGraphCreate({ dir: root, settingsDir: user, cwd: project });
  releases.push(async () => { await graph.close(); rmSync(root, { recursive: true, force: true }); });
  const env = {
    _sourceGraph: graph, _providers: { openai: { login: async ({ token }) => ({ token }), testConnection: async () => { if (fail) throw new Error("denied"); return true; }, models: async () => ({}) } },
    _endpointScopes: new Map(), _dynamicEndpoints: new Set(), _modelsPending: new Set(), _modelRetries: new Map(),
    _settingsDir: user, cwd: project, _dir: root, models: () => new Map(),
  };
  return { env, graph, user };
}

test("dynamic login publishes connection and token only in detection memory", async () => {
  const { env, graph, user } = fixture();
  await graph.ready();
  await login(env, "ep", { provider: "openai", url: "https://dynamic", token: "secret" });
  expect(graph.detectionGet("ep")).toEqual({ provider: "openai", url: "https://dynamic", auth: { token: "secret" } });
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
});

test("persisted login saves a self-contained connection and credentials", async () => {
  const { env, graph, user } = fixture();
  await graph.ready();
  const result = await login(env, "ep", { provider: "openai", url: "https://api", token: "secret" }, { scope: "package" });
  expect(result.endpoint).toEqual({ provider: "openai", url: "https://api" });
  expect(graph.store.read(["providers", "ep", "auth", "token"])).toBe("secret");
  expect(JSON.parse(readFileSync(join(user, "auth-ep.json"), "utf8"))).toEqual({ ep: { provider: "openai", url: "https://api", auth: { token: "secret" }, models: {} } });
});

test("persisted login connection failure restores existing auth source exactly", async () => {
  const { env, graph, user } = fixture({ fail: true });
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { provider: "openai", url: "https://old", auth: { token: "old" } }, unrelated: { value: 1 } }, null, 2) + "\n");
  await graph.ready();
  const source = graph.authFile("ep");
  const before = readFileSync(join(user, "auth-ep.json"), "utf8");
  await expect(login(env, "ep", { provider: "openai", url: "https://new", token: "new" }, { scope: "package" })).rejects.toThrow("connection test failed");
  expect(source.own()).toEqual(JSON.parse(before));
  expect(readFileSync(join(user, "auth-ep.json"), "utf8")).toBe(before);
});

test("failed first persisted login removes provisional auth file", async () => {
  const { env, graph, user } = fixture({ fail: true });
  await graph.ready();
  await expect(login(env, "ep", { provider: "openai", url: "https://new", token: "new" }, { scope: "package" })).rejects.toThrow("connection test failed");
  expect(graph.store.read(["providers", "ep"])).toBeUndefined();
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
});
