import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";

const cleanup = [];
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});
async function fixture() {
  const cwd = resolve(await mkdtemp("./ai-tmp/settings-override-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const user = join(cwd, "user");
  await mkdir(user);
  return { cwd, user, file: join(user, "settings.json") };
}
async function open(cwd, user, settings) {
  const env = await Env.open(cwd, { settingsDir: user, ...(settings === undefined ? {} : { settings }), init: { providers: false, tools: false } });
  cleanup.push(() => env.close());
  return env;
}

test("Env.open overrides select the ephemeral layer, including nested writes, without persisting after flush and close", async () => {
  const { cwd, user, file } = await fixture();
  const persisted = { web: { theme: "saved", autocomplete: false } };
  await writeFile(file, JSON.stringify(persisted));
  const env = await open(cwd, user, { web: { theme: "temporary" } });
  expect(env.settings.web.theme).toBe("temporary");
  expect(env.settings.web.autocomplete).toBe(false);
  env.settings.web.theme = "changed";
  await env.settingsFlush();
  expect(env._sourceGraph.settings.own(["web", "theme"])).toBe("changed");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(persisted);
  await env.close();
  const next = await open(cwd, user);
  expect(next.settings.web.theme).toBe("saved");
});

test("deleting an override and writing it again cannot leak to disk, but unoverridden writes still persist", async () => {
  const { cwd, user, file } = await fixture();
  await writeFile(file, JSON.stringify({ web: { theme: "saved" } }));
  const env = await open(cwd, user, { web: { theme: "temporary" } });
  delete env.settings.web.theme;
  env.settings.web.theme = "again";
  env.settings.web.autocomplete = false;
  await env.settingsFlush();
  expect(env.settings.web.theme).toBe("again");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ web: { theme: "saved", autocomplete: false } });
});

test("isolated override selections do not spill into other open environments", async () => {
  const { cwd, user } = await fixture();
  const one = await open(cwd, user, { web: { theme: "one" } });
  const two = await open(cwd, user, { web: { theme: "two" } });
  one.settings.web.theme = "changed";
  expect(two.settings.web.theme).toBe("two");
  await one.close();
  expect(two.settings.web.theme).toBe("two");
});
