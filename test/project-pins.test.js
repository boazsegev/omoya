// Pinned projects: settings.projects persists to the user projects.json; a
// pinned project's model memory is selected before the global memory.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { readLastCombo } from "../lib/app/shared/catalog.js";
import { endpointPolicySet } from "../lib/app/shared/endpoint-policy.js";

/** A settings folder shared by project Envs over one stub provider. */
async function pinEnv(settingsDir, cwd) {
  class Wire { static provider = {}; static async models() { return {}; } }
  const env = await Env.open(cwd, { dir: settingsDir, settingsDir, providers: { wire: Wire }, settings: {
    providers: {
      one: { provider: "wire", url: "http://one", models: { a: null, b: null } },
      two: { provider: "wire", url: "http://two", models: { c: null } },
    },
  } });
  await env.ready();
  return env;
}

/** Await a selection's persisted global history notification. */
function rememberPair(env, selector) {
  const previous = env.models(true).get(selector)?.lastUsed;
  return new Promise((resolve) => {
    const handle = env.onEvent(Env.EVENT.MODELS_CHANGED, () => {
      const current = env.models(true).get(selector)?.lastUsed;
      if (current == null || current === previous) return;
      env.offEvent(handle);
      resolve();
    });
    env.connection(selector);
  });
}

/** Fresh settings folder plus two project folders. */
function folders() {
  const root = resolve(mkdtempSync("./ai-tmp/project-pins-")); // env.folder is absolute: so are projects keys
  const settings = join(root, "settings");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  for (const dir of [settings, alpha, beta]) mkdirSync(dir);
  return { settings, alpha, beta };
}

describe("pinned projects", () => {
  test("pins persist to the global projects registry and the pinned project's last model wins over the global one", async () => {
    const { settings, alpha, beta } = folders();
    await Env.ready();
    Env.settings.projects[alpha] = { models: {} };
    let a, b, again;
    try {
      a = await pinEnv(settings, alpha);
      await rememberPair(a, "one/a"); // alpha remembers one/a
      await Env.settingsFlush();
      expect(Object.keys(Env.settings.projects[alpha].models)).toEqual(["one/a"]);
      expect(existsSync(join(settings, "settings.json"))).toBe(false);

      b = await pinEnv(settings, beta); // unpinned: global memory only
      await rememberPair(b, "two/c");
      expect(readLastCombo(b)).toBe("two/c");
      expect(Object.keys(Env.settings.projects).filter((path) => path === alpha)).toEqual([alpha]);

      await a.close(); // one open Env per folder
      a = undefined;
      again = await pinEnv(settings, alpha); // a new env for alpha: project memory first
      await new Promise((resolve) => {
        const handle = again.onEvent(Env.EVENT.MODELS_CHANGED, () => {
          if (again.models().get("two/c")?.lastUsed == null) return;
          again.offEvent(handle);
          resolve();
        });
        if (again.models().get("two/c")?.lastUsed != null) { again.offEvent(handle); resolve(); }
      });
      expect(again.models().get("one/a").projectLastUsed).toEqual(expect.any(String));
      expect(again.models().get("two/c").projectLastUsed).toBe(null);
      expect(readLastCombo(again)).toBe("one/a");
      // unavailable project pairs fall back to the global list
      endpointPolicySet(again, "one", { disabled: true });
      expect(readLastCombo(again)).toBe("two/c");
    } finally {
      delete Env.settings.projects[alpha];
      await Env.settingsFlush();
      await Promise.all([a?.close(), b?.close(), again?.close()]);
    }
  });

  test("a project's memory keeps the newest pairs; external unpinning removes its entry", async () => {
    const { settings, alpha } = folders();
    await Env.ready();
    Env.settings.projects[alpha] = { models: {} };
    const env = await pinEnv(settings, alpha);
    try {
      for (const pair of ["one/a", "one/b", "two/c", "one/a"]) await rememberPair(env, pair);
      expect(Object.keys(Env.settings.projects[alpha].models)).toEqual(["one/a", "two/c", "one/b"]);
      delete Env.settings.projects[alpha];
      expect(env.settings.projects.toJSON().this).toEqual({ name: "this", folder: alpha });
      expect(env.settings.projects.toJSON()[alpha]).toEqual({ name: "this", folder: alpha });
    } finally {
      delete Env.settings.projects[alpha];
      await Env.settingsFlush();
      await env.close();
    }
  });

  test("project settings cannot pin projects", async () => {
    const { settings, alpha, beta } = folders();
    writeFileSync(join(alpha, NAMES.projectSettings), JSON.stringify({ projects: { [beta]: { name: "beta" } } }));
    const env = await pinEnv(settings, alpha);
    expect(env.settings.projects.toJSON().this).toEqual({ name: "this", folder: alpha });
      expect(env.settings.projects.toJSON()[alpha]).toEqual({ name: "this", folder: alpha });
    await env.close();
  });
});
