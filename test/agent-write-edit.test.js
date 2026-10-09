// test/agent-write-edit.test.js — proof for the write/edit tools:
// pi semantics (write creates parents and overwrites; edit matches
// edits[] against the ORIGINAL, unique and non-overlapping) guarded
// by the DETERMINISTIC path resolver (tools/guard/resolve.js — the
// path argument, resolved and refused outside the Agent folder)
// and the fast-path content trip-wire
// (tools/guard/paths.js — persisted content scanned for
// path-traversal strings; shebang-exempt; backslash escape sequences
// like `\n` are text, not path separators). write runs under the OS
// write sandbox (sandbox: true — the kernel jail is the enforcement,
// the scan the trip-wire; refusal only, no ask flow). edit keeps the
// ask:true permission flow through the question bridge.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import "../lib/env.js"; // sets the global Env the tool wrappers stamp with
import { write, toolDescription as writeDescription } from "../tools/write.js";
import { edit, editUndo, toolDescription as editDescription } from "../tools/edit.js";
import { findTraversal, findWriteTraversal, traversalSnippet } from "../tools/guard/paths.js";
import Agent from "../lib/agent.js";
import { testEnv } from "./fakes.js";
import { toolsLoad } from "./env-internals.js";

const ROOT = `./ai-tmp/write-edit-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));
const rel = (name) => `${ROOT}/${name}`;
const seed = (name, content) => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(rel(name), content);
};

describe("write tool (pi semantics)", () => {
  test("writes a file, creating parent directories; overwrites", async () => {
    expect(await write({ path: rel("a/b/c.txt"), content: "hello" })).toBe("Successfully wrote 5 bytes to " + rel("a/b/c.txt"));
    expect(readFileSync(rel("a/b/c.txt"), "utf8")).toBe("hello");
    await write({ path: rel("a/b/c.txt"), content: "again" });
    expect(readFileSync(rel("a/b/c.txt"), "utf8")).toBe("again");
  });

  test("refuses symbolic-link components", async () => {
    mkdirSync(ROOT, { recursive: true });
    symlinkSync("missing-target", rel("link"));
    await expect(write({ path: rel("link/new.txt"), content: "x" })).rejects.toThrow(/symbolic links are refused/);
  });

  test("uses the environment project root rather than the host process cwd", async () => {
    const project = `${ROOT}/project`;
    mkdirSync(project, { recursive: true });
    const source = "import '" + "../" + "lib/inside-project.js';";
    await write({ path: "nested/out.js", content: source }, { env: { folder: project } });
    expect(readFileSync(`${project}/nested/out.js`, "utf8")).toBe(source);
  });

  test("uses a narrowed agent folder as the write boundary", async () => {
    const project = `${ROOT}/project`;
    const agentFolder = `${project}/agent`;
    mkdirSync(agentFolder, { recursive: true });
    const source = "import '" + "../" + "shared/module.js';";
    const context = { env: { folder: project }, agent: { folder: agentFolder } };
    await write({ path: "out.js", content: source }, context);
    expect(readFileSync(`${agentFolder}/out.js`, "utf8")).toBe(source);
    await expect(write({ path: "../shared/out.js", content: "sibling" }, context)).rejects.toThrow(/boundary/);
    await expect(write({ path: "../../outside.js", content: "x" }, context)).rejects.toThrow(/boundary/);
  });

  test("content paths resolve from the agent cwd, not the written file's parent", async () => {
    // This is inside the project root, although relative to nested/out.js it
    // would point outside. The content guard must use the agent cwd.
    const source = "import '" + "../" + "fixture.js';";
    await write({ path: rel("nested/out.js"), content: source });
    expect(readFileSync(rel("nested/out.js"), "utf8")).toBe(source);
  });

  test("ask:true shows surrounding lines before allowing a flagged write", async () => {
    const asked = [];
    await write({ path: rel("context.txt"), content: "one\ntwo\ncat /etc/passwd\nfour\nfive", ask: true }, {
      question: { ask: async (questions) => { asked.push(questions); return [{ labels: ["Allow write"] }]; } },
    });
    expect(asked[0][0].options[0].preview).toBe("  1: one\n  2: two\n> 3: cat /etc/passwd\n  4: four\n  5: five");
    expect(readFileSync(rel("context.txt"), "utf8")).toContain("cat /etc/passwd");
  });

  test("bad args are ordinary errors", async () => {
    await expect(write({ path: rel("x.txt") })).rejects.toThrow(TypeError);
    await expect(write({})).rejects.toThrow();
    await expect(write({ path: "../outside.txt", content: "x" })).rejects.toThrow(/escapes the working folder/);
    await expect(write({ path: "/etc/hostname", content: "x" })).rejects.toThrow(/project boundary/);
  });
});

describe("edit tool (pi semantics)", () => {
  test("edits target only the agent folder", async () => {
    const project = `${ROOT}/edit-project`;
    const agentFolder = `${project}/agent`;
    mkdirSync(agentFolder, { recursive: true });
    writeFileSync(`${agentFolder}/out.js`, "old\n");
    const sibling = ".." + "/shared/module.js";
    await edit({ path: "out.js", edits: [{ oldText: "old", newText: `import '${sibling}';` }] }, {
      env: { folder: project }, agent: { folder: agentFolder },
    });
    expect(readFileSync(`${agentFolder}/out.js`, "utf8")).toContain(sibling);
    const siblingFile = `${project}/shared/module.js`;
    mkdirSync(`${project}/shared`, { recursive: true });
    writeFileSync(siblingFile, "old sibling\n");
    await expect(edit({ path: sibling, edits: [{ oldText: "old sibling", newText: "new sibling" }] }, {
      env: { folder: project }, agent: { folder: agentFolder },
    })).rejects.toThrow(/boundary/);
    expect(readFileSync(siblingFile, "utf8")).toContain("old sibling");
    await expect(edit({ path: "../../outside.txt", edits: [{ oldText: "x", newText: "y" }] }, {
      env: { folder: project }, agent: { folder: agentFolder },
    })).rejects.toThrow(/boundary/);
  });

  test("edits match against the ORIGINAL; the result replaces all blocks", async () => {
    seed("e.txt", "one two three\n");
    const out = await edit({ path: rel("e.txt"), edits: [
      { oldText: "one", newText: "1" },
      { oldText: "three", newText: "3" },
    ] });
    expect(out.result).toBe(`Replaced 2 block(s) in ${rel("e.txt")}.`);
    expect(out.display).toContain("--- a/"); // the display-only unified patch
    expect(out.display).toContain("-one two three");
    expect(out.display).toContain("+1 two 3");
    expect(readFileSync(rel("e.txt"), "utf8")).toBe("1 two 3\n");
  });

  test("context lines never mimic fenced diff delimiters", async () => {
    seed("fence-context.txt", "before\n```diff\nold\n```\nafter\n");
    const out = await edit({ path: rel("fence-context.txt"), edits: [{ oldText: "old", newText: "new" }] });
    expect(out.display).toStartWith("```diff\n");
    expect(out.display).toEndWith("\n```");
    expect(out.display).not.toMatch(/^ {1,3}```(?:diff)?\s*$/m);
  });

  test("schema requires path alongside rollback — a rollback is intentional", () => {
    const schema = editDescription().edit.inputSchema;
    expect(schema.required).toEqual(["path", "edits"]);
    expect(schema.properties.rollback).toBeUndefined();
    expect(schema.properties.matchAll).toBeUndefined();
    expect(schema.properties.edits.items.properties.matchAll.type).toBe("boolean");
    expect(editDescription()["edit-undo"].inputSchema.required).toEqual(["path", "editId"]);
  });
  test("rollback reverses a recorded edit by its tool call id (and records itself — a redo)", async () => {
    seed("r.txt", "alpha beta gamma\n");
    const context = { call: { callId: "agent-7", name: "edit" } };
    const out = await edit({ path: rel("r.txt"), edits: [{ oldText: "beta", newText: "BETA" }] }, context);
    expect(out.result).toMatch(/\bEdit id: \S+/);
    expect(readFileSync(rel("r.txt"), "utf8")).toBe("alpha BETA gamma\n");
    // the rollback: the path names the file the id belongs to — the
    // record carries the edits
    const back = await editUndo({ path: rel("r.txt"), editId: "agent-7" }, { call: { callId: "agent-8", name: "edit" } });
    expect(back.result).toContain("Undid edit: restored 1 block(s)");
    expect(back.display).toContain("-alpha BETA gamma");
    expect(back.display).toContain("+alpha beta gamma");
    expect(readFileSync(rel("r.txt"), "utf8")).toBe("alpha beta gamma\n");
    // the redo: the rollback recorded itself under its own call id
    await editUndo({ path: rel("r.txt"), editId: "agent-8" });
    expect(readFileSync(rel("r.txt"), "utf8")).toBe("alpha BETA gamma\n");
    // consumed: a third rollback of the same id reports the unknown edit
    await expect(editUndo({ path: rel("r.txt"), editId: "agent-8" })).rejects.toThrow(/^Use an edit id returned/);
  });

  test("a rollback requires the path the edit id belongs to — and the record survives a mismatch", async () => {
    seed("rb-path.txt", "alpha beta\n");
    await edit({ path: rel("rb-path.txt"), edits: [{ oldText: "beta", newText: "BETA" }] }, { call: { callId: "agent-12", name: "edit" } });
    // no path at all: a TypeError, like the other bad-argument errors
    await expect(editUndo({ editId: "agent-12" })).rejects.toThrow(TypeError);
    // a path that does not match the record refuses BEFORE the rewrite
    await expect(editUndo({ path: rel("other.txt"), editId: "agent-12" })).rejects.toThrow(/^Use the `path` matching the `editId`/);
    expect(readFileSync(rel("rb-path.txt"), "utf8")).toBe("alpha BETA\n"); // untouched
    // a mismatched rollback is not consumed: the right path still rolls back
    await editUndo({ path: rel("rb-path.txt"), editId: "agent-12" });
    expect(readFileSync(rel("rb-path.txt"), "utf8")).toBe("alpha beta\n");
  });

  test("edit and undo reject misplaced arguments", async () => {
    seed("f.txt", "one two\n");
    await expect(edit({ path: rel("f.txt"), rollback: "unknown" })).rejects.toThrow(TypeError);
    await expect(editUndo({ path: rel("f.txt") })).rejects.toThrow(TypeError);
    await expect(edit({ path: rel("f.txt"), edits: [{ oldText: "one", newText: "1", matchAll: "true" }] })).rejects.toThrow(TypeError);
    expect(readFileSync(rel("f.txt"), "utf8")).toBe("one two\n");
  });

  test("a rollback refuses honestly when the file drifted since the edit — and stays retryable", async () => {
    seed("d.txt", "one two\n");
    await edit({ path: rel("d.txt"), edits: [{ oldText: "two", newText: "2" }] }, { call: { callId: "agent-9", name: "edit" } });
    writeFileSync(rel("d.txt"), "one changed-by-someone-else\n");
    await expect(editUndo({ path: rel("d.txt"), editId: "agent-9" })).rejects.toThrow(/^The file changed since this edit/);
    expect(readFileSync(rel("d.txt"), "utf8")).toBe("one changed-by-someone-else\n"); // untouched
    // the record survives the failed rollback: reconcile the file and retry
    writeFileSync(rel("d.txt"), "one 2\n");
    await editUndo({ path: rel("d.txt"), editId: "agent-9" });
    expect(readFileSync(rel("d.txt"), "utf8")).toBe("one two\n");
  });

  test("a rollback restores EXACTLY the edited region even when drift duplicated the replacement text", async () => {
    seed("dup.txt", "one two\n");
    await edit({ path: rel("dup.txt"), edits: [{ oldText: "two", newText: "2" }] }, { call: { callId: "agent-10", name: "edit" } });
    // unrelated drift APPENDS another "2" — the old swapped-text match
    // would have refused (duplicate); the recorded offset restores anyway
    writeFileSync(rel("dup.txt"), "one 2\n2\n");
    await editUndo({ path: rel("dup.txt"), editId: "agent-10" });
    expect(readFileSync(rel("dup.txt"), "utf8")).toBe("one two\n2\n");
  });

  test("matchAll replaces every occurrence, and its rollback restores all of them", async () => {
    seed("m.txt", "ab ab ab\n");
    await expect(edit({ path: rel("m.txt"), edits: [{ oldText: "ab", newText: "x" }] }))
      .rejects.toThrow(/matchAll: true/); // unique mode still refuses duplicates
    const out = await edit({ path: rel("m.txt"), edits: [{ oldText: "ab", newText: "x", matchAll: true }] }, { call: { callId: "agent-11", name: "edit" } });
    expect(readFileSync(rel("m.txt"), "utf8")).toBe("x x x\n");
    await editUndo({ path: rel("m.txt"), editId: "agent-11" });
    expect(readFileSync(rel("m.txt"), "utf8")).toBe("ab ab ab\n");
  });

  test("each edit chooses its own match mode and undo restores mixed matches", async () => {
    seed("mixed.txt", "ab cd ab ef\n");
    const context = { call: { callId: "mixed-edit", name: "edit" } };
    await edit({ path: rel("mixed.txt"), edits: [
      { oldText: "ab", newText: "x", matchAll: true },
      { oldText: "cd", newText: "longer", matchAll: false },
      { oldText: "ef", newText: "z" },
    ] }, context);
    expect(readFileSync(rel("mixed.txt"), "utf8")).toBe("x longer x z\n");
    await editUndo({ path: rel("mixed.txt"), editId: "mixed-edit" });
    expect(readFileSync(rel("mixed.txt"), "utf8")).toBe("ab cd ab ef\n");
    await expect(edit({ path: rel("mixed.txt"), edits: [
      { oldText: "ab", newText: "x", matchAll: true },
      { oldText: "ab", newText: "y" },
    ] })).rejects.toThrow(/matches more than once/);
    expect(readFileSync(rel("mixed.txt"), "utf8")).toBe("ab cd ab ef\n");
  });

  test("manual Env.toolCall retains edit rollback storage when writable and honors Agent safe mode", async () => {
    seed("manual.txt", "alpha\n");
    const env = await testEnv({}, { cwd: process.cwd() });
    await toolsLoad(env, { dirs: ["./tools"] });
    const agent = await Agent.create({ env });
    const path = rel("manual.txt");
    try {
      if (!agent.can.write) {
        // Linux CI without bubblewrap forces read-only mode at construction;
        // editing must be refused, never bypass the security gate for this test.
        await expect(env.toolCall("edit", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }, { agent }))
          .rejects.toThrow(/safe mode/);
        expect(readFileSync(path, "utf8")).toBe("alpha\n");
        return;
      }
      await expect(env.toolCall("edit", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }, { agent, call: { callId: "manual-edit" } }))
        .resolves.toHaveProperty("result");
      expect(readFileSync(path, "utf8")).toBe("ALPHA\n");
      await env.toolCall("edit-undo", { path, editId: "manual-edit" }, { agent });
      expect(readFileSync(path, "utf8")).toBe("alpha\n");
      agent.can.write = false;
      await expect(env.toolCall("edit", { path, edits: [{ oldText: "alpha", newText: "unsafe" }] }, { agent }))
        .rejects.toThrow(/safe mode/);
      expect(readFileSync(path, "utf8")).toBe("alpha\n");
    } finally {
      agent.close();
      env.close();
    }
  });

  test("edit records live in the CALLING AGENT's session store — another agent cannot roll them back", async () => {
    seed("iso.txt", "alpha\n");
    const storage = {};
    const agent = { folder: process.cwd() };
    await edit({ path: rel("iso.txt"), edits: [{ oldText: "alpha", newText: "ALPHA" }] }, { agent, storage, call: { callId: "a-1", name: "edit" } });
    expect(readFileSync(rel("iso.txt"), "utf8")).toBe("ALPHA\n");
    // a different agent (its own empty store) does not see the id
    const other = { folder: process.cwd() };
    const otherStorage = {};
    await expect(editUndo({ path: rel("iso.txt"), editId: "a-1" }, { agent: other, storage: otherStorage })).rejects.toThrow(/^Use an edit id returned by a recent successful edit/);
    expect(readFileSync(rel("iso.txt"), "utf8")).toBe("ALPHA\n"); // untouched
    // the owning agent rolls back fine
    await editUndo({ path: rel("iso.txt"), editId: "a-1" }, { agent, storage });
    expect(readFileSync(rel("iso.txt"), "utf8")).toBe("alpha\n");
  });

  test("a rollback resolves against the agent's narrowed folder and refuses symlinks", async () => {
    const project = `${ROOT}/rb-project`;
    const agentFolder = `${project}/agent`;
    mkdirSync(agentFolder, { recursive: true });
    writeFileSync(`${agentFolder}/out.js`, "old\n");
    const storage = {}; // dispatch supplies the SAME store every call
    const agent = { folder: agentFolder };
    const context = { env: { folder: project }, agent, storage, call: { callId: "a-2", name: "edit" } };
    await edit({ path: "out.js", edits: [{ oldText: "old", newText: "new" }] }, context);
    expect(readFileSync(`${agentFolder}/out.js`, "utf8")).toBe("new\n");
    // the rollback resolves against the agent folder (not the process cwd)
    await editUndo({ path: "out.js", editId: "a-2" }, context);
    expect(readFileSync(`${agentFolder}/out.js`, "utf8")).toBe("old\n");
    // a symlink planted at the path is refused by edit AND by rollback
    const realTarget = `${project}/real.txt`;
    writeFileSync(realTarget, "safe\n");
    const link = `${agentFolder}/linked.txt`;
    symlinkSync("../real.txt", link);
    await expect(edit({ path: "linked.txt", edits: [{ oldText: "safe", newText: "x" }] }, context))
      .rejects.toThrow(/symbolic links are refused/);
    expect(readFileSync(realTarget, "utf8")).toBe("safe\n");
  });

  test("a rollback preserves the file's ORIGINAL dominant line ending", async () => {
    seed("crlf-rb.txt", "one\r\ntwo\r\n");
    const context = { call: { callId: "a-3", name: "edit" } };
    await edit({ path: rel("crlf-rb.txt"), edits: [{ oldText: "two", newText: "2" }] }, context);
    expect(readFileSync(rel("crlf-rb.txt"), "utf8")).toBe("one\r\n2\r\n");
    // the rollback restores the region under the RECORDED ending — it
    // never re-detects (a drifted dominant style would otherwise make
    // the rollback rewrite the whole file's line endings)
    await editUndo({ path: rel("crlf-rb.txt"), editId: "a-3" }, context);
    expect(readFileSync(rel("crlf-rb.txt"), "utf8")).toBe("one\r\ntwo\r\n");
  });

  test("oldText must be unique; missing and overlapping edits are errors", async () => {
    seed("u.txt", "ab ab\n");
    await expect(edit({ path: rel("u.txt"), edits: [{ oldText: "ab", newText: "x" }] }))
      .rejects.toThrow(/^oldText matches more than once/);
    await expect(edit({ path: rel("u.txt"), edits: [{ oldText: "zz", newText: "x" }] }))
      .rejects.toThrow(/^oldText was not found in the file/);
    seed("o.txt", "abcd\n");
    await expect(edit({ path: rel("o.txt"), edits: [
      { oldText: "abc", newText: "x" },
      { oldText: "bcd", newText: "y" },
    ] })).rejects.toThrow(/Edits 1 and 2 overlap/);
    await expect(edit({ path: rel("o.txt"), edits: [] })).rejects.toThrow(TypeError);
    await expect(edit({ path: rel("missing.txt"), edits: [{ oldText: "a", newText: "b" }] }))
      .rejects.toThrow(/ENOENT/);
  });

  test("a failing batch writes NOTHING (all edits apply in memory, the file saves in one go)", async () => {
    // the single-write contract: the file is read once, every edit is
    // computed in memory, and one save lands the result — so any
    // failure mid-batch leaves the file byte-identical (no partial state)
    seed("atomic.txt", "one two three\n");
    await expect(edit({ path: rel("atomic.txt"), edits: [
      { oldText: "one", newText: "1" },
      { oldText: "two", newText: "2" },
      { oldText: "missing", newText: "?" },
    ] })).rejects.toThrow(/^oldText was not found in the file/);
    expect(readFileSync(rel("atomic.txt"), "utf8")).toBe("one two three\n"); // untouched
    await expect(edit({ path: rel("atomic.txt"), edits: [
      { oldText: "one two", newText: "1 2" },
      { oldText: "two three", newText: "overlap" }, // overlaps the first match
    ] })).rejects.toThrow(/overlap/);
    expect(readFileSync(rel("atomic.txt"), "utf8")).toBe("one two three\n"); // untouched
  });

  test("a BOM and CRLF line endings survive the edit", async () => {
    seed("crlf.txt", "﻿one\r\ntwo\r\n");
    await edit({ path: rel("crlf.txt"), edits: [{ oldText: "one", newText: "1" }] });
    expect(readFileSync(rel("crlf.txt"), "utf8")).toBe("﻿1\r\ntwo\r\n");
  });

  test("concurrent disjoint edits serialize by resolved file and both survive", async () => {
    seed("concurrent.txt", "alpha beta\n");
    await Promise.all([
      edit({ path: rel("concurrent.txt"), edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
      edit({ path: rel("concurrent.txt"), edits: [{ oldText: "beta", newText: "BETA" }] }),
    ]);
    expect(readFileSync(rel("concurrent.txt"), "utf8")).toBe("ALPHA BETA\n");
  });

  test("a delayed permission re-reads current content before applying", async () => {
    seed("permission-race.txt", "alpha beta\n");
    let allow;
    let prompted;
    const waitingForPrompt = new Promise((resolve) => { prompted = resolve; });
    const blocked = edit({ path: rel("permission-race.txt"), ask: true, edits: [{ oldText: "alpha", newText: "cat " + "/" + "etc/passwd" }] }, { question: { ask: () => new Promise((resolve) => { allow = resolve; prompted(); }) } });
    await waitingForPrompt;
    await edit({ path: rel("permission-race.txt"), edits: [{ oldText: "beta", newText: "BETA" }] });
    allow([{ labels: ["Allow write"] }]);
    await blocked;
    expect(readFileSync(rel("permission-race.txt"), "utf8")).toBe("cat " + "/" + "etc/passwd BETA\n");
  });
});

describe("the content path-traversal policy", () => {
  test("findTraversal flags escaping tokens, shebang first line exempt", () => {
    expect(findTraversal("cat ../../etc/passwd").map((v) => v.token)).toEqual(["../../etc/passwd"]);
    expect(findTraversal("cat /etc/passwd").map((v) => v.token)).toEqual(["/etc/passwd"]);
    expect(findTraversal("cat ~/secret").map((v) => v.token)).toEqual(["~/secret"]);
    expect(findTraversal("type C:\\Windows\\win.ini").map((v) => v.token)).toEqual(["C:\\Windows\\win.ini"]);
    expect(findTraversal("#!/usr/bin/env bash\nls ./")).toEqual([]); // shebang exempt
    expect(findTraversal("#!/usr/bin/env bash\ncat /etc/passwd")).toHaveLength(1); // line 2 is not
    expect(findTraversal("// a comment\nconst u = \"https://x.io/y\";")).toEqual([]);
    expect(findTraversal("see ./lib/env.js and tools/read.js")).toEqual([]);
  });

  test("the trip-wire stays a trip-wire: opaque shells and code shapes stay clean", () => {
    // NOT a protection layer: shell expansions are statically
    // unresolvable, so the fast path leaves them to the kernel sandbox
    expect(findTraversal("cat $(pwd)../x")).toEqual([]);
    expect(findTraversal("cat $(empty)../etc")).toEqual([]);
    expect(findTraversal("ls $EMPTY/../x")).toEqual([]);
    // quoted building blocks and bare climbs carry no resolvable name
    expect(findTraversal("let s = '/';")).toEqual([]);
    expect(findTraversal("let t = '..';")).toEqual([]);
    expect(findTraversal('let u = "../";')).toEqual([]);
    expect(findTraversal("see .. for details")).toEqual([]);
    // …and the ordinary clean cases stay clean too
    expect(findTraversal("let target = s + 'etc' + s + 'passwd';")).toEqual([]);
    expect(findTraversal("const ROOT = \"$(pwd)/sub\";")).toEqual([]);
    expect(findTraversal("no `..` escape")).toEqual([]); // backticks = docs
    expect(findTraversal("const a = 1 / 2;")).toEqual([]); // division
    expect(findTraversal("text.split(' / ')")).toEqual([]); // a delimiter, not a path
    expect(findTraversal("echo ...")).toEqual([]); // an ellipsis is not a climb
    // the mistakes the trip-wire EXISTS for still trip it
    expect(findTraversal("cat ../../etc/passwd")).toHaveLength(1);
    expect(findTraversal("cat /etc/passwd")).toHaveLength(1);
  });

  test("traversalSnippet centers the offending line with a > marker", () => {
    const content = "l1\nl2\nl3\nl4 cat /etc/x\nl5\nl6\nl7";
    const snippet = traversalSnippet(content, 4);
    expect(snippet).toBe("  2: l2\n  3: l3\n> 4: l4 cat /etc/x\n  5: l5\n  6: l6");
  });

  test("write's lax scan permits ordinary path-like code but flags known host roots", async () => {
    expect(await findWriteTraversal("const next = /continue;\nconst path = /tool-write;")).toEqual([]);
    expect(await findWriteTraversal("context/private")).toEqual([]);
    expect((await findWriteTraversal("read ~/.")).map((v) => v.token)).toEqual(["~/."]);
    await write({ path: rel("slash-word.txt"), content: "context/private" });
    expect(readFileSync(rel("slash-word.txt"), "utf8")).toBe("context/private");
    expect(await findWriteTraversal("run ./bin/ai-tools2bash and read " + "../" + "lib/env.js")).toEqual([]);
    mkdirSync(`${ROOT}/nested/child`, { recursive: true });
    const packageRoot = "../" + "..";
    const importMetaSource = 'const root = fileURLToPath(new URL("' + packageRoot + '", import.meta.url));';
    expect(await findWriteTraversal(importMetaSource, { cwd: `${ROOT}/nested/child` })).toEqual([]);
    seed("provider-registry.js", "const root = null;\n");
    await edit({ path: rel("provider-registry.js"), edits: [{ oldText: "null", newText: 'fileURLToPath(new URL("' + packageRoot + '", import.meta.url))' }] });
    expect(readFileSync(rel("provider-registry.js"), "utf8")).toContain(importMetaSource);
    await write({ path: rel("ordinary.js"), content: "const next = /continue;\nconst path = /tool-write;" });
    const err = await write({ path: rel("t1.sh"), content: "cat /etc/passwd" }).catch((e) => e);
    expect(err.message).toMatch(/path traversal refused/);
    expect(err.message).toContain("ask: true"); // write can request informed permission
    expect(err.system).toBeUndefined(); // no system message rides along anymore
    seed("t2.txt", "ok\n");
    await expect(edit({ path: rel("t2.txt"), edits: [{ oldText: "ok", newText: "cat /etc/passwd" }] }))
      .rejects.toThrow(/path traversal refused/);
  });

  test("write asks through an available bridge automatically", async () => {
    const schema = writeDescription().write;
    expect(schema.interactive).toBeUndefined();
    const asked = [];
    await write({ path: rel("automatic-ask.txt"), content: "cat " + "/" + "etc/passwd" }, {
      question: { ask: async (questions) => { asked.push(questions); return [{ labels: ["Allow write"] }]; } },
    });
    expect(asked).toHaveLength(1);
  });

  test("backslash escape sequences are TEXT, not path separators (scripting stays easy)", async () => {
    // the reported false positive: printf format strings like '\n---\n'
    const script = "#!/bin/sh\nprintf '\\n---\\n'\nprintf 'col1\\tcol2\\n'\necho '100%'\n";
    expect(findTraversal(script)).toEqual([]);
    await write({ path: rel("fmt.sh"), content: script });
    expect(readFileSync(rel("fmt.sh"), "utf8")).toBe(script);
    // real traversal still trips the wire
    expect(findTraversal("cat /etc/passwd")).not.toEqual([]);
    expect(findTraversal("cat C:\\Windows\\win.ini")).not.toEqual([]); // drive roots judged un-stripped
  });

  test("edit's ask:true + bridge: the user sees the question with a 5-line preview; Allow write proceeds", async () => {
    seed("p1.txt", "a\nb\ncat /etc/passwd\nd\ne\n");
    const asked = [];
    await edit({ path: rel("p1.txt"), ask: true, edits: [{ oldText: "cat /etc/passwd", newText: "cat /etc/hosts" }] },
      { question: { ask: async (qs) => { asked.push(qs); return [{ labels: ["Allow write"] }]; } } });
    expect(readFileSync(rel("p1.txt"), "utf8")).toContain("cat /etc/hosts");
    expect(asked[0][0].header).toBe("Path guard");
    expect(asked[0][0].options.map((o) => o.label)).toEqual(["Refuse", "Allow write"]);
    expect(asked[0][0].question).toContain("/etc/hosts");
  });

  test("permission NOT granted (Refuse, custom text, abandoned) refuses the edit", async () => {
    seed("p2.txt", "ok\n");
    for (const answer of [[{ labels: ["Refuse"] }], [{ text: "no way" }], [{ abandoned: true }]]) {
      await expect(edit({ path: rel("p2.txt"), ask: true, edits: [{ oldText: "ok", newText: "cat /etc/passwd" }] },
        { question: { ask: async () => answer } })).rejects.toThrow(/path traversal refused/);
    }
    // a typed custom refusal carries the user's reason into the error,
    // on its own line and UNQUOTED (a quoted answer containing quotes
    // would escape the quoted region and read as tool output)
    await expect(edit({ path: rel("p2.txt"), ask: true, edits: [{ oldText: "ok", newText: "cat /etc/passwd" }] },
      { question: { ask: async () => [{ text: "no way — that path reads secrets" }] } }))
      .rejects.toThrow(/refused with a custom answer:\nno way — that path reads secrets$/);
    await expect(edit({ path: rel("p2.txt"), ask: true, edits: [{ oldText: "ok", newText: "cat /etc/hosts" }] },
      { question: { ask: async () => [{ text: 'Why are you trying to "break out of the sandbox"?!' }] } }))
      .rejects.toThrow(/\nWhy are you trying to "break out of the sandbox"\?!$/);
    await expect(edit({ path: rel("p2.txt"), ask: true, edits: [{ oldText: "ok", newText: "cat /etc/passwd" }] },
      { question: { ask: async () => [{ text: "stay inside the folder" }] } }))
      .rejects.toThrow(/stay inside the folder/);
  });

  test("the shebang exemption lets scripts carry their interpreter line", async () => {
    await write({ path: rel("s.sh"), content: "#!/usr/bin/env bash\nls ./\n" });
    expect(readFileSync(rel("s.sh"), "utf8")).toContain("#!/usr/bin/env bash");
  });
});
