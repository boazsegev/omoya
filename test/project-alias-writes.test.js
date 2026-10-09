import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { defaultSettingsDir } from "../lib/env/paths.js";

test("instance and global project aliases write and delete global folder pins without persisting derived fields", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const root = resolve(mkdtempSync("./ai-tmp/project-alias-writes-"));
  const own = join(root, "own");
  const peer = join(root, "peer");
  const outside = join(root, "outside");
  for (const path of [own, peer, outside]) mkdirSync(path);
  const projectsFile = join(defaultSettingsDir(), "projects.json");
  let env;
  try {
    await Env.ready();
    env = await Env.open(own, { init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    Env.settings.projects[own] = { groups: { team: true } };
    env.settings.projects.this.description = "Own";
    expect(Env.settings.projects[own]).toMatchObject({ folder: own, description: "Own", groups: { team: true } });
    const ownSnapshot = env.settings.projects.toJSON();
    expect(ownSnapshot.this).toBe(ownSnapshot[own]);
    expect(env.settings.projects.this).toBe(env.settings.projects[own]);

    // Global aliases and instance aliases both resolve to the folder pin.
    Env.settings.projects[peer] = { groups: { team: true } };
    const peerName = Env.settings.projects[peer].name;
    expect(Env.settings.projects[peerName]).toBe(Env.settings.projects[peer]);
    expect(env.settings.projects[peerName]).toBe(env.settings.projects[peer]);
    Env.settings.projects[peerName].description = "Global alias edit";
    Env.settings.projects[peerName].name = "Ignored name edit";
    env.settings.projects[peer].folder = outside;
    expect(Env.settings.projects[peer].folder).toBe(peer);
    expect(Env.settings.projects[peer].description).toBe("Global alias edit");
    env.settings.projects[peerName].description = "Instance alias edit";
    expect(Env.settings.projects[peer].description).toBe("Instance alias edit");
    env.settings.projects[peer].groups.team = false;
    expect(env.settings.projects[peer]).toBeUndefined(); // writes update reachability
    expect(Env.settings.projects[peer].groups.team).toBe(false);

    // New pins inherit true own groups, so they become reachable immediately.
    env.settings.projects[outside] = { description: "New outside pin" };
    expect(Env.settings.projects[outside]).toMatchObject({ description: "New outside pin", groups: { team: true } });
    expect(env.settings.projects[outside].folder).toBe(outside);
    const outsideName = Env.settings.projects[outside].name;
    env.settings.projects[outsideName] = { description: "Edited outside" };
    expect(Env.settings.projects[outside]).toMatchObject({ description: "Edited outside", groups: { team: true } });
    await Env.settingsFlush();
    const persisted = JSON.parse(readFileSync(projectsFile, "utf8")).projects;
    expect(persisted[own]).toEqual({ groups: { team: true }, description: "Own" });
    expect(persisted[peer]).toEqual({ groups: { team: false }, description: "Instance alias edit" });
    expect(persisted[outside]).toEqual({ description: "Edited outside", groups: { team: true } });
    expect(persisted[peerName]).toBeUndefined();
    expect(persisted[outsideName]).toBeUndefined();

    delete env.settings.projects[outsideName];
    expect(Env.settings.projects[outside]).toBeUndefined();
    delete Env.settings.projects[peerName];
    expect(Env.settings.projects[peer]).toBeUndefined();
    delete env.settings.projects.this;
    expect(Env.settings.projects[own]).toBeUndefined();
    expect(env.settings.projects.toJSON().this).toEqual({ name: "this", folder: own });
    await Env.settingsFlush();
    expect(Env.settings.projects[outside]).toBeUndefined();
  } finally {
    for (const path of [own, peer, outside, "this"]) delete Env.settings.projects[path];
    await Env.settingsFlush();
    await env?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
