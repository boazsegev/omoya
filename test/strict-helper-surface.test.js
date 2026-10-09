import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Agent from "../lib/agent.js";
import Env from "../lib/env.js";
import IO, { timeoutsResolve } from "../lib/io.js";
import { testEnv } from "./fakes.js";

const opened = [];
const roots = [];
afterEach(async () => {
  for (const instance of opened.splice(0).reverse()) await instance.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("tests-only Agent.pathInfo is absent while jobs' public IO timeout resolver remains", () => {
  expect(Object.hasOwn(Agent.prototype, "pathInfo")).toBe(false);
  expect(IO.timeoutsResolve).toBe(timeoutsResolve);
});

test("public timeout resolver uses per-request deadline before live Env default", async () => {
  const env = await testEnv({ providers: { p: { provider: "test", url: "test://script", timeout: "3s" } } });
  opened.push(env);
  expect(IO.timeoutsResolve({ env, model: "p/m", timeout: "2s" })).toBe(2000);
  expect(timeoutsResolve({ env, model: "p/m" })).toBe(3000);
  env.settings.providers.p.timeout = "4s";
  expect(timeoutsResolve({ env, model: "p/m" })).toBe(4000);
  expect(() => timeoutsResolve({ env, model: "p/m", settings: { timeout: "5s" } })).toThrow(/configure provider settings on Env/);
});

test("sendFile retains the owning path boundary without exposing pathInfo", async () => {
  const cwd = resolve(mkdtempSync("./ai-tmp/strict-path-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "sample.webp"), "RIFF");
  const env = await Env.open(cwd, { dir: cwd, settingsDir: null });
  opened.push(env);
  const agent = await Agent.create({ env });
  opened.push(agent);
  agent.run = async () => ({ type: "done" });
  await expect(agent.sendFile("../outside.webp")).rejects.toThrow(/path traversal refused/);
  expect(agent.pending).toEqual([]);
  await agent.sendFile("sample.webp");
  expect(agent.context.at(-1).content[0]).toMatchObject({ type: "binary", mimetype: "image/webp" });
});
