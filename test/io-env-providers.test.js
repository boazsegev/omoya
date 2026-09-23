// Env loads provider protocol classes by file basename.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";

let dir, providersDir;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-envp-")));
  providersDir = join(dir, "providers");
  mkdirSync(providersDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VALID = `
export default class Provider {
  static provider = { capabilities: { tools: true } };
}
`;

describe("Env.loadProviders scan-and-load", () => {
  test("auto-detects default-exported classes and registers normalized classes by basename", async () => {
    writeFileSync(join(providersDir, "alpha.js"), VALID);
    writeFileSync(join(providersDir, "beta.js"), VALID);
    const env = new Env({ dir, cwd: dir });
    const names = await env.loadProviders({ dirs: [providersDir], detect: false });
    expect(names).toEqual(["alpha", "beta"]);
    expect(env.providerNames()).toEqual(["alpha", "beta"]);
    const Alpha = env.provider("alpha");
    expect(typeof Alpha.prototype.read).toBe("function");
    expect(typeof Alpha.prototype.models).toBe("function");
    expect(Alpha.provider.name).toBe("alpha");
    expect(Alpha.provider.capabilities.tools).toBe(true);
    expect(Alpha.provider.capabilities.streaming).toBe(false);
  });

  test("non-JS files are ignored; missing roots scan empty", async () => {
    writeFileSync(join(providersDir, "notes.txt"), "not a provider");
    const env = new Env({ dir, cwd: dir });
    expect(await env.loadProviders({ dirs: [providersDir], detect: false })).toEqual([]);
    expect(await env.loadProviders({ dirs: [join(dir, "absent")], detect: false })).toEqual([]);
  });

  test("invalid modules surface a class export error", async () => {
    writeFileSync(join(providersDir, "broken.js"), "export const nothing = 1;");
    const env = new Env({ dir, cwd: dir });
    await expect(env.loadProviders({ dirs: [providersDir], detect: false })).rejects.toThrow(/default-export a class/);
  });

  test("duplicate basenames across roots are diagnosed", async () => {
    const second = join(dir, "second");
    mkdirSync(second);
    writeFileSync(join(providersDir, "alpha.js"), VALID);
    writeFileSync(join(second, "alpha.js"), VALID);
    const env = new Env({ dir, cwd: dir });
    await expect(env.loadProviders({ dirs: [providersDir, second], detect: false })).rejects.toThrow(/duplicate provider/);
  });

  test("default scan roots include the package providers folder", async () => {
    const { fileURLToPath } = await import("node:url");
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const env = new Env({ dir: packageRoot, cwd: dir });
    const names = await env.loadProviders({ detect: false });
    expect(names).toContain("ollama");
    expect(names).toContain("openai");
    expect(names).toContain("test");
    for (const name of names) expect(env.provider(name).provider.name).toBe(name);
  });
});

describe("Env.toolSchemas availability selection", () => {
  test("omitted/[\"*\"] = all; [] = none; explicit = recognized subset", () => {
    const env = new Env({ dir, cwd: dir });
    env.registerTool("a", () => {}, { description: "A", inputSchema: {} });
    env.registerTool("b", () => {}, { description: "B", inputSchema: {} });
    expect(env.toolSchemas().map((tool) => tool.name)).toEqual(["tool-refresh", "a", "b"]);
    expect(env.toolSchemas(["*"]).map((tool) => tool.name)).toEqual(["tool-refresh", "a", "b"]);
    expect(env.toolSchemas([])).toEqual([]);
    expect(env.toolSchemas(["a", "nope"]).map((tool) => tool.name)).toEqual(["a"]);
    expect(() => env.toolSchemas("a")).toThrow(TypeError);
  });
});
