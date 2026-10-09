// SettingsStore contract: a flat, ordered, project-agnostic aggregator with grouped async load/save/update.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SettingsStore } from "../lib/env/settings-store.js";
import { Env } from "../lib/env.js";

let dir;
const stores = [];
const open = (options) => { const store = new SettingsStore(options); stores.push(store); return store; };
const json = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const later = (ms = 30) => new Promise((done) => setTimeout(done, ms));
beforeEach(() => { mkdirSync("./ai-tmp", { recursive: true }); dir = resolve(mkdtempSync("./ai-tmp/store-")); });
afterEach(async () => {
  const errors = [];
  for (const store of stores.splice(0).reverse()) {
    try { await store.close(); } catch (error) { errors.push(error); }
  }
  rmSync(dir, { recursive: true, force: true });
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Settings stores failed to close");
});

test("reads merge the flat list, last wins; arrays and scalars replace; reads are detached", () => {
  const store = open({ sources: [
    { data: { a: 1, list: [1, 2], nested: { x: 1, y: 1 } } },
    { data: { a: 2, nested: { y: 2 } } },
    { data: { list: [3], nested: { z: 3 } } },
  ] });
  expect(store.read()).toEqual({ a: 2, list: [3], nested: { x: 1, y: 2, z: 3 } });
  expect(store.read(["nested", "y"])).toBe(2);
  expect(store.read(["missing", "deep"])).toBeUndefined();
  const copy = store.read(["nested"]);
  copy.x = 99;
  expect(store.read(["nested", "x"])).toBe(1);
});

test("a write lands on the last writable node holding the exact key, else the catch-all", () => {
  const store = open();
  const pkg = store.attach({ writable: false, data: { locked: 1, providers: { a: { url: "x" } } } });
  const user = store.attach({ catchAll: true, data: { theme: "dark" } });
  const project = store.attach({ data: { providers: { a: { filter: "^k" } } } });
  store.write(["providers", "a", "filter"], "^z"); // a known nested key
  expect(project.own(["providers", "a", "filter"])).toBe("^z");
  store.write(["providers", "a", "url"], "y"); // held only read-only: the catch-all takes it
  expect(user.own(["providers", "a", "url"])).toBe("y");
  expect(pkg.own(["providers", "a", "url"])).toBe("x");
  store.write(["providers", "a"], { url: "w" }); // a known whole object, replaced on its owner
  expect(project.own(["providers", "a"])).toEqual({ url: "w" });
  store.write(["fresh"], 1);
  expect(store.owner(["fresh"])).toBe(user);
  expect(store.owner(["nothing"])).toBeUndefined();
  store.write(["providers", "a"], undefined); // a delete exposes lower sources
  expect(project.own(["providers", "a"])).toBeUndefined();
  expect(store.read(["providers", "a", "url"])).toBe("y");
  expect(store.write(["absent"], undefined)).toBe(false);
});

test("reads are cached per path; a write invalidates only overlapping paths, also in child stores", () => {
  const parent = open({ sources: [{ catchAll: true, data: { a: { x: 1 }, b: 1 } }] });
  const child = open({ parent, sources: [{ data: { c: 1 } }] });
  const layer = parent.nodes[0];
  let layers = 0;
  const original = layer.layer.bind(layer);
  layer.layer = (path) => { layers++; return original(path); };
  child.read(["a"]); child.read(["b"]);
  const warm = layers;
  child.read(["a"]); child.read(["b"]);
  expect(layers).toBe(warm); // cached
  parent.write(["a", "x"], 2);
  expect(child.read(["a", "x"])).toBe(2);
  const afterWrite = layers;
  child.read(["b"]); // unrelated: still cached
  expect(layers).toBe(afterWrite);
});

test("reads and writes are immediate; one storage round saves files and announces once", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ keep: true }));
  const store = open();
  const user = store.attach({ source: join(dir, "settings.json"), catchAll: true });
  const memory = store.attach({ data: { live: 1 } });
  expect(store.read()).toEqual({ live: 1 }); // nothing loaded yet: partial state, no waiting
  await store.poll();
  expect(store.read()).toEqual({ keep: true, live: 1 });
  const events = [];
  for (const name of ["saved", "updated"]) store.on(name, ({ nodes }) => events.push([name, nodes.size, nodes.has(user)]));
  store.write(["a"], 1);
  store.write(["b"], 2);
  store.write(["live"], 2);
  expect(store.read(["a"])).toBe(1);
  expect(user.dirty).toBe(true);
  expect(memory.dirty).toBe(false); // memory has nothing to save
  await store.save();
  expect(json("settings.json")).toEqual({ keep: true, a: 1, b: 2 });
  expect(events).toEqual([["saved", 1, true], ["updated", 2, true]]);
  store.write(["a"], 1); // equal writes change nothing
  await store.save();
  expect(events.length).toBe(2);
  expect(await store.poll()).toBe(false); // our own write is never reread
});

