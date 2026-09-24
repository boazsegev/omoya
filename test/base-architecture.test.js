// test/base-architecture.test.js — proof for the module layout and its
// LINEAR OWNERSHIP rule (user-directed 2026-09-04):
//
//   public modules live at lib/<name>.js; each may own a PRIVATE folder
//   lib/<name>/ nobody else imports; dependencies point strictly DOWN
//   the chain markdown < context < env < io < agent < cli < jobs < tui (an
//   owner is never
//   owned by what it owns); providers are plugins over context/env/io;
//   executables touch public modules only.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { NAMES } from "../lib/namespace.js";

// Jobs owns headless execution and uses CLI's public model selection contract.
const RANK = { markdown: 0, context: 1, env: 2, io: 3, agent: 4, cli: 5, jobs: 6, tui: 7, web: 8 };
const PUBLIC = Object.keys(RANK);
const FOUNDATIONS = ["namespace", "tool-runtime"];
/** The tui façade owns two private folders:
 *  lib/tui.js -> lib/tui-app/ -> lib/gtui/gtui.js -> gtui privates,
 *  one direction only, checked below with its own stricter rule
 *  (gtui imports node: + its own files ONLY — no lower public modules;
 *  tui-app imports gtui's FAÇADE only, never a gtui private). */
