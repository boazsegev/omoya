/**
 * lib/env/tools.js — tool-folder scanning (private to Env).
 *
 * The scan is NOT recursive: only a root's TOP-LEVEL .js files are
 * tool modules. Sub-folders are private to the tools — a well-designed
 * tool is a thin wrapper (tools/read.js) whose helpers/libraries live
 * beside it (tools/read/grep.js, tools/read/mime-map.js, ...) and are
 * never imported or published by the scan.
 *
 * Module contract: a module's toolDescription(env) — or describe(env)
 * when toolDescription is undefined (the fallback name) — returns an
 * object keyed
 * by exported function name, each value an MCP-like {description,
 * inputSchema} (plus optional harness metadata: safe/trusted/
 * sandbox/onTimeout/secret/fn — never published). `onTimeout` is an
 * Agent-facing callback, not a model-facing schema member. `secret:
 * true` hides the tool from the PUBLISHED catalog (never sent to the
 * model) while it stays callable directly (bin/scripts/tool, the TUI's
 * `/<tool>` and Tools menu). A described function is normally
 * published only when the module exports a callable of that name;
 * an entry may instead carry its own `fn` (a closure built at scan
 * time) for names that have no static export — the env-dependent
 * shortcut tools tools/mcp.js builds per configured server
 * (`mcp-<name>`). The scan-time `env` argument lets a module read
 * live settings (e.g. settings.mcp) to decide which such entries to
 * contribute; it is REBUILT on every refresh, so settings edits take
 * effect on the next tool-refresh. Modules without any of the three
 * functions are omitted from the catalog (their import side effects
 * still run). Duplicate names are diagnosed (throw), never resolved
 * arbitrarily.
 *
 * Every scan imports modules with a cache-busting `?v=<revision>`
 * (bumped on every refresh), so wrappers re-run and re-import their
 * helpers (stamped with Env.toolTimestamp()). Bun IGNORES query
 * strings on file:// URL imports — plain absolute paths only.
 *
 * A module may also export `settingsSchema()` (zero-arg, sync, same
 * scan cadence as toolDescription): `{ [settingKey]: {default,
 * description} }`, merged into the DEFAULTS SCHEMA (see
 * lib/env/settings-schema.js, env.defaultsSchema()) — a tool's own
 * self-documentation for the setting(s) it reads (tools/mcp.js
 * contributes `mcp` this way). Purely discovery metadata: an unknown
 * settings key is never rejected either way.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPlainObject } from "./settings.js";
import { folderIdentity } from "./paths.js";

/**
 * The shared tool-refresh revision (module-level: import caching is
 * per-process). Bumped before every scan; read by tool wrappers
 * through Env.toolTimestamp().
 */
let toolRevision = 0;

/** @returns {number} the current refresh revision */
export function currentRevision() {
  return toolRevision;
}

/** Bump the shared refresh revision (once per refresh). @returns {number} */
export function bumpRevision() {
  toolRevision += 1;
  return toolRevision;
}

const TOOL_SKIP_TOKENS = new Set(["bench", "benchmark", "test", "tests", "spec", "smoke", "fixture", "fixtures", "example", "examples", "demo"]);

/**
 * Publish the current revision for tool modules: they stamp helper
 * imports with toolRevision() (lib/tool-runtime.js — the
 * dependency-free leaf) instead of importing the whole Env for it.
 */
function publishRevision() {
  globalThis.__AiEnvToolRevision = currentRevision();
}

/**
 * Tool-module filename filter: files named like benches, tests, or
 * demos are NEVER imported by the tool scan. Importing a module runs
 * its top level — a bench/test script executes its suite on import,
 * printing results AND retaining its datasets in the module cache for
 * the process's lifetime (observed: ai at ~30x baseline memory
 * from benchmark modules under a host tools dir). Tokens split on any
 * non-alphanumeric, so "contest.js" or "latest.js" are unaffected.
 * @param {string} name - file name
 * @returns {boolean}
 */
export function isToolModuleFile(name) {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/);
  return !tokens.some((t) => TOOL_SKIP_TOKENS.has(t));
}

/**
 * Import one tool module with its stdout CAPTURED. The scan imports
 * user modules into the HOST process, and a script-shaped module (no
 * import.meta.main guard) runs its main() at import — its output
 * would otherwise spew onto the TUI's screen (or into the headless
 * connector's stdout protocol channel). Import-time printing is
 * ALWAYS a bug (the scan owns no output channel), so the bytes are
 * discarded and reported once on stderr with the convention's fix.
 * Bun's console.log bypasses a process.stdout.write override — both
 * are captured; stderr stays untouched (the diagnostics channel).
 * Imports run sequentially here, so the overrides never overlap.
 */
