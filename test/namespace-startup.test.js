// test/namespace-startup.test.js — bounded startup proof for the
// dependency-free namespace foundation and explicit tool imports.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Env from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { toolRoots, toolsLoad } from "./env-internals.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("namespace migration startup", () => {
  test("importing the library and loading package tools stays below 256 MiB RSS", async () => {
    const script = `
      import API from "./lib/index.js";
      const env = await API.Env.create({ dir: "./ai-tmp", cwd: "./ai-tmp", settingsDir: null, settings: {} }, { models: false });
      process.stdout.write(JSON.stringify({ rss: process.memoryUsage().rss, tools: (await env.tools()).size }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.tools).toBeGreaterThan(0);
    expect(result.rss).toBeLessThan(256 * 1024 * 1024);
  }, 20_000);

  test("a stray environment variable cannot inject a tool scan root", async () => {
    mkdirSync("./ai-tmp", { recursive: true });
    const root = mkdtempSync("./ai-tmp/stray-tool-root-");
    roots.push(root);
    writeFileSync(`${root}/must-not-load.js`, 'throw new Error("stray tool root was loaded");\n');
    const strayName = `${NAMES.NAMESPACE}_STRAY_TOOLS_DIR`;
    const saved = process.env[strayName];
    process.env[strayName] = root;
    try {
      const env = new Env({ dir: "./ai-tmp", cwd: "./ai-tmp", settingsDir: null, settings: {} });
      expect(toolRoots(env)).not.toContain(root);
      // contract: the package's own tools load (which tools exist is content)
      await expect(toolsLoad(env)).resolves.not.toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env[strayName];
      else process.env[strayName] = saved;
    }
  });
});
