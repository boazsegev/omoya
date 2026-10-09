import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { extensionRoots } from "../lib/env/extensions.js";
import { providerNamesOf, toolNames } from "./env-internals.js";

function fixture() {
  const root = resolve(mkdtempSync("ai-tmp/omoya-extensions-"));
  const host = join(root, "host");
  const user = join(root, "user");
  const project = join(root, "project");
  for (const dir of [host, user, project]) mkdirSync(dir, { recursive: true });
  return { root, host, user, project };
}

async function readyEnv(f, options = {}) {
  const env = f.env = await Env.open(f.project, { dir: f.host, settingsDir: f.user, ...options });
  await env.ready();
  return env;
}

function toolRoots(env) {
  return env.folders.filter(({ kind }) => kind === "tools").map(({ path }) => path);
}

function put(root, path, content) {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function pkg(root, name) {
  const dir = join(root, "node_modules", ...name.split("/"));
  put(dir, "package.json", JSON.stringify({ name, extensions: ["should-not-merge"] }));
  return dir;
}

describe("extension content roots", () => {
  it("loads extension settings, provider, tools, skills and prompts from an installed npm package", async () => {
    const f = fixture();
    try {
      const ext = pkg(f.user, "@sample/extension");
      put(f.user, "settings.json", JSON.stringify({ extensions: { "@sample/extension": true } }));
      put(ext, "options.json", JSON.stringify({ extensionMarker: "loaded" }));
      put(ext, "providers/demo.js", "export default class Demo { static provider = { name: 'demo' }; }\n");
      put(ext, "providers/private/nested.js", "throw new Error('nested provider must not load');\n");
      put(ext, "tools/ext-tool.js", "export const hello = () => 'hi'; export const toolDescription = () => ({ extension_hello: { fn: hello, description: 'hello', inputSchema: { type: 'object', properties: {} } } });\n");
      put(ext, "tools/private/nested.js", "throw new Error('nested tool must not load');\n");
      put(ext, "skills/extension/SKILL.md", "---\nname: extension\ndescription: extension skill\n---\nhello skill\n");
      put(ext, "prompts/extension.md", "---\nname: extension\ndescription: extension prompt\n---\nhello prompt\n");
      const env = f.env = await Env.open(f.project, { dir: f.host, settingsDir: f.user, init: { detect: false } });
      expect(env.settings.extensionMarker).toBe("loaded");
      expect(env.settings.name).toBeUndefined();
      expect(env.settings.extensions).toEqual({ "@sample/extension": true });
      expect(providerNamesOf(env)).toContain("demo");
      expect(toolNames(env)).toContain("extension_hello");
      expect(env.skills().get("extension")).toMatchObject({ description: "extension skill", body: expect.stringContaining("hello skill") });
      expect(env.prompts().get("extension")).toMatchObject({ source: join(ext, "prompts"), body: expect.stringContaining("hello prompt") });
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  it("does not accept project or extension requests to load executable packages", async () => {
    const f = fixture();
    try {
      const ext = pkg(f.user, "first-extension");
      pkg(f.user, "second-extension");
      put(f.user, "settings.json", JSON.stringify({ extensions: { "first-extension": true } }));
      put(ext, "settings.json", JSON.stringify({ extensions: { "second-extension": true } }));
      put(f.project, NAMES.projectSettings, JSON.stringify({ extensions: { "second-extension": true } }));
      const env = await readyEnv(f);
      expect(toolRoots(env)).toContain(join(ext, "tools"));
      expect(toolRoots(env)).not.toContain(join(f.user, "node_modules/second-extension/tools"));
      expect(env.settings.extensions).toEqual({ "first-extension": true });
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  it("merges extension roots in order before user settings, skipping metadata and nested JSON", async () => {
    const f = fixture();
    try {
      const first = pkg(f.host, "first-extension");
      const second = pkg(f.user, "second-extension");
      put(f.host, "settings.json", JSON.stringify({ extensions: { "first-extension": true } }));
      put(f.user, "options.json", JSON.stringify({ extensions: { "second-extension": true }, choice: "user" }));
      put(first, "settings.json", JSON.stringify({ choice: "first", fromFirst: true }));
      put(second, "settings.json", JSON.stringify({ choice: "second" }));
      put(second, "package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
      put(second, "private/nested.json", JSON.stringify({ nested: true }));
      const env = await readyEnv(f);
      expect(toolRoots(env).filter((path) => [join(first, "tools"), join(second, "tools")].includes(path))).toEqual([join(first, "tools"), join(second, "tools")]);
      expect(env.settings.choice).toBe("user");
      expect(env.settings.fromFirst).toBe(true);
      expect(env.settings.lockfileVersion).toBeUndefined();
      expect(env.settings.nested).toBeUndefined();
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  it("overrides selections across trusted files in deterministic order without resolving disabled packages", async () => {
    const f = fixture();
    try {
      const first = pkg(f.user, "first-extension");
      const third = pkg(f.host, "third-extension");
      put(f.host, "a.json", JSON.stringify({ extensions: { "first-extension": true, "missing-extension": false } }));
      put(f.host, "settings.json", JSON.stringify({ extensions: { "third-extension": true } }));
      put(f.user, "options.json", JSON.stringify({ extensions: { "first-extension": false, "third-extension": false } }));
      put(f.user, "settings.json", JSON.stringify({ extensions: { "third-extension": true } }));
      expect(await extensionRoots({ "first-extension": false, "third-extension": true }, { dir: f.host, settingsDir: f.user })).toEqual([third]);
      const env = await readyEnv(f, { settings: { extensions: { "first-extension": true } } });
      expect(toolRoots(env).filter((path) => [join(first, "tools"), join(third, "tools")].includes(path))).toEqual([join(first, "tools"), join(third, "tools")]);
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  it("rejects legacy arrays without rewriting the file", async () => {
    const f = fixture();
    try {
      const second = pkg(f.user, "second-extension");
      pkg(f.host, "first-extension");
      put(f.host, "settings.json", JSON.stringify({ extensions: ["first-extension", "second-extension"] }));
      put(f.user, "settings.json", JSON.stringify({ extensions: { "first-extension": false } }));
      await expect(readyEnv(f)).rejects.toThrow(/migrate legacy arrays/);
      expect(await extensionRoots({ "second-extension": true }, { dir: f.host, settingsDir: f.user })).toEqual([second]);
      await expect(extensionRoots(["second-extension"], { dir: f.host, settingsDir: f.user })).rejects.toThrow(/migrate legacy arrays/);
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });

  it("fails clearly for missing packages and invalid names", async () => {
    const f = fixture();
    try {
      await expect(Env.open(f.project, { dir: f.host, settingsDir: f.user, settings: { extensions: { "missing-extension": true } }, init: { providers: false, tools: false } })).rejects.toThrow(/not installed/);
      await expect(Env.open(f.project, { dir: f.host, settingsDir: f.user, settings: { extensions: { "../bad": true } }, init: { providers: false, tools: false } })).rejects.toThrow(/folder does not exist|invalid extension name or folder path/);
      for (const value of [1, "true", null, [], {}]) {
        await expect(extensionRoots({ "valid-package": value }, { dir: f.host })).rejects.toThrow(/boolean/);
      }
      expect(await extensionRoots({ "valid-package": false }, { dir: f.host })).toEqual([]);
      await expect(extensionRoots(JSON.parse('{"__proto__":true}'), { dir: f.host })).rejects.toThrow(/folder does not exist|invalid extension name or folder path/);
    } finally { await f.env?.close(); rmSync(f.root, { recursive: true, force: true }); }
  });
});
