import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { defaultSettingsDir } from "../lib/env/paths.js";

test("new instance pins inherit only true own groups; global additions do not", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const root = resolve(mkdtempSync("./ai-tmp/project-group-inheritance-"));
  const [own, added, globalAdded, existing, noGroups] = ["own", "added", "global", "existing", "no-groups"].map((name) => join(root, name));
  for (const folder of [own, added, globalAdded, existing, noGroups]) mkdirSync(folder);
  const projectsFile = join(defaultSettingsDir(), "projects.json");
  let env;
  try {
    await Env.ready();
    env = await Env.open(own, { init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    const unpinned = env.settings.projects.toJSON();
    expect(unpinned.this).toEqual({ name: "this", folder: own });
    expect(unpinned.this.groups).toBeUndefined();

    Env.settings.projects[own] = { groups: { team: true, blocked: false, another: true } };
    Env.settings.projects[existing] = { groups: { legacy: true }, description: "before" };
    env.settings.projects[added] = { description: "new from instance" };
    expect(Env.settings.projects[added].groups).toEqual({ team: true, another: true });
    expect(env.settings.projects[added].folder).toBe(added);
    expect(env.settings.projects[Env.settings.projects[added].name].folder).toBe(added);

    // An existing pin keeps its own groups on update rather than inheriting anew.
    env.settings.projects[existing] = { description: "updated" };
    expect(Env.settings.projects[existing].groups).toEqual({ legacy: true });
    expect(Env.settings.projects[existing].description).toBe("updated");
    // This pin is not reachable; global access still permits its explicit edit.
    Env.settings.projects[existing].groups.legacy = false;
    expect(Env.settings.projects[existing].groups.legacy).toBe(false);

    Env.settings.projects[globalAdded] = { description: "global only" };
    expect(Env.settings.projects[globalAdded].groups).toBeUndefined();
    expect(env.settings.projects[globalAdded]).toBeUndefined();
    await Env.settingsFlush();
    const persisted = JSON.parse(readFileSync(projectsFile, "utf8")).projects;
    expect(persisted[added]).toEqual({ description: "new from instance", groups: { team: true, another: true } });
    expect(persisted[globalAdded]).toEqual({ description: "global only" });
    expect(persisted[existing].groups).toEqual({ legacy: false });
    expect(persisted[added].name).toBeUndefined();
    expect(persisted[added].folder).toBeUndefined();

    delete Env.settings.projects[own];
    expect(env.settings.projects.toJSON().this.groups).toBeUndefined();
    env.settings.projects[noGroups] = { description: "added without own pin" };
    expect(Env.settings.projects[noGroups].groups).toBeUndefined();
    // A folder pin without shared groups is not reachable from an unpinned Env.
    expect(env.settings.projects[noGroups]).toBeUndefined();
  } finally {
    for (const folder of [own, added, globalAdded, existing, noGroups]) delete Env.settings.projects[folder];
    await Env.settingsFlush();
    await env?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
