import { test, expect } from "bun:test";
import { mkdir, writeFile, rm, stat, utimes, rename } from "node:fs/promises";
import { SettingsStore } from "../lib/env/settings-store.js";
import { performanceCaseRun } from "./performance-process.js";
const ROOT = "ai-tmp/settings-performance-regression";

test("large in-memory settings read and write without accidental complexity (smoke)", async () => {
  await performanceCaseRun("settings", "memory", { timeout: 25000 });
}, 30000);

test("unchanged polls never reread and each changed version loads once", async () => {
  await mkdir(ROOT, { recursive: true });
  const file = `${ROOT}/settings.json`;
  await writeFile(file, JSON.stringify({ value: 1 }));
  let loads = 0;
  const store = new SettingsStore({ sources: [{ source: file, catchAll: true }] });
  store.on("loaded", () => { loads++; });
  try {
    await store.poll();
    expect(loads).toBe(1);
    for (let count = 0; count < 20; count++) await store.poll();
    expect(loads).toBe(1);
    await writeFile(file, JSON.stringify({ value: 222 }));
    await Promise.all([store.poll(), store.poll(), store.poll()]);
    expect(store.read(["value"])).toBe(222);
    expect(loads).toBe(2);
    store.write(["value"], 333);
    expect(store.read(["value"])).toBe(333);
    await store.save();
    await store.poll(); // our own save is not reread
    expect(loads).toBe(2);
    await writeFile(file, "{invalid");
    await expect(store.poll()).rejects.toThrow();
    await writeFile(file, JSON.stringify({ value: 444 }));
    await store.poll();
    expect(store.read(["value"])).toBe(444);
    expect(loads).toBe(3);
    const before = await stat(file);
    const replacement = `${file}.replacement`;
    await writeFile(replacement, JSON.stringify({ value: 555 }));
    await utimes(replacement, before.atime, before.mtime);
    await rename(replacement, file); // same times, new inode
    await store.poll();
    expect(store.read(["value"])).toBe(555);
    expect(loads).toBe(4);
  } finally { await store.close(); await rm(ROOT, { recursive: true, force: true }); }
});

test("whole Env cold and changed large-file loads stay responsive (smoke)", async () => {
  await performanceCaseRun("settings", "env", { timeout: 35000 });
}, 40000);
