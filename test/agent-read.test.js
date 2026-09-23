// test/agent-read.test.js — proof for the shipped read tool:
// read-only, cwd-rooted, path-traversal protection (no ".." or
// absolute-path escape), published by the independent tools/read.js
// wrapper.
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Env } from "../lib/env.js";
import { read, readDescription } from "../tools/read/read.js";
import { resolveCwdPath } from "../tools/guard/resolve.js";

const ROOT = `./ai-tmp/read-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("read tool", () => {
  test("readDescription() publishes an MCP-like schema for read", async () => {
    const d = readDescription();
    expect(d).toMatchObject({ inputSchema: { type: "object" } });
    expect(d.inputSchema.required).toEqual(["path"]);
  });

  test("reads a UTF-8 file inside the working folder", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/note.txt`, "hello π");
    expect(await read({ path: "./ai-tmp/../ai-tmp/read-" + process.pid + "/note.txt" }))
      .toBe("hello π"); // dot-segments that stay inside cwd are fine
  });

  test("rejects '..' escapes outside the working folder — global policy, bad even if successful", async () => {
    await expect(read({ path: "../../../etc/hostname" })).rejects.toThrow(/escapes the working folder/);
    await expect(read({ path: ".." })).rejects.toThrow(/escapes the working folder/);
    await expect(read({ path: ".." })).rejects.toThrow(/global security policy violation/);
    await expect(read({ path: ".." })).rejects.toThrow(/even if it would succeed/);
  });

  test("rejects absolute paths — global policy, bad even if successful", async () => {
    await expect(read({ path: "/etc/hostname" })).rejects.toThrow(/path traversal refused/);
    await expect(read({ path: "/etc/hostname" })).rejects.toThrow(/global security policy violation/);
    await expect(read({ path: "C:\\Windows\\win.ini" })).rejects.toThrow(/path traversal refused/);
  });

  test("refuses symbolic-link paths and folder entries", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/real.txt`, "safe");
    symlinkSync("real.txt", `${ROOT}/link.txt`);
    await expect(read({ path: `./ai-tmp/read-${process.pid}/link.txt` })).rejects.toThrow(/symbolic links are refused/);
    await expect(read({ path: `./ai-tmp/read-${process.pid}` })).rejects.toThrow(/^Choose a regular file or folder/);
  });

  test("reading a FOLDER lists its entries with a clear header", async () => {
    mkdirSync(`${ROOT}/sub`, { recursive: true });
    writeFileSync(`${ROOT}/b.txt`, "b");
    writeFileSync(`${ROOT}/a.txt`, "a");
    const out = await read({ path: "./ai-tmp/../ai-tmp/read-" + process.pid });
    expect(out.startsWith("ls ")).toBe(true);
    expect(out).toContain("sub/"); // directories suffixed
    expect(out).toContain("a.txt");
    expect(out.indexOf("a.txt")).toBeLessThan(out.indexOf("b.txt")); // sorted
  });

  test("a FOLDER listing shows each FILE's approximate size in bytes; directories carry none", async () => {
    mkdirSync(`${ROOT}/sub`, { recursive: true });
    writeFileSync(`${ROOT}/a.txt`, "hello"); // 5 bytes
    const out = await read({ path: "./ai-tmp/../ai-tmp/read-" + process.pid });
    expect(out).toContain("a.txt (5 bytes)");
    expect(out.split("\n")).toContain("sub/"); // no "(N bytes)" tacked onto a directory
    expect(out).not.toMatch(/sub\/ \(/);
  });

  test("missing files and bad args are ordinary errors (tool-result errors at the Agent)", async () => {
    await expect(read({ path: "./no-such-file.txt" })).rejects.toThrow(/ENOENT/);
    await expect(read({})).rejects.toThrow(TypeError);
    await expect(read()).rejects.toThrow(TypeError);
  });

  test("an EMPTY path lists the current folder (a falsey fill, not a missing arg)", async () => {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(`${ROOT}/a.txt`, "a");
    const out = await read({ path: "" });
    expect(out.startsWith("ls .:")).toBe(true);
    expect(out).toContain("test/");
  });

  test("resolveCwdPath allows the root itself but nothing outside its boundary", async () => {
    expect(resolveCwdPath(".", { cwd: ROOT })).toBe(resolve(ROOT));
    expect(() => resolveCwdPath("./../x", { cwd: ROOT })).toThrow(/escapes/);
  });

  test("uses the agent folder as cwd and permits parent reads within env.cwd", async () => {
    const project = `${ROOT}/project`;
    const folder = `${project}/agent`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${project}/project.txt`, "project");
    writeFileSync(`${folder}/agent.txt`, "agent");
    const context = { env: { cwd: project }, agent: { folder } };
    expect(await read({ path: "." }, context)).toContain("agent.txt");
    expect(await read({ path: "../project.txt" }, context)).toBe("project");
    await expect(read({ path: "missing.txt" }, context)).rejects.toThrow(
      "Hint: you're in `./agent`, use `../` to read files from the root project.",
    );
    await expect(read({ path: "../../outside.txt" }, context)).rejects.toThrow(/project boundary/);
  });

  test("a CURRENT-FOLDER listing from a sub-folder carries the root-project hint", async () => {
    const project = `${ROOT}/project`;
    const folder = `${project}/agent`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/agent.txt`, "agent");
    const context = { env: { cwd: project }, agent: { folder } };
    const hint = "Hint: you're in `./agent`, use `../` to read files from the root project.";
    for (const path of ["", ".", "./"]) {
      const out = await read({ path }, context);
      expect(out.startsWith("ls .:")).toBe(true);
      expect(out).toContain("agent.txt");
      expect(out).toContain(hint);
    }
    // a listing of a DIFFERENT folder carries no hint
    expect(await read({ path: ".." }, context)).not.toContain("Hint:");
    // and neither does a root-folder agent (nothing more to reach)
    const root = { env: { cwd: project }, agent: { folder: project } };
    expect(await read({ path: "." }, root)).not.toContain("Hint:");
  });

  test("discovers as read through the package default root (tools/read.js wrapper)", async () => {
    const env = new Env({ settings: {} });
    const names = await env.loadTools(); // default includes package ./tools
    expect(names).toContain("read");
    const [schema] = env.toolSchemas(["read"]);
    expect(schema.name).toBe("read");
    const content = await env.callTool("read", { path: "./README.md" });
    expect(content).toContain("A transparent agent harness");
    await expect(env.callTool("read", { path: "../outside" }))
      .rejects.toThrow(/escapes the working folder/);
    // a folder read lists entries through the same surface
    const listing = await env.callTool("read", { path: "./tools" });
    expect(listing).toContain("ls ./tools:");
    expect(listing).toContain("read.js");
  });
});

describe("read folders: search and recursive", () => {
  const rel = (name) => `./ai-tmp/../ai-tmp/read-${process.pid}/${name}`;
  const setup = () => {
    mkdirSync(`${ROOT}/sub/deep`, { recursive: true });
    writeFileSync(`${ROOT}/a.txt`, "apple top\nbanana\nAPPLE caps");
    writeFileSync(`${ROOT}/b.txt`, "nothing here");
    writeFileSync(`${ROOT}/sub/c.txt`, "apple sub\ncherry");
    writeFileSync(`${ROOT}/sub/deep/d.txt`, "apple deep");
  };

  test("a folder search greps every file in the folder (top level only by default)", async () => {
    setup();
    const out = await read({ path: rel("."), pattern: "apple" });
    expect(out).toBe(
      `grep ${rel(".")} /apple/ (1):\n` + "a.txt:1: apple top");
  });

  test("recursive: true descends into sub-folders, prefixing matches with file paths", async () => {
    setup();
    const out = await read({ path: rel("."), pattern: "apple", recursive: true });
    expect(out).toBe(
      `grep ${rel(".")} /apple/ (3):\n` +
        "a.txt:1: apple top\n" +
        "sub/c.txt:1: apple sub\n" +
        "sub/deep/d.txt:1: apple deep");
  });

  test("folder grep honors ignoreCase, maxMatches, and clean no-match reports", async () => {
    setup();
    const ci = await read({ path: rel("."), pattern: "apple", ignoreCase: true });
    expect(ci).toContain("(2):");
    expect(ci).toContain("3: APPLE caps");
    const capped = await read({ path: rel("."), pattern: "apple", recursive: true, maxMatches: 2 });
    expect(capped).toContain("(3, showing first 2):");
    expect(capped.split("\n").slice(1)).toHaveLength(2);
    expect(await read({ path: rel("."), pattern: "zebra", recursive: true }))
      .toBe(`grep: no matches for /zebra/ in ${rel(".")}`);
    await expect(read({ path: rel("."), pattern: "([bad" })).rejects.toThrow("Invalid pattern. Use a valid regular expression.");
  });

  test("glob filters folder listings and candidate files before grep", async () => {
    setup();
    expect(await read({ path: rel("."), glob: "*.txt" })).toBe(
      `find ${rel(".")} (glob: *.txt):\na.txt (27 bytes)\nb.txt (12 bytes)`);
    expect(await read({ path: rel("."), pattern: "apple", glob: "*.txt", recursive: true }))
      .toBe(`grep ${rel(".")} /apple/ (3):\na.txt:1: apple top\nsub/c.txt:1: apple sub\nsub/deep/d.txt:1: apple deep`);
    expect(await read({ path: rel("."), pattern: "apple", glob: "sub/**/*.txt", recursive: true }))
      .toBe(`grep ${rel(".")} /apple/ (2):\nsub/c.txt:1: apple sub\nsub/deep/d.txt:1: apple deep`);
  });

  test("a recursive folder listing nests sub-folder entries, each file sized in bytes", async () => {
    setup();
    const out = await read({ path: rel("."), recursive: true });
    expect(out).toBe(
      `ls ${rel(".")} (recursive):\n` +
        "a.txt (27 bytes)\nb.txt (12 bytes)\nsub/\nsub/c.txt (16 bytes)\n" +
        "sub/deep/\nsub/deep/d.txt (10 bytes)");
  });

  test("file-only options on a folder are ordinary errors", async () => {
    setup();
    await expect(read({ path: rel("."), binary: true })).rejects.toThrow("binary applies only to files. Choose a file path or remove binary.");
    await expect(read({ path: rel("."), base64: true })).rejects.toThrow("base64 applies only to files. Choose a file path or remove base64.");
    await expect(read({ path: rel("."), startChar: 2 })).rejects.toThrow("startChar applies only to files. Choose a file path or remove startChar.");
  });

  test("endChar caps a folder listing's rendered output", async () => {
    setup();
    const full = await read({ path: rel(".") });
    expect(await read({ path: rel("."), endChar: 20 })).toBe([...full].slice(0, 20).join(""));
  });

  test("a line range on a FOLDER is an entry cap (an initial maxMatches — never an error)", async () => {
    setup();
    // a model's `startLine:1, endLine:2` means "at most 2 entries", not a conflict
    const out = await read({ path: rel("."), startLine: 1, endLine: 2 });
    expect(out).toBe(`ls ${rel(".")}:\na.txt (27 bytes)\nb.txt (12 bytes)\n… (1 more — capped at 2)`);
    // an explicit non-zero maxMatches overrides the line range's cap
    const wider = await read({ path: rel("."), startLine: 1, endLine: 2, maxMatches: 3 });
    expect(wider).toBe(`ls ${rel(".")}:\na.txt (27 bytes)\nb.txt (12 bytes)\nsub/`);
    // the same cap applies to a folder SEARCH (maxMatches semantics)
    const search = await read({ path: rel("."), pattern: "apple", ignoreCase: true, startLine: 1, endLine: 1 });
    expect(search).toContain("(2, showing first 1):");
    const overridden = await read({ path: rel("."), pattern: "apple", ignoreCase: true, startLine: 1, endLine: 1, maxMatches: 2 });
    expect(overridden).toContain("(2):");
  });
});

describe("read info:true — file/query summary instead of the payload", () => {
  const rel = (name) => `./ai-tmp/../ai-tmp/read-${process.pid}/${name}`;
  const setup = () => {
    mkdirSync(`${ROOT}/sub`, { recursive: true });
    writeFileSync(`${ROOT}/a.txt`, "apple top\nbanana\nAPPLE caps");
    writeFileSync(`${ROOT}/sub/c.txt`, "apple sub");
  };

  test("a file info reports metadata (incl. characters/lines) and the would-be read size", async () => {
    setup();
    const out = await read({ path: rel("a.txt"), info: true });
    expect(out).toContain(`info for ${rel("a.txt")}:`);
    expect(out).toContain("type: file");
    expect(out).toContain("size: 27 bytes");
    expect(out).toContain("characters: 27");
    expect(out).toContain("lines: 3"); // "apple top\nbanana\nAPPLE caps" — 3 lines
    expect(out).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
    expect(out).toMatch(/modified: \d{4}-\d{2}-\d{2}T/);
    expect(out).toContain("the requested read would return 27 bytes (whole file)");
  });

  test("info reflects the requested narrowing (line range, search, binary)", async () => {
    setup();
    expect(await read({ path: rel("a.txt"), info: true, startLine: 2, endLine: 3 }))
      .toMatch(/read would return \d+ bytes \(lines 2–3\)/); // header + 2 lines
    expect(await read({ path: rel("a.txt"), info: true, pattern: "apple" }))
      .toMatch(/grep would return 1 matches \(\d+ bytes\)/);
    const bin = await read({ path: rel("a.txt"), info: true, binary: true, startChar: 0, endChar: 5 });
    expect(bin).toContain("read would return 5 bytes (byte range 0–4 of 27");
    expect(bin).not.toContain("characters:"); // binary has no meaningful character/line count
    expect(await read({ path: rel("a.txt"), info: true, pattern: "apple", ignoreCase: true }))
      .toMatch(/grep would return 2 matches/);
  });

  test("a narrowed text info STILL reports the WHOLE file's character/line counts", async () => {
    setup();
    // narrowed to lines 2-3 ("banana\nAPPLE caps" — 2 lines, 17 chars),
    // but characters/lines describe the FILE, not the slice
    const out = await read({ path: rel("a.txt"), info: true, startLine: 2, endLine: 3 });
    expect(out).toContain("characters: 27");
    expect(out).toContain("lines: 3");
  });

  test("a folder info reports entry counts and grep tallies", async () => {
    setup();
    expect(await read({ path: rel("."), info: true }))
      .toContain("the requested ls/find would return 2 entries");
    expect(await read({ path: rel("."), info: true, recursive: true }))
      .toContain("ls/find would return 3 entries (recursive)");
    expect(await read({ path: rel("."), info: true, pattern: "apple", recursive: true }))
      .toContain("type: folder");
    expect(await read({ path: rel("."), info: true, pattern: "apple", recursive: true }))
      .toContain("grep would return 2 matches in 2 file(s)");
  });

  test("base64 does not combine with info", async () => {
    setup();
    await expect(read({ path: rel("a.txt"), info: true, base64: true })).rejects.toThrow(/base64/);
  });
});

describe("read ranges and grep-like search", () => {
  const setup = (name, content) => {
    mkdirSync(ROOT, { recursive: true });
    const rel = `./ai-tmp/../ai-tmp/read-${process.pid}/${name}`;
    writeFileSync(`${ROOT}/${name}`, content);
    return rel;
  };
  const numbered = (n) => Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`).join("\n");

  test("a 1-based inclusive line range narrows the read, with a total-lines header", async () => {
    const rel = setup("lines.txt", numbered(30));
    const out = await read({ path: rel, startLine: 5, endLine: 25 });
    expect(out.startsWith("[lines 5–25 of 30 total]\n")).toBe(true);
    const body = out.split("\n").slice(1);
    expect(body[0]).toBe("line-05");
    expect(body.at(-1)).toBe("line-25");
    expect(body).toHaveLength(21);
  });

  test("open-ended line ranges default to the file start/end", async () => {
    const rel = setup("lines.txt", numbered(10));
    expect((await read({ path: rel, startLine: 8 })).split("\n").slice(1)).toEqual(["line-08", "line-09", "line-10"]);
    expect((await read({ path: rel, endLine: 2 })).split("\n").slice(1)).toEqual(["line-01", "line-02"]);
  });

  test("a character range slices UTF-8 characters (code points), endChar exclusive", async () => {
    const rel = setup("chars.txt", "hello π world"); // π is ONE character
    const out = await read({ path: rel, startChar: 0, endChar: 7 });
    expect(out).toBe("[characters 0–6 of 13 total]\nhello π");
  });

  test("binary + base64 returns the byte range as base64 TEXT with a byte header", async () => {
    mkdirSync(ROOT, { recursive: true });
    const rel = `./ai-tmp/../ai-tmp/read-${process.pid}/bin.dat`;
    writeFileSync(`${ROOT}/bin.dat`, Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]));
    const out = await read({ path: rel, binary: true, base64: true, startChar: 2, endChar: 6 });
    expect(out).toBe(`[bytes 2–5 of 8 total, base64]\n${Buffer.from([2, 3, 250, 251]).toString("base64")}`);
  });

  test("binary alone returns mime-sniffed BINARY content blocks (not base64 text)", async () => {
    mkdirSync(ROOT, { recursive: true });
    const rel = `./ai-tmp/../ai-tmp/read-${process.pid}/pic.png`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(`${ROOT}/pic.png`, png);
    const out = await read({ path: rel, binary: true });
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toEqual({ type: "text", text: `[bytes 0–10 of 11 total, image/png]` });
    expect(out[1]).toEqual({ type: "binary", mime: "image/png", content: png.toString("base64") });
    const sliced = await read({ path: rel, binary: true, startChar: 8 });
    expect(sliced[1].mime).toBe("image/png"); // the EXTENSION map answers first
    // an unknown extension with no magic bytes sniffs to octet-stream
    writeFileSync(`${ROOT}/blob.xyz`, Buffer.from([1, 2, 3]));
    const unknown = await read({ path: `./ai-tmp/../ai-tmp/read-${process.pid}/blob.xyz`, binary: true });
    expect(unknown[1].mime).toBe("application/octet-stream");
  });

  test("base64 alone encodes the TEXT result (ranges and searches included)", async () => {
    const rel = setup("lines.txt", numbered(5));
    const out = await read({ path: rel, base64: true, startLine: 2, endLine: 3 });
    const plain = await read({ path: rel, startLine: 2, endLine: 3 });
    expect(out.startsWith("[base64]\n")).toBe(true);
    expect(Buffer.from(out.slice(8), "base64").toString("utf8")).toBe(plain);
  });

  test("glob permits a matching file path and rejects only a nonmatching one", async () => {
    const markdown = setup("note.md", "# Note\nTODO");
    expect(await read({ path: markdown, glob: "**/*.md", pattern: "TODO" }))
      .toBe(`grep ${markdown} /TODO/ (1):\n2: TODO`);
    await expect(read({ path: markdown, glob: "*.ts" })).rejects
      .toThrow('The file does not match glob "*.ts".');
  });

  test("conflicting options are ordinary errors", async () => {
    const rel = setup("lines.txt", numbered(5));
    await expect(read({ path: rel, binary: true, startLine: 1 })).rejects.toThrow("Binary reads use startChar/endChar, not startLine/endLine.");
    await expect(read({ path: rel, binary: true, pattern: "x" })).rejects.toThrow("Binary reads cannot use pattern. Remove pattern or binary.");
    await expect(read({ path: rel, startLine: -1 })).rejects.toThrow(/startLine/);
  });

  test("a line range AND a character range combine (a character cap never excludes a line range)", async () => {
    const rel = setup("lines.txt", numbered(30));
    // "up to 5 lines, but no more than 10 characters": the line range
    // selects first, the character range caps the selection
    const out = await read({ path: rel, startLine: 1, endLine: 5, endChar: 10 });
    expect(out).toBe("[lines 1–5 of 30 total]\n[characters 0–9 of 39 in the line range]\nline-01\nli");
    // a search inside both keeps the line range's original numbers
    const found = await read({ path: rel, startLine: 2, endLine: 4, endChar: 20, pattern: "line" });
    expect(found).toContain("2: line-02");
    expect(found).toContain("3: line-03");
  });

  test("FALSEY-FILLED optionals count as absent (models that fill every field)", async () => {
    const rel = setup("lines.txt", numbered(3));
    // some models always fill every schema field with 0/null/false/""
    // for "no value" — a filled startLine: 0 or pattern: "" must not
    // throw or change the query (optionality is absence from
    // `required`; a falsey fill is how a model says "absent")
    const filled = await read({
      path: rel, startLine: 0, endLine: null, startChar: 0, endChar: 0,
      pattern: "", maxMatches: 0, binary: false, base64: false,
      ignoreCase: false, recursive: false, info: false,
    });
    expect(filled).toBe(await read({ path: rel }));
  });

  test("grep returns matching lines with 1-based line numbers (grep -n style)", async () => {
    const rel = setup("log.txt", "info: start\nerror: first\ninfo: middle\nERROR: second\ninfo: end");
    const out = await read({ path: rel, pattern: "error" });
    expect(out).toBe("grep " + rel + " /error/ (1):\n2: error: first");
    const ci = await read({ path: rel, pattern: "error", ignoreCase: true });
    expect(ci).toContain("(2):");
    expect(ci).toContain("2: error: first");
    expect(ci).toContain("4: ERROR: second");
  });

  test("grep honors maxMatches and reports the cap", async () => {
    const rel = setup("many.txt", numbered(30));
    const out = await read({ path: rel, pattern: "line", maxMatches: 3 });
    expect(out).toContain("(30, showing first 3):");
    expect(out.split("\n").slice(1)).toHaveLength(3);
  });

  test("grep within a line range keeps the ORIGINAL line numbers", async () => {
    const rel = setup("log.txt", "info: a\nerror: b\ninfo: c\nerror: d\ninfo: e");
    const out = await read({ path: rel, startLine: 3, endLine: 5, pattern: "error" });
    expect(out).toContain("4: error: d"); // not "2: ..."
  });

  test("no matches and invalid patterns report cleanly", async () => {
    const rel = setup("log.txt", "nothing here");
    expect(await read({ path: rel, pattern: "zebra" })).toBe(`grep: no matches for /zebra/ in ${rel}`);
    await expect(read({ path: rel, pattern: "([bad" })).rejects.toThrow("Invalid pattern. Use a valid regular expression.");
  });
});
