import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sourceGraphCreate } from "../lib/env/source-graph.js";

const graphs = [];
const folders = [];
afterEach(async () => {
  for (const graph of graphs.splice(0)) {
    await graph.flush();
    await graph.close();
  }
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("API-key-detected ephemeral endpoint keeps model maxActive in persistent user settings after reload", async () => {
  const dir = mkdtempSync(join("ai-tmp", "ephemeral-max-active-"));
  folders.push(dir);
  const system = join(dir, "system");
  const user = join(dir, "user");
  const cwd = join(dir, "project");
  for (const path of [system, user, cwd]) mkdirSync(path);
  const graph = sourceGraphCreate({ dir: system, settingsDir: user, cwd });
  graphs.push(graph);
  await graph.ready();
  graph.detectionSet("ephemeral", { provider: "openai", url: "https://api.example.test", auth: { apiKey: "secret" }, models: { "model-1": { contextWindow: 8192 } } });
  const path = ["providers", "ephemeral", "models", "model-1", "maxActive"];
  graph.store.write(path, 3);
  expect(graph.store.read(path)).toBe(3);
  await graph.flush();
  expect(JSON.parse(readFileSync(join(user, "settings.json"), "utf8")).providers.ephemeral.models["model-1"].maxActive).toBe(3);
  await graph.store.poll();
  expect(graph.store.read(path)).toBe(3);
  expect(graph.store.read(["providers", "ephemeral", "models", "model-1", "contextWindow"])).toBe(8192);
});