test("the debounced storage round coalesces a burst of writes into one update", async () => {
  const store = open({ sources: [{ source: join(dir, "settings.json"), catchAll: true }] });
  await store.poll();
  let updates = 0;
  store.on("updated", () => updates++);
  for (let index = 0; index < 10; index++) store.write(["n"], index);
  await later();
  expect(updates).toBe(1);
  expect(json("settings.json")).toEqual({ n: 9 });
});

test("a poll round loads changed files together; loaded fires for equal versions, updated only for changes", async () => {
  writeFileSync(join(dir, "a.json"), JSON.stringify({ a: 1 }));
  writeFileSync(join(dir, "b.json"), JSON.stringify({ b: 1 }));
  const store = open({ sources: [{ source: join(dir, "a.json") }, { source: join(dir, "b.json") }] });
  const events = [];
  for (const name of ["loaded", "updated"]) store.on(name, ({ nodes }) => events.push([name, nodes.size]));
  expect(await store.poll()).toBe(true);
  expect(events).toEqual([["loaded", 2], ["updated", 2]]);
  expect(await store.poll()).toBe(false); // unchanged files are not reread
  expect(events.length).toBe(2);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ b: 2 }));
  await store.poll();
  expect(store.read(["b"])).toBe(2);
  expect(events.slice(2)).toEqual([["loaded", 1], ["updated", 1]]);
  await later(15);
  writeFileSync(join(dir, "b.json"), JSON.stringify({ b: 2 })); // touched, equal content
  await store.poll();
  expect(events.slice(4)).toEqual([["loaded", 1]]);
});

test("malformed files reject the poll and keep their last good data; JSONC is accepted", async () => {
  writeFileSync(join(dir, "s.json"), JSON.stringify({ v: 1 }));
  const store = open({ sources: [{ source: join(dir, "s.json"), catchAll: true }] });
  await store.poll();
  writeFileSync(join(dir, "s.json"), "{broken");
  await expect(store.poll()).rejects.toThrow();
  expect(store.read(["v"])).toBe(1);
  writeFileSync(join(dir, "s.json"), "// comment\n{ \"v\": 2 }");
  await store.poll();
  expect(store.read(["v"])).toBe(2);
});

test("discovery adds one node per found file, sorted, in its place; skips manifests and attached files", async () => {
  const folder = join(dir, "layers");
  mkdirSync(folder);
  for (const [name, data] of [["b.json", { v: "b" }], ["a.json", { v: "a", only: "a" }], ["package.json", { v: "manifest" }],
    ["settings.json", { v: "settings" }], ["skip.json", { v: "skip" }]]) writeFileSync(join(folder, name), JSON.stringify(data));
  writeFileSync(join(folder, "note.txt"), "x");
  const store = open();
  const settings = store.attach({ source: join(folder, "settings.json"), catchAll: true });
  const discovery = store.attach({ source: folder, exclude: /^skip\./ }); // a folder: its *.json files
  const top = store.attach({ data: { top: true } });
  await store.poll();
  expect(discovery.nodes.map((node) => node.source.split("/").pop())).toEqual(["a.json", "b.json"]);
  expect(store.nodes).toEqual([settings, ...discovery.nodes, top]);
  expect(store.read()).toEqual({ v: "b", only: "a", top: true });
  rmSync(join(folder, "b.json"));
  expect(await store.poll()).toBe(true);
  expect(store.read(["v"])).toBe("a");
  const glob = store.attach({ source: join(folder, "a*.json") }); // a glob: a.json is attached already
  await store.poll();
  expect(glob.nodes).toEqual([]);
});

test("a file attached in a discovery's place is skipped by that discovery; empty files are deleted", async () => {
  const folder = join(dir, "auth");
  mkdirSync(folder);
  const store = open();
  const discovery = store.attach({ source: join(folder, "auth-*.json") });
  await store.poll();
  const created = store.attach({ source: join(folder, "auth-c.json") }, { before: discovery });
  await store.poll(); // the new file loads (missing: empty) and stays a single node
  created.assign(["c"], { token: "t" });
  await store.save();
  expect(JSON.parse(readFileSync(join(folder, "auth-c.json"), "utf8"))).toEqual({ c: { token: "t" } });
  await store.poll();
  expect(discovery.nodes).toEqual([]);
  expect(store.attach({ source: join(folder, "auth-c.json") })).toBe(created);
  created.assign(["c"], undefined); // saving an empty object deletes the file
  await store.save();
  expect(existsSync(join(folder, "auth-c.json"))).toBe(false);
});

