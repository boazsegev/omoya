// Tool-root map migration: enabled paths load, disabled paths do not.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { defaultToolRoots, loadTools } from "../lib/env/tool-registry.js";
import { NAMES } from "../lib/namespace.js";

const dirs = [];
const makeDir = () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const dir = mkdtempSync("./ai-tmp/folders-map-");
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((env) => dirs.includes(env.folder)).map((env) => env.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("tools.folders loads only enabled map entries in insertion order and deduplicates roots", async () => {
  const cwd = makeDir();
  const enabled = join(cwd, "enabled");
  const disabled = join(cwd, "disabled");
  mkdirSync(enabled);
  mkdirSync(disabled);
  writeFileSync(join(enabled, "enabled.js"), 'export function toolDescription() { return { enabled: { description: "ok", inputSchema: { type: "object" } } }; } export function enabled() { return true; }');
  writeFileSync(join(disabled, "disabled.js"), 'export function toolDescription() { return { disabled: { description: "no", inputSchema: { type: "object" } } }; } export function disabled() { return true; }');
  const env = await Env.open(cwd, { settingsDir: null, init: { tools: false }, settings: { tools: { folders: { [enabled]: true, [disabled]: false, [join(enabled, ".")]: true } } } });
  const roots = defaultToolRoots(env);
  expect(roots.slice(-1)).toEqual([enabled]);
  const names = await loadTools(env);
  expect(names).toContain("enabled");
  expect(names).not.toContain("disabled");
  await env.close();
});

test("tools.folders rejects invalid map values and path keys", async () => {
  const cwd = makeDir();
  for (const folders of [{ valid: 1 }, { valid: "true" }, { valid: null }, { "": true }, { "   ": false }, { "bad\0path": true }, JSON.parse('{"__proto__":true}'), null]) {
    await expect(Env.open(cwd, { settingsDir: null, init: { tools: false }, settings: { tools: { folders } } })).rejects.toThrow(/tools\.folders/);
    expect(Env.envs[cwd]).toBeUndefined();
  }
});

test("project settings cannot inject map-based tool roots", async () => {
  const cwd = makeDir();
  const injected = join(cwd, "injected");
  mkdirSync(injected);
  writeFileSync(join(injected, "evil.js"), 'export function toolDescription() { return { evil: { description: "no", inputSchema: { type: "object" } } }; } export function evil() { return true; }');
  writeFileSync(join(cwd, NAMES.projectSettings), JSON.stringify({ tools: { folders: { [injected]: true } } }));
  const env = await Env.open(cwd, { settingsDir: null, init: { tools: false } });
  expect(defaultToolRoots(env)).not.toContain(injected);
  expect(await loadTools(env)).not.toContain("evil");
  await env.close();
});
