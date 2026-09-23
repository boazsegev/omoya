// test/base-env.test.js — proof for lib/env.js core (registry surfaces, views)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";

let dir;
beforeAll(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "env-core-")));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Env construction", () => {
  test("empty folder scans to empty settings", () => {
    const env = new Env({ dir, cwd: dir });
    expect(env.settings).toEqual({});
    expect(env.endpoints).toEqual({});
    expect(env.endpointSettings("ollama")).toEqual({});
  });

  test("missing folder scans as empty (no crash)", () => {
    const missing = join(dir, "does-not-exist");
    const env = new Env({ dir: missing, cwd: missing });
    expect(env.settings).toEqual({});
  });

  test("environment.folders is TITLED {title, path} pairs; tool roots join as 'tool folder'", async () => {
    const env = new Env({ dir, cwd: dir });
    const folders = env.environment.folders;
    expect(folders).toContainEqual({ title: "project folder", path: dir });
    expect(folders.every((f) => typeof f.title === "string" && typeof f.path === "string")).toBe(true);
    await env.loadTools({ dirs: [join(dir, "tools-a")] });
    expect(env.environment.folders).toContainEqual({ title: "tool folder", path: join(dir, "tools-a") });
    await env.loadTools({ dirs: [join(dir, "tools-a")] }); // deduped by path
    expect(env.environment.folders.filter((f) => f.path === join(dir, "tools-a"))).toHaveLength(1);
  });
});

describe("provider registry surface (sole registry)", () => {
  test("register/lookup/names", () => {
    const env = new Env({ dir, cwd: dir });
    class Ollama {}
    env.registerProvider("ollama", Ollama);
    expect(env.provider("ollama").original).toBe(Ollama);
    expect(env.provider("nope")).toBeUndefined();
    expect(env.providerNames()).toEqual(["ollama"]);
  });

  test("duplicate provider is diagnosed", () => {
    const env = new Env({ dir, cwd: dir });
    env.registerProvider("ollama", class {});
    expect(() => env.registerProvider("ollama", class {})).toThrow(/duplicate provider/);
  });
});

describe("tool registry surface (flattened exact lookup)", () => {
  test("register, list, exact dispatch", async () => {
    const env = new Env({ dir, cwd: dir });
    const fn = ({ path }) => `read:${path}`;
    env.registerTool("file-read", fn, { description: "read a file" });
    expect(env.toolNames()).toEqual(["tool-refresh", "file-read"]); // built-in first
    expect(env.hasTool("file-read")).toBe(true);
    expect(env.hasTool("fileread")).toBe(false); // no name parsing
    await expect(env.callTool("file-read", { path: "a.txt" })).resolves.toBe("read:a.txt");
  });

  test("missing names and non-functions become ordinary errors", async () => {
    const env = new Env({ dir, cwd: dir });
    await expect(env.callTool("ghost", {})).rejects.toThrow(/unknown tool "ghost"/);
    expect(() => env.registerTool("bad", 42)).toThrow(/not callable/);
  });

  test("duplicate flattened names are diagnosed", () => {
    const env = new Env({ dir, cwd: dir });
    env.registerTool("file-read", () => {});
    expect(() => env.registerTool("file-read", () => {})).toThrow(/duplicate tool name/);
  });
});
