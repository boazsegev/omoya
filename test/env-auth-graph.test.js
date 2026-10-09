import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import { NAMES } from "../lib/namespace.js";
import { authSet, mergeAuthInMemory, removeEndpoint } from "../lib/env/auth.js";

const cleanups = [];
function setup() {
  const root = mkdtempSync(join("ai-tmp", "auth-graph-"));
  const user = join(root, "user");
  const project = join(root, "project");
  mkdirSync(user); mkdirSync(project);
  const graph = sourceGraphCreate({ dir: root, settingsDir: user, cwd: project });
  const env = { _sourceGraph: graph, _endpointScopes: new Map(), _dynamicEndpoints: new Set(), _modelRetries: new Map(), cwd: project, _settingsDir: user, _dir: root, _configuredEndpoints: new Set(), _modelsPending: new Set() };
  cleanups.push(async () => { await graph.close(); rmSync(root, { recursive: true, force: true }); });
  return { env, graph, user, project };
}
afterEach(async () => {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Auth graphs failed to close");
});

test("authSet never creates an auth file: data stays in memory until a login file exists, then updates it", async () => {
  const { env, graph, user } = setup();
  await graph.ready();
  graph.store.write(["providers", "ep"], { provider: "openai", url: "https://policy" });
  expect(authSet(env, "ep", { token: "a", models: { one: {} } })).toEqual({ auth: { token: "a" }, models: { one: {} } });
  await graph.flush();
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
  expect(graph.runtime.own(["providers", "ep"])).toEqual({ auth: { token: "a" }, models: { one: {} } });
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { auth: { token: "login" } } }));
  await graph.store.poll();
  expect(authSet(env, "ep", { token: "b", models: { two: {} } })).toEqual({ auth: { token: "b" }, models: { two: {} } });
  await graph.flush();
  expect(JSON.parse(readFileSync(join(user, "auth-ep.json"), "utf8"))).toEqual({ ep: { auth: { token: "b" }, models: { two: {} } } });
  expect(graph.store.read(["providers", "ep", "url"])).toBe("https://policy");
});

test("credentials kept under a configured providers entry are updated there", async () => {
  const { env, graph, user } = setup();
  await graph.ready();
  graph.store.write(["providers", "ep"], { provider: "openai", url: "https://api", auth: { token: "old", refresh: "r" } });
  authSet(env, "ep", { auth: { token: "new" } });
  await graph.flush();
  expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8")).providers.ep.auth).toEqual({ token: "new", refresh: "r" });
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
});

test("user-scope credential rotation propagates between project graphs", async () => {
  const { env, graph, user, project } = setup();
  const peer = sourceGraphCreate({ dir: join(project, ".."), settingsDir: user, cwd: project });
  cleanups.push(() => peer.close());
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { provider: "openai", url: "https://api" } }));
  await Promise.all([graph.ready(), peer.ready()]);
  authSet(env, "ep", { token: "first" });
  expect(peer.store.read(["providers", "ep", "auth", "token"])).toBe("first");
  authSet(env, "ep", { token: "rotated" });
  expect(peer.store.read(["providers", "ep", "auth", "token"])).toBe("rotated");
});

test("unsafe endpoint names and nested keys are rejected before a graph write", () => {
  const { env, graph, user } = setup();
  expect(() => authSet(env, "../escape", { token: "secret" })).toThrow(TypeError);
  expect(() => authSet(env, "ep", JSON.parse('{"auth":{"__proto__":{"admin":true}}}'))).toThrow(TypeError);
  expect(() => removeEndpoint(env, "../escape")).toThrow(TypeError);
  expect(graph.store.read(["providers", "ep"])).toBeUndefined();
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
});

test("dynamic credentials stay in detection memory and logout removes them", () => {
  const { env, graph, user } = setup();
  env._dynamicEndpoints.add("ep");
  graph.store.write(["providers", "ep"], { provider: "policy", url: "https://policy", filter: "policy-only" });
  graph.detectionSet("ep", { provider: "openai", url: "https://dynamic", auth: { token: "initial" } });
  mergeAuthInMemory(env, "ep", { auth: { token: "next" } });
  expect(graph.detectionGet("ep")).toEqual({ provider: "openai", url: "https://dynamic", auth: { token: "next" } });
  expect(authSet(env, "ep", { models: { current: {} } }).models).toEqual({ current: {} });
  expect(graph.detectionGet("ep")).not.toHaveProperty("filter");
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
  expect(removeEndpoint(env, "ep")).toEqual({ name: "ep", dynamic: true });
  expect(graph.detectionGet("ep")).toBeUndefined();
  expect(graph.store.read(["providers", "ep", "filter"])).toBe("policy-only");
});

test("logout removes newly emptied user settings file, but preserves unrelated settings", async () => {
  const { env, graph, user } = setup();
  await graph.ready();
  graph.store.write(["providers", "temporary"], { provider: "openai", url: "https://api" });
  await graph.flush();
  const file = join(user, "settings.json");
  expect(existsSync(file)).toBe(true);
  removeEndpoint(env, "temporary");
  await graph.flush();
  expect(existsSync(file)).toBe(false);
  graph.store.write(["keep"], { value: 1 });
  graph.store.write(["providers", "ep"], { provider: "openai", url: "https://api" });
  removeEndpoint(env, "ep");
  await graph.flush();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ keep: { value: 1 } });
});

test("logout does not create absent auth files", async () => {
  const { env, graph, user } = setup();
  graph.store.write(["providers", "ep"], { url: "https://only-configured" });
  removeEndpoint(env, "ep");
  await graph.flush();
  expect(graph.authFile("ep", { scope: "user" })).toBeUndefined();
  expect(graph.authFile("ep", { scope: "project" })).toBeUndefined();
  expect(existsSync(join(user, "auth-ep.json"))).toBe(false);
});

test("logout removes settings and auth from both scopes without deleting unrelated auth sections", async () => {
  const { env, graph, user, project } = setup();
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { auth: { token: "user" } }, other: { auth: { token: "keep" } } }));
  writeFileSync(join(project, `${NAMES.projectAuthPrefix}ep.json`), JSON.stringify({ ep: { auth: { token: "project" } } }));
  await graph.ready();
  graph.store.write(["providers", "ep"], { url: "https://one" });
  expect(removeEndpoint(env, "ep")).toEqual({ name: "ep", dynamic: false });
  await graph.flush();
  expect(graph.store.read(["providers", "ep"])).toBeUndefined();
  expect(JSON.parse(readFileSync(join(user, "auth-ep.json"), "utf8"))).toEqual({ other: { auth: { token: "keep" } } });
  expect(existsSync(join(project, `${NAMES.projectAuthPrefix}ep.json`))).toBe(false);
});
