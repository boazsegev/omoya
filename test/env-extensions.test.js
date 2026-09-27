import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Env from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { providerNamesOf, toolNames } from "./env-internals.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omoya-extensions-"));
  const host = join(root, "host");
  const user = join(root, "user");
  const project = join(root, "project");
  for (const dir of [host, user, project]) mkdirSync(dir, { recursive: true });
  return { root, host, user, project };
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
      put(f.user, "settings.json", JSON.stringify({ extensions: ["@sample/extension"] }));
      put(ext, "options.json", JSON.stringify({ extensionMarker: "loaded" }));
      put(ext, "providers/demo.js", "export default class Demo { static provider = { name: 'demo' }; }\n");
      put(ext, "providers/private/nested.js", "throw new Error('nested provider must not load');\n");
      put(ext, "tools/ext-tool.js", "export const hello = () => 'hi'; export const toolDescription = () => ({ extension_hello: { fn: hello, description: 'hello', inputSchema: { type: 'object', properties: {} } } });\n");
      put(ext, "tools/private/nested.js", "throw new Error('nested tool must not load');\n");
      put(ext, "skills/extension/SKILL.md", "---\nname: extension\ndescription: extension skill\n---\nhello skill\n");
      put(ext, "prompts/extension.md", "---\nname: extension\ndescription: extension prompt\n---\nhello prompt\n");
      const env = await Env.create({ dir: f.host, settingsDir: f.user, cwd: f.project }, { detect: false });
      expect(env.settings.extensionMarker).toBe("loaded");
      expect(env.settings.name).toBeUndefined();
      expect(env.settings.extensions).toEqual(["@sample/extension"]);
      expect(providerNamesOf(env)).toContain("demo");
      expect(toolNames(env)).toContain("extension_hello");
      expect(env.skills().get("extension")).toMatchObject({ description: "extension skill", body: expect.stringContaining("hello skill") });
      expect(env.prompts().get("extension")).toMatchObject({ source: join(ext, "prompts"), body: expect.stringContaining("hello prompt") });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("does not accept project or extension requests to load executable packages", () => {
    const f = fixture();
    try {
      const ext = pkg(f.user, "first-extension");
      pkg(f.user, "second-extension");
      put(f.user, "settings.json", JSON.stringify({ extensions: ["first-extension"] }));
      put(ext, "settings.json", JSON.stringify({ extensions: ["second-extension"] }));
      put(f.project, NAMES.projectSettings, JSON.stringify({ extensions: ["second-extension"] }));
      const env = new Env({ dir: f.host, settingsDir: f.user, cwd: f.project });
      expect(env._extensionRoots).toEqual([ext]);
      expect(env.settings.extensions).toEqual(["first-extension"]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("merges extension roots in order before user settings, skipping metadata and nested JSON", () => {
    const f = fixture();
    try {
      const first = pkg(f.host, "first-extension");
      const second = pkg(f.user, "second-extension");
      put(f.host, "settings.json", JSON.stringify({ extensions: ["first-extension"] }));
      put(f.user, "options.json", JSON.stringify({ extensions: ["second-extension"], choice: "user" }));
      put(first, "settings.json", JSON.stringify({ choice: "first", fromFirst: true }));
      put(second, "settings.json", JSON.stringify({ choice: "second" }));
      put(second, "package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
      put(second, "private/nested.json", JSON.stringify({ nested: true }));
      const env = new Env({ dir: f.host, settingsDir: f.user, cwd: f.project });
      expect(env._extensionRoots).toEqual([first, second]);
      expect(env.settings.choice).toBe("user");
      expect(env.settings.fromFirst).toBe(true);
      expect(env.settings.lockfileVersion).toBeUndefined();
      expect(env.settings.nested).toBeUndefined();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("fails clearly for missing packages and invalid names", () => {
    const f = fixture();
    try {
      expect(() => new Env({ dir: f.host, settingsDir: f.user, cwd: f.project, settings: { extensions: ["missing-extension"] } })).toThrow(/not installed/);
      expect(() => new Env({ dir: f.host, settingsDir: f.user, cwd: f.project, settings: { extensions: ["../bad"] } })).toThrow(/npm package names/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
