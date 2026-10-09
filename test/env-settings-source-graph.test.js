// Env's settings tree: which folders and files it declares, and the project/auth policy it applies.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../lib/namespace.js";
import { sourceGraphCreate } from "../lib/env/source-graph.js";

const handles = [];
const folders = [];
afterEach(async () => {
  const results = await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true });
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Source graphs failed to close");
});
function fixture() {
  const root = mkdtempSync(join("ai-tmp", "source-graph-")); folders.push(root);
  const dirs = Object.fromEntries(["system", "user", "one", "two"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  return dirs;
}
async function open(options) { const graph = sourceGraphCreate(options); handles.push(graph); await graph.ready(); return graph; }
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

test("the package is read-only and new keys go to the user catch-all, below other user files", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(system, "settings.json"), JSON.stringify({ pref: "package" }));
  writeFileSync(join(user, "extra.json"), JSON.stringify({ pref: "extra" }));
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.store.read(["pref"])).toBe("extra");
  graph.store.write(["newPref"], 2);
  graph.store.write(["pref"], "edited"); // the known key's owner: extra.json
  await graph.flush();
  expect(json(join(user, "settings.json"))).toEqual({ newPref: 2 });
  expect(json(join(user, "extra.json"))).toEqual({ pref: "edited" });
  expect(json(join(system, "settings.json"))).toEqual({ pref: "package" });
});

test("deleting the last field of a file removes the file", async () => {
  const { system, user, one } = fixture();
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  const file = join(user, "settings.json");
  graph.store.write(["providers", "ep"], { url: "http://local" });
  await graph.flush();
  expect(existsSync(file)).toBe(true);
  graph.store.write(["providers", "ep"], undefined);
  await graph.flush();
  expect(existsSync(file)).toBe(false);
  graph.store.write(["keep"], true);
  graph.store.write(["providers", "ep"], { url: "http://local" });
  graph.store.write(["providers", "ep"], undefined);
  await graph.flush();
  expect(json(file)).toEqual({ keep: true });
});

test("project files are trust-filtered on every load, and filtered keys are dropped on save", async () => {
  const { system, user, one } = fixture();
  const filename = join(one, NAMES.projectSettings);
  writeFileSync(filename, JSON.stringify({ tools: { folders: { "./ignored": true }, timeout: 3 }, mcp: { ignored: { command: "no" } }, sessions: "here" }));
  writeFileSync(join(one, `${NAMES.projectAuthPrefix}ep.json`), JSON.stringify({ ep: { auth: { token: "t" } }, sessions: "never" }));
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.store.read(["tools"])).toEqual({ timeout: 3 });
  expect(graph.store.read(["mcp"])).toBeUndefined();
  expect(graph.store.read(["sessions"])).toBe("here"); // only the project settings file may set sessions
  expect(graph.store.read(["sessions"])).toBe("here"); // an auth file's keys stay under providers
  graph.store.write(["tools", "timeout"], 4);
  await graph.flush();
  expect(json(filename)).toEqual({ tools: { timeout: 4 }, sessions: "here" });
  writeFileSync(filename, JSON.stringify({ tools: { folders: { worse: true }, timeout: 5 }, extensions: { evil: true } }));
  await graph.store.poll();
  expect(graph.store.read(["extensions"])).toBeUndefined();
  expect(graph.store.read(["tools"])).toEqual({ timeout: 5 });
});

test("identical explicit extension selections share one global store without mixing different selections", async () => {
  const { system, user, one, two } = fixture();
  writeFileSync(join(user, "settings.json"), JSON.stringify({ shared: "user" }));
  const first = await open({ dir: system, settingsDir: user, cwd: one, settings: { extensions: {} } });
  const second = await open({ dir: system, settingsDir: user, cwd: two, settings: { extensions: {} } });
  expect(second.global).toBe(first.global);
  expect(second.store.parent).toBe(first.global);
  expect(second.store.read(["shared"])).toBe("user");
  await first.close();
  expect(second.store.read(["shared"])).toBe("user"); // releasing one borrower keeps the parent alive
  const different = await open({ dir: system, settingsDir: user, cwd: one, settings: { extensions: { other: false } } });
  expect(different.global).not.toBe(first.global);
  const inherited = await open({ dir: system, settingsDir: user, cwd: two });
  expect(inherited.global).not.toBe(first.global);
});

