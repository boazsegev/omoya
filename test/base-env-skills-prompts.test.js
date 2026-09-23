// test/base-env-skills-prompts.test.js — proof for Env's skill/prompt
// discovery: accumulated roots (package folder + settings key + env var,
// ALL of them, never just one), skills EXTEND same-named entries across
// roots while prompts OVERRIDE, and everything is read fresh from disk.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";

let dir; // this Env's own package folder
let extra; // a standalone configured/environment skill root
const savedEnv = {};

function skillFile(root, name, frontmatter, body) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}
function promptFile(root, filename, frontmatter, body) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, filename), `---\n${frontmatter}\n---\n${body}\n`);
}

beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "env-skills-"))));
  extra = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "env-skills-extra-"))));
  savedEnv.skills = process.env[NAMES.skillsEnv];
  savedEnv.prompts = process.env[NAMES.promptsEnv];
  savedEnv.settings = process.env[NAMES.settingsEnv];
  delete process.env[NAMES.skillsEnv];
  delete process.env[NAMES.promptsEnv];
  // an EMPTY per-test settings layer: the real user settings folder
  // (or another test's) never leaks into these root expectations
  process.env[NAMES.settingsEnv] = join(dir, "user-settings");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(extra, { recursive: true, force: true });
  if (savedEnv.skills === undefined) delete process.env[NAMES.skillsEnv]; else process.env[NAMES.skillsEnv] = savedEnv.skills;
  if (savedEnv.prompts === undefined) delete process.env[NAMES.promptsEnv]; else process.env[NAMES.promptsEnv] = savedEnv.prompts;
  if (savedEnv.settings === undefined) delete process.env[NAMES.settingsEnv]; else process.env[NAMES.settingsEnv] = savedEnv.settings;
});

const SETTINGS = () => join(dir, "user-settings");

describe("Env skill roots — accumulative layers", () => {
  test("the layer order: package, settings folder, project skills", () => {
    const env = new Env({ dir, cwd: extra, settings: {} });
    expect(env.defaultSkillRoots()).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("settings.skills ADDS to the accumulated roots, never replaces", () => {
    const env = new Env({ dir, cwd: extra, settings: { skills: [extra] } });
    expect(env.defaultSkillRoots()).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      extra,
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("the namespace skill variable ADDS after configured roots", () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = new Env({ dir, cwd: dir, settings: {} });
    expect(env.defaultSkillRoots()).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), extra, join(dir, NAMES.projectSkillsDir)]);
  });

  test("all sources accumulate together, in layer order", () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = new Env({ dir, cwd: dir, settings: { skills: "/configured/path" } });
    expect(env.defaultSkillRoots()).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      "/configured/path",
      extra,
      join(dir, NAMES.projectSkillsDir),
    ]);
  });

  test("a folder already scanned under an earlier layer is never scanned twice", () => {
    // an environment root resolving to <settingsDir>/skills scans ONCE
    process.env[NAMES.skillsEnv] = join(SETTINGS(), "skills");
    const env = new Env({ dir, cwd: dir, settings: {} });
    expect(env.defaultSkillRoots()).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
    // a configured root repeating the package folder scans once too
    const env2 = new Env({ dir, cwd: dir, settings: { skills: [join(dir, "skills")] } });
    expect(env2.defaultSkillRoots()).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
  });
});

describe("Env.skillCatalog / skillBodies — skills EXTEND across roots", () => {
  test("catalog lists every skill, sorted, with descriptions", () => {
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "first"', "alpha body");
    skillFile(join(dir, "skills"), "beta", 'name: beta\ndescription: "second"', "beta body");
    const env = new Env({ dir, settings: {} });
    const text = env.skillCatalog();
    expect(text).toContain("`alpha` — first");
    expect(text).toContain("`beta` — second");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
  });

  test("a same-named skill in a later root EXTENDS (concatenates), never replaces", () => {
    skillFile(join(dir, "skills"), "core", "name: core\ndescription: base", "base rules");
    skillFile(extra, "core", "name: core\ndescription: extra", "extra rules");
    const env = new Env({ dir, settings: { skills: [extra] } });
    const { text, unknown } = env.skillBodies(["core"]);
    expect(unknown).toEqual([]);
    expect(text).toContain("base rules");
    expect(text).toContain("extra rules");
    expect(text.indexOf("base rules")).toBeLessThan(text.indexOf("extra rules"));
  });

  test("unknown skill names are reported, not fatal", () => {
    const env = new Env({ dir, settings: {} });
    const { text, unknown } = env.skillBodies(["nope"]);
    expect(text).toBe("");
    expect(unknown).toEqual(["nope"]);
  });

  test("--debug-equivalent: catalog can append sources", () => {
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "d"', "b");
    const env = new Env({ dir, settings: {} });
    expect(env.skillCatalog({ debug: true })).toContain(`(${join(dir, "skills")})`);
  });
});

describe("Env.promptNamesAsync — async merged prompt names", () => {
  test("matches synchronous names for layered overrides and an explicit roots override", async () => {
    promptFile(join(dir, "prompts"), "base.md", "name: shared", "base");
    promptFile(extra, "override.md", "name: shared", "override");
    promptFile(extra, "other.md", "name: other", "other");
    const env = new Env({ dir, settings: { prompts: [extra] } });
    expect(await env.promptNamesAsync()).toEqual(env.promptNames());
    expect(await env.promptNamesAsync({ roots: [extra] })).toEqual(env.promptNames({ roots: [extra] }));
  });
});

describe("Env.promptCatalog / promptBody — prompts OVERRIDE across roots", () => {
  test("a same-named prompt in a later root REPLACES the earlier one", () => {
    promptFile(join(dir, "prompts"), "greet.md", 'name: greet\ndescription: base', "base greeting");
    promptFile(extra, "greet.md", 'name: greet\ndescription: override', "overriding greeting");
    const env = new Env({ dir, settings: { prompts: [extra] } });
    expect(env.promptBody("greet")).toBe("overriding greeting");
    expect(env.promptCatalog()).toContain("`greet` — override");
    expect(env.promptCatalog()).not.toContain("base");
  });

  test("an unknown prompt name resolves to null", () => {
    const env = new Env({ dir, settings: {} });
    expect(env.promptBody("nope")).toBeNull();
  });

  test("never cached: adding a prompt file after construction is picked up on the next call", () => {
    const env = new Env({ dir, settings: {} });
    expect(env.promptBody("late")).toBeNull();
    promptFile(join(dir, "prompts"), "late.md", "name: late\ndescription: d", "late body");
    expect(env.promptBody("late")).toBe("late body");
  });
});
