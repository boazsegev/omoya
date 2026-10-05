import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { read, readDescription, readSettingsSchema } from "../tools/read/read.js";
import { executeReadQuery } from "../tools/read/engine.js";
import { serializeReadResult } from "../tools/read/serialize.js";
import { normalizeReadQuery, readQuerySchema } from "../tools/read/query.js";
import { write, toolDescription } from "../tools/write.js";
import { Env } from "../lib/env.js";
import { toolsLoad } from "./env-internals.js";
import { Agent } from "../lib/agent.js";
import { scriptedIO, USER, TEXT, TOOLCALL } from "./fakes.js";
const ROOT = `./ai-tmp/read-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));
function setup(files = {}) {
  mkdirSync(ROOT, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(ROOT, path, ".."), { recursive: true });
    writeFileSync(join(ROOT, path), content);
  }
  return { env: { cwd: ROOT, settings: {} } };
}
function texts(result) { return typeof result === "string" ? result : result.filter((block) => block.type === "text").map((block) => block.text).join("\n"); }
async function plain(query, context) { return texts(await read({ ...query, annotate: false }, context)); }

describe("read query normalization and shared JavaScript schemas", () => {
  test("normalizes wrong-type model fillers without deleting meaningful values", () => {
    const dense = { path: "", recursive: null, ignore: [], info: -1, binary: 0, base64: null, annotate: true,
      glob: [], exclude: false, lines: { from: 0, to: null, last: false }, characters: [], bytes: true,
      search: { text: "", regex: false, ignoreCase: false, invert: false, before: 0, after: 0 }, limit: -1, offset: null };
    expect(normalizeReadQuery(dense)).toEqual(normalizeReadQuery({ path: "." }));
    const q = normalizeReadQuery({ path: "a", lines: { from: -8, to: -1 }, limit: 0, offset: 0, ignore: true, annotate: false });
    expect(q.lines).toEqual({ from: -8, to: -1 });
    expect(q.limit).toBe(0); expect(q.ignore).toBe(true); expect(q.annotate).toBe(false);
    expect(normalizeReadQuery({ path: "a", characters: { to: 0 } }).characters.to).toBe(0);
  });
  test("rejects unknown fields, bad integers, malformed regex and contradictory modes before I/O", async () => {
    for (const args of [{ path: "missing", startLine: 1 }, { path: "missing", limit: 1.2 }, { path: "missing", lines: { last: 2, from: 1 } },
      { path: "missing", search: { text: "x", regex: "[" } }, { path: "missing", bytes: { from: 2 } }, { path: "missing", binary: true, lines: { from: 1 } }]) {
      await expect(read(args)).rejects.toThrow();
    }
    expect(() => normalizeReadQuery({ path: "a", lines: { from: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
    expect(() => normalizeReadQuery({ path: "a", offset: -5 })).toThrow();
    expect(() => normalizeReadQuery({})).toThrow(TypeError);
  });
  test("publishes the read schema with target; write has no query input", () => {
    expect(readDescription().safe).toBe(true);
    expect(readDescription().inputSchema).toEqual(readQuerySchema());
    expect(toolDescription().write.inputSchema.properties.source).toBeUndefined();
    expect(toolDescription().write.safe).toBeUndefined();
    expect(readQuerySchema().additionalProperties).toBe(false);
    expect(readSettingsSchema().read.default.scanBytes).toBeGreaterThan(0);
  });
});

describe("read ranges and text correctness", () => {
  test("reads UTF-8 and preserves selected line endings without MIME when unannotated", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\nthree\n", "unicode.txt": "hi π🙂" });
    expect(await plain({ path: "a.txt" }, ctx)).toBe("one\ntwo\nthree\n");
    expect(await plain({ path: "a.txt", lines: { from: 2, to: 2 } }, ctx)).toBe("two\n");
    expect(await plain({ path: "unicode.txt", characters: { from: 3, to: 5 } }, ctx)).toBe("π🙂");
    expect(await plain({ path: "unicode.txt", characters: { to: 0 } }, ctx)).toBe("");
    expect(await plain({ path: "unicode.txt", characters: { from: 1000 } }, ctx)).toBe("");
    expect(await plain({ path: "a.txt", lines: { from: 1000 } }, ctx)).toBe("");
    expect(texts(await read({ path: "a.txt" }, ctx))).toStartWith("[text/plain]\n");
  });
  test("resolves meaningful negative line/character/byte indexes from end", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\nthree\nfour", "bytes.bin": Buffer.from([1, 2, 3, 4, 5]) });
    expect(await plain({ path: "a.txt", lines: { from: -2, to: -1 } }, ctx)).toBe("three\nfour");
    expect(await plain({ path: "a.txt", lines: { last: 2 } }, ctx)).toBe("three\nfour");
    expect(await plain({ path: "a.txt", lines: { last: 0 } }, ctx)).toBe("");
    expect(await plain({ path: "a.txt", characters: { from: -4 } }, ctx)).toBe("four");
    expect(await plain({ path: "a.txt", characters: { from: -4, to: -1 } }, ctx)).toBe("fou");
    const result = await read({ path: "bytes.bin", binary: true, bytes: { from: -2 }, annotate: false }, ctx);
    expect(Buffer.from(result[0].content, "base64")).toEqual(Buffer.from([4, 5]));
    await expect(read({ path: "a.txt", characters: { from: -1, to: -4 } }, ctx)).rejects.toThrow(/range.from/);
  });
  test("decodes UTF-16 LE/BE and valid UTF-8 crossing the sniff boundary", async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi π\nnext", "utf16le")]);
    const be = Buffer.from(le); for (let i = 0; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
    const ctx = setup({ "le.txt": le, "be.txt": be, "wide.txt": "a".repeat(65535) + "πTARGET" });
    expect(await plain({ path: "le.txt" }, ctx)).toBe("hi π\nnext");
    expect(await plain({ path: "be.txt", search: { text: "π" } }, ctx)).toBe("hi π");
    expect(texts(await read({ path: "wide.txt", search: { text: "TARGET" } }, ctx))).toContain("TARGET");
  });
  test("keeps original source line numbers after combined character/line selection", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\nthree\nfour" });
    const output = texts(await read({ path: "a.txt", lines: { from: 2 }, characters: { from: 4 }, search: { text: "three" } }, ctx));
    expect(output).toContain("3: three");
  });
  test("info counts actual source lines and whole text only within budgets", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\n", "empty.txt": "" });
    const info = texts(await read({ path: "a.txt", lines: { to: 1 }, info: true }, ctx));
    expect(info).toContain("lines: 2"); expect(info).toContain("characters: 8");
    expect(texts(await read({ path: "empty.txt", info: true }, ctx))).toContain("lines: 0");
  });
});

describe("read literal/regex search and discovery", () => {
  test("ORs literal and regex, prints a selected line once and supports inversion/context", async () => {
    const ctx = setup({ "a.txt": "start\na.b TODO TODO\nFIXME\nend" });
    expect(await plain({ path: "a.txt", search: { text: "a.b", regex: "TODO|FIXME" } }, ctx)).toBe("a.b TODO TODO\nFIXME");
    expect(await plain({ path: "a.txt", search: { text: "TODO", regex: "FIXME", invert: true } }, ctx)).toBe("start\nend");
    const context = texts(await read({ path: "a.txt", search: { text: "TODO", before: 1, after: 1 } }, ctx));
    expect(context).toContain("1- start"); expect(context).toContain("2: a.b TODO TODO"); expect(context).toContain("3- FIXME");
  });
  test("multiline regex counts selected lines and always reports an omitted selection", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\nthree\nfour" });
    const out = texts(await read({ path: "a.txt", search: { regex: "two\\nthree" }, limit: 1 }, ctx));
    expect(out).toContain("2: two"); expect(out).not.toContain("3: three"); expect(out).toContain("selection limit");
    expect(texts(await read({ path: "a.txt", search: { regex: "two\\nthree" }, info: true }, ctx))).toContain("2 selected lines");
  });
  test("case-insensitive matching, zero-length patterns and empty text terminate", async () => {
    const ctx = setup({ "a.txt": "APPLE\nbanana", "empty.txt": "" });
    expect(await plain({ path: "a.txt", search: { text: "apple", ignoreCase: true } }, ctx)).toBe("APPLE");
    expect(await plain({ path: "a.txt", search: { regex: "^" } }, ctx)).toBe("APPLE\nbanana");
    expect(await plain({ path: "empty.txt", search: { regex: ".*" } }, ctx)).toBe("");
  });
  test("glob includes .md files, excludes subtrees, deterministic entries and pagination", async () => {
    const ctx = setup({ "a.md": "TODO", "b.js": "TODO", "sub/c.md": "TODO", "generated/d.md": "TODO" });
    expect(await plain({ path: ".", recursive: true, glob: "*.md", exclude: "generated/**" }, ctx)).toBe("a.md\nsub/c.md");
    expect(await plain({ path: ".", recursive: true, glob: ["*.md", "*.js"], exclude: ["generated/**", "sub/**"] }, ctx)).toBe("a.md\nb.js");
    expect(texts(await read({ path: ".", recursive: true, glob: "sub/**/*.md", search: { text: "TODO" } }, ctx))).toContain("sub/c.md:1:");
    expect(texts(await read({ path: ".", recursive: true, search: { text: "TODO" }, info: true }, ctx))).toContain("sub/c.md: 1 selected lines");
    const page = await plain({ path: ".", limit: 1, offset: 1 }, ctx);
    expect(page).toContain("b.js"); expect(page).toContain("selection limit");
    await expect(read({ path: ".", lines: { to: 2 } }, ctx)).rejects.toThrow(/ranges/);
  });
  test("ignore defaults off, opts into both files, inherits rules, explicit files always search", async () => {
    const ctx = setup({ ".gitignore": "*.md\n", ".ignore": "!keep.md\n", "drop.md": "TODO", "keep.md": "TODO", "sub/drop.md": "TODO", ".DS_Store": "TODO" });
    expect(await plain({ path: ".", recursive: true, glob: "*.md" }, ctx)).toBe("drop.md\nkeep.md\nsub/drop.md");
    expect(await plain({ path: ".", recursive: true, glob: "*.md", ignore: true }, ctx)).toContain("keep.md");
    expect(await plain({ path: ".", recursive: true, glob: "*.md", ignore: true }, ctx)).not.toContain("drop.md");
    expect(await plain({ path: "sub", glob: "*.md", ignore: true }, ctx)).not.toContain("sub/drop.md");
    expect(await plain({ path: "drop.md", ignore: true, search: { text: "TODO" } }, ctx)).toBe("TODO");
    expect(await plain({ path: ".DS_Store", ignore: true, search: { text: "TODO" } }, ctx)).toBe("TODO");
  });
  test("binary files list, text search skips them, binary folder search works", async () => {
    const ctx = setup({ "a.txt": "PNG", "pic.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]) });
    expect(await plain({ path: "." }, ctx)).toContain("pic.bin");
    expect(texts(await read({ path: ".", search: { text: "PNG" } }, ctx))).toContain("1 binary skipped");
    await expect(read({ path: "pic.bin", search: { text: "PNG" } }, ctx)).rejects.toThrow(/only to text/);
    expect(texts(await read({ path: ".", binary: true, search: { text: "PNG" } }, ctx))).toContain("pic.bin:1:");
  });
});

describe("read guarded auxiliary access and bounded execution", () => {
  test("rejects escapes/direct links, skips discovered links, never follows ignore symlinks", async () => {
    const ctx = setup({ "a.txt": "TODO", "rules.txt": "a.txt" });
    symlinkSync("a.txt", join(ROOT, "link.txt"));
    expect(texts(await read({ path: "." }, ctx))).toContain("1 symlink skipped");
    await expect(read({ path: "link.txt" }, ctx)).rejects.toThrow(/symbolic/);
    symlinkSync("rules.txt", join(ROOT, ".ignore"));
    // Explicit file does not open ignore files at all, even with ignore:true.
    expect(await plain({ path: "a.txt", ignore: true, search: { text: "TODO" } }, ctx)).toBe("TODO");
    await expect(read({ path: ".", ignore: true }, ctx)).rejects.toThrow(/symbolic/);
    await expect(read({ path: ".." }, ctx)).rejects.toThrow(/boundary/);
    await expect(read({ path: ["", "etc", "passwd"].join("/") }, ctx)).rejects.toThrow(/boundary/);
  });
  test("guards .gitignore and ancestor auxiliary paths too", async () => {
    const ctx = setup({ "sub/a.txt": "TODO", "rules.txt": "a.txt" });
    symlinkSync("rules.txt", join(ROOT, ".gitignore"));
    await expect(read({ path: "sub", ignore: true }, ctx)).rejects.toThrow(/symbolic/);
  });
  test("agent subfolder reads project siblings and gets relative root hints", async () => {
    setup({ "project/a.txt": "a", "project/agent/b.txt": "b" });
    const ctx = { env: { cwd: `${ROOT}/project` }, agent: { folder: `${ROOT}/project/agent` } };
    expect(await plain({ path: "../a.txt" }, ctx)).toBe("a");
    expect(texts(await read({ path: "." }, ctx))).toContain("use `../`");
    await expect(read({ path: "missing" }, ctx)).rejects.toThrow(/Hint:/);
    await expect(read({ path: "../../outside" }, ctx)).rejects.toThrow(/boundary/);
    setup({ "separate/own.txt": "own" });
    const separate = { env: { cwd: `${ROOT}/project` }, agent: { folder: `${ROOT}/separate` } };
    expect(await plain({ path: "own.txt" }, separate)).toBe("own");
    expect(await plain({ path: "../project/a.txt" }, separate)).toBe("a");
    await expect(read({ path: "../outside" }, separate)).rejects.toThrow(/boundary/);
  });
  test("positioned byte reads and positive head/tail queries don't load huge files", async () => {
    const ctx = setup({ "big.txt": "first\n" + "middle\n".repeat(200000) + "last", "big.bin": Buffer.alloc(2000000, 1) });
    const bytes = await executeReadQuery({ path: "big.bin", binary: true, bytes: { from: -4 } }, ctx);
    expect(bytes.scannedBytes).toBe(4);
    const head = await executeReadQuery({ path: "big.txt", lines: { to: 1 }, annotate: false }, ctx);
    expect(head.payload).toBe("first\n"); expect(head.scannedBytes).toBeLessThan(100000);
    const tail = await executeReadQuery({ path: "big.txt", lines: { from: -1 }, annotate: false }, ctx);
    expect(tail.payload).toBe("last"); expect(tail.scannedBytes).toBeLessThan(150000);
  });
  test("filters before content scans and reports finite scan/output limits", async () => {
    const ctx = setup({ "a.txt": "a".repeat(10000), "b.md": "TODO", "big.md": "TODO".repeat(2000) });
    ctx.env.settings.read = { grepFileSizeLimit: 100, outputBytes: 200, scanBytes: 1000 };
    const search = await executeReadQuery({ path: ".", glob: "*.md", search: { text: "TODO" } }, ctx);
    expect(search.scannedBytes).toBe(4); expect(search.skips.oversized).toBe(1);
    const incomplete = await executeReadQuery({ path: "a.txt" }, ctx);
    expect(incomplete.selectionComplete).toBe(false); expect(incomplete.status.join()).toContain("budget");
    ctx.env.settings.read = { outputBytes: 200 };
    expect(texts(await read({ path: "a.txt" }, ctx))).toContain("serialized output budget");
  });
  test("regex isolation terminates pathological work and respects cancellation", async () => {
    const ctx = setup({ "a.txt": "a".repeat(10000) + "!" });
    ctx.env.settings.read = { regexMs: 50 };
    const start = Date.now();
    const out = texts(await read({ path: "a.txt", search: { regex: "(a+)+$" } }, ctx));
    expect(out).toContain("Search time budget exhausted"); expect(Date.now() - start).toBeLessThan(1500);
    const controller = new AbortController();
    const pending = read({ path: "a.txt", search: { regex: "(a+)+$" } }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await expect(pending).rejects.toThrow(/cancelled/);
  });
  test("directory entry budgets interrupt with explicit incompleteness", async () => {
    const ctx = setup({ "a": "a", "b": "b", "c": "c" });
    ctx.env.settings.read = { entries: 2 };
    const out = texts(await read({ path: ".", info: true }, ctx));
    expect(out).toContain("incomplete"); expect(out).toContain("entries budget");
  });
});

describe("read.target shared payload and atomic failure guarantees", () => {
  test("Agent runs read as safe and read.target as a mutating sequential barrier", async () => {
    setup({ "a.txt": "hello" });
    const env = new Env({ cwd: ROOT, settings: { providers: { p: { provider: "test", url: "test://script" } } } });
    await toolsLoad(env);
    const io = scriptedIO([
      [...TOOLCALL(0, "save", "read", { path: "a.txt", annotate: true, target: "out.txt" }),
        ...TOOLCALL(1, "readback", "read", { path: "out.txt", annotate: false }), { type: "done" }],
      [...TEXT(0, "done"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("save and read")], createIO: () => io });
    try {
      expect((await agent.run()).type).toBe("done");
      const result = agent.context.messages().find((message) => message.callId === "readback");
      expect(result.content[0].text).toBe("hello");
      expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("hello");
    } finally { agent.close(); await env.close(); }
  });
  test("saves plain text, listings and reports without agent payload round-trip", async () => {
    const ctx = setup({ "a.txt": "one\nTODO\nthree" });
    const query = { path: "a.txt", lines: { from: 2, to: 2 }, annotate: false };
    await read({ ...query, target: "out.txt" }, ctx);
    expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("TODO\n");
    const report = { path: "a.txt", search: { text: "TODO" } };
    const expected = serializeReadResult(await executeReadQuery(report, ctx, { artifact: true }));
    await read({ ...report, target: "report.txt" }, ctx);
    expect(readFileSync(join(ROOT, "report.txt"))).toEqual(expected);
    await read({ path: ".", glob: "*.txt", annotate: false, target: "list.txt" }, ctx);
    expect(readFileSync(join(ROOT, "list.txt"), "utf8")).toContain("a.txt");
  });
  test("forces annotations off for non-search file/range/listing/base64 saves", async () => {
    const ctx = setup({ "source.txt": "one\ntwo\nthree" });
    for (const annotate of [undefined, true, false]) {
      const query = { path: "source.txt", annotate, lines: { from: 2, to: 2 } };
      await read({ ...query, target: "out.txt" }, ctx);
      expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("two\n");
      expect(query.annotate).toBe(annotate); // Caller query is not mutated.
    }
    await read({ path: ".", glob: "source.txt", annotate: true, target: "list.txt" }, ctx);
    expect(readFileSync(join(ROOT, "list.txt"), "utf8")).toBe("source.txt");
    await read({ path: "source.txt", base64: true, annotate: true, target: "base64.txt" }, ctx);
    expect(Buffer.from(readFileSync(join(ROOT, "base64.txt"), "utf8"), "base64").toString("utf8")).toBe("one\ntwo\nthree");
    expect(texts(await read({ path: "source.txt" }, ctx))).toStartWith("[text/plain]\n");
  });
  test("normalizes empty/filler searches before deciding annotation policy", async () => {
    const ctx = setup({ "source.txt": "source" });
    for (const search of [undefined, null, false, true, [], {}, { text: "", regex: null }, { ignoreCase: true, before: 2 }]) {
      await read({ path: "source.txt", search, annotate: true, target: "out.txt" }, ctx);
      expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("source");
    }
    await expect(read({ path: "source.txt", annotate: "invalid", target: "out.txt" }, ctx)).rejects.toThrow(/boolean/);
  });
  test("effective searches retain default/true annotations and honor explicit false", async () => {
    const ctx = setup({ "source.txt": "one\nTODO\nthree" });
    for (const search of [{ text: "TODO" }, { regex: "TODO" }]) {
      for (const annotate of [undefined, true, false]) {
        const query = { path: "source.txt", search, annotate };
        const expected = serializeReadResult(await executeReadQuery(query, ctx, { artifact: true }));
        await read({ ...query, target: "out.txt" }, ctx);
        expect(readFileSync(join(ROOT, "out.txt"))).toEqual(expected);
        if (annotate !== false) expect(expected.toString("utf8")).toContain("2: TODO");
        else expect(expected.toString("utf8")).toBe("TODO");
      }
    }
    await read({ path: "source.txt", info: true, target: "info.txt" }, ctx);
    expect(readFileSync(join(ROOT, "info.txt"), "utf8")).toContain("lines: 3");
  });
  test("preserves bytes and base64 without binary decoration or status", async () => {
    const ctx = setup({ "a.bin": Buffer.from([0, 255, 3, 4]) });
    await read({ path: "a.bin", binary: true, bytes: { from: -2 }, target: "b.bin" }, ctx);
    expect(readFileSync(join(ROOT, "b.bin"))).toEqual(Buffer.from([3, 4]));
    await read({ path: "a.bin", binary: true, base64: true, target: "b64.txt" }, ctx);
    expect(readFileSync(join(ROOT, "b64.txt"), "utf8")).toBe("AP8DBA==");
  });
  test("rejects missing content, unknown fields, safe mode, source identity and incomplete saves", async () => {
    const ctx = setup({ "a.txt": "a".repeat(1000), "dest.txt": "unchanged" });
    await expect(write({ path: "x" }, ctx)).rejects.toThrow(/content must be a string/);
    await expect(write({ path: "x", content: "", source: { path: "a.txt" } }, ctx)).rejects.toThrow(/Unknown write field: source/);
    await expect(read({ path: "a.txt", target: "x" }, { ...ctx, safe: true })).rejects.toThrow(/safe mode/);
    await expect(read({ path: "a.txt", target: 5 }, ctx)).rejects.toThrow(/path string/);
    expect(texts(await read({ path: "a.txt", lines: { last: 0 }, target: "" }, ctx))).not.toContain("Successfully");
    await expect(write({ path: "x", content: "a" }, { ...ctx, safe: true })).rejects.toThrow(/safe mode/);
    await expect(read({ path: "a.txt", target: "a.txt" }, ctx)).rejects.toThrow(/must differ/);
    ctx.env.settings.read = { artifactBytes: 100 };
    await expect(read({ path: "a.txt", target: "dest.txt" }, ctx)).rejects.toThrow(/incomplete/);
    expect(readFileSync(join(ROOT, "dest.txt"), "utf8")).toBe("unchanged");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(write({ path: "dest.txt", content: "new" }, { ...ctx, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(readFileSync(join(ROOT, "dest.txt"), "utf8")).toBe("unchanged");
  });
  test("explicit limit is intentional, larger artifact budget differs from preview, empty content valid", async () => {
    const ctx = setup({ "a.txt": "one\ntwo\nthree", "large.txt": "x".repeat(1000) });
    ctx.env.settings.read = { outputBytes: 100, artifactBytes: 2000 };
    await read({ path: "a.txt", search: { regex: ".+" }, limit: 1, annotate: false, target: "out.txt" }, ctx);
    expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("one");
    await read({ path: "large.txt", annotate: false, target: "large-out.txt" }, ctx);
    expect(readFileSync(join(ROOT, "large-out.txt")).length).toBe(1000);
    await write({ path: "empty.txt", content: "" }, ctx);
    expect(readFileSync(join(ROOT, "empty.txt")).length).toBe(0);
  });
  test("publishes read safe/write unsafe through Env and calls the shared query", async () => {
    const env = new Env({ cwd: ROOT, settings: {} });
    setup({ "a.txt": "hello" });
    try {
      await toolsLoad(env);
      const tools = await env.tools(true);
      expect(tools.has("read")).toBe(true); expect(tools.has("write")).toBe(false);
      // Scanned tools keep their readOnly classifier (read.target and skill-resource target serialize).
      expect(tools.get("read").readOnly({ path: "a", target: "b" })).toBe(false);
      expect(tools.get("skill-resource").readOnly({ name: "a", target: "b" })).toBe(false);
      const ctx = { env };
      expect(await env.toolCall("read", { path: "a.txt", annotate: false }, ctx)).toBe("hello");
      await env.toolCall("read", { path: "a.txt", target: "out.txt" }, ctx);
      await expect(env.toolCall("read", { path: "a.txt", target: "safe.txt" }, { env, safe: true })).rejects.toThrow(/safe mode/);
      expect(readFileSync(join(ROOT, "out.txt"), "utf8")).toBe("hello");
    } finally { await env.close(); }
  });
});