async function importToolModule(file) {
  const write = process.stdout.write.bind(process.stdout);
  const { log, info } = console;
  let captured = 0;
  process.stdout.write = (chunk, ...rest) => {
    captured += String(chunk).length;
    rest.find((a) => typeof a === "function")?.(); // never block on a stream nobody reads
    return true;
  };
  console.log = (...args) => { captured += args.join(" ").length + 1; };
  console.info = console.log;
  try {
    return await import(file);
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.info = info;
    if (captured > 0) {
      process.stderr.write(
        `Env: tool module ${file} printed ${captured} bytes at import — suppressed ` +
        `(a tool module never prints at import; guard script output behind import.meta.main)\n`,
      );
    }
  }
}

/**
 * Scan tool roots into a flattened name -> { fn, schema, file, safe? }
 * map, plus every module's contributed settings-schema entries.
 * @param {string[]} roots
 * @param {object} [env] - the owning Env (handed to toolDescription(env)
 *   so a module can contribute settings-dependent entries; omitted for
 *   callers that have none, e.g. before construction completes)
 * @param {{trustedRoots?: string[]}} [options] - roots authorized to honor schema trusted:true
 * @returns {Promise<{tools: Map<string, {fn: Function, schema: object, file: string, safe?: true, trusted?: true}>, settingsSchema: Object}>}
 */
export async function scanToolRoots(roots, env, { trustedRoots = [] } = {}) {
  publishRevision();
  const found = new Map();
  const settingsSchema = {};
  const trustedRootIds = new Set(trustedRoots.map(folderIdentity));
  const publish = (name, fn, schema, file, allowTrusted) => {
    if (found.has(name)) {
      throw new Error(
        `Env: duplicate tool name "${name}" (${found.get(name).file} vs ${file})`,
      );
    }
    // `safe: true` marks a tool read-only, `trusted: true` is honored
    // only from a trusted root, and `sandbox: true` opts it into the OS
    // write sandbox,
    // `secret: true` hides it from the published (model-facing) catalog
    // while it stays directly callable, and `onTimeout` is the
    // Agent-facing cleanup/final-response hook (the same derivations
    // registerTool applies)
    if (schema?.onTimeout !== undefined && typeof schema.onTimeout !== "function") {
      throw new TypeError(`Env: ${file} tool "${name}" onTimeout must be a function`);
    }
    if (schema?.detect !== undefined && typeof schema.detect !== "function") {
      throw new TypeError(`Env: ${file} tool "${name}" detect must be a function`);
    }
    if (schema?.available !== undefined && typeof schema.available !== "function") {
      throw new TypeError(`Env: ${file} tool "${name}" available must be a function`);
    }
    found.set(name, {
      fn, schema, file,
      ...(typeof schema?.available === "function" ? { available: schema.available, eligible: false } : {}),
      ...(schema?.safe === true ? { safe: true } : {}),
      ...(allowTrusted && schema?.trusted === true ? { trusted: true } : {}),
      ...(schema?.sandbox === true ? { sandbox: true } : {}),
      ...(schema?.secret === true ? { secret: true } : {}),
      ...(typeof schema?.storage === "string" ? { storage: schema.storage } : {}),
      ...(typeof schema?.onTimeout === "function" ? { onTimeout: schema.onTimeout } : {}),
      ...(typeof schema?.detect === "function" ? { detect: schema.detect } : {}),
    });
  };
  for (const root of roots) {
    const allowTrusted = trustedRootIds.has(folderIdentity(root));
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable root scans as empty
    }
    // TOP-LEVEL files only — the scan is NOT recursive: a sub-folder
    // holds a tool's private helpers, never tools themselves.
    const modules = entries
      .filter((e) => e.isFile() && e.name.endsWith(".js") && isToolModuleFile(e.name))
      .map((e) => join(root, e.name))
      .sort();
    for (const file of modules) {
      // cache-bust with a plain absolute path + the shared revision;
      // import-time stdout is captured (a script-shaped module's
      // top-level output never reaches the host's screen)
      const mod = await importToolModule(resolve(file) + `?v=${toolRevision}`);
      if (typeof mod.settingsSchema === "function") {
        const contributed = mod.settingsSchema();
        if (!isPlainObject(contributed)) {
          throw new TypeError(`Env: ${file} settingsSchema() must return an object`);
        }
        Object.assign(settingsSchema, contributed);
      }
      // toolDescription() wins; describe() is the fallback when it is
      // undefined
      const describe = typeof mod.toolDescription === "function" ? mod.toolDescription
        : typeof mod.describe === "function" ? mod.describe
        : null;
      if (describe === null) continue; // side-effect module
      const described = describe(env);
      if (!isPlainObject(described)) {
        throw new TypeError(`Env: ${file} toolDescription() must return an object`);
      }
      for (const [fname, schema] of Object.entries(described)) {
        // an entry may carry its own `fn` (built at scan time, for a
        // name with no static export — see the module contract above)
        const fn = typeof schema?.fn === "function" ? schema.fn : mod[fname];
        if (typeof fn !== "function") continue; // described but not exported
        publish(fname, fn, schema, file, allowTrusted);
      }
    }
  }
  return { tools: found, settingsSchema };
}
