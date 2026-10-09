import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { defaultSettingsDir } from "../lib/env/paths.js";

test("reachable projects expose an unpinned own record by folder and this", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const folder = resolve(mkdtempSync("./ai-tmp/reachable-projects-"));
  const env = await Env.open(folder, {
    dir: folder,
    settingsDir: null,
    init: { providers: false, tools: false, detect: false, models: false },
  });
  try {
    await env.ready();
    const reachable = env.settings.projects.toJSON();
    expect(reachable.this).toEqual({ name: "this", folder });
    expect(reachable[folder]).toBe(reachable.this);
    expect(Object.getPrototypeOf(env.settings.projects)).toBe(Object.prototype);
    expect(env.settings.projects.toJSON().this).toEqual({ name: "this", folder });
  } finally {
    await env.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("global pin edits immediately recompute reachable records and persist only pin fields", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const folder = resolve(mkdtempSync("./ai-tmp/global-project-pin-"));
  const peer = join(folder, "peer");
  mkdirSync(peer);
  const projectsFile = join(defaultSettingsDir(), "projects.json");
  let env;
  try {
    await Env.ready();
    env = await Env.open(folder, { init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    expect(env.settings.projects.toJSON().this).toEqual({ name: "this", folder });
    Env.settings.projects[folder] = { models: {}, groups: { team: true } };
    Env.settings.projects[peer] = { models: {}, groups: { team: true } };
    const reachable = env.settings.projects.toJSON();
    expect(reachable.this).toBe(reachable[folder]);
    expect(reachable[folder]).toMatchObject({ folder, models: {}, groups: { team: true } });
    expect(reachable[reachable[folder].name]).toBe(reachable[folder]);
    expect(reachable[peer]).toEqual({ name: "peer", folder: peer, models: {}, groups: { team: true } });
    expect(reachable.peer).toBe(reachable[peer]);
    const global = Env.settings.projects.toJSON();
    expect(global[peer]).toBe(global.peer);
    expect(global[folder]).toBe(global[global[folder].name]);
    Env.settings.projects[peer].description = "Persisted pin";
    await Env.settingsFlush();
    expect(JSON.parse(readFileSync(projectsFile, "utf8")).projects[peer]).toEqual({
      models: {}, groups: { team: true }, description: "Persisted pin",
    });
    expect(JSON.parse(readFileSync(projectsFile, "utf8")).projects[folder]).toEqual({
      models: {}, groups: { team: true },
    });
    expect(Env.settings.projects[peer].folder).toBe(peer);
    expect(Env.settings.projects[peer].name).toBe("peer");
    delete Env.settings.projects[peer];
    const after = env.settings.projects.toJSON();
    expect(after.this).toBe(after[folder]);
    expect(after[peer]).toBeUndefined();
  } finally {
    delete Env.settings.projects[peer];
    delete Env.settings.projects[folder];
    await Env.settingsFlush();
    await env?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