test("two projects share user writes while project preferences stay private", async () => {
  const { system, user, one, two } = fixture();
  writeFileSync(join(one, NAMES.projectSettings), JSON.stringify({ tools: { timeout: 1 } }));
  const a = await open({ dir: system, settingsDir: user, cwd: one });
  const b = await open({ dir: system, settingsDir: user, cwd: two });
  const updates = [];
  a.store.on("updated", () => updates.push("a"));
  b.store.on("updated", () => updates.push("b"));
  a.store.write(["shared"], 1);
  expect(b.store.read(["shared"])).toBe(1);
  a.store.write(["tools", "timeout"], 2); // owned by project one
  expect(a.store.read(["tools", "timeout"])).toBe(2);
  expect(b.store.read(["tools", "timeout"])).toBeUndefined();
  await Promise.all([a.flush(), b.flush()]);
  expect([...new Set(updates)].sort()).toEqual(["a", "b"]); // one notice per store round
});

test("the projects source is shared across handles, in a file or in memory", async () => {
  const { system, user, one, two } = fixture();
  const a = await open({ dir: system, settingsDir: user, cwd: one });
  const b = await open({ dir: system, settingsDir: user, cwd: two });
  a.projects.assign(["projects", "x"], { pinned: true });
  expect(b.store.read(["projects", "x", "pinned"])).toBe(true);
  await a.flush();
  expect(json(join(user, "projects.json"))).toEqual({ projects: { x: { pinned: true } } });
  writeFileSync(join(one, `${NAMES.projectAuthPrefix}projects.json`), JSON.stringify({ projects: { stolen: true } }));
  await a.store.poll();
  expect(a.store.read(["projects", "stolen"])).toBeUndefined(); // a refused project key
  const memory = await open({ dir: system, settingsDir: null, cwd: one });
  memory.projects.assign(["projects", "y"], 1);
  expect(memory.store.read(["projects", "y"])).toBe(1);
});

test("sessions and endpoint scopes follow the project file that owns them", async () => {
  const { system, user, one } = fixture();
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.sessionsScope()).toBe("user");
  expect(graph.endpointScope("ep")).toBe("package");
  writeFileSync(join(one, NAMES.projectSettings), JSON.stringify({ sessions: "local", providers: { ep: { url: "u" } } }));
  await graph.store.poll();
  expect(graph.sessionsScope()).toBe("local");
  expect(graph.endpointScope("ep")).toBe("local");
  writeFileSync(join(one, `${NAMES.projectAuthPrefix}auth.json`), JSON.stringify({ auth: { token: "t" } }));
  await graph.store.poll();
  expect(graph.endpointScope("auth")).toBe("local");
});

test("auth-file lookup never creates a file; only authFileCreate (login) does, in sorted order", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(user, "auth-b.json"), JSON.stringify({ b: { auth: { token: "b" } } }));
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.authFile("a")).toBeUndefined();
  expect(graph.authFile("a", { scope: "project" })).toBeUndefined();
  const created = await graph.authFileCreate("a");
  expect(await graph.authFileCreate("a")).toBe(created);
  const auth = graph.global.nodes.filter((node) => /auth-/.test(node.source || ""));
  expect(auth.map((node) => node.source.split("/").pop())).toEqual(["auth-a.json", "auth-b.json"]);
  created.assign(["a"], { auth: { token: "a" } });
  const project = await graph.authFileCreate("a", { scope: "project" });
  project.assign(["a"], { auth: { token: "local" } });
  await graph.flush();
  expect(json(join(user, "auth-a.json"))).toEqual({ a: { auth: { token: "a" } } });
  expect(json(join(one, `${NAMES.projectAuthPrefix}a.json`))).toEqual({ a: { auth: { token: "local" } } });
  expect(graph.store.read(["providers", "a", "auth", "token"])).toBe("local"); // project files are above user files
  await expect(graph.authFileCreate("../escape")).rejects.toThrow(TypeError);
});

