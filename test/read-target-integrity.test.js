import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { read } from "../tools/read/read.js";

const ROOT = `ai-tmp/read-target-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function setup(files, settings = {}) {
  mkdirSync(ROOT, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(`${ROOT}/${name}`, bytes);
  return { env: { cwd: ROOT, settings } };
}

function saved(name) { return readFileSync(`${ROOT}/${name}`); }

function lines(count) { return Array.from({ length: count }, (_, index) => `MATCH ${index}`).join("\n"); }

describe("read.target saves complete selections rather than previews", () => {
  it("copies text, binary and base64 payloads beyond the preview budget", async () => {
    const bytes = Buffer.alloc(128 * 1024, 255);
    const source = `hello π\n${"x".repeat(128 * 1024)}`;
    const ctx = setup({ "source.txt": source, "source.bin": bytes });
    await read({ path: "source.txt", target: "text.txt" }, ctx);
    await read({ path: "source.bin", binary: true, target: "copy.bin" }, ctx);
    await read({ path: "source.bin", binary: true, base64: true, target: "encoded.txt" }, ctx);
    expect(saved("text.txt")).toEqual(Buffer.from(source));
    expect(saved("copy.bin")).toEqual(bytes);
    expect(saved("encoded.txt").toString()).toBe(bytes.toString("base64"));
  });

  it("saves all search results when limit is omitted", async () => {
    const source = lines(150);
    const ctx = setup({ "source.txt": source });
    await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false, target: "matches.txt" }, ctx);
    expect(saved("matches.txt").toString()).toBe(source);
  });

  it("saves all matches across files, including info reports", async () => {
    const ctx = setup({ "a.txt": lines(80), "b.txt": lines(80) });
    await read({ path: ".", glob: ["a.txt", "b.txt"], search: { text: "MATCH" }, annotate: false, target: "matches.txt" }, ctx);
    expect(saved("matches.txt").toString()).toBe(`${lines(80)}\n${lines(80)}`);
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`info${String(index).padStart(3, "0")}.txt`, "MATCH"]));
    for (const [name, source] of Object.entries(files)) writeFileSync(`${ROOT}/${name}`, source);
    await read({ path: ".", glob: "info*.txt", search: { text: "MATCH" }, info: true, target: "info.txt" }, ctx);
    const report = saved("info.txt").toString();
    for (const name of Object.keys(files)) expect(report).toContain(`${name}: 1 selected lines`);
  });

  it("saves every listing entry when limit is omitted", async () => {
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`item${String(index).padStart(3, "0")}.txt`, "ok"]));
    const ctx = setup(files);
    await read({ path: ".", target: "list.txt" }, ctx);
    expect(saved("list.txt").toString()).toBe(Object.keys(files).join("\n"));
  });

  it("preserves complete annotated search lines instead of preview excerpts", async () => {
    const source = `${"x".repeat(5000)}MATCH${"y".repeat(5000)}`;
    const ctx = setup({ "source.txt": source });
    await read({ path: "source.txt", search: { text: "MATCH" }, target: "matches.txt" }, ctx);
    expect(saved("matches.txt").toString()).toContain(`1: ${source}`);
  });

  it("saves full reports larger than the model preview byte budget", async () => {
    const source = `MATCH ${"x".repeat(128 * 1024)}`;
    const ctx = setup({ "source.txt": source });
    await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false, target: "matches.txt" }, ctx);
    expect(saved("matches.txt").toString()).toBe(source);
  });

  it("treats absent or filler limits as all results while saving", async () => {
    const ctx = setup({ "source.txt": lines(150) });
    for (const limit of [undefined, null, false, "", -1]) {
      await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false, limit, target: "matches.txt" }, ctx);
      expect(saved("matches.txt").toString()).toBe(lines(150));
    }
  });

  it("keeps explicit limits, offsets and ranges intentional", async () => {
    const ctx = setup({ "source.txt": lines(150) });
    await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false, offset: 100, limit: 2, target: "matches.txt" }, ctx);
    expect(saved("matches.txt").toString()).toBe("MATCH 100\nMATCH 101");
    await read({ path: "source.txt", lines: { from: 101, to: 102 }, target: "range.txt" }, ctx);
    expect(saved("range.txt").toString()).toBe("MATCH 100\nMATCH 101\n");
    await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false, limit: 0, target: "empty.txt" }, ctx);
    expect(saved("empty.txt")).toHaveLength(0);
  });

  it("keeps explicit listing limits and binary byte ranges exact", async () => {
    const bytes = Buffer.alloc(128 * 1024, 255);
    const ctx = setup({ "a.txt": "one", "b.txt": "two", "source.bin": bytes });
    await read({ path: ".", glob: ["a.txt", "b.txt"], offset: 1, limit: 1, target: "list.txt" }, ctx);
    expect(saved("list.txt").toString()).toBe("b.txt");
    await read({ path: "source.bin", binary: true, bytes: { from: 17, to: 110000 }, target: "range.bin" }, ctx);
    expect(saved("range.bin")).toEqual(bytes.subarray(17, 110000));
  });

  it("does not change the preview default of 100 matches", async () => {
    const ctx = setup({ "source.txt": lines(150) });
    const output = await read({ path: "source.txt", search: { text: "MATCH" }, annotate: false }, ctx);
    const text = typeof output === "string" ? output : output.map((block) => block.text).join("\n");
    expect(text).toContain("MATCH 99");
    expect(text).not.toContain("MATCH 100");
  });

  it("refuses skipped oversized search inputs rather than saving an incomplete report", async () => {
    const ctx = setup({ "source.txt": "MATCH".repeat(30), "dest.txt": "unchanged" }, { read: { grepFileSizeLimit: 32 } });
    await expect(read({ path: ".", glob: "source.txt", search: { text: "MATCH" }, target: "dest.txt" }, ctx)).rejects.toThrow(/incomplete/);
    expect(saved("dest.txt").toString()).toBe("unchanged");
  });

  for (const budget of ["artifactBytes", "fileBytes", "scanBytes"]) {
    it(`refuses ${budget} exhaustion without replacing the destination`, async () => {
      const ctx = setup({ "source.txt": "x".repeat(1000), "dest.txt": "unchanged" }, { read: { [budget]: 100 } });
      await expect(read({ path: "source.txt", target: "dest.txt" }, ctx)).rejects.toThrow(/incomplete/);
      expect(saved("dest.txt").toString()).toBe("unchanged");
    });
  }

  it("refuses artifacts above the default 16 MiB save budget", async () => {
    const ctx = setup({ "large.bin": Buffer.alloc(16 * 1024 * 1024 + 1, 255), "dest.bin": "unchanged" });
    await expect(read({ path: "large.bin", binary: true, target: "dest.bin" }, ctx)).rejects.toThrow(/incomplete/);
    expect(saved("dest.bin").toString()).toBe("unchanged");
  });

  it("refuses oversized binary and encoded artifacts rather than saving their prefixes", async () => {
    const ctx = setup({ "source.bin": Buffer.alloc(100, 255), "dest.bin": "unchanged" }, { read: { artifactBytes: 100 } });
    await expect(read({ path: "source.bin", binary: true, base64: true, target: "dest.bin" }, ctx)).rejects.toThrow(/incomplete/);
    expect(saved("dest.bin").toString()).toBe("unchanged");
    ctx.env.settings.read.artifactBytes = 99;
    await expect(read({ path: "source.bin", binary: true, target: "dest.bin" }, ctx)).rejects.toThrow(/incomplete/);
    expect(saved("dest.bin").toString()).toBe("unchanged");
  });
});
