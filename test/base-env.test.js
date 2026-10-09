// test/base-env.test.js — proof for lib/env.js core (registry surfaces, views)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { providerAdd, providerNamesOf, providerOf, toolExists, toolNames, toolsLoad } from "./env-internals.js";

let dir;
beforeAll(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "env-core-")));
});
afterAll(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => env.folder === dir || env.folder.startsWith(`${dir}/`)).map((env) => env.close()));
  rmSync(dir, { recursive: true, force: true });
});

describe("Env construction", () => {
  /** Every key the view answers is a schema default (or derived): no layer contributed. */
  const onlyDefaults = (env) => {
    const schema = env.settingsSchema();
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(env.settings)))) {
      if (key === "providers") expect(value).toEqual({});
      else if (key === "projects") expect(value).toEqual({ this: { name: "this", folder: env.folder }, [env.folder]: { name: "this", folder: env.folder } });
      else if (!schema[key]?.derive) expect(value, key).toEqual(schema[key]?.default);
    }
  };

  test("empty folder scans to empty settings (defaults only)", async () => {
    const env = await Env.open(dir, { dir, settingsDir: null });
    await env.ready();
    onlyDefaults(env);
    expect(env.models()).toEqual(new Map());
    expect(env.settings.providers.ollama).toBeUndefined();
  });

  test("missing folder scans as empty (no crash)", async () => {
    const missing = join(dir, "does-not-exist");
    const env = await Env.open(missing, { dir: missing, settingsDir: null });
    await env.ready();
    onlyDefaults(env);
  });

  test("folders are typed {kind, title, path}, computed from current state; tool roots are kind 'tools'", async () => {
    const settingsDir = join(dir, "user");
    const env = await Env.open(dir, { dir, settingsDir });
    await env.ready();
    const folders = env.folders;
    expect(Object.isFrozen(folders)).toBe(true);
    expect(folders.slice(0, 3)).toEqual([
      { kind: "project", title: "project folder", path: resolve(dir) },
      { kind: "harness", title: "harness folder", path: dir },
      { kind: "settings", title: "settings folder", path: settingsDir },
    ]);
    await toolsLoad(env, { dirs: [join(dir, "tools-a"), join(dir, "tools-a")] }); // a repeated root lists once
    expect(env.folders.filter((f) => f.kind === "tools")).toEqual([{ kind: "tools", title: "tool folder", path: join(dir, "tools-a") }]);
    expect(() => { env.folder = join(dir, "elsewhere"); }).toThrow();
    expect(env.folders[0].path).toBe(resolve(dir));
    await env.close();
    const withoutSettings = await Env.open(dir, { dir, settingsDir: null });
    await withoutSettings.ready();
    expect(withoutSettings.folders.some((f) => f.kind === "settings")).toBe(false);
  });
});

describe("provider registry surface (sole registry)", () => {
  test("register/lookup/names", async () => {
    const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    class Ollama {}
    providerAdd(env, "ollama", Ollama);
    expect(providerOf(env, "ollama").original).toBe(Ollama);
    expect(providerOf(env, "nope")).toBeUndefined();
    expect(providerNamesOf(env)).toEqual(["ollama"]);
  });

  test("duplicate provider is diagnosed", async () => {
    const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    providerAdd(env, "ollama", class {});
    expect(() => providerAdd(env, "ollama", class {})).toThrow(/duplicate provider/);
  });
});

describe("tool registry surface (flattened exact lookup)", () => {
  test("register, list, exact dispatch", async () => {
    const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    const fn = ({ path }) => `read:${path}`;
    env.toolAdd("file-read", fn, { description: "read a file" });
    expect(toolNames(env)).toEqual(["tool-refresh", "file-read"]); // built-in first
    expect(toolExists(env, "file-read")).toBe(true);
    expect(toolExists(env, "fileread")).toBe(false); // no name parsing
    await expect(env.toolCall("file-read", { path: "a.txt" })).resolves.toBe("read:a.txt");
  });

  test("missing names and non-functions become ordinary errors", async () => {
    const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    await expect(env.toolCall("ghost", {})).rejects.toThrow(/unknown tool "ghost"/);
    expect(() => env.toolAdd("bad", 42)).toThrow(/not callable/);
  });

  test("duplicate flattened names are diagnosed", async () => {
    const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
    await env.ready();
    env.toolAdd("file-read", () => {});
    expect(() => env.toolAdd("file-read", () => {})).toThrow(/duplicate tool name/);
  });
});
