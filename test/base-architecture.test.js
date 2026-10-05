// test/base-architecture.test.js — proof for the module layout and its
// LINEAR OWNERSHIP rule (user-directed 2026-09-04):
//
//   public modules live at lib/<name>.js; each may own a PRIVATE folder
//   lib/<name>/ nobody else imports; dependencies point strictly DOWN
//   the chain context < env < io < agent < cli < jobs < app (an
//   owner is never owned by what it owns); providers are Env plugins importing only Context;
//   executables touch public modules only.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { NAMES } from "../lib/namespace.js";

// Jobs owns headless execution and uses CLI's public model selection contract.
const RANK = { sandbox: 0, context: 1, env: 2, io: 3, agent: 4, cli: 5, jobs: 6, app: 7 };
const PUBLIC = Object.keys(RANK);
const FOUNDATIONS = ["namespace", "tool-runtime", "util"];
/** The app façade owns lib/app/, whose areas get their own stricter
 *  recursive rules below: lib/app.js -> lib/app/{tui,web} -> lib/app/gtui/gtui.js
 *  (tui only) -> gtui privates, one direction only; lib/app/markdown/ and
 *  lib/app/shared/ are browser-safe leaves both front ends use. */
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
      const owner = folder;
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
      const owned = [name];
      for (const spec of specifiers(join("lib", `${name}.js`))) {
        if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
        if (owned.some((f) => spec.startsWith(`./${f}/`))) continue; // own privates
        if (FOUNDATIONS.some((f) => spec === `./${f}.js`)) continue; // dependency-free cross-cutting foundations
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
      const owner = folder;
      const rank = RANK[owner];
      for (const file of jsFiles(join("lib", folder))) {
        for (const spec of specifiers(file)) {
          if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
          if (/^\.\/[a-z-]+\.js$/.test(spec)) continue; // sibling private (same folder)
          if (/^\.\/[a-z-]+\/[a-z-]+\.js$/.test(spec)) continue; // nested private owned by the same folder
          if (FOUNDATIONS.some((f) => spec === `../${f}.js`)) continue; // dependency-free cross-cutting foundations
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

  // lib/app/ areas, walked recursively. Each imports its own files plus
  // exactly what its row allows: GTUI stays generic (never escapes its
  // folder), shared stays a browser-safe leaf (no node:/bun either — the
  // web server serves it to the SPA), TUI reaches GTUI only through its
  // façade, and TUI/Web never import each other.
  const MARKDOWN = join("lib", "app", "markdown", "index.js");
  const SHARED = join("lib", "app", "shared") + "/";
  const APP_AREAS = {
    gtui: { runtime: true, lower: false, allow: [] },
    // the one approved optional dependency: marked.js's guarded import (test/cli-nodeps.test.js)
    markdown: { runtime: false, lower: false, allow: [], packages: ["marked"] },
    shared: { runtime: false, lower: false, allow: [] },
    tui: { runtime: true, lower: true, allow: [join("lib", "app", "gtui", "gtui.js"), MARKDOWN, SHARED] },
    // public/text-safe.js re-exports the Markdown display sanitizer for the SPA
    web: { runtime: true, lower: true, allow: [MARKDOWN, SHARED, join("lib", "app", "markdown", "browser.js"), join("lib", "app", "markdown", "text-safe.js")] },
  };
  test("every lib/app/ folder is a ruled area", () => {
    expect(folders(join("lib", "app")).filter((folder) => !(folder in APP_AREAS))).toEqual([]);
  });
  for (const [area, rule] of Object.entries(APP_AREAS)) {
    test(`recursive: lib/app/${area}/** imports only its own files and what its area rule allows`, () => {
      const root = join("lib", "app", area);
      if (!existsSync(root)) return;
      const offenders = [];
      for (const file of filesRecursive(root)) {
        for (const spec of specifiers(file)) {
          if (spec.startsWith("node:") || spec.startsWith("bun")) {
            if (!rule.runtime) offenders.push(`${file} -> ${spec} (runtime import in a browser-safe area)`);
            continue;
          }
          if (rule.packages?.includes(spec)) continue;
          if (!spec.startsWith(".")) { offenders.push(`${file} -> ${spec} (non-relative import)`); continue; }
          const resolved = join(dirname(file), spec);
          if (resolved.startsWith(root + "/")) continue; // own file
          if (rule.allow.some((allowed) => allowed.endsWith("/") ? resolved.startsWith(allowed) : resolved === allowed)) continue;
          if (rule.lower) {
            if (FOUNDATIONS.some((f) => resolved === join("lib", `${f}.js`))) continue; // cross-cutting foundation
            const m = /^lib\/([a-z-]+)\.js$/.exec(resolved);
            if (m && RANK[m[1]] !== undefined && RANK[m[1]] < RANK.app) continue; // a lower public module
          }
          offenders.push(`${file} -> ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test("providers import only Context (plus the namespace foundation) or another bundled provider's dialect", () => {
    const offenders = [];
    for (const file of jsFiles("providers")) {
      for (const spec of specifiers(file)) {
        if (spec.startsWith("node:")) continue;
        if (spec === "../lib/context.js" || spec === "../lib/namespace.js") continue;
        if (file === "providers/claude.js" && spec === "./anthropic.js") continue;
        offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("Env's internals never leak: no private fields, endpoint-keyed reads, or removed statics outside lib/env", () => {
    // Env publishes settings, folders, models/connection, login, tools,
    // skills/prompts and events; everything else is its own business.
    const LEAKS = [
      /\benv\._[A-Za-z]/, // private state
      /\benv\.endpoint/, // endpoint-keyed members (the pair is the published unit)
      /\benv\.providers\b/, // the provider registry
      /\bsafeEnv\b/, // safe mode is the caller's argument
      /\bEnv\.(http|provider|thinking|mcp|osSandbox)/, // statics that moved off Env
    ];
    const roots = ["lib", "tools", "bin", "providers"];
    const walk = (dir) => readdirSync(dir).flatMap((entry) => {
      const file = join(dir, entry);
      return statSync(file).isDirectory() ? walk(file) : [file];
    });
    const files = roots.flatMap((root) => walk(root))
      .filter((file) => !file.startsWith(join("lib", "env") + "/") && file !== join("lib", "env.js"))
      .filter((file) => file.endsWith(".js") || (file.startsWith("bin/") && !/\.[a-z]+$/.test(file)));
    const offenders = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const pattern of LEAKS) if (pattern.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // Browser SPA layering (web client option B): leaves < state/logic < views
  // < orchestrators < app.js root. Views meet only in app.js's intent table.
  test("web client: views, orchestrators, and transport import only downward", () => {
    const root = join("lib", "app", "web", "public");
    const app = join(root, "app") + "/";
    const views = join(app, "views") + "/";
    const orchestrators = join(app, "orchestrators") + "/";
    const logic = join(app, "logic") + "/";
    const offenders = [];
    for (const file of filesRecursive(root).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(file, "utf8");
      if (/\bactions\.[A-Za-z]|new Proxy\(/.test(source)) offenders.push(`${file}: late-bound registry or Proxy`);
      for (const spec of specifiers(file).filter((s) => s.startsWith("."))) {
        const target = join(dirname(file), spec);
        const ownView = file.startsWith(views) ? file.slice(0, views.length) + file.slice(views.length).split("/")[0] + "/" : null;
        const bad =
          (target.startsWith(views) && file !== join(root, "app.js") && !(ownView && target.startsWith(ownView))) ||
          (ownView && (target.startsWith(orchestrators) || /app\/(wire|render|dispatch)\.js$/.test(target))) ||
          (file.startsWith(orchestrators) && (/app\/wire\.js$/.test(target) ||
            (target.startsWith(orchestrators) && !/turn/.test(file) ))) ||
          (file.startsWith(logic) && (target.startsWith(views) || target.startsWith(orchestrators) || /app\/(state|wire|render)\.js$/.test(target))) ||
          (file === join(app, "wire.js"));
        if (bad) offenders.push(`${file} -> ${spec}`);
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
    const expected = { sandbox: "Sandbox", context: "Context", env: "Env", io: "IO", agent: "Agent", cli: "CLI", jobs: "Jobs", app: "App" };
    for (const [file, name] of Object.entries(expected)) {
      const module = await import(`../lib/${file}.js`);
      expect(module.default?.name, `lib/${file}.js default namespace`).toBe(name);
    }
    const source = readFileSync("lib/index.js", "utf8");
    expect(source).toContain('import Agent from "./agent.js";');
    expect(source).toContain('import Jobs from "./jobs.js";');
    expect(source).not.toContain("...Agent");
    expect(source).toContain("Context: Agent.Context");
    expect(source).not.toContain('"./app.js"');
    const fullSource = readFileSync("lib/index_app.js", "utf8");
    expect(fullSource).toContain('import Core from "./index.js";');
    expect(fullSource).toContain('import CLI from "./cli.js";');
    expect(fullSource).not.toContain('import Jobs from "./jobs.js";');
    expect(fullSource).toContain('import App from "./app.js";');
    expect(fullSource).toContain("export default { ...Core, CLI, App };");
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
    const App = (await import("../lib/app.js")).default;
    expect(full.default.App).toBe(App);
    expect(Object.keys(App).sort()).toEqual(["GTUI", "Markdown", "TUI", "Web"]);
    expect(App.GTUI).toBe((await import("../lib/app/gtui/gtui.js")).GTUI);
    for (const name of ["Markdown", "TUI", "GTUI", "Web"]) expect(full.default[name], `no top-level ${name}`).toBeUndefined();
    expect(core.default.App).toBeUndefined();
    expect(core.default.NAMES).toBe(NAMES);
    expect(Object.keys(core.default).some((name) => name.startsWith("_"))).toBe(false);
    expect(full.default.Env._loadThemes).toBeUndefined();
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
