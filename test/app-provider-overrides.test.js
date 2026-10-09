import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable, Writable } from "node:stream";
import Env from "../lib/env.js";
import { runApplication } from "../lib/app/tui/cli-run.js";
import { serve } from "../lib/app/web/server.js";

async function fixture(run) {
  const root = await mkdtemp("./ai-tmp/app-provider-");
  const cwd = resolve(root);
  const settingsDir = join(cwd, "user");
  await mkdir(settingsDir);
  const envOptions = { cwd, settingsDir, settings: { providers: { custom: { provider: "test", url: "test://original", models: { m: {} } } } } };
  try { await run({ cwd, settingsDir, envOptions }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });

test("TUI invocation provider overrides stay on its isolated Env and do not write disk", async () => fixture(async ({ cwd, settingsDir, envOptions }) => {
  const result = await runApplication({ envOptions, model: { model: "custom/m", url: "test://temporary", token: "one" }, timeout: "5s",
    mode: "line", input: Readable.from([]), output: sink(), diagnostics: sink() });
  expect(result.agent.url).toBeUndefined();
  expect(result.agent.timeout).toBeUndefined();
  expect(result.agent.settings).toBeUndefined();
  expect(Env.envs[cwd]).toBeUndefined();
  expect(await readFile(join(settingsDir, "settings.json"), "utf8").catch((error) => error.code)).toBe("ENOENT");
}));

test("Web invocation provider overrides apply to Env but never Agent", async () => fixture(async ({ cwd, settingsDir, envOptions }) => {
  const web = await serve({ port: 0, envOptions, model: { model: "custom/m", url: "test://temporary", token: "two" }, timeout: "5s" });
  try {
    expect(web.env.settings.providers.custom).toMatchObject({ provider: "test", url: "test://temporary", auth: { token: "two" }, timeout: "5s" });
    expect(Env.envs[cwd]).toBeUndefined();
  } finally { await web.stop(); }
  expect(web.env.closed).toBe(true);
  expect(await readFile(join(settingsDir, "settings.json"), "utf8").catch((error) => error.code)).toBe("ENOENT");
}));

test("Web plain project startup uses the registered Env and closes only its own instance", async () => fixture(async ({ cwd }) => {
  const web = await serve({ port: 0 });
  // Default startup uses process cwd, which remains the shared project registry.
  expect(Env.envs[process.cwd()]).toBe(web.env);
  await web.stop();
  expect(web.env.closed).toBe(true);
}));

test("provider override without a qualified selector rejects instead of being ignored", async () => fixture(async ({ envOptions }) => {
  await expect(runApplication({ envOptions, model: { model: "m", token: "one" } })).rejects.toThrow(/qualified endpoint/);
  await expect(serve({ envOptions, model: { model: "m", token: "one" } })).rejects.toThrow(/qualified endpoint/);
}));
