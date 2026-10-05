// test/base-env.test.js — proof for lib/env.js core (registry surfaces, views)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { providerAdd, providerNamesOf, providerOf, settingsOf, toolExists, toolNames, toolsLoad } from "./env-internals.js";

let dir;
beforeAll(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "env-core-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Env construction", () => {
  /** Every key the view answers is a schema default (or derived): no layer contributed. */
  const onlyDefaults = (env) => {
    const schema = env.settingsSchema();
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(env.settings)))) {
      if (key === "providers") expect(value).toEqual({});
      else if (!schema[key]?.derive) expect(value, key).toEqual(schema[key]?.default);
    }
  };

  test("empty folder scans to empty settings (defaults only)", () => {
    const env = new Env({ dir, cwd: dir });
    onlyDefaults(env);
    expect(env._endpoints).toEqual({});
    expect(settingsOf(env, "ollama")).toEqual({});
  });

  test("missing folder scans as empty (no crash)", () => {
    const missing = join(dir, "does-not-exist");
    const env = new Env({ dir: missing, cwd: missing });
    onlyDefaults(env);
  });

  test("folders are typed {kind, title, path}, computed from current state; tool roots are kind 'tools'", async () => {
    const settingsDir = join(dir, "user");
    const env = new Env({ dir, cwd: dir, settingsDir });
    const folders = env.folders;
    expect(Object.isFrozen(folders)).toBe(true);
    expect(folders.slice(0, 3)).toEqual([
      { kind: "project", title: "project folder", path: resolve(dir) },
      { kind: "harness", title: "harness folder", path: dir },
      { kind: "settings", title: "settings folder", path: settingsDir },
    ]);
    await toolsLoad(env, { dirs: [join(dir, "tools-a"), join(dir, "tools-a")] }); // a repeated root lists once
    expect(env.folders.filter((f) => f.kind === "tools")).toEqual([{ kind: "tools", title: "tool folder", path: join(dir, "tools-a") }]);
    expect(() => { env.cwd = join(dir, "elsewhere"); }).toThrow();
    expect(env.folders[0].path).toBe(resolve(dir));
    env.close();
    expect(new Env({ dir, cwd: dir, settingsDir: null }).folders.some((f) => f.kind === "settings")).toBe(false);
  });
});

describe("provider registry surface (sole registry)", () => {
  test("register/lookup/names", () => {
    const env = new Env({ dir, cwd: dir });
    class Ollama {}
    providerAdd(env, "ollama", Ollama);
    expect(providerOf(env, "ollama").original).toBe(Ollama);
    expect(providerOf(env, "nope")).toBeUndefined();
    expect(providerNamesOf(env)).toEqual(["ollama"]);
  });

  test("duplicate provider is diagnosed", () => {
    const env = new Env({ dir, cwd: dir });
    providerAdd(env, "ollama", class {});
    expect(() => providerAdd(env, "ollama", class {})).toThrow(/duplicate provider/);
  });
});

describe("tool registry surface (flattened exact lookup)", () => {
  test("register, list, exact dispatch", async () => {
    const env = new Env({ dir, cwd: dir });
    const fn = ({ path }) => `read:${path}`;
    env.toolAdd("file-read", fn, { description: "read a file" });
    expect(toolNames(env)).toEqual(["tool-refresh", "file-read"]); // built-in first
    expect(toolExists(env, "file-read")).toBe(true);
    expect(toolExists(env, "fileread")).toBe(false); // no name parsing
    await expect(env.toolCall("file-read", { path: "a.txt" })).resolves.toBe("read:a.txt");
  });

  test("missing names and non-functions become ordinary errors", async () => {
    const env = new Env({ dir, cwd: dir });
    await expect(env.toolCall("ghost", {})).rejects.toThrow(/unknown tool "ghost"/);
    expect(() => env.toolAdd("bad", 42)).toThrow(/not callable/);
  });

  test("duplicate flattened names are diagnosed", () => {
    const env = new Env({ dir, cwd: dir });
    env.toolAdd("file-read", () => {});
    expect(() => env.toolAdd("file-read", () => {})).toThrow(/duplicate tool name/);
  });
});
