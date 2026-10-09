import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import Env from "../lib/env.js";
import "../lib/agent.js";

const roots = [];
const environments = [];
afterEach(async () => {
  const results = await Promise.allSettled(environments.splice(0).map((env) => env.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Model Envs failed to close");
});

test("models reflects a new model capacity leaf immediately after a settings write", async () => {
  const root = mkdtempSync("ai-tmp/models-immediate-");
  roots.push(root);
  const env = await Env.open(root, { dir: root, settingsDir: root, settings: { maxActive: 4 } });
  environments.push(env);
  await env.ready();
  env.settings.providers.ep = { provider: "test", models: { m: {} } };
  expect(env.models(true).get("ep/m").maxActive).toBe(4);
  env.settings.providers.ep.models.m.maxActive = 1;
  expect(env.settings.providers.ep.models.m.maxActive).toBe(1);
  expect(env.models(true).get("ep/m")).toMatchObject({ maxActive: 1, available: 1 });
});
