import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../lib/context/store.js";
import { userMessage } from "../lib/context/types.js";
import { SettingsStore } from "../lib/env/settings-store.js";
import { Env } from "../lib/env.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("Context concurrent close persists its final snapshot and refuses new messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-context-"));
  try {
    const context = new Context({ dir, id: "close-test" });
    context.append(userMessage("persist"));
    const a = context.close();
    const b = context.close();
    expect(() => context.append(userMessage("rejected"))).toThrow(/closed/);
    await Promise.all([a, b]);
    expect(await readFile(context.file, "utf8")).toContain("persist");
    await context.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SettingsStore close persists local edits but leaves borrowed parent writable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-settings-"));
  const parent = new SettingsStore({ sources: [{ data: {}, catchAll: true }] });
  const file = join(dir, "settings.json");
  const child = new SettingsStore({ parent, sources: [{ source: file, catchAll: true }] });
  try {
    child.write(["answer"], 42);
    await Promise.all([child.close(), child.close()]);
    expect(JSON.parse(await readFile(file, "utf8")).answer).toBe(42);
    expect(() => child.write(["answer"], 7)).toThrow(/closed/);
    expect(parent.write(["answer"], 7)).toBe(true);
  } finally {
    await child.close();
    await parent.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SettingsStore refuses writes through store and retained node during a pending close", async () => {
  const gate = deferred();
  const store = new SettingsStore({ sources: [{ catchAll: true }] });
  const node = store.nodes[0];
  const original = store.save.bind(store);
  store.save = async (...args) => { await gate.promise; return original(...args); };
  const close = store.close();
  expect(() => store.write(["late"], 1)).toThrow(/closed/);
  expect(() => node.assign(["late"], 1)).toThrow(/closed/);
  expect(() => node.replace({ late: 1 })).toThrow(/closed/);
  gate.resolve();
  await close;
});

test("Context retries durable failure after close rejects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-retry-"));
  try {
    const context = new Context({ dir, id: "retry" });
    context.append(userMessage("first"));
    const original = context.flushAsync.bind(context);
    let fail = true;
    context.flushAsync = async () => {
      if (fail) { fail = false; throw new Error("injected persistence failure"); }
      return original();
    };
    await expect(context.close()).rejects.toThrow(/injected persistence failure/);
    context.append(userMessage("second"));
    await context.close();
    expect(await readFile(context.file, "utf8")).toContain("second");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SettingsStore close rejects after a failed file write and still releases parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-failure-"));
  const parent = new SettingsStore();
  const child = new SettingsStore({ parent, sources: [{ source: join(dir, "missing", "settings.json"), catchAll: true }] });
  try {
    child.write(["value"], true);
    await expect(child.close()).rejects.toThrow();
    expect(child.closed).toBe(true);
    expect(parent.closed).toBe(false);
  } finally { await parent.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SettingsStore close rejects an early write blocked by malformed initial file without clobbering it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-malformed-"));
  const file = join(dir, "settings.json");
  const { writeFile } = await import("node:fs/promises");
  const invalid = "{invalid json";
  await writeFile(file, invalid);
  const store = new SettingsStore({ sources: [{ source: file, catchAll: true }] });
  try {
    store.write(["accepted"], true);
    await expect(store.close()).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(invalid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Context close awaits an already pending async flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-flush-"));
  try {
    const context = new Context({ dir, id: "pending" });
    context.append(userMessage("waiting"));
    const flush = context.flushAsync();
    const close = context.close();
    await Promise.all([flush, close]);
    expect(await readFile(context.file, "utf8")).toContain("waiting");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Env close awaits graph persistence and frees its registry slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-env-"));
  try {
    const env = await Env.open(dir, { dir, settingsDir: null });
    await env.ready();
    const node = env._sourceGraph.store.attach({ source: join(dir, "lifecycle.json"), catchAll: true });
    await env._sourceGraph.store.poll({ parent: false });
    node.assign(["lifecycleValue"], "durable");
    const first = env.close();
    const second = env.close();
    expect(env.closed).toBe(true);
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(join(dir, "lifecycle.json"), "utf8")).lifecycleValue).toBe("durable");
    const replacement = await Env.open(dir, { dir, settingsDir: null });
    await replacement.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Env close attempts graph release after another owned release fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omoya-lifecycle-env-error-"));
  try {
    const env = await Env.open(dir, { dir, settingsDir: null });
    await env.ready();
    const node = env._sourceGraph.store.attach({ source: join(dir, "release.json"), catchAll: true });
    await env._sourceGraph.store.poll({ parent: false });
    node.assign(["saved"], true);
    env._settingsAccess.close = () => { throw new Error("adapter release failed"); };
    await expect(env.close()).rejects.toThrow(/adapter release failed/);
    expect(JSON.parse(await readFile(join(dir, "release.json"), "utf8")).saved).toBe(true);
    expect(env.closed).toBe(true);
    const replacement = await Env.open(dir, { dir, settingsDir: null });
    await replacement.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("close promises remain pending until asynchronous work settles", async () => {
  const gate = deferred();
  const store = new SettingsStore();
  const original = store.save.bind(store);
  store.save = async (...args) => { await gate.promise; return original(...args); };
  let completed = false;
  const close = store.close().then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  gate.resolve();
  await close;
  expect(completed).toBe(true);
});
