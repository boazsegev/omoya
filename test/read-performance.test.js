import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { executeReadQuery } from "../tools/read/engine.js";
import { spawnSync } from "node:child_process";

function fixture(mode) {
  const child = spawnSync(process.execPath, ["test/read-fs-fixture.js", mode], { encoding: "utf8" });
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

describe("read filesystem privacy and traversal cost", () => {
  for (const operation of ["opendir", "lstat", "open", "read", "auxiliary", "write-open"]) {
    test(`${operation} timeouts expose only relative diagnostics`, () => {
      const result = fixture(operation);
      expect(result.code).toBe("ETIMEDOUT");
      expect(result.leaked).toBe(false);
      expect(result.relativePath).toBe(true);
      expect(result.message).toContain("sub");
      expect(result.message).not.toContain("[HOST ROOT]");
    });
  }
  test("filtered traversal does not stat files that cannot match", () => {
    const result = fixture("count");
    expect(result.lstat).toBeLessThan(7);
  });
  test("whole-text search uses a sample plus a bulk read, not per-line or tiny-block I/O", () => {
    expect(fixture("bulk-count").read).toBe(2);
  });
});

const ROOT = `./ai-tmp/read-performance-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));
function setup(files) {
  mkdirSync(ROOT, { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(`${ROOT}/${path}`, text);
  return { env: { cwd: ROOT, settings: {} } };
}

describe("read bulk matching regressions", () => {
  test("irrelevant whole text is rejected without allocating the line index", async () => {
    const ctx = setup({ "many.txt": "no hit\n".repeat(210000) });
    const result = await executeReadQuery({ path: "many.txt", search: { text: "absent" } }, ctx);
    expect(result.complete).toBe(true);
    expect(result.selected).toBe(0);
  });
  test("matched and inverted files still respect the line index budget", async () => {
    const ctx = setup({ "many.txt": "hit\n".repeat(210000) });
    for (const search of [{ text: "hit" }, { text: "absent", invert: true }]) {
      const result = await executeReadQuery({ path: "many.txt", search }, ctx);
      expect(result.complete).toBe(false);
      expect(result.status.join()).toContain("line budget");
    }
  });
  test("shared workers reset regex state and ignore trailing manufactured lines", async () => {
    const ctx = setup({ "a.txt": "needle\nnext\n", "b.txt": "needle\nnext\n", "c.txt": "other\n" });
    const result = await executeReadQuery({ path: "", search: { regex: "^needle\\nnext$" }, info: true }, ctx);
    expect(result.selected).toBe(4);
    expect(result.matchingFiles).toEqual([{ path: "a.txt", count: 2 }, { path: "b.txt", count: 2 }]);
    const invert = await executeReadQuery({ path: "", search: { text: "needle", invert: true }, info: true }, ctx);
    expect(invert.selected).toBe(3);
  });
  test("bulk decoding preserves UTF-8 across the 8 MiB boundary", async () => {
    const ctx = setup({ "wide.txt": "a".repeat(8 * 1024 * 1024 + 65535) + "🙂\nTARGET" });
    const result = await executeReadQuery({ path: "wide.txt", search: { text: "TARGET" }, info: true }, ctx);
    expect(result.complete).toBe(true);
    expect(result.selected).toBe(1);
    expect(result.totals.lines).toBe(2);
  });
});
