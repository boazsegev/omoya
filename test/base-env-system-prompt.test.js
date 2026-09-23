// test/base-env-system-prompt.test.js — proof for Env.resolveSystemPrompt():
// settings.system (inline or a file path) falling back to the harness
// folder's AGENTS.md, always layered with the project folder's own
// AGENTS.md, read fresh from disk on every call (never cached).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";

let dir; // the Env's own folder (settings.json home / harness-folder fallback)
let cwd; // a separate folder stood in for process.cwd() (the "project folder")
let originalCwd;

beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  // ABSOLUTE and real (macOS /tmp-style dirs are themselves symlinks) so
  // both stay valid path arguments after process.chdir() below, and so
  // that "same directory" comparisons inside resolveSystemPrompt() hold.
  dir = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "env-sysprompt-"))));
  cwd = realpathSync(resolve(mkdtempSync(join("./ai-tmp/", "env-sysprompt-cwd-"))));
  originalCwd = process.cwd();
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("Env.resolveSystemPrompt", () => {
  test("no settings.system and no AGENTS.md anywhere: nothing to prefill", () => {
    const env = new Env({ dir, settings: {} });
    expect(env.resolveSystemPrompt()).toEqual([]);
  });

  test("settings.system as inline text is used verbatim", () => {
    const env = new Env({ dir, settings: { system: "be terse" } });
    expect(env.resolveSystemPrompt()).toEqual(["be terse"]);
  });

  test("settings.system naming an existing file reads its content", () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "from a file\n");
    const env = new Env({ dir, settings: { system: promptFile } });
    expect(env.resolveSystemPrompt()).toEqual(["from a file\n"]);
  });

  test("with no settings.system, falls back to the harness folder's AGENTS.md", () => {
    writeFileSync(join(dir, "AGENTS.md"), "harness rules\n");
    const env = new Env({ dir, settings: {} });
    expect(env.resolveSystemPrompt()).toEqual(["harness rules\n"]);
  });

  test("the project folder's own AGENTS.md always layers in, after the base", () => {
    writeFileSync(join(dir, "AGENTS.md"), "harness rules\n");
    writeFileSync(join(cwd, "AGENTS.md"), "project rules\n");
    const env = new Env({ dir, settings: {} });
    expect(env.resolveSystemPrompt()).toEqual(["harness rules\n", "project rules\n"]);
  });

  test("the USER SETTINGS folder's AGENTS.md layers between package and project (scan order)", () => {
    const settingsHome = realpathSync(resolve(mkdtempSync(join(dir, "env-sd-")))); // dir is absolute (the suite chdirs)
    try {
      writeFileSync(join(dir, "AGENTS.md"), "harness rules\n");
      writeFileSync(join(settingsHome, "AGENTS.md"), "user rules\n");
      writeFileSync(join(cwd, "AGENTS.md"), "project rules\n");
      const env = new Env({ dir, settingsDir: settingsHome, settings: {} });
      expect(env.resolveSystemPrompt()).toEqual(["harness rules\n", "user rules\n", "project rules\n"]);
      // settingsDir: null disables the layer
      const noLayer = new Env({ dir, settingsDir: null, settings: {} });
      expect(noLayer.resolveSystemPrompt()).toEqual(["harness rules\n", "project rules\n"]);
      // a settings.system override still replaces only the PACKAGE layer
      const configured = new Env({ dir, settingsDir: settingsHome, settings: { system: "be terse" } });
      expect(configured.resolveSystemPrompt()).toEqual(["be terse", "user rules\n", "project rules\n"]);
    } finally {
      rmSync(settingsHome, { recursive: true, force: true });
    }
  });

  test("project AGENTS.md layers in even with settings.system set", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "project rules\n");
    const env = new Env({ dir, settings: { system: "be terse" } });
    expect(env.resolveSystemPrompt()).toEqual(["be terse", "project rules\n"]);
  });

  test("harness folder AND project folder being the SAME directory reads it only once", () => {
    process.chdir(dir); // dir IS the cwd for this test
    writeFileSync(join(dir, "AGENTS.md"), "shared rules\n");
    const env = new Env({ dir, settings: {} });
    expect(env.resolveSystemPrompt()).toEqual(["shared rules\n"]);
  });

  test("never cached: editing the source between calls is picked up immediately", () => {
    const env = new Env({ dir, settings: { system: "first" } });
    expect(env.resolveSystemPrompt()).toEqual(["first"]);
    env.settings.system = "second"; // live settings mutation, no reload
    expect(env.resolveSystemPrompt()).toEqual(["second"]);
  });

  test("a settings.system file edited on disk is re-read every call, not cached", () => {
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "v1");
    const env = new Env({ dir, settings: { system: promptFile } });
    expect(env.resolveSystemPrompt()).toEqual(["v1"]);
    writeFileSync(promptFile, "v2");
    expect(env.resolveSystemPrompt()).toEqual(["v2"]);
  });
});

describe("Env.resolveSystemPrompt — {{skill}} prefill", () => {
  /** A skill root with one skill (absolute — the suite chdirs). */
  const skillRoot = (name, body) => {
    const root = mkdtempSync(join(dir, "env-skillref-"));
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
    return root;
  };

  test("a {{name}} handlebars reference is replaced with the skill's content", () => {
    const root = skillRoot("demo", "DEMO RULES");
    const env = new Env({ dir, settings: { system: "before\n{{demo}}\nafter", skills: [root] } });
    const [text] = env.resolveSystemPrompt();
    expect(text).toContain("before\n<skill name=\"demo\">\nDEMO RULES\n</skill>\nafter");
    rmSync(root, { recursive: true, force: true });
  });

  test("an unknown skill name stays verbatim (never a silent rewrite)", () => {
    const env = new Env({ dir, settings: { system: "keep {{no-such-skill}} here" } });
    expect(env.resolveSystemPrompt()).toEqual(["keep {{no-such-skill}} here"]);
  });

  test("the project AGENTS.md layer expands too; multiple references expand", () => {
    const root = skillRoot("one", "ONE");
    writeFileSync(join(cwd, "AGENTS.md"), "rules: {{one}} and {{one}} and {{unknown}}\n");
    const env = new Env({ dir, settings: { system: "base", skills: [root] } });
    const [, local] = env.resolveSystemPrompt();
    expect(local).toBe("rules: <skill name=\"one\">\nONE\n</skill> and <skill name=\"one\">\nONE\n</skill> and {{unknown}}\n");
    rmSync(root, { recursive: true, force: true });
  });
});
