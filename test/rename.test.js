// test/rename.test.js — contract proof for bin/scripts/rename. Every run
// happens inside a THROWAWAY sandbox (a minimal copy of the tree the tool
// touches, under the gitignored ai-tmp) — the real project tree is never
// mutated. Expectations assert the CONTRACT (the tool rewires its inputs,
// regenerates a coherent wrapper set, mirrors it in package.json, and
// refuses invalid input without touching anything), never the project's
// current names — a rename of this repo must not break this suite.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** A fresh sandbox: the two switches, the wrapper machinery, the entry
 * points the tool guards, package.json, and the current generated wrappers.
 * Copying the wrappers avoids a preparatory rename: the sole test run below
 * is the only renamer process launched by the entire suite. */
function sandbox() {
  const dir = mkdtempSync(join(ROOT, "ai-tmp", "rename-test-"));
  cpSync(join(ROOT, "lib", "namespace.js"), join(dir, "lib", "namespace.js"), { recursive: true });
  cpSync(join(ROOT, "lib", "index.js"), join(dir, "lib", "index.js"));
  cpSync(join(ROOT, "lib", "index_app.js"), join(dir, "lib", "index_app.js"));
  cpSync(join(ROOT, "bin", "scripts"), join(dir, "bin", "scripts"), { recursive: true });
  for (const name of readdirSync(join(ROOT, "bin"))) {
    if (statSync(join(ROOT, "bin", name)).isFile()) cpSync(join(ROOT, "bin", name), join(dir, "bin", name));
  }
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  return dir;
}

// the SANDBOX's own copy of the tool runs — the tool resolves its tree
// from its own location, so invoking the real one would mutate the repo
const run = (cwd, ...args) =>
  Bun.spawnSync(["bun", join(cwd, "bin", "scripts", "rename"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });

const binFiles = (dir) =>
  readdirSync(join(dir, "bin")).filter((name) => statSync(join(dir, "bin", name)).isFile()).sort();
const namespace = (dir) => /NAMESPACE = "([^"]*)"/.exec(readFileSync(join(dir, "lib", "namespace.js"), "utf8"))[1];
const prefix = (dir) => /PREFIX = "([^"]*)"/.exec(readFileSync(join(dir, "lib", "namespace.js"), "utf8"))[1];
const pkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// the canonical wrapper set: NAMES read from the SANDBOX's namespace.js
// (it changes on every run), wrapperMap called with those values as
// arguments (a plain import of index.js would resolve NAMES from the
// module cache — possibly this repo's own)
async function wrapperNames(dir) {
  const ns = await import(`${dir}/lib/namespace.js`);
  const idx = await import(`${dir}/bin/scripts/index.js`);
  return Object.keys(idx.wrapperMap(ns.NAMES.cliPrefix, ns.NAMES.namespace)).sort();
}

const sandboxes = [];
async function inSandbox(fn) {
  const dir = sandbox();
  sandboxes.push(dir);
  return fn(dir);
}
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe("bin/scripts/rename (one sandboxed execution — the real tree is never touched)", () => {
  test("rewrites both switches and every derived wrapper coherently", () =>
    inSandbox(async (dir) => {
      const result = run(dir, "Foo", "f");
      expect(result.exitCode).toBe(0);
      expect(namespace(dir)).toBe("Foo");
      expect(prefix(dir)).toBe("f");
      const names = await wrapperNames(dir);
      expect(binFiles(dir)).toEqual(names);
      expect(readFileSync(join(dir, "bin", "f-app"), "utf8")).toContain('import "./scripts/app";');
      expect(readFileSync(join(dir, "bin", "f"), "utf8")).toContain('import "./scripts/app";');
      expect(statSync(join(dir, "bin", "scripts", "app")).isFile()).toBe(true);
      expect(Object.keys(pkg(dir).bin).sort()).toEqual(names);
      expect(pkg(dir).name).toBe("foo");
    }));

  test("rejects an alias option without writing a third app command", () =>
    inSandbox((dir) => {
      const before = readFileSync(join(dir, "package.json"), "utf8");
      const result = run(dir, "Foo", "f", "--alias", "fooi");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("unknown option: --alias");
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
    }));
});
