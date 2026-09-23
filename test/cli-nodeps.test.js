// test/cli-nodeps.test.js — proof that the project is a standalone,
// zero-dependency source tree: its package manifest declares no dependencies,
// no symlink escapes, and
// every static code dependency resolves inside this folder (except
// runtime builtins and the guarded OPTIONAL `marked` enhancement).
// Every namespace/executable expectation derives from the canonical
// modules — rename-safe.
import { describe, expect, test } from "bun:test";
import {
  existsSync, lstatSync, readdirSync, readFileSync, statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NAMES } from "../lib/namespace.js";
import { wrapperNames } from "../bin/scripts/index.js";

const ROOT = resolve(".");
const SKIP_TREE = new Set([".git", "ai-tmp"]); // generated/ignored state is not source

/** Every tree entry, recursively, excluding generated/ignored state. */
function entries(dir = ".") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_TREE.has(entry)) continue;
    const file = join(dir, entry);
    out.push(file);
    if (lstatSync(file).isDirectory()) out.push(...entries(file));
  }
  return out;
}

/** All .js files under dir (recursive). */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) out.push(...sources(file));
    else if (entry.endsWith(".js")) out.push(file);
  }
  return out;
}

/** Every bin file (recursive): generated shims AND the scripts/
 *  implementations — extensionless executables and .js helpers alike. */
function binFiles(dir = "bin") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) out.push(...binFiles(file));
    else if (entry !== ".DS_Store") out.push(file);
  }
  return out;
}

const FILE_URL = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
const transpiler = new Bun.Transpiler({ loader: "js" });

function matches(file, pattern) {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

/** Bun parses actual module syntax, avoiding quoted fixture/source examples. */
function specifiers(file) {
  return transpiler.scan(readFileSync(file, "utf8")).imports.map((entry) => entry.path);
}

const RUNTIME_DIRS = ["lib", "tools", "providers"];
const CODE_DIRS = [...RUNTIME_DIRS, "ai-tools", "test"];
// bin holds generated shims PLUS the scripts/ implementation folder —
// walk it so both are scanned (executables have no .js extension)
const BINS = binFiles();
const RUNTIME_SURFACES = [...RUNTIME_DIRS.flatMap(sources), ...BINS];
const SURFACES = [...CODE_DIRS.flatMap(sources), ...BINS];
const SOURCE_TREE = entries();

function insideRoot(file) {
  const rel = relative(ROOT, resolve(file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("standalone source tree (zero required external dependencies)", () => {
  test("the root package manifest declares no dependencies and no source symlink exists", () => {
    const manifests = SOURCE_TREE.filter((file) => basename(file) === "package.json");
    expect(manifests).toEqual(["package.json"]);
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    // the package name follows the namespace (the rename script syncs it)
    expect(manifest.name).toBe(NAMES.namespace);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies ?? {}).toEqual({});
    expect(SOURCE_TREE.filter((file) => lstatSync(file).isSymbolicLink())).toEqual([]);
  });

  test("imports use runtime builtins, internal relative files, or guarded optional marked", () => {
    const offenders = [];
    for (const file of SURFACES) {
      for (const spec of specifiers(file)) {
        if (spec.startsWith("node:") || spec === "bun:test" || spec === "bun:ffi" || spec === "bun:jsc") continue;
        if (spec === "marked") continue; // optional everywhere; runtime guard proven below
        if (!spec.startsWith(".")) { offenders.push(`${file}: external ${spec}`); continue; }
        const target = resolve(dirname(file), spec.split("?")[0]);
        if (!insideRoot(target) || !existsSync(target)) offenders.push(`${file}: ${spec} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("import.meta.url file roots resolve inside this project", () => {
    const offenders = [];
    for (const file of SURFACES) {
      for (const spec of matches(file, FILE_URL)) {
        const target = resolve(dirname(file), spec);
        if (!insideRoot(target) || !existsSync(target)) offenders.push(`${file}: ${spec} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("source contains no machine-absolute or sibling-project references", () => {
    const offenders = [];
    for (const file of RUNTIME_SURFACES) {
      const text = readFileSync(file, "utf8");
      if (/\/Users\/|Mobile Documents|Dev\/system\/scripts/.test(text)) offenders.push(`${file}: absolute machine path`);
      // a bin/ SHIM's "./scripts/<name>" forward is generated, not a
      // sibling-project escape — strip that one specifier before the scan
      const stripped = text.replace(/"\.\/scripts\/[a-z0-9-]+"/gi, "");
      if (/\.\.\/(?:core|scripts)(?:\/|\b)/.test(stripped)) offenders.push(`${file}: sibling project path`);
    }
    expect(offenders).toEqual([]);
  });

  test("the optional marked enhancement is guarded and the scan covers every executable", () => {
    const text = readFileSync(join("lib", "markdown", "marked.js"), "utf8");
    expect(text).toMatch(/try\s*\{[^}]*import\(\s*["']marked["']\s*\)/s);
    // every wrapper the canonical wrapperMap derives must be on disk
    for (const bin of wrapperNames()) {
      expect(SURFACES).toContain(join("bin", bin));
    }
    for (const impl of ["app", "agent", "io", "jobs", "tool", "skills", "tools2bash", "help.js", "index.js", "rename"]) {
      expect(SURFACES).toContain(join("bin", "scripts", impl));
    }
    expect(SURFACES).toContain(join("lib", "tui-app", "app.js"));
    expect(SURFACES.length).toBeGreaterThan(100);
  });
});
