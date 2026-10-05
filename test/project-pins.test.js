// Pinned projects: settings.projects persists to the user projects.json; a
// pinned project's model memory is selected before the global memory.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { readLastCombo, endpointPolicySet } from "../lib/cli.js";

/** A settings folder shared by project Envs over one stub provider. */
function pinEnv(settingsDir, cwd) {
  class Wire { static provider = {}; static async models() { return {}; } }
  return new Env({ dir: settingsDir, cwd, settingsDir, providers: { wire: Wire }, settings: {
    providers: { one: { provider: "wire", url: "http://one" }, two: { provider: "wire", url: "http://two" } },
    one: { models: { a: null, b: null } },
    two: { models: { c: null } },
  } });
}

/** Fresh settings folder plus two project folders. */
function folders() {
  const root = resolve(mkdtempSync("./ai-tmp/project-pins-")); // env.cwd is absolute: so are projects keys
  const settings = join(root, "settings");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  for (const dir of [settings, alpha, beta]) mkdirSync(dir);
  return { settings, alpha, beta };
}

/** Parse the persisted projects.json. */
const projectsFile = (settings) => JSON.parse(readFileSync(join(settings, "projects.json"), "utf8"));

describe("pinned projects", () => {
  test("pins persist to projects.json and the pinned project's last model wins over the global one", () => {
    const { settings, alpha, beta } = folders();
    const a = pinEnv(settings, alpha);
    a.settings.projects[alpha] = { name: "alpha", models: {} };
    a.connection("one/a"); // alpha remembers one/a
    a._writeQueue.drain();
    expect(Object.keys(projectsFile(settings).projects)).toEqual([alpha]);
    expect(Object.keys(projectsFile(settings).projects[alpha].models)).toEqual(["one/a"]);
    expect(existsSync(join(settings, "settings.json"))).toBe(false);

    const b = pinEnv(settings, beta); // unpinned: global memory only
    b.connection("two/c");
    expect(readLastCombo(b)).toBe("two/c");
    b._writeQueue.drain();
    expect(Object.keys(projectsFile(settings).projects)).toEqual([alpha]);

    a.close(); // one open Env per folder
    const again = pinEnv(settings, alpha); // a new env for alpha: project memory first
    expect(again.models().get("one/a").projectLastUsed).toEqual(expect.any(String));
    expect(again.models().get("two/c").projectLastUsed).toBe(null);
    expect(readLastCombo(again)).toBe("one/a");
    // unavailable project pairs fall back to the global list
    endpointPolicySet(again, "one", { disabled: true });
    expect(readLastCombo(again)).toBe("two/c");
  });

  test("a project's memory keeps the newest pairs; unpinning deletes its entry", () => {
    const { settings, alpha } = folders();
    const env = pinEnv(settings, alpha);
    env.settings.projects[alpha] = { name: "alpha", models: {} };
    for (const pair of ["one/a", "one/b", "two/c", "one/a"]) env.connection(pair);
    expect(Object.keys(env.settings.projects[alpha].models)).toEqual(["one/a", "two/c", "one/b"]);
    delete env.settings.projects[alpha];
    env._writeQueue.drain();
    expect(projectsFile(settings).projects).toEqual({});
  });

  test("project settings cannot pin projects", () => {
    const { settings, alpha, beta } = folders();
    writeFileSync(join(alpha, NAMES.projectSettings), JSON.stringify({ projects: { [beta]: { name: "beta" } } }));
    expect(pinEnv(settings, alpha).settings.projects[beta]).toBeUndefined();
  });
});
