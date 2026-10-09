import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { loadHistory, readHistory, touchHistory } from "../lib/env/model-history.js";

const dirs = [];
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => dirs.some((dir) => env.folder === dir)).map((env) => env.close()));
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync("./ai-tmp/history-async-");
  dirs.push(dir);
  const env = await Env.open(dir, { dir, settingsDir: dir, settings: {
    providers: { wire: { provider: "openai", url: "http://wire", models: { m: {} } } },
  } });
  return { env, dir };
}

test("models answers synchronously and announces history another process saved", async () => {
  const { env, dir } = await fixture();
  await env.ready();
  writeFileSync(join(dir, "last-model.json"), JSON.stringify({ "wire/m": new Date().toISOString() }));
  const events = [];
  const listener = env.onEvent(Env.EVENT.MODELS_CHANGED, () => events.push(env.models().get("wire/m")?.lastUsed));
  expect(env.models().get("wire/m")?.lastUsed).toBeNull();
  await loadHistory(env);
  expect(env.models().get("wire/m")?.lastUsed).not.toBeNull();
  expect(events.some((value) => value !== null)).toBe(true);
  env.offEvent(listener);
  await env.close();
});

test("concurrent history touches retain the latest eight pairs", async () => {
  const { env, dir } = await fixture();
  await env.ready();
  await Promise.all(Array.from({ length: 10 }, (_, i) => touchHistory(env, { endpoint: "wire", model: `m${i}` })));
  const stored = JSON.parse(readFileSync(join(dir, "last-model.json"), "utf8"));
  const newest = Object.entries(stored).sort((left, right) => right[1].localeCompare(left[1])).map(([pair]) => pair);
  expect(newest).toEqual(["m9", "m8", "m7", "m6", "m5", "m4", "m3", "m2"].map((model) => `wire/${model}`));
  expect(readHistory(env).map(({ model }) => model)).toEqual(["m9", "m8", "m7", "m6", "m5", "m4", "m3", "m2"]);
  await env.close();
});

test("an external history change is noticed by the next poll", async () => {
  const { env, dir } = await fixture();
  await env.ready();
  writeFileSync(join(dir, "last-model.json"), JSON.stringify({ "wire/external": new Date().toISOString() }));
  expect(readHistory(env)).toEqual([]);
  await loadHistory(env);
  expect(readHistory(env)[0].model).toBe("external");
  await env.close();
});
