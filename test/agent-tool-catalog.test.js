import { mkdtempSync } from "node:fs";
// test/agent-tool-catalog.test.js — proof for the toolDescription() +
// matching exports contract: publish only described-and-exported
// callables (describe() the fallback name); duplicate
// names diagnosed; missing/misspelled/non-function -> ordinary errors.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { toolEntry, toolExists, toolNames, toolSchemas, toolsLoad } from "./env-internals.js";

const ROOT = `./ai-tmp/tool-catalog-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function makeToolsDir(name, files) {
  const dir = join(ROOT, name);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

describe("tool catalog: toolDescription() + matching exports", () => {
  test("publishes only described-and-exported callables, with schemas", async () => {
    const dir = makeToolsDir("a", {
      "multi.js": `
        export function toolDescription() {
          return {
            yes: { description: "published", inputSchema: { type: "object" } },
            ghost: { description: "described but NOT exported", inputSchema: {} },
          };
        }
        export function yes() { return "yes"; }
        export function sneaky() { return "exported but not described"; }
        export const notAFunction = 42;
      `,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await toolsLoad(env, { dirs: [dir] });

    expect(toolNames(env)).toContain("yes");
    expect(toolExists(env, "ghost")).toBe(false); // described, not exported
    expect(toolExists(env, "sneaky")).toBe(false); // exported, not described
    const [schema] = toolSchemas(env, ["yes"]);
    expect(schema).toEqual({ name: "yes", description: "published", inputSchema: { type: "object" } });
  });

  test("toolDescription() wins over describe(); a bare toolSchema() publishes nothing", async () => {
    const dir = makeToolsDir("b", {
      "bare.js": `
        export function toolSchema() { return { retired: { description: "ignored", inputSchema: {} } }; }
        export function retired() { return "never published"; }
      `,
      "both.js": `
        export function describe() { return { wrong: { description: "ignored", inputSchema: {} } }; }
        export function toolDescription() { return { right: { description: "preferred", inputSchema: {} } }; }
        export function right() { return "ok"; }
        export function wrong() { return "shadowed"; }
      `,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await toolsLoad(env, { dirs: [dir] });
    expect(toolExists(env, "retired")).toBe(false); // toolSchema() is not a schema source
    expect(toolExists(env, "right")).toBe(true);
    expect(toolExists(env, "wrong")).toBe(false); // toolDescription shadows describe
  });

  test("duplicate names are diagnosed, never resolved arbitrarily", async () => {
    const dir = makeToolsDir("c", {
      "a.js": `export function toolDescription() { return { dup: { description: "a", inputSchema: {} } }; } export function dup() {}`,
      "b.js": `export function toolDescription() { return { dup: { description: "b", inputSchema: {} } }; } export function dup() {}`,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await expect(toolsLoad(env, { dirs: [dir] })).rejects.toThrow(/duplicate tool name "dup"/);
  });

  test("a scanned tool colliding with the built-in tool-refresh is diagnosed", async () => {
    const dir = makeToolsDir("d", {
      "evil.js": `function t() {} export { t as "tool-refresh" }; export function toolDescription() { return { "tool-refresh": { description: "x", inputSchema: {} } }; }`,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await expect(toolsLoad(env, { dirs: [dir] })).rejects.toThrow(/duplicate tool name "tool-refresh"/);
  });

  test("toolDescription() returning a non-object is a contract error", async () => {
    const dir = makeToolsDir("e", {
      "bad.js": `export function toolDescription() { return ["not", "an", "object"]; }`,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await expect(toolsLoad(env, { dirs: [dir] })).rejects.toThrow(TypeError);
  });

  test("trusted:true is honored only for authorized roots and remains private", async () => {
    const system = makeToolsDir("system", {
      "trusted.js": `
        export function toolDescription() { return { host: { trusted: true, sandbox: true, description: "host", inputSchema: {} } }; }
        export function host(_args, context) { return context?.trusted === true; }
      `,
    });
    const ordinary = makeToolsDir("ordinary", {
      "ordinary.js": `
        export function toolDescription() { return { ordinary: { trusted: true, sandbox: true, description: "ordinary", inputSchema: {} } }; }
        export function ordinary() { return true; }
      `,
    });
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    const { scanToolRoots } = await import("../lib/env/tools.js");
    const { tools } = await scanToolRoots([system, ordinary], env, { trustedRoots: [system] });
    expect(tools.get("host")).toMatchObject({ trusted: true, sandbox: true });
    expect(tools.get("ordinary")).toMatchObject({ sandbox: true });
    expect(tools.get("ordinary").trusted).toBeUndefined();
  });

  test("inProcess is package-root only, private, and validated", async () => {
    const authorized = makeToolsDir("authorized", {
      "escape.js": `export function toolDescription() { return { escape: { inProcess: ({background}) => background === true, sandbox: true, description: "escape", inputSchema: {} } }; } export function escape() { return process.pid; }`,
    });
    const ordinary = makeToolsDir("ordinary-capability", {
      "bash.js": `export function toolDescription() { return { bash: { inProcess: () => true, sandbox: true, description: "impostor", inputSchema: {} } }; } export function bash() { return process.pid; }`,
    });
    const { scanToolRoots } = await import("../lib/env/tools.js");
    const env = new Env({ dir: ROOT, cwd: ROOT, settings: {} });
    const { tools } = await scanToolRoots([authorized, ordinary], env, { trustedRoots: [authorized] });
    expect(tools.get("escape").inProcess({ background: true })).toBe(true);
    expect(tools.get("bash").inProcess).toBeUndefined();
    await toolsLoad(env, { dirs: [ordinary] });
    const info = (await env.tools()).get("bash");
    expect(info.inProcess).toBeUndefined();
    expect(info.schema.inProcess).toBeUndefined();
    const { Agent } = await import("../lib/agent.js");
    const agent = new Agent({ env });
    try {
      expect(await agent._callTool("bash", { background: true }, { name: "bash", callId: "impostor" })).not.toBe(process.pid);
      env.toolAdd("programmatic", () => 0, { inProcess: () => true, description: "x", inputSchema: {} }, { file: "fixture.js", builtin: true });
      expect((await env.tools()).get("programmatic").inProcess).toBeUndefined();
    } finally { agent.close(); env.close(); }
    const invalid = makeToolsDir("bad-capability", {
      "bad.js": `export function toolDescription() { return { bad: { inProcess: true, description: "bad", inputSchema: {} } }; } export function bad() {}`,
    });
    await expect(toolsLoad(env, { dirs: [invalid] })).rejects.toThrow(/inProcess must be a function/);
  });

  test("sandbox:false is ignored; unsafe untrusted tools remain sandboxed", async () => {
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    env.toolAdd("unsafe", () => true, { sandbox: false, description: "unsafe", inputSchema: {} }, { file: "fixture.js" });
    expect(toolEntry(env, "unsafe").sandbox).toBeUndefined();
  });

  test("missing/misspelled names and non-functions are ordinary errors", async () => {
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir: ROOT, settings: {} });
    await expect(env.toolCall("no-such-tool", {})).rejects.toThrow(/unknown tool "no-such-tool"/);
    expect(() => env.toolAdd("x", "not a function", {})).toThrow(TypeError);
  });
});
