import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { read } from "../tools/read/read.js";
import { write } from "../tools/write.js";
import { matchesGlob } from "../tools/read/glob.js";
import { parseIgnore, isIgnored } from "../tools/read/ignore.js";
const ROOT = `./ai-tmp/read-security-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));
function setup() { mkdirSync(`${ROOT}/project/sub`, { recursive: true }); return { env: { cwd: `${ROOT}/project`, settings: {} } }; }
function text(value) { return typeof value === "string" ? value : value.filter((block) => block.type === "text").map((block) => block.text).join("\n"); }

describe("read security regressions", () => {
  test("auxiliary symlink to outside the selected project is refused before its content is read", async () => {
    const ctx = setup();
    writeFileSync(`${ROOT}/secret.txt`, "sub/\n");
    writeFileSync(`${ROOT}/project/sub/a.txt`, "visible");
    symlinkSync("../secret.txt", `${ROOT}/project/.ignore`);
    await expect(read({ path: ".", recursive: true, ignore: true }, ctx)).rejects.toThrow(/symbolic/);
    await expect(read({ path: "sub", ignore: true }, ctx)).rejects.toThrow(/symbolic/);
    expect(text(await read({ path: "sub/a.txt", ignore: true, search: { text: "visible" } }, ctx))).toContain("visible");
  });
  test("ordinary discovered symlinks never follow external content", async () => {
    const ctx = setup();
    writeFileSync(`${ROOT}/secret.txt`, "SECRET");
    symlinkSync("../secret.txt", `${ROOT}/project/link.txt`);
    const out = text(await read({ path: ".", recursive: true, search: { text: "SECRET" } }, ctx));
    expect(out).toContain("symlink skipped"); expect(out).not.toContain("SECRET");
  });
  test("direct FIFO and auxiliary FIFO fail without blocking, discovery skips special files", async () => {
    if (process.platform === "win32") return;
    const ctx = setup();
    const child = spawnSync("mkfifo", [`${ROOT}/project/pipe`, `${ROOT}/project/.ignore`]);
    expect(child.status).toBe(0);
    await expect(read({ path: "pipe" }, ctx)).rejects.toThrow(/special/);
    await expect(read({ path: ".", ignore: true }, ctx)).rejects.toThrow(/special/);
    expect(text(await read({ path: "." }, ctx))).toContain("2 special skipped");
    await expect(write({ path: "pipe", content: "x" }, ctx)).rejects.toThrow(/regular file/);
  });
  test("hardlink source identity and failed query cannot replace destination", async () => {
    const ctx = setup();
    writeFileSync(`${ROOT}/project/a.txt`, "unchanged");
    linkSync(`${ROOT}/project/a.txt`, `${ROOT}/project/b.txt`);
    await expect(write({ path: "b.txt", source: { path: "a.txt" } }, ctx)).rejects.toThrow(/must differ/);
    await expect(write({ path: "b.txt", source: { path: "missing" } }, ctx)).rejects.toThrow(/ENOENT/);
    expect(readFileSync(`${ROOT}/project/b.txt`, "utf8")).toBe("unchanged");
    expect(readdirSync(`${ROOT}/project`).some((path) => path.endsWith(".tmp"))).toBe(false);
  });
  test("glob evaluation bounds pathological wildcard patterns and supports anchors/alternatives", () => {
    expect(matchesGlob("a/b.md", "*.md")).toBe(true);
    expect(matchesGlob("a/b.md", "**/*.md")).toBe(true);
    expect(matchesGlob("a/b.md", "/b.md")).toBe(false);
    expect(matchesGlob("b.md", "/b.md")).toBe(true);
    expect(matchesGlob("a/b.md", "a/*.{txt,md}")).toBe(true);
    expect(matchesGlob("a/b/c.md", "a/*.md")).toBe(false);
    expect(() => matchesGlob("a".repeat(3000), "*a".repeat(1000) + "b")).toThrow(/budget/);
  });
  test("ignore anchors cover subtrees, escaped prefixes remain literal, negation works", () => {
    const rules = parseIgnore("/build/\nsub/cache\n*.md\n!keep.md\n\\#literal\n\\!literal\n", "");
    expect(isIgnored([rules], "build/a/x.txt")).toBe(true);
    expect(isIgnored([rules], "other/build/x.txt")).toBe(false);
    expect(isIgnored([rules], "sub/cache/x.txt")).toBe(true);
    expect(isIgnored([rules], "keep.md")).toBe(false);
    expect(isIgnored([rules], "#literal")).toBe(true);
    expect(isIgnored([rules], "!literal")).toBe(true);
  });
});
