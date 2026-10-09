import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SettingsStore } from "../lib/env/settings-store.js";
import { storeSettingsCreate } from "../lib/env/store-settings.js";

const cleanup = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});
function fixture({ projects = true } = {}) {
  mkdirSync("ai-tmp", { recursive: true });
  const root = resolve(mkdtempSync(join("ai-tmp", "env-store-settings-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const settingsDir = join(root, "user"); const cwd = join(root, "project");
  mkdirSync(settingsDir); mkdirSync(cwd);
  const store = new SettingsStore();
  const user = store.attach({ source: join(settingsDir, "settings.json"), catchAll: true });
  const named = projects ? store.attach({ source: join(settingsDir, "projects.json") }) : undefined;
  const project = store.attach({ source: join(cwd, "ai-settings.json") });
  const settings = store.attach({});
  cleanup.push(async () => { await store.close(); });
  const env = { folder: cwd, _settingsDir: settingsDir, _sessionsBase: settingsDir, _endpointScopes: new Map(), _dynamicEndpoints: new Set() };
  const adapter = storeSettingsCreate(env, store, { user, projects: named, globalOnly: true });
  return { root, settingsDir, cwd, user, named, project, settings, store, env, adapter };
}

test("repeated settings reads reuse the effective graph snapshot until a source changes", () => {
  const { adapter, store } = fixture();
  const original = store.read.bind(store);
  let graphReads = 0;
  store.read = (path) => { graphReads++; return original(path); };
  expect(adapter.read(["tui", "theme"])).toBe("default");
  expect(adapter.read(["tui", "cursor", "shape"])).toBe("line");
  const first = graphReads;
  for (let i = 0; i < 100; i++) expect(adapter.read(["tui", "cursor", "shape"])).toBe("line");
  expect(graphReads).toBe(first);
  store.write(["tui", "theme"], "night");
  expect(adapter.read(["tui", "theme"])).toBe("night");
  expect(graphReads).toBeGreaterThan(first);
  adapter.close();
});

test("reads nested schema defaults, derived sessions, and global theme descent", () => {
  const { adapter, env, store } = fixture();
  expect(adapter.read(["tui", "cursor", "shape"])).toBe("line");
  expect(adapter.read(["web", "theme"])).toBe("system");
  expect(adapter.read(["sessions"])).toBe(join(env._settingsDir, "sessions"));
  store.write(["theme"], "night");
  expect(adapter.read(["tui", "theme"])).toBe("night");
  store.write(["web", "theme"], "light");
  expect(adapter.read(["web", "theme"])).toBe("light");
  expect(adapter.read(["tui"])).toMatchObject({ theme: "night", cursor: { shape: "line" } });
  expect(adapter.read([]).sessions).toBe(join(env._settingsDir, "sessions"));
  env._sessionsDirOverride = "custom";
  expect(adapter.read(["sessions"])).toBe(join(env.folder, "custom"));
});

test("writes and deletes project-owned paths but refuses restricted project writes", async () => {
  const { adapter, project, user, cwd, store } = fixture();
  await store.poll();
  project.replace({ tools: { timeout: 10 } });
  await store.save();
  adapter.write(["tools", "timeout"], 20);
  await store.save();
  expect(JSON.parse(readFileSync(join(cwd, "ai-settings.json"), "utf8")).tools.timeout).toBe(20);
  adapter.delete(["tools", "timeout"]);
  await store.save();
  expect(project.own().tools?.timeout).toBeUndefined();
  project.replace({ providerPaths: { rogue: true }, mcp: { rogue: {} } });
  await store.save();
  adapter.write(["providerPaths", "safe"], true);
  expect(project.own().providerPaths.safe).toBeUndefined();
  expect(user.own().providerPaths.safe).toBe(true);
  project.replace({ tools: { timeout: 42 } });
  await store.save();
  adapter.write(["tools", "folders"], { "/trusted/tool": true });
  expect(project.own().tools).toEqual({ timeout: 42 });
  expect(user.own().tools.folders).toEqual({ "/trusted/tool": true });
  adapter.write(["tools"], { timeout: 60, folders: { "/trusted/other": true } });
  await store.save();
  await store.save();
  expect(project.own().tools).toEqual({ timeout: 60 });
  expect(user.own().tools.folders).toEqual({ "/trusted/other": true });
  await store.save();
  expect(JSON.parse(readFileSync(join(cwd, "ai-settings.json"), "utf8")).tools).toEqual({ timeout: 60 });
  expect(adapter.read(["tools", "timeout"])).toBe(60);
  expect(() => adapter.write(["sessions"], "other")).toThrow(/derived/);
});

test("deleting the last field through the settings adapter removes the owned file", async () => {
  const { adapter, settingsDir, named, store } = fixture();
  await store.poll();
  const file = join(settingsDir, "projects.json");
  adapter.write(["projects", "folder", "groups", "friends"], true);
  await store.save();
  expect(JSON.parse(readFileSync(file, "utf8")).projects.folder.groups.friends).toBe(true);
  adapter.delete(["projects", "folder", "groups", "friends"]);
  await store.save();
  expect(existsSync(file)).toBe(false);
});

test("persists project keys in alphabetical order regardless of insertion order", async () => {
  const { adapter, settingsDir, store } = fixture();
  await store.poll();
  adapter.write(["projects", "/zeta", "description"], "z");
  adapter.write(["projects", "/alpha", "description"], "a");
  adapter.write(["projects", "/middle", "description"], "m");
  await store.save();
  expect(Object.keys(JSON.parse(readFileSync(join(settingsDir, "projects.json"), "utf8")).projects)).toEqual(["/alpha", "/middle", "/zeta"]);
});

test("routes schema named projects to user projects.json, never project or catch-all", async () => {
  const { adapter, settingsDir, project, user, named, store } = fixture();
  await store.poll();
  adapter.write(["projects", "folder", "groups", "friends"], true);
  await store.save();
  expect(JSON.parse(readFileSync(join(settingsDir, "projects.json"), "utf8")).projects.folder.groups.friends).toBe(true);
  expect(project.own().projects).toBeUndefined();
  expect(user.own().projects).toBeUndefined();
  expect(adapter.read(["projects", "folder", "groups", "friends"])).toBe(true);
  adapter.delete(["projects", "folder", "groups", "friends"]);
  await store.save();
  expect(adapter.read(["projects", "folder", "groups", "friends"])).toBeUndefined();
});

test("does not persist detected endpoint facts or endpoint credentials", () => {
  const { adapter, user, store, env, project } = fixture();
  store.attach({ data: { providers: { ep: { url: "detected", models: ["m"], auth: { token: "secret" } } } }, writable: false }, { before: project });
  env._dynamicEndpoints.add("ep");
  expect(() => adapter.write(["providers", "ep", "url"], "changed")).toThrow();
  expect(() => adapter.write(["providers", "ep"], { url: "changed" })).toThrow();
  expect(() => adapter.delete(["providers", "ep", "models"])).toThrow();
  expect(() => adapter.write(["providers", "ep", "auth", "token"], "bad")).toThrow();
  expect(() => adapter.write(["ep", "auth"], { token: "bad" })).toThrow();
  adapter.write(["providers", "ep", "filter"], "ok");
  expect(store.read(["providers", "ep", "filter"])).toBe("ok");
  expect(user.own().providers.ep?.url).toBeUndefined();
});

test("reads only the supplied reduced store without recovering endpoint secrets", () => {
  const { adapter, settings } = fixture();
  settings.replace({ providers: { ep: { url: "local", disabled: false } } });
  expect(adapter.read(["providers", "ep"])).toEqual({ url: "local", disabled: false });
  expect(adapter.read(["providers", "ep", "auth"])).toBeUndefined();
});

test("fails closed when the graph has not supplied the named projects source", () => {
  const { env, store } = fixture({ projects: false });
  const blocked = storeSettingsCreate(env, store, { globalOnly: true });
  expect(() => blocked.write(["projects", "one"], {})).toThrow(/unavailable/);
  expect(store.read(["projects"])).toBeUndefined();
});

test("refuses unsafe path keys", () => {
  const { adapter } = fixture();
  expect(() => adapter.write(["__proto__", "x"], true)).toThrow(TypeError);
  expect(() => adapter.read(["constructor"])).toThrow(TypeError);
});
