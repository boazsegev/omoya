import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import Env from "../lib/env.js";

test("static settings expose ready global layers without opening a project and share live writes", async () => {
  await Env.close(); // prior tests may have acquired the process-global facade
  const root = resolve(await mkdtemp("./ai-tmp/env-global-"));
  const user = join(root, "user");
  const project = join(root, "project");
  await mkdir(user); await mkdir(project);
  const before = process.env.OMOYA_SETTINGS_DIR;
  process.env.OMOYA_SETTINGS_DIR = user;
  let env;
  try {
    await writeFile(join(user, "settings.json"), JSON.stringify({ globalValue: 7, web: { theme: "dark" } }));
    await writeFile(join(user, "projects.json"), JSON.stringify({ projects: { [project]: { description: "Pinned" } } }));
    await writeFile(join(project, "ai-settings.json"), JSON.stringify({ globalValue: 9, projectOnly: true }));
    const registered = Object.keys(Env.envs);
    const live = Env.settings;
    const ready = await Env.ready();
    expect(ready).toBe(live);
    expect(await Env.ready()).toBe(live); // late await cannot miss startup
    expect(Object.keys(Env.envs)).toEqual(registered);
    expect(live.globalValue).toBe(7);
    expect(live.projects[project].description).toBe("Pinned");
    expect(live.projectOnly).toBeUndefined();
    env = await Env.open(project, { init: { providers: false, tools: false, detect: false, models: false } });
    expect(env.settings.globalValue).toBe(9);
    Env.settings.globalExtra = "shared";
    expect(env.settings.globalExtra).toBe("shared");
    env.settings.web.theme = "light";
    expect(live.web.theme).toBe("light");
    await Env.settingsFlush();
    expect(JSON.parse(await readFile(join(user, "settings.json"), "utf8")).globalExtra).toBe("shared");
    live.closeWrite = "durable";
    await Env.close(); // close flushes even while another Env retains global sources
    expect(JSON.parse(await readFile(join(user, "settings.json"), "utf8")).closeWrite).toBe("durable");
    expect(env.closed).toBe(false);
    expect(env.settings.globalExtra).toBe("shared");
  } finally {
    await env?.close(); await Env.close();
    if (before === undefined) delete process.env.OMOYA_SETTINGS_DIR; else process.env.OMOYA_SETTINGS_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});

test("static readiness reports malformed global files and close permits corrected startup", async () => {
  await Env.close();
  const user = resolve(await mkdtemp("./ai-tmp/env-global-error-"));
  const before = process.env.OMOYA_SETTINGS_DIR;
  process.env.OMOYA_SETTINGS_DIR = user;
  try {
    await writeFile(join(user, "settings.json"), "{broken");
    await expect(Env.ready()).rejects.toThrow();
    await Env.close();
    await writeFile(join(user, "settings.json"), '{"repaired":true}');
    await Env.ready();
    expect(Env.settings.repaired).toBe(true);
  } finally {
    await Env.close();
    if (before === undefined) delete process.env.OMOYA_SETTINGS_DIR; else process.env.OMOYA_SETTINGS_DIR = before;
    await rm(user, { recursive: true, force: true });
  }
});
