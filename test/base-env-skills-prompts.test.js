// test/base-env-skills-prompts.test.js — proof for Env's skill/prompt
// discovery: accumulated roots (package folder + settings key + env var,
// ALL of them, never just one), skills OVERRIDE same-named entries across
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
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => env.folder === dir || env.folder === extra).map((env) => env.close()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(extra, { recursive: true, force: true });
  if (savedEnv.skills === undefined) delete process.env[NAMES.skillsEnv]; else process.env[NAMES.skillsEnv] = savedEnv.skills;
  if (savedEnv.prompts === undefined) delete process.env[NAMES.promptsEnv]; else process.env[NAMES.promptsEnv] = savedEnv.prompts;
  if (savedEnv.settings === undefined) delete process.env[NAMES.settingsEnv]; else process.env[NAMES.settingsEnv] = savedEnv.settings;
});

const SETTINGS = () => join(dir, "user-settings");

describe("Env skill roots — accumulative layers", () => {
  test("the layer order: package, settings folder, project skills", async () => {
    const env = await Env.open(extra, { dir, settings: {} });
    expect(skillRoots(env)).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("settings.skills ADDS to the accumulated roots, never replaces", async () => {
    const env = await Env.open(extra, { dir, settings: { skills: { [extra]: true } } });
    expect(skillRoots(env)).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      extra,
      join(extra, NAMES.projectSkillsDir),
    ]);
  });

  test("the namespace skill variable ADDS after configured roots", async () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = await Env.open(dir, { dir, settings: {} });
    expect(skillRoots(env)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), extra, join(dir, NAMES.projectSkillsDir)]);
  });

  test("all sources accumulate together, in layer order", async () => {
    process.env[NAMES.skillsEnv] = extra;
    const env = await Env.open(dir, { dir, settings: { skills: { "/configured/path": true } } });
    expect(skillRoots(env)).toEqual([
      join(dir, "skills"),
      join(SETTINGS(), "skills"),
      "/configured/path",
      extra,
      join(dir, NAMES.projectSkillsDir),
    ]);
  });

  test("a folder already scanned under an earlier layer is never scanned twice", async () => {
    // an environment root resolving to <settingsDir>/skills scans ONCE
    process.env[NAMES.skillsEnv] = join(SETTINGS(), "skills");
    const env = await Env.open(dir, { dir, settings: {} });
    expect(skillRoots(env)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
    // a configured root repeating the package folder scans once too
    await env.close();
    const env2 = await Env.open(dir, { dir, settings: { skills: { [join(dir, "skills")]: true } } });
    expect(skillRoots(env2)).toEqual([join(dir, "skills"), join(SETTINGS(), "skills"), join(dir, NAMES.projectSkillsDir)]);
  });
});

describe("env.skills() — skills OVERRIDE across roots", () => {
  test("a name-sorted Map of {name, description, file, source, body}", async () => {
    skillFile(join(dir, "skills"), "beta", 'name: beta\ndescription: "second"', "beta body");
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "first"', "alpha body");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {} });
    const skills = env.skills();
    expect([...skills.keys()]).toEqual(["alpha", "beta"]);
    expect(skills.get("alpha")).toMatchObject({ name: "alpha", description: "first", file: join(dir, "skills", "alpha", "SKILL.md"), source: join(dir, "skills") });
    expect(skills.get("alpha").body).toContain("alpha body");
    expect(Object.isFrozen(skills.get("alpha"))).toBe(true);
  });

  test("a same-named skill in a later root overrides; self references explicitly extend", async () => {
    skillFile(join(dir, "skills"), "core", "name: core\ndescription: base", "base rules");
    skillFile(extra, "core", "name: core\ndescription: extra", "extra rules");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: { skills: { [extra]: true } } });
    expect(env.skills().get("core").body).toBe("extra rules");
    skillFile(extra, "core", "name: core\ndescription: extra", "{{core}}\nextra rules");
    expect(env.skills().get("core").body).toBe("base rules\nextra rules");
  });

  test("skillDirs replaces the accumulated layers (embedders, tests)", async () => {
    skillFile(join(dir, "skills"), "alpha", "name: alpha", "a");
    skillFile(extra, "only", "name: only", "o");
    expect([...(await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {}, skillDirs: [extra] })).skills().keys()]).toEqual(["only"]);
  });
});

describe("Env formats its catalogs (skillCatalog / promptCatalog / skillSection)", () => {
  test("catalog text lists every entry, sorted, with descriptions; debug appends sources", async () => {
    skillFile(join(dir, "skills"), "alpha", 'name: alpha\ndescription: "first"', "alpha body");
    skillFile(join(dir, "skills"), "beta", 'name: beta\ndescription: "second"', "beta body");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {} });
    const text = env.skillCatalog();
    expect(text).toStartWith("# Skill Catalog\n");
    expect(text).toContain("`alpha` — first");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
    expect(env.skillCatalog({ debug: true })).toContain(`(${join(dir, "skills")})`);
    expect(env.skillSection(env.skills().get("alpha"))).toBe(`<skill name="alpha">\n${env.skills().get("alpha").body}\n</skill>`);
  });

  test("the prompt catalog shows the overriding entry only", async () => {
    promptFile(join(dir, "prompts"), "greet.md", "name: greet\ndescription: base", "base greeting");
    promptFile(extra, "greet.md", "name: greet\ndescription: override", "overriding greeting");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: { prompts: { [extra]: true } } });
    const text = env.promptCatalog();
    expect(text).toStartWith("# Prompt Catalog\n");
    expect(text).toContain("`greet` — override");
    expect(text).not.toContain("base");
  });
});

describe("env.prompts() — prompts OVERRIDE across roots", () => {
  test("a same-named prompt in a later root REPLACES the earlier one", async () => {
    promptFile(join(dir, "prompts"), "greet.md", "name: greet\ndescription: base", "base greeting");
    promptFile(extra, "greet.md", "name: greet\ndescription: override", "overriding greeting");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: { prompts: { [extra]: true } } });
    expect(env.prompts().get("greet")).toMatchObject({ description: "override", body: "overriding greeting", source: extra });
  });

  test("an unknown prompt name is absent", async () => {
    expect((await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {} })).prompts().has("nope")).toBe(false);
  });

  test("never cached: adding a prompt file after construction is picked up on the next call", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {} });
    expect(env.prompts().has("late")).toBe(false);
    promptFile(join(dir, "prompts"), "late.md", "name: late\ndescription: d", "late body");
    expect(env.prompts().get("late").body).toBe("late body");
  });

  test("promptDirs replaces the accumulated layers", async () => {
    promptFile(join(dir, "prompts"), "base.md", "name: base", "b");
    promptFile(extra, "other.md", "name: other", "o");
    expect([...(await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settings: {}, promptDirs: [extra] })).prompts().keys()]).toEqual(["other"]);
  });
});
