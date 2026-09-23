// test/cli-init.test.js — proof for lib/cli/init.js (the `--init`
// contract): a fresh namespaced project template with every known
// settings key commented out, and the refuse-to-overwrite guard.
import { NAMES } from "../lib/namespace.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cli } from "./bin-names.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { renderSettingsTemplate, writeSettingsTemplate } from "../lib/cli.js";
import { parseJsonc } from "../lib/env/jsonc.js";

let dir;
beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  dir = mkdtempSync("./ai-tmp/init-");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("renderSettingsTemplate", () => {
  test("every schema key appears, commented out, and the whole file parses as JSONC to {}", async () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await env.loadTools({ dirs: ["./tools"] }); // so mcp's own contribution is included
    const text = renderSettingsTemplate(env);
    const schema = env.defaultsSchema();
    for (const key of Object.keys(schema)) {
      expect(text).toContain(`// ${JSON.stringify(key)}:`);
    }
    expect(parseJsonc(text)).toEqual({}); // fully commented out — no real settings
  });
});

describe("the tui wrapper --init", () => {
  test("writes the template into the spawned process's cwd, then exits 0", async () => {
    const settingsDir = mkdtempSync("./ai-tmp/init-settings-");
    const proc = Bun.spawn(["bun", `${process.cwd()}/${cli.app.slice(2)}`, "--init"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, [NAMES.settingsEnv]: settingsDir },
    });
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    rmSync(settingsDir, { recursive: true, force: true });
    expect(exit).toBe(0);
    const file = join(dir, NAMES.projectSettings);
    expect(existsSync(file)).toBe(true);
    expect(stderr).toContain(file);
    expect(parseJsonc(readFileSync(file, "utf8"))).toEqual({});
  }, 15_000);
});

describe("writeSettingsTemplate", () => {
  test("writes the namespaced project settings file into env.cwd", async () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await env.loadTools({ dirs: ["./tools"] });
    const file = writeSettingsTemplate(env);
    expect(file).toBe(join(dir, NAMES.projectSettings));
    expect(existsSync(file)).toBe(true);
    expect(parseJsonc(readFileSync(file, "utf8"))).toEqual({});
  });

  test("refuses to overwrite an existing file unless force", async () => {
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {} });
    await env.loadTools({ dirs: ["./tools"] });
    writeSettingsTemplate(env);
    expect(() => writeSettingsTemplate(env)).toThrow(/already exists/);
    expect(() => writeSettingsTemplate(env, { force: true })).not.toThrow();
  });
});
