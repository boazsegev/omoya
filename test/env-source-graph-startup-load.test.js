import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sourceGraphCreate } from "../lib/env/source-graph.js";

test("initial discovery of 160 local files yields to the event loop and keeps sorted precedence", async () => {
  const root = await mkdtemp("ai-tmp/graph-load-");
  const user = join(root, "user");
  const project = join(root, "project");
  let graph;
  try {
    await Promise.all([mkdir(user), mkdir(project)]);
    await Promise.all(Array.from({ length: 160 }, (_, index) => writeFile(
      join(user, `config-${String(index).padStart(3, "0")}.json`), JSON.stringify({ order: index }))));
    const started = performance.now();
    graph = sourceGraphCreate({ dir: root, cwd: project, settingsDir: user });
    // Startup must return before loading the files, without synchronously
    // blocking the event loop. The order of a 0ms timer and completed async
    // file I/O is platform-dependent, so don't use their race as a gate.
    expect(graph.store.read(["order"])).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(250);
    await graph.ready();
    expect(graph.store.read(["order"])).toBe(159);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    await graph?.close();
    await rm(root, { recursive: true, force: true });
  }
});