test("detected facts stay in memory, take no generic writes, and preferences persist in user settings", async () => {
  const { system, user, one } = fixture();
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.detectionSet("ep", { provider: "openai", url: "https://d", auth: { token: "k" }, models: { m: { maxActive: 4 } } })).toBe(true);
  expect(graph.detectionSet("ep", { provider: "openai", url: "https://d", auth: { token: "k" }, models: { m: { maxActive: 4 } } })).toBe(false);
  graph.store.write(["providers", "ep", "models", "m", "maxActive"], 1);
  graph.store.write(["providers", "ep", "filter"], "^m");
  expect(graph.detectionGet("ep").models.m.maxActive).toBe(4);
  expect(graph.store.read(["providers", "ep", "models", "m", "maxActive"])).toBe(1);
  expect(graph.configuredEndpoint("ep")).toEqual({ models: { m: { maxActive: 1 } }, filter: "^m" });
  await graph.flush();
  expect(json(join(user, "settings.json"))).toEqual({ providers: { ep: { models: { m: { maxActive: 1 } }, filter: "^m" } } });
  expect(graph.detectionRemove("ep")).toBe(true);
  expect(graph.detectionGet("ep")).toBeUndefined();
});

test("a project preference masks a global one alongside detected facts", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(user, "settings.json"), JSON.stringify({ providers: { ep: { disabled: true } } }));
  writeFileSync(join(one, NAMES.projectSettings), JSON.stringify({ providers: { ep: { disabled: false } } }));
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  graph.detectionSet("ep", { provider: "openai", url: "https://d" });
  expect(graph.store.read(["providers", "ep"])).toEqual({ provider: "openai", url: "https://d", disabled: false });
  expect(graph.configuredEndpoint("ep")).toEqual({ disabled: false });
});

test("overlapping folders: a user folder that is the package or the project is loaded once, writable", async () => {
  const { system, one } = fixture();
  writeFileSync(join(system, "settings.json"), JSON.stringify({ base: 1 }));
  writeFileSync(join(system, "auth-ep.json"), JSON.stringify({ ep: { auth: { token: "old" } } }));
  const shared = await open({ dir: system, settingsDir: system, cwd: system });
  expect(shared.global.nodes.some((node) => node.writable === false && node.source)).toBe(false); // no package layer
  expect(shared.project).toBeUndefined();
  shared.store.write(["providers", "ep", "auth", "token"], "new");
  await shared.flush();
  expect(json(join(system, "auth-ep.json"))).toEqual({ ep: { auth: { token: "new" } } });
  expect(json(join(system, "settings.json"))).toEqual({ base: 1 });
  writeFileSync(join(one, NAMES.projectSettings), JSON.stringify({ local: true }));
  writeFileSync(join(one, "package-layer.json"), JSON.stringify({ packaged: true }));
  const packageIsProject = await open({ dir: one, settingsDir: null, cwd: one });
  expect(packageIsProject.store.read(["packaged"])).toBe(true);
  expect(packageIsProject.project.own(["local"])).toBe(true);
  expect(packageIsProject.global.nodes.filter((node) => node.source && !node.writable).map((node) => node.source.split("/").pop())).toEqual(["package-layer.json"]);
});

test("a malformed project auth file does not fail startup and is retried by polling", async () => {
  const { system, user, one } = fixture();
  const bad = join(one, `${NAMES.projectAuthPrefix}bad.json`);
  writeFileSync(bad, "{nope");
  const graph = await open({ dir: system, settingsDir: user, cwd: one });
  expect(graph.authFile("bad", { scope: "project" }).error).toBeInstanceOf(Error);
  writeFileSync(bad, JSON.stringify({ bad: { auth: { token: "ok" } } }));
  await graph.store.poll();
  expect(graph.store.read(["providers", "bad", "auth", "token"])).toBe("ok");
});

test("with auth disabled, credentials are stripped from every source", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { url: "u", auth: { token: "secret" } } }));
  writeFileSync(join(user, "settings.json"), JSON.stringify({ providers: { x: { auth: { token: "secret" } } } }));
  const graph = await open({ dir: system, settingsDir: user, cwd: one, auth: false, settings: { y: { auth: { token: "secret" } } } });
  expect(graph.store.read(["providers", "ep"])).toEqual({ url: "u" });
  expect(graph.store.read(["providers", "x"])).toEqual({});
  expect(graph.store.read(["y"])).toEqual({});
  await expect(graph.authFileCreate("ep")).rejects.toThrow(TypeError);
});
