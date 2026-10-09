import { expect, test } from "bun:test";
import { serve } from "../lib/app/web/server.js";
import { testEnv } from "./fakes.js";
import { Env } from "../lib/env.js";

test("serve closes its created root Env after persisting project description", async () => {
  const origin = await testEnv();
  const settingsDir = origin._settingsDir;
  const cwd = origin.folder;
  const dir = origin._dir;
  await origin.close();
  const web = await serve({ port: 0, envOptions: { dir, cwd, settingsDir, settings: { providers: { p: { provider: "test", url: "test://script" } } } } });
  try {
    await Env.ready();
    Env.settings.projects[cwd] = { models: { "p/m": "2026-01-01T00:00:00.000Z" }, groups: { work: true }, description: "Root project" };
  } finally {
    await web.stop();
    delete Env.settings.projects[cwd];
    await Env.settingsFlush();
  }
  await web.done;
  expect(web.env.closed).toBe(true);
});

test("serve does not close a borrowed root Env", async () => {
  const env = await testEnv();
  const web = await serve({ port: 0, env });
  await web.stop();
  expect(env.closed).toBe(false);
  await env.close();
});
