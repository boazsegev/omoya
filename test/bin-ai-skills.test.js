// test/bin-ai-skills.test.js — proof for the prefixed `skills` wrapper (and
// its unprefixed `skills` alias): the real binary spawned end to end, over
// the harness's OWN accumulated skill roots (no more ../core dependency —
// see tools/skill.js and lib/env/registry.js). The namespace skill variable
// is pinned to a throwaway folder per test so the catalog is deterministic.
// Every executable name derives from bin-names.js — rename-safe.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { binName, cli } from "./bin-names.js";

const SKILLS_NAME = binName("skills"); // "<prefix>-skills"

async function run(bin, args, { skillsDir = "" } = {}) {
  const proc = Bun.spawn(["bun", bin, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, [NAMES.skillsEnv]: skillsDir },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit };
}

function extraSkillDir() {
  const dir = mkdtempSync("./ai-tmp/ai-skills-cli-");
  mkdirSync(`${dir}/demo`);
  writeFileSync(`${dir}/demo/SKILL.md`, "---\ndescription: a demo skill\n---\nDEMO BODY\n");
  return dir;
}

describe("the skills CLI (prefixed + unprefixed wrappers)", () => {
  test("no args: the merged catalog, including the packaged 'core' skill and an environment entry", async () => {
    const dir = extraSkillDir();
    const { stdout, exit } = await run(cli.skills, [], { skillsDir: dir });
    expect(exit).toBe(0);
    expect(stdout).toContain("# Skill Catalog");
    expect(stdout).toContain("`core`");
    expect(stdout).toContain("`demo` — a demo skill");
  });

  test("--debug appends each skill's source root(s)", async () => {
    const dir = extraSkillDir();
    const { stdout } = await run(cli.skills, ["--debug"], { skillsDir: dir });
    expect(stdout).toContain(`(${dir})`);
  });

  test("named skills print full bodies wrapped in <skill> tags", async () => {
    const dir = extraSkillDir();
    const { stdout, exit } = await run(cli.skills, ["demo"], { skillsDir: dir });
    expect(exit).toBe(0);
    expect(stdout).toContain('<skill name="demo">');
    expect(stdout).toContain("DEMO BODY");
  });

  test("an unknown name is reported on stderr with a nonzero exit", async () => {
    const { stdout, stderr, exit } = await run(cli.skills, ["nope"], {});
    expect(exit).toBe(1);
    expect(stderr).toContain("unknown skill: nope");
    expect(stdout).toBe("");
  });

  test("--help prints usage under the invoked name and exits 0", async () => {
    const { stdout, exit } = await run(cli.skills, ["--help"], {});
    expect(exit).toBe(0);
    expect(stdout).toContain(`Usage: ${SKILLS_NAME}`);
    // the name is dynamic: the unprefixed wrapper reports its own name
    const short = await run(cli.skillsBare, ["--help"], {});
    expect(short.exit).toBe(0);
    expect(short.stdout).toContain("Usage: skills");
    expect(short.stdout).not.toContain(`Usage: ${SKILLS_NAME}`);
  });

  test("the unprefixed wrapper is the exact same program under a shorter name", async () => {
    const dir = extraSkillDir();
    const { stdout: a } = await run(cli.skills, [], { skillsDir: dir });
    const { stdout: b } = await run(cli.skillsBare, [], { skillsDir: dir });
    expect(b).toBe(a);
  });
});
