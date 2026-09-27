// test/base-env-skills-prompts.test.js — proof for Env's skill/prompt
// discovery: accumulated roots (package folder + settings key + env var,
// ALL of them, never just one), skills EXTEND same-named entries across
// roots while prompts OVERRIDE, and everything is read fresh from disk.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { skillRoots } from "./env-internals.js";

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
    expect(skillRoots(env)).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("settings.skills ADDS to the accumulated roots, never replaces", () => {
    const env = new Env({ dir, cwd: extra, settings: { skills: [extra] } });
    expect(skillRoots(env)).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      extra,
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("the namespace skill variable ADDS after configured roots", () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = new Env({ dir, cwd: dir, settings: {} });
    expect(skillRoots(env)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), extra, join(dir, NAMES.projectSkillsDir)]);
  });

  test("all sources accumulate together, in layer order", () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = new Env({ dir, cwd: dir, settings: { skills: "/configured/path" } });
    expect(skillRoots(env)).toEqual([
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
    expect(skillRoots(env)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
    // a configured root repeating the package folder scans once too
    const env2 = new Env({ dir, cwd: dir, settings: { skills: [join(dir, "skills")] } });
    expect(skillRoots(env2)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
  });
});

describe("env.skills() — skills EXTEND across roots", () => {
  test("a name-sorted Map of {name, description, file, source, body}", () => {
    skillFile(join(dir, "skills"), "beta", 'name: beta\ndescription: "second"', "beta body");
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "first"', "alpha body");
    const env = new Env({ dir, settings: {} });
    const skills = env.skills();
    expect([...skills.keys()]).toEqual(["alpha", "beta"]);
    expect(skills.get("alpha")).toMatchObject({ name: "alpha", description: "first", file: join(dir, "skills", "alpha", "SKILL.md"), source: join(dir, "skills") });
    expect(skills.get("alpha").body).toContain("alpha body");
    expect(Object.isFrozen(skills.get("alpha"))).toBe(true);
  });

  test("a same-named skill in a later root EXTENDS (concatenates), never replaces", () => {
    skillFile(join(dir, "skills"), "core", "name: core\ndescription: base", "base rules");
    skillFile(extra, "core", "name: core\ndescription: extra", "extra rules");
    const env = new Env({ dir, settings: { skills: [extra] } });
    const { body } = env.skills().get("core");
    expect(body).toContain("base rules");
    expect(body).toContain("extra rules");
    expect(body.indexOf("base rules")).toBeLessThan(body.indexOf("extra rules"));
  });

  test("skillDirs replaces the accumulated layers (embedders, tests)", () => {
    skillFile(join(dir, "skills"), "alpha", "name: alpha", "a");
    skillFile(extra, "only", "name: only", "o");
    expect([...new Env({ dir, settings: {}, skillDirs: [extra] }).skills().keys()]).toEqual(["only"]);
  });
});

describe("Agent formats the catalogs (Agent.skillCatalog / promptCatalog / skillSection)", () => {
  test("catalog text lists every entry, sorted, with descriptions; debug appends sources", () => {
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "first"', "alpha body");
    skillFile(join(dir, "skills"), "beta", 'name: beta\ndescription: "second"', "beta body");
    const env = new Env({ dir, settings: {} });
    const text = Agent.skillCatalog(env.skills());
    expect(text).toStartWith("# Skill Catalog\n");
    expect(text).toContain("`alpha` — first");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
    expect(Agent.skillCatalog(env.skills(), { debug: true })).toContain(`(${join(dir, "skills")})`);
    expect(Agent.skillSection(env.skills().get("alpha"))).toBe(`<skill name="alpha">\n${env.skills().get("alpha").body}\n</skill>`);
  });

  test("the prompt catalog shows the overriding entry only", () => {
    promptFile(join(dir, "prompts"), "greet.md", "name: greet\ndescription: base", "base greeting");
    promptFile(extra, "greet.md", "name: greet\ndescription: override", "overriding greeting");
    const env = new Env({ dir, settings: { prompts: [extra] } });
    const text = Agent.promptCatalog(env.prompts());
    expect(text).toStartWith("# Prompt Catalog\n");
    expect(text).toContain("`greet` — override");
    expect(text).not.toContain("base");
  });
});

describe("env.prompts() — prompts OVERRIDE across roots", () => {
  test("a same-named prompt in a later root REPLACES the earlier one", () => {
    promptFile(join(dir, "prompts"), "greet.md", "name: greet\ndescription: base", "base greeting");
    promptFile(extra, "greet.md", "name: greet\ndescription: override", "overriding greeting");
    const env = new Env({ dir, settings: { prompts: [extra] } });
    expect(env.prompts().get("greet")).toMatchObject({ description: "override", body: "overriding greeting", source: extra });
  });

  test("an unknown prompt name is absent", () => {
    expect(new Env({ dir, settings: {} }).prompts().has("nope")).toBe(false);
  });

  test("never cached: adding a prompt file after construction is picked up on the next call", () => {
    const env = new Env({ dir, settings: {} });
    expect(env.prompts().has("late")).toBe(false);
    promptFile(join(dir, "prompts"), "late.md", "name: late\ndescription: d", "late body");
    expect(env.prompts().get("late").body).toBe("late body");
  });

  test("promptDirs replaces the accumulated layers", () => {
    promptFile(join(dir, "prompts"), "base.md", "name: base", "b");
    promptFile(extra, "other.md", "name: other", "o");
    expect([...new Env({ dir, settings: {}, promptDirs: [extra] }).prompts().keys()]).toEqual(["other"]);
  });
});
