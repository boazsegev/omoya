import { afterEach, expect, test } from "bun:test";
import Env from "../lib/env.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathPreferences } from "../lib/env/path-preferences.js";
import { extensionRoots, configuredExtensions } from "../lib/env/extensions.js";
import { sourceGraphCreate } from "../lib/env/source-graph.js";
import { SettingsStore } from "../lib/env/settings-store.js";
import { storeSettingsCreate } from "../lib/env/store-settings.js";
import { defaultProviderRoots } from "../lib/env/provider-registry.js";
import { validateInitialToolFolders } from "../lib/env/tool-registry.js";

const cleanup = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});
function fixture() {
  mkdirSync("ai-tmp", { recursive: true });
  const root = resolve(mkdtempSync(join("ai-tmp", "array-policy-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ["system", "user", "project", "extension"]) mkdirSync(join(root, folder));
  return Object.fromEntries(["system", "user", "project", "extension"].map((name) => [name, join(root, name)]));
}

test("path maps reject legacy arrays without mutating them", () => {
  expect(pathPreferences({ "./one": true, "./two": false }, "skills")).toEqual(["./one"]);
  expect(() => pathPreferences(["./one"], "skills")).toThrow(/migrate legacy arrays/);
  expect(() => validateInitialToolFolders({ tools: { folders: ["./one"] } })).toThrow(/migrate legacy arrays/);
});

test("extensions accept existing direct folders and packages, but reject arrays and escaping relative paths", async () => {
  const dirs = fixture();
  expect(await extensionRoots({ [dirs.extension]: true }, { dir: dirs.system, settingsDir: dirs.user })).toEqual([dirs.extension]);
  await expect(extensionRoots({ "../extension": true }, { dir: dirs.system, settingsDir: dirs.user })).rejects.toThrow(/escapes trusted settings folder/);
});

test("trusted extension selection rejects arrays without rewriting the persisted file", async () => {
  const dirs = fixture();
  const file = join(dirs.user, "settings.json");
  const content = JSON.stringify({ extensions: ["old-package"] });
  writeFileSync(file, content);
  await expect(configuredExtensions({ dir: dirs.system, settingsDir: dirs.user })).rejects.toThrow(/migrate legacy arrays/);
  expect(readFileSync(file, "utf8")).toBe(content);
});

test("known maps reject arrays but generic and ordered settings arrays remain snapshots", () => {
  const store = new SettingsStore();
  cleanup.push(() => store.close());
  const user = store.attach({ catchAll: true });
  const env = { cwd: ".", _settingsDir: ".", _endpointScopes: new Map(), _dynamicEndpoints: new Set() };
  const settings = storeSettingsCreate(env, store, { user, projects: store.attach({}), globalOnly: true });
  for (const path of [["skills"], ["prompts"], ["tools", "folders"], ["extensions"], ["providers"], ["mcp"], ["projects"], ["env"], ["themes"], ["tui", "keys"]]) {
    expect(() => settings.write(path, ["legacy"])).toThrow(/must be a map/);
  }
  settings.write(["pluginUnknown"], [1, 2]);
  settings.write(["mcp", "server", "args"], ["--one", "--two"]);
  settings.write(["web", "search", "engines"], ["first"]);
  expect(settings.read(["pluginUnknown"])).toEqual([1, 2]);
  expect(settings.read(["mcp", "server", "args"])).toEqual(["--one", "--two"]);
  expect(settings.read(["web", "search", "engines"])).toEqual(["first"]);
  settings.write(["mcp", "server", "args"], ["--new"]);
  expect(settings.read(["mcp", "server", "args"])).toEqual(["--new"]);
});

test("source graph reports legacy map arrays without rewriting user settings and ignores retired providerPaths", async () => {
  const dirs = fixture();
  const file = join(dirs.user, "settings.json");
  const content = JSON.stringify({ skills: ["old"] });
  writeFileSync(file, content);
  const graph = sourceGraphCreate({ dir: dirs.system, cwd: dirs.project, settingsDir: dirs.user });
  cleanup.push(() => graph.close());
  await expect(graph.ready()).rejects.toThrow(/skills must be a map/);
  expect(readFileSync(file, "utf8")).toBe(content);
  expect(defaultProviderRoots({ _dir: dirs.system, _extensionRoots: [dirs.extension], settings: { providerPaths: { [dirs.user]: true } } })).not.toContain(dirs.user);
});

test("explicit extension selections isolate their global layers from each other and ordinary environments", async () => {
  const dirs = fixture();
  const other = join(resolve(dirs.system, ".."), "other-extension");
  mkdirSync(other);
  writeFileSync(join(dirs.extension, "settings.json"), JSON.stringify({ extensionOnly: "first" }));
  writeFileSync(join(other, "settings.json"), JSON.stringify({ extensionOnly: "second" }));
  const options = { dir: dirs.system, cwd: dirs.project, settingsDir: dirs.user };
  const ordinary = sourceGraphCreate({ ...options, extensionRoots: [] });
  const first = sourceGraphCreate({ ...options, extensionRoots: Promise.resolve([dirs.extension]), settings: { extensions: { [dirs.extension]: true } } });
  const second = sourceGraphCreate({ ...options, extensionRoots: Promise.resolve([other]), settings: { extensions: { [other]: true } } });
  for (const graph of [ordinary, first, second]) cleanup.push(() => graph.close());
  await Promise.all([ordinary.ready(), first.ready(), second.ready()]);
  expect(ordinary.store.read(["extensionOnly"])).toBeUndefined();
  expect(first.store.read(["extensionOnly"])).toBe("first");
  expect(second.store.read(["extensionOnly"])).toBe("second");
  ordinary.store.write(["ordinarySetting"], true);
  expect(first.store.read(["ordinarySetting"])).toBeUndefined();
  await first.close();
  await second.store.poll();
  expect(second.store.read(["extensionOnly"])).toBe("second");
  expect(ordinary.store.read(["extensionOnly"])).toBeUndefined();
});

test("Env.open with distinct extension overrides does not leak into ordinary Env.open", async () => {
  const dirs = fixture();
  const other = join(resolve(dirs.system, ".."), "other-extension");
  mkdirSync(other);
  writeFileSync(join(dirs.extension, "settings.json"), JSON.stringify({ extensionMarker: "first" }));
  writeFileSync(join(other, "settings.json"), JSON.stringify({ extensionMarker: "second" }));
  const base = { dir: dirs.system, settingsDir: dirs.user, init: { providers: false, tools: false, models: false } };
  const first = await Env.open(dirs.project, { ...base, settings: { extensions: { [dirs.extension]: true } } });
  const second = await Env.open(dirs.project, { ...base, settings: { extensions: { [other]: true } } });
  const ordinary = await Env.open(dirs.project, base);
  for (const env of [first, second, ordinary]) cleanup.push(() => env.close());
  expect(first.settings.extensionMarker).toBe("first");
  expect(second.settings.extensionMarker).toBe("second");
  expect(ordinary.settings.extensionMarker).toBeUndefined();
  await first.close();
  expect(second.settings.extensionMarker).toBe("second");
  expect(ordinary.settings.extensionMarker).toBeUndefined();
});

test("project extension declarations are ignored", async () => {
  const dirs = fixture();
  writeFileSync(join(dirs.project, "ai-settings.json"), JSON.stringify({ extensions: { [dirs.extension]: true } }));
  const graph = sourceGraphCreate({ dir: dirs.system, cwd: dirs.project, settingsDir: dirs.user });
  cleanup.push(() => graph.close());
  await graph.ready();
  expect(graph.store.read(["extensions"])).toBeUndefined();
});
