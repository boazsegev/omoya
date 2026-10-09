import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourceGraphCreate } from "../lib/env/source-graph.js";

const handles = [];
const folders = [];
function fixture() {
  const root = mkdtempSync(join("ai-tmp", "settings-discovery-")); folders.push(root);
  const dirs = Object.fromEntries(["system", "user", "one", "two"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  return dirs;
}
async function open(options) { const handle = sourceGraphCreate(options); handles.push(handle); await handle.ready(); return handle; }
afterEach(async () => {
  const results = await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  for (const root of folders.splice(0)) rmSync(root, { force: true, recursive: true });
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Settings source graphs failed to close");
});

const poll = (...handles) => Promise.all(handles.map((handle) => handle.store.poll()));

test("a shared user file appears and disappears in every project when any of them polls", async () => {
  const { system, user, one, two } = fixture();
  const a = await open({ dir: system, settingsDir: user, cwd: one });
  const b = await open({ dir: system, settingsDir: user, cwd: two });
  expect(a.global).toBe(b.global); // one global store per user folder
  writeFileSync(join(user, "extras.json"), JSON.stringify({ welcome: "new" }));
  expect(await a.store.poll()).toBe(true);
  expect(a.store.read(["welcome"])).toBe("new");
  expect(b.store.read(["welcome"])).toBe("new");
  rmSync(join(user, "extras.json"));
  await b.store.poll();
  expect(a.store.read(["welcome"])).toBeUndefined();
});

test("membership changes keep the node of an unchanged auth file", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(user, "auth-ep.json"), JSON.stringify({ ep: { auth: { token: "before" } } }));
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  const original = handle.authFile("ep");
  expect(original).toBeDefined();
  writeFileSync(join(user, "extra.json"), JSON.stringify({ other: true }));
  expect(await handle.store.poll()).toBe(true);
  expect(handle.authFile("ep")).toBe(original);
  original.assign(["ep", "auth", "token"], "after");
  expect(handle.store.read(["providers", "ep", "auth", "token"])).toBe("after");
});

test("a newly discovered later file merges over retained earlier fields", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(user, "a.json"), JSON.stringify({ pref: { first: 1, shared: "a" } }));
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  writeFileSync(join(user, "z.json"), JSON.stringify({ pref: { shared: "z" } }));
  await handle.store.poll();
  expect(handle.store.read(["pref"])).toEqual({ first: 1, shared: "z" });
});

test("project auth membership changes keep the node of an unchanged file", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(one, "ai-auth-ep.json"), JSON.stringify({ ep: { auth: { token: "old" } } }));
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  const original = handle.authFile("ep", { scope: "project" });
  expect(original).toBeDefined();
  writeFileSync(join(one, "ai-auth-other.json"), JSON.stringify({ other: { url: "u" } }));
  await handle.store.poll();
  expect(handle.authFile("ep", { scope: "project" })).toBe(original);
  handle.store.write(["providers", "ep", "auth", "token"], "rotated"); // the known key's owner takes the write
  expect(original.own(["ep", "auth", "token"])).toBe("rotated");
});

test("a new package file is visible in every project and the package stays read-only", async () => {
  const { system, user, one, two } = fixture();
  const a = await open({ dir: system, settingsDir: user, cwd: one });
  const b = await open({ dir: system, settingsDir: user, cwd: two });
  writeFileSync(join(system, "extra.json"), JSON.stringify({ packageValue: 3 }));
  await a.store.poll();
  expect(a.store.read(["packageValue"])).toBe(3);
  expect(b.store.read(["packageValue"])).toBe(3);
  a.store.write(["packageValue"], 4);
  expect(a.user.own(["packageValue"])).toBe(4); // the user catch-all, never the package file
});

test("polls settle safely when one handle closes", async () => {
  const { system, user, one, two } = fixture();
  const a = await open({ dir: system, settingsDir: user, cwd: one });
  const b = await open({ dir: system, settingsDir: user, cwd: two });
  writeFileSync(join(user, "extras.json"), JSON.stringify({ welcome: "new" }));
  const first = a.store.poll();
  const second = b.store.poll();
  await a.close();
  await first;
  await second;
  expect(b.store.read(["welcome"])).toBe("new");
});

test("update notices see every file of a poll round already loaded", async () => {
  const { system, user, one } = fixture();
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  const observed = [];
  handle.store.on("updated", () => observed.push([handle.store.read(["providers", "first", "url"]), handle.store.read(["providers", "second", "url"])]));
  writeFileSync(join(one, "ai-auth-first.json"), JSON.stringify({ first: { url: "1" } }));
  writeFileSync(join(one, "ai-auth-second.json"), JSON.stringify({ second: { url: "2" } }));
  expect(await handle.store.poll()).toBe(true);
  expect(observed).toEqual([["1", "2"]]);
});

test("a malformed required settings file fails the poll and keeps its last good data", async () => {
  const { system, user, one } = fixture();
  writeFileSync(join(system, "settings.json"), JSON.stringify({ stable: true }));
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  writeFileSync(join(system, "settings.json"), "{not json");
  await expect(handle.store.poll()).rejects.toThrow();
  expect(handle.store.read(["stable"])).toBe(true);
});

test("a malformed file does not block other files in the same round", async () => {
  const { system, user, one } = fixture();
  const handle = await open({ dir: system, settingsDir: user, cwd: one });
  writeFileSync(join(system, "extra.json"), JSON.stringify({ staged: true }));
  writeFileSync(join(one, "ai-auth-bad.json"), "{invalid!");
  await expect(handle.store.poll()).rejects.toThrow();
  expect(handle.store.read(["staged"])).toBe(true);
  expect(handle.authFile("bad", { scope: "project" }).error).toBeInstanceOf(Error);
});
