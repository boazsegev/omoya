// test/agent-tool-discovery.test.js — proof for tool-folder discovery:
// configured settings.tools roots, TOP-LEVEL .js modules only (the scan
// is NOT recursive — sub-folders hold a tool's private helpers), missing
// folders scan empty, side-effect modules imported but omitted from the
// catalog.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";

const ROOT = `./ai-tmp/tool-discovery-${process.pid}`;
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeToolsDir(name, files) {
  const dir = join(ROOT, name);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

const TOOL = (fname, ret) => `
export function toolDescription() {
  return { ${fname}: { description: "${fname}", inputSchema: { type: "object" } } };
}
export function ${fname}() { return ${JSON.stringify(ret)}; }
`;

describe("tool-folder discovery", () => {
  test("bench/test/spec/demo-named files are NEVER imported (no side effects, no memory)", async () => {
    // Regression: the scan used to import EVERY .js under the roots —
    // bench/test scripts execute their suite at import, printing results
    // and retaining datasets in the module cache (observed ~30x memory).
    const dir = makeToolsDir("benches", {
      "2026-01-01 001 bench-malloc.js": `globalThis.__BENCH_IMPORTED = (globalThis.__BENCH_IMPORTED || 0) + 1;`,
      "my-tool.test.js": `globalThis.__TEST_IMPORTED = 1;`,
      "smoke-check.js": `globalThis.__SMOKE_IMPORTED = 1;`,
      "real-tool.js": TOOL("real", "here"),
      "contest.js": TOOL("contest", "kept"), // contains "test" but no token boundary
    });
    const env = new Env({ dir: join(ROOT, "empty-pkg"), settings: {} });
    const names = await env.loadTools({ dirs: [dir] });

    expect(names).toContain("real");
    expect(names).toContain("contest"); // "contest" is not a test file
    expect(globalThis.__BENCH_IMPORTED).toBeUndefined(); // never imported
    expect(globalThis.__TEST_IMPORTED).toBeUndefined();
    expect(globalThis.__SMOKE_IMPORTED).toBeUndefined();
  });

  test("import-time tool printing is SUPPRESSED (the host owns stdout) and reported on stderr", async () => {
    // a script-shaped module (no import.meta.main guard) runs its
    // main() at import; its output must never reach the host's
    // stdout (the TUI's screen, the headless protocol channel) — it
    // is discarded and reported once on stderr with the fix
    const dir = makeToolsDir("noisy", {
      "script-shaped.js": `
console.log("import-noise-console:", JSON.stringify({ leak: true }));
process.stdout.write("import-noise-direct\\n");
${TOOL("quiet", "ok")}`,
    });
    const outChunks = [];
    const errChunks = [];
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c, ...r) => { outChunks.push(String(c)); r.find((a) => typeof a === "function")?.(); return true; };
    process.stderr.write = (c, ...r) => { errChunks.push(String(c)); r.find((a) => typeof a === "function")?.(); return true; };
    let env;
    try {
      env = new Env({ dir: ROOT, settings: {} });
      await env.loadTools({ dirs: [dir] });
    } finally {
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }
    expect(outChunks.join("")).not.toContain("import-noise"); // nothing reached the host's stdout
    const notice = errChunks.join("");
    expect(notice).toContain("script-shaped.js");
    expect(notice).toContain("suppressed");
    expect(notice).toContain("import.meta.main");
    expect(await env.callTool("quiet")).toBe("ok"); // the tool itself still published
  });

  test("the scan is NOT recursive: sub-folders are private helpers, never imported", async () => {
    const dir = makeToolsDir("a", {
      "plain.js": TOOL("hello", "root"),
      "ns/deep.js": `globalThis.__DEEP_IMPORTED = 1; ${TOOL("dig", "namespaced")}`,
      "ns/too/deep.js": TOOL("buried", "never"),
    });
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [dir] });
    expect(env.toolNames().sort()).toEqual(["hello", "tool-refresh"]);
    expect(await env.callTool("hello")).toBe("root");
    expect(globalThis.__DEEP_IMPORTED).toBeUndefined(); // never even imported
    expect(env.hasTool("dig")).toBe(false);
    expect(env.hasTool("ns-dig")).toBe(false); // no namespace flattening
    expect(env.hasTool("buried")).toBe(false);
  });

  test("modules without toolDescription()/describe() are imported (side effects) but omitted", async () => {
    const marker = join(ROOT, "side-effect-ran.json");
    const dir = makeToolsDir("b", {
      "extend.js": `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "{}");
        export const x = 1;
      `,
      "real.js": TOOL("real", 1),
    });
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [dir] });
    expect(env.toolNames()).toContain("real");
    expect(env.toolNames()).not.toContain("extend");
    expect(await Bun.file(marker).exists()).toBe(true); // side effect ran
  });

  test("describe() is the fallback schema function when toolDescription is undefined", async () => {
    const dir = makeToolsDir("fallback", {
      // describe() only — the fallback name
      "via-describe.js": `
        export function describe() {
          return { viaDescribe: { description: "d", inputSchema: { type: "object" } } };
        }
        export function viaDescribe() { return "from describe"; }
      `,
      // BOTH: toolDescription wins over describe
      "both.js": `
        export function describe() {
          return { shadowed: { description: "d", inputSchema: { type: "object" } } };
        }
        export function toolDescription() {
          return { preferred: { description: "p", inputSchema: { type: "object" } } };
        }
        export function preferred() { return "from toolDescription"; }
        export function shadowed() { return "never published"; }
      `,
      // a bare toolSchema() module is NOT a schema source — side-effect
      // module only (the retired alias never publishes)
      "retired.js": `
        export function toolSchema() {
          return { retired: { description: "l", inputSchema: { type: "object" } } };
        }
        export function retired() { return "never published"; }
      `,
    });
    const env = new Env({ dir: ROOT, settings: {} });
    await env.loadTools({ dirs: [dir] });
    expect(await env.callTool("viaDescribe")).toBe("from describe");
    expect(await env.callTool("preferred")).toBe("from toolDescription");
    expect(env.hasTool("shadowed")).toBe(false); // toolDescription REPLACES describe wholesale
    expect(env.hasTool("retired")).toBe(false); // toolSchema() is not a schema source
  });

  test("missing/unreadable roots scan as empty; only built-ins remain", async () => {
    const env = new Env({ dir: ROOT, settings: {} });
    const names = await env.loadTools({ dirs: [join(ROOT, "does-not-exist")] });
    expect(names).toEqual(["tool-refresh"]);
  });

  test("roots ACCUMULATE in layer order: package tools, settings folder, settings.tools", async () => {
    const first = makeToolsDir("s", { "one.js": TOOL("one", 1) });
    const second = makeToolsDir("e", { "two.js": TOOL("two", 2) });
    // the package ./tools ships read/write/edit/question/skill/bash;
    // the settings-folder layer is the test preload's temp folder — empty
    const env = new Env({ dir: ROOT, cwd: ROOT, settings: { tools: [first, second] } });
    const roots = env.defaultToolRoots();
    expect(roots[0]).toEndWith(`${sep}tools`); // the package's own tools/ first
    expect(roots.slice(-2)).toEqual([first, second]);
    expect(new Set(roots).size).toBe(roots.length); // deduped, never twice
    const names = await env.loadTools();
    for (const expected of ["one", "two", "read", "bash", "tool-refresh"]) {
      expect(names).toContain(expected);
    }
  });

  test("the PROJECT folder is NEVER a tool root (executable trust)", async () => {
    // SECURITY: tool code runs with harness privileges (a schema can
    // mark itself interactive/in-process) — a project-writable root
    // would let an agent author its own unsandboxed tools. Tools
    // come from the package and the settings folder only.
    makeToolsDir("project-tools", { "evil.js": TOOL("evil", "injected") });
    const env = new Env({ dir: ROOT, cwd: ROOT, settings: {} });
    expect(env.defaultToolRoots().join(sep)).not.toContain("project-tools");
    const names = await env.loadTools();
    expect(names).not.toContain("evil");
    expect(names.length).toBeGreaterThan(0); // the package's own tools still load (which tools exist is content)
  });

  test("a `tools` key in project settings is STRIPPED (same vector)", async () => {
    // SECURITY: the project-scoped settings file is agent-writable —
    // it must never name tool roots (load.js drops the key before
    // the merge; package/settings-scoped settings.tools still work)
    const injected = makeToolsDir("injected", { "evil.js": TOOL("evil", "injected") });
    const project = join(ROOT, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, NAMES.projectSettings), JSON.stringify({ tools: [injected], other: 1 }));
    const env = new Env({ dir: ROOT, cwd: project, settings: {} });
    expect(env.settings.tools).toBeUndefined(); // stripped at load
    expect(env.settings.other).toBe(1); // the rest of the file merges normally
    expect(await env.loadTools()).not.toContain("evil");
  });

  test("settings.tools string (single root) works; package tools/ is the fallback default", async () => {
    const dir = makeToolsDir("single", { "one.js": TOOL("one", 1) });
    const env = new Env({ dir: ROOT, settings: { tools: dir } });
    expect(await env.loadTools()).toContain("one");

    // no settings.tools -> package ./tools (its tool set is content, not asserted)
    const fallback = new Env({ settings: {} });
    expect(fallback.defaultToolRoots().join("/")).toContain("tools");
    const names = await fallback.loadTools();
    expect(names.length).toBeGreaterThan(0);
  });
});
