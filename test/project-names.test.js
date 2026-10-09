// Project names derive from pin records; grouped projects define reachability.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";

async function projectEnv(settingsDir, cwd) {
  const env = await Env.open(cwd, { dir: settingsDir, settingsDir, init: { providers: false, tools: false, detect: false, models: false } });
  await env.ready();
  return env;
}

function folders(...names) {
  const root = resolve(mkdtempSync("./ai-tmp/project-names-"));
  const settings = join(root, "settings");
  mkdirSync(settings);
  const paths = names.map((name) => join(root, name));
  for (const path of paths) mkdirSync(path, { recursive: true });
  return { settings, paths };
}

describe("project names", () => {
  test("pin records answer a derived, unstored name resolved against other pins", async () => {
    const { settings, paths: [one, two, other] } = folders("x/app", "y/app", "lib");
    await Env.ready();
    const env = await projectEnv(settings, one);
    try {
      Env.settings.projects[one] = { models: {}, groups: { shared: true }, name: "ignored" };
      Env.settings.projects[two] = { models: {}, groups: { shared: true } };
      Env.settings.projects[other] = { models: {} };
      expect(Env.settings.projects[one].name).toBe("x/app");
      expect(Env.settings.projects[two].name).toBe("y/app");
      expect(Env.settings.projects[other].name).toBe("lib");
      expect(env.name).toBe("x/app");
      Env.settings.projects[other].name = "renamed";
      expect(Env.settings.projects[other].name).toBe("lib");
      const reachable = env.settings.projects.toJSON();
      expect(reachable.this).toEqual({ name: "x/app", folder: one, models: {}, groups: { shared: true } });
      expect(reachable[one]).toBe(reachable.this);
      expect(reachable["x/app"]).toBe(reachable.this);
      expect(reachable[two]).toEqual({ name: "y/app", folder: two, models: {}, groups: { shared: true } });
      expect(reachable["y/app"]).toBe(reachable[two]);
      expect(reachable.app).toBeUndefined(); // ambiguous basename must not overwrite either alias
      await Env.settingsFlush();
    } finally {
      for (const path of [one, two, other]) delete Env.settings.projects[path];
      await Env.settingsFlush();
      await env.close();
    }
  });

  test("reachable project records share folder and name aliases for group peers without replacing this", async () => {
    const { settings, paths: [own, peer, stranger, reserved] } = folders("own", "peer", "stranger", "this");
    const env = await projectEnv(settings, own);
    try {
      expect(env.settings.projects.toJSON()).toEqual({
        this: { name: "this", folder: own },
        [own]: { name: "this", folder: own },
      });
      await Env.ready();
      Env.settings.projects[own] = { models: {}, groups: { team: true } };
      Env.settings.projects[peer] = { models: {}, groups: { team: true, other: true } };
      Env.settings.projects[stranger] = { models: {}, groups: { other: true } };
      Env.settings.projects[reserved] = { models: {}, groups: { team: true } };
      const reachable = env.settings.projects.toJSON();
      expect(reachable.this).toEqual({ name: "own", folder: own, models: {}, groups: { team: true } });
      expect(reachable[own]).toBe(reachable.this);
      expect(reachable.own).toBe(reachable.this);
      expect(reachable[peer]).toEqual({ name: "peer", folder: peer, models: {}, groups: { team: true, other: true } });
      expect(reachable.peer).toBe(reachable[peer]);
      expect(reachable[stranger]).toBeUndefined();
      expect(reachable.stranger).toBeUndefined();
      expect(reachable[reserved]).toEqual({ name: "this", folder: reserved, models: {}, groups: { team: true } });
      expect(reachable.this).toBe(reachable[own]); // reserved peer cannot steal the own alias
      expect(JSON.parse(JSON.stringify(env.settings.projects))).toEqual(reachable);
      Env.settings.projects[own] = { models: {}, groups: { team: false } };
      const filtered = env.settings.projects.toJSON();
      expect(filtered.this).toBe(filtered[own]);
      expect(filtered[peer]).toBeUndefined();
      expect(filtered[reserved]).toBeUndefined();
      // Reads stay filtered even though writes may target any global folder.
      expect(filtered[stranger]).toBeUndefined();
    } finally {
      for (const path of [own, peer, stranger, reserved]) delete Env.settings.projects[path];
      await Env.settingsFlush();
      await env.close();
    }
  });
});