const FOLDER_OWNER = { "gtui": "tui", "tui-app": "tui", "web-app": "web" };
const ownerOf = (folder) => FOLDER_OWNER[folder] ?? folder;
const SPECIFIER = /(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+[^"']*?\s+from\s+|import\s*\(\s*)["']([^"'`]+)["']/g;

const specifiers = (file) =>
  [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((m) => m[1]);
const jsFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
const folders = (dir) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory());
const filesRecursive = (dir) => readdirSync(dir).flatMap((entry) => {
  const file = join(dir, entry);
  if (statSync(file).isDirectory()) return filesRecursive(file);
  return entry.endsWith(".js") ? [file] : [];
});

/** Classify a relative specifier from a file in lib/<folder>/ or lib/. */
function publicNameOf(spec) {
  const m = /^\.\.?\/([a-z-]+)\.js$/.exec(spec);
  return m ? m[1] : null;
}

describe("module layout: public façades own private folders", () => {
  test("every lib/<folder>/ (except providers/) has a public façade (several folders may share one)", () => {
    for (const folder of folders("lib")) {
      if (folder === "providers") continue;
      const owner = ownerOf(folder);
      expect(existsSync(join("lib", `${owner}.js`)), `lib/${folder}/ has no façade`).toBe(true);
      expect(PUBLIC, `lib/${folder} is not a ranked public module`).toContain(owner);
    }
  });

  test("the top-level modules are exactly the ranked chain, foundations, and core/full index barrels", () => {
    const names = jsFiles("lib").map((f) => f.slice(4, -3)).sort();
    expect(names).toEqual([...PUBLIC, ...FOUNDATIONS, "index", "index_app"].sort());
  });

  test("cross-cutting foundations are dependency-free leaves", () => {
    for (const name of FOUNDATIONS) {
      expect(specifiers(join("lib", `${name}.js`)), `lib/${name}.js imports`).toEqual([]);
    }
    // the tool-runtime leaf is exactly what tools may import WITHOUT
    // the library: it must never grow a dependency a worker pays for
    const runtime = readFileSync("lib/tool-runtime.js", "utf8");
    expect(runtime).not.toMatch(/\.\/env\//);
  });

  test("the namespace derives every migratable runtime name in one place", () => {
    // lib/namespace.js keeps NAMESPACE and PREFIX INTERNAL consts; NAMES
    // carries every public variation (Namespace/NAMESPACE/namespace from
    // NAMESPACE, Pr/pr/PR from PREFIX). Namespaces-facing env vars,
    // settings home and agent-facing names derive from NAMESPACE; the
    // project-file names (ai-settings.json, ai-*, sessions) are STABLE
    // literals so a rename never orphans user state; cliPrefix derives
    // derive from PREFIX.
    const source = readFileSync("lib/namespace.js", "utf8");
    expect(source).not.toContain("export const NAMESPACE");
    expect(source).not.toContain("export const PREFIX");
    const lower = NAMES.namespace;
    const upper = NAMES.NAMESPACE;
    expect(NAMES.Namespace.toLowerCase()).toBe(lower);
    expect(NAMES.Namespace.toUpperCase()).toBe(upper);
    const prefix = NAMES.pr;
    expect(NAMES.PR).toBe(prefix.toUpperCase());
    expect(NAMES).toMatchObject({
      Namespace: NAMES.Namespace,
      NAMESPACE: upper,
      namespace: lower,
      settingsEnv: `${upper}_SETTINGS_DIR`, skillsEnv: `${upper}_SKILLS_DIR`,
      promptsEnv: `${upper}_PROMPTS_DIR`,
      osSandboxEnv: `${upper}_OS_SANDBOX`, toolWorkerEnv: `${upper}_TOOL_WORKER`,
      testScriptEnv: `${upper}_TEST_SCRIPT`, settingsHome: `.${lower}-settings`,
      realAgentSymbol: `${lower}.realAgent`, agentName: `${lower}-agent`,
      cliPrefix: prefix,
    });
    expect(NAMES.tuiAlias).toBeUndefined(); // a rename-only wrapper concern, not a runtime name
    expect(NAMES.toolsEnv).toBeUndefined();
  });

});

describe("linear ownership: dependencies only point DOWN the chain", () => {
  test("a public module imports only its own privates and LOWER public modules", () => {
    const offenders = [];
    for (const name of PUBLIC) {
      const owned = [name, ...Object.keys(FOLDER_OWNER).filter((f) => FOLDER_OWNER[f] === name)];
      for (const spec of specifiers(join("lib", `${name}.js`))) {
        if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
        if (owned.some((f) => spec.startsWith(`./${f}/`))) continue; // own privates
        if (spec === "./namespace.js") continue; // dependency-free cross-cutting foundation
        const target = publicNameOf(spec);
        if (target !== null && spec.startsWith("./") && RANK[target] < RANK[name]) continue;
        offenders.push(`lib/${name}.js -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a private module imports only same-owner privates and LOWER public modules (never its own façade, never another module's privates)", () => {
    const offenders = [];
    for (const folder of folders("lib")) {
      if (folder === "providers") continue;
      const owner = ownerOf(folder);
      const rank = RANK[owner];
      for (const file of jsFiles(join("lib", folder))) {
        for (const spec of specifiers(file)) {
          if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
          if (spec === "marked" && file === join("lib", "markdown", "marked.js")) continue; // the one approved optional dependency (test/cli-nodeps.test.js)
          if (/^\.\/[a-z-]+\.js$/.test(spec)) continue; // sibling private (same folder)
          if (/^\.\/[a-z-]+\/[a-z-]+\.js$/.test(spec)) continue; // nested private owned by the same folder
          if (FOUNDATIONS.some((f) => spec === `../${f}.js`)) continue; // dependency-free cross-cutting foundations
          const crossFolder = /^\.\.\/([a-z-]+)\/[a-z-]+\.js$/.exec(spec);
          if (crossFolder && ownerOf(crossFolder[1]) === owner) continue; // another folder of the SAME façade
          const target = publicNameOf(spec);
          if (target !== null && spec.startsWith("../") && RANK[target] < rank) continue;
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the static library/provider/tool module graph is acyclic", () => {
    const modules = ["lib", "providers", "tools"].flatMap(filesRecursive).filter((file) => file.endsWith(".js"));
    const known = new Set(modules);
    const edges = new Map(modules.map((file) => [file, specifiers(file)
      .filter((spec) => spec.startsWith("."))
      .map((spec) => {
        const target = join(dirname(file), spec);
        return target.endsWith(".js") ? target : `${target}.js`;
      })
      .filter((target) => known.has(target))]));
    const state = new Map();
    const stack = [];
    const cycles = [];
    const visit = (file) => {
      state.set(file, 1);
      stack.push(file);
      for (const target of edges.get(file)) {
        if (state.get(target) === 1) cycles.push([...stack.slice(stack.indexOf(target)), target].join(" -> "));
        else if (state.get(target) !== 2) visit(target);
      }
      stack.pop();
      state.set(file, 2);
    };
    for (const file of modules) if (!state.has(file)) visit(file);
    expect(cycles).toEqual([]);
  });

  test("recursive: lib/gtui/** (including nested folders, e.g. widgets/) imports only node:/bun and its own files — never escapes lib/gtui/", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith(".js")) continue;
        for (const spec of specifiers(full)) {
          if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
          if (!spec.startsWith(".")) { offenders.push(`${full} -> ${spec} (non-relative import)`); continue; }
          const resolved = join(dirname(full), spec);
          if (!resolved.startsWith(join("lib", "gtui") + "/") && resolved !== join("lib", "gtui")) {
            offenders.push(`${full} -> ${spec}`);
          }
        }
      }
    };
    walk(join("lib", "gtui"));
    expect(offenders).toEqual([]);
  });

  test("recursive: lib/tui-app/** imports only lib/gtui/gtui.js (never a gtui private), lower-ranked public modules, and its own files", () => {
    const offenders = [];
    const gtuiFacade = join("lib", "gtui", "gtui.js");
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith(".js")) continue;
        for (const spec of specifiers(full)) {
          if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
          if (!spec.startsWith(".")) { offenders.push(`${full} -> ${spec} (non-relative import)`); continue; }
          const resolved = join(dirname(full), spec);
          if (resolved.startsWith(join("lib", "tui-app") + "/")) continue; // own file
          if (resolved === join("lib", "namespace.js")) continue; // cross-cutting foundation
          if (resolved === gtuiFacade) continue; // the gtui FAÇADE only
          const m = /^lib\/([a-z-]+)\.js$/.exec(resolved);
          if (m && RANK[m[1]] !== undefined && RANK[m[1]] < RANK.tui) continue; // a lower public module
          offenders.push(`${full} -> ${spec}`);
        }
      }
    };
    walk(join("lib", "tui-app"));
    expect(offenders).toEqual([]);
  });

  test("providers are plugins over the public context/env/io surfaces only", () => {
    const offenders = [];
    for (const file of jsFiles("providers")) {
      for (const spec of specifiers(file)) {
        if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
        const target = publicNameOf(spec);
        const rootHelper = /^\.\.\/lib\/(context|env|io|namespace)\.js$/.test(spec);
        if ((target !== null && spec.startsWith("../") && RANK[target] <= RANK.io) || rootHelper) continue;
        offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("executables import public modules only (never lib/<module>/ privates)", () => {
    const offenders = [];
    // ai-tools are development instrumentation: they may inspect private
    // implementation seams. Published bin executables remain façade-only.
    const executables = readdirSync("bin")
      .filter((name) => statSync(join("bin", name)).isFile())
      .map((name) => join("bin", name));
    for (const exe of executables) {
      for (const spec of specifiers(exe)) {
        if (/lib\/[a-z-]+\/[a-z-]+\.js/.test(spec)) offenders.push(`${exe} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every top-level package tool imports lib through a default public façade only", () => {
    const offenders = [];
    for (const tool of jsFiles("tools")) {
      const source = readFileSync(tool, "utf8");
      for (const spec of specifiers(tool)) {
        if (!spec.startsWith("../lib/")) continue;
        const facade = /^\.\.\/lib\/([a-z-]+)\.js$/.exec(spec)?.[1];
        if (FOUNDATIONS.includes(facade)) continue;
        const defaultImport = new RegExp(`import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+["\']${spec}["\']`).test(source);
        if (!facade || !PUBLIC.includes(facade) || !defaultImport) offenders.push(`${tool} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("each façade publishes its canonical namespace and Agent/application entries assemble explicit variants", async () => {
    const expected = { markdown: "Markdown", context: "Context", env: "Env", io: "IO", agent: "Agent", cli: "CLI", jobs: "Jobs", tui: "TUI", web: "Web" };
    for (const [file, name] of Object.entries(expected)) {
      const module = await import(`../lib/${file}.js`);
      expect(module.default?.name, `lib/${file}.js default namespace`).toBe(name);
    }
    const source = readFileSync("lib/index.js", "utf8");
    expect(source).toContain('import Agent from "./agent.js";');
    expect(source).toContain('import Jobs from "./jobs.js";');
    expect(source).toContain("export default { ...Agent, Agent, Jobs };");
    expect(source).not.toContain('"./tui.js"');
    const fullSource = readFileSync("lib/index_app.js", "utf8");
    expect(fullSource).toContain('import Core from "./index.js";');
    expect(fullSource).toContain('import Markdown from "./markdown.js";');
    expect(fullSource).toContain('import CLI from "./cli.js";');
    expect(fullSource).not.toContain('import Jobs from "./jobs.js";');
    expect(fullSource).toContain('"./tui.js"');
    expect(fullSource).toContain("const GTUI = TUI.GTUI;");
    expect(fullSource).toContain("export default { ...Core, Markdown, CLI, TUI, GTUI, Web };");
    expect(fullSource).not.toMatch(/^export (const|let|var|class|function) /m);
    expect(fullSource).not.toMatch(/export \{/);
    expect(fullSource).not.toMatch(new RegExp(`\\b${NAMES.Namespace}\\b`));
    // Both entry points export exactly one default; Agent owns the core
    // tree, while the full default is a fresh application superset that never
    // leaks application concerns into the core module object.
    const core = await import("../lib/index.js");
    const full = await import("../lib/index_app.js");
    expect(Object.keys(core)).toEqual(["default"]);
    expect(Object.keys(full)).toEqual(["default"]);
    expect(full.default).not.toBe(core.default);
    expect(full.default.Env).toBe(core.default.Env);
    expect(full.default.Agent).toBe(core.default.Agent);
    expect(core.default.Jobs).toBe((await import("../lib/jobs.js")).default);
    expect(full.default.Jobs).toBe(core.default.Jobs);
    expect(full.default.GTUI).toBe(full.default.TUI.GTUI);
    expect(full.default.Web).toBe((await import("../lib/web.js")).default);
    expect(core.default.TUI).toBeUndefined();
    expect(core.default.GTUI).toBeUndefined();
    expect(core.default.Web).toBeUndefined();
    expect(core.default.NAMES).toBe(NAMES);
  });

  test("internal cross-façade dependencies import the canonical default namespace", () => {
    const offenders = [];
    for (const folder of folders("lib")) {
      for (const file of jsFiles(join("lib", folder))) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\.\/([a-z-]+)\.js["']/g)) {
          if (PUBLIC.includes(match[1])) offenders.push(`${file} -> ../${match[1]}.js`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