test("filters choose a file node's keys; filtered keys are dropped on save", async () => {
  writeFileSync(join(dir, "p.json"), JSON.stringify({ ok: 1, refused: 2 }));
  const store = open({ sources: [{ catchAll: true }, { source: join(dir, "p.json"), filter: ({ refused: _refused, ...rest }) => rest }] });
  await store.poll();
  expect(store.read()).toEqual({ ok: 1 });
  store.write(["ok"], 3);
  await store.save();
  expect(json("p.json")).toEqual({ ok: 3 });
});

test("a child store reads over its parent, writes fall through to it, and relays its notices", async () => {
  const parent = open({ sources: [{ source: join(dir, "settings.json"), catchAll: true }] });
  const one = open({ parent, sources: [{ data: { local: 1 } }] });
  const two = open({ parent, sources: [] });
  await one.poll(); // polls the parent too
  const seen = [];
  two.on("updated", () => seen.push("two"));
  one.write(["shared"], 1); // no node of `one` takes it: the parent's catch-all does
  one.write(["local"], 2);
  expect(two.read(["shared"])).toBe(1);
  expect(two.read(["local"])).toBeUndefined();
  expect(one.owner(["shared"])).toBe(parent.nodes[0]);
  await one.save(); // saves the parent too
  expect(json("settings.json")).toEqual({ shared: 1 });
  expect(seen).toEqual(["two"]);
  expect(one.attached(join(dir, "settings.json"))).toBe(parent.nodes[0]);
});

test("save failures reject and keep the node dirty", async () => {
  const store = open();
  const bad = store.attach({ source: join(dir, "missing", "s.json"), catchAll: true });
  await store.poll();
  store.write(["a"], 1);
  await expect(store.save()).rejects.toThrow();
  expect(bad.dirty).toBe(true);
  expect(bad.error).toBeInstanceOf(Error);
  mkdirSync(join(dir, "missing"));
  await store.save();
  expect(bad.dirty).toBe(false);
});

test("writes before a file's first load are never saved over it; the load merges them over its content", async () => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ keep: 1, early: 0 }));
  const store = open();
  const user = store.attach({ source: join(dir, "settings.json"), catchAll: true });
  store.write(["early"], 1);
  expect(store.read(["early"])).toBe(1);
  await store.save(); // not loaded: nothing is written over the unread file
  expect(json("settings.json")).toEqual({ keep: 1, early: 0 });
  await store.poll();
  expect(store.read()).toEqual({ keep: 1, early: 1 });
  expect(user.dirty).toBe(true);
  await store.save();
  expect(json("settings.json")).toEqual({ keep: 1, early: 1 });
});

test("a mounted catch-all owns its namespace: a registry under tools stays in memory", async () => {
  const store = open({ sources: [
    { source: join(dir, "settings.json"), catchAll: true },
    { at: ["tools"], catchAll: true, data: { read: { safe: true } } },
  ] });
  const tools = store.nodes[1];
  await store.poll();
  expect(store.read()).toEqual({ tools: { read: { safe: true } } });
  store.write(["tools", "bash"], { safe: false }); // a new key inside the namespace
  store.write(["theme"], "dark"); // outside: the root catch-all
  expect(tools.own()).toEqual({ read: { safe: true }, bash: { safe: false } });
  expect(store.owner(["tools", "bash"])).toBe(tools);
  store.write(["tools"], { only: {} }); // the mount path replaces the namespace
  expect(store.read(["tools"])).toEqual({ only: {} });
  await store.save();
  expect(json("settings.json")).toEqual({ theme: "dark" }); // the registry is never saved
});

test("live attach and detach change the layers immediately", () => {
  const store = open({ sources: [{ catchAll: true, data: { a: 1 } }] });
  const extra = store.attach({ data: { a: 2 } });
  expect(store.read(["a"])).toBe(2);
  const below = store.attach({ data: { a: 0, b: 0 } }, { before: extra });
  expect(store.nodes.indexOf(below)).toBe(1);
  expect(store.read()).toEqual({ a: 2, b: 0 });
  expect(store.detach(extra)).toBe(true);
  expect(store.read(["a"])).toBe(0);
});

test("the store is public as Env.SettingsStore", () => {
  expect(Env.SettingsStore).toBe(SettingsStore);
});
