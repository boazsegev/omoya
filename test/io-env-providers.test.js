// Env loads provider protocol classes by file basename.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { providerNamesOf, providerOf, providersLoad } from "./env-internals.js";

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

describe("Env.providersLoad scan-and-load", () => {
  test("auto-detects default-exported classes and registers normalized classes by basename", async () => {
    writeFileSync(join(providersDir, "alpha.js"), VALID);
    writeFileSync(join(providersDir, "beta.js"), VALID);
    const env = new Env({ dir, cwd: dir });
    const names = await providersLoad(env, { dirs: [providersDir], detect: false });
    expect(names).toEqual(["alpha", "beta"]);
    expect(providerNamesOf(env)).toEqual(["alpha", "beta"]);
    const Alpha = providerOf(env, "alpha");
    expect(typeof Alpha.models).toBe("function"); // the catalog side Env completes
    expect(Alpha.provider.name).toBe("alpha");
    expect(Alpha.provider.capabilities.tools).toBe(true);
    expect(Alpha.provider.capabilities.streaming).toBe(false);
  });

  test("non-JS files are ignored; missing roots scan empty", async () => {
    writeFileSync(join(providersDir, "notes.txt"), "not a provider");
    const env = new Env({ dir, cwd: dir });
    expect(await providersLoad(env, { dirs: [providersDir], detect: false })).toEqual([]);
    expect(await providersLoad(env, { dirs: [join(dir, "absent")], detect: false })).toEqual([]);
  });

  test("invalid modules surface a class export error", async () => {
    writeFileSync(join(providersDir, "broken.js"), "export const nothing = 1;");
    const env = new Env({ dir, cwd: dir });
    await expect(providersLoad(env, { dirs: [providersDir], detect: false })).rejects.toThrow(/default-export a class/);
  });

  test("duplicate basenames across roots are diagnosed", async () => {
    const second = join(dir, "second");
    mkdirSync(second);
    writeFileSync(join(providersDir, "alpha.js"), VALID);
    writeFileSync(join(second, "alpha.js"), VALID);
    const env = new Env({ dir, cwd: dir });
    await expect(providersLoad(env, { dirs: [providersDir, second], detect: false })).rejects.toThrow(/duplicate provider/);
  });

  test("default scan roots include the package providers folder", async () => {
    const { fileURLToPath } = await import("node:url");
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const env = new Env({ dir: packageRoot, cwd: dir });
    const names = await providersLoad(env, { detect: false });
    expect(names).toContain("ollama");
    expect(names).toContain("openai");
    expect(names).toContain("test");
    for (const name of names) expect(providerOf(env, name).provider.name).toBe(name);
  });
});

