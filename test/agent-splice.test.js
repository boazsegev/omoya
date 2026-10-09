import { test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import "../lib/env.js";
import { splice, toolDescription } from "../tools/splice.js";
import { editUndo, edit } from "../tools/edit.js";

const root = `./ai-tmp/splice-test-${process.pid}`;
afterEach(() => rmSync(root, { recursive: true, force: true }));
function seed(name, content) {
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/${name}`, content);
  return `${root}/${name}`;
}

test("splice copies selected lines without modifying source and edit-undo restores target", async () => {
  const source = seed("source.txt", "ignore\nnew a\nnew b\n");
  const target = seed("target.txt", "one\r\ntwo\r\nthree\r\nfour\r\n");
  const context = { call: { callId: "splice-1" } };
  const out = await splice({ source: { path: source, from: 2, to: 3 }, target: { path: target, from: 2, to: 3 } }, context);
  expect(out.result).toContain("Edit id: splice-1");
  expect(readFileSync(target, "utf8")).toBe("one\r\nnew a\r\nnew b\r\nfour\r\n");
  expect(readFileSync(source, "utf8")).toBe("ignore\nnew a\nnew b\n");
  rmSync(source);
  await editUndo({ path: target, editId: "splice-1" }, { call: { callId: "splice-2" } });
  expect(readFileSync(target, "utf8")).toBe("one\r\ntwo\r\nthree\r\nfour\r\n");
  await editUndo({ path: target, editId: "splice-2" });
  expect(readFileSync(target, "utf8")).toBe("one\r\nnew a\r\nnew b\r\nfour\r\n");
});

test("splice insert can be undone only while resulting file has not drifted", async () => {
  const source = seed("source.txt", "insert\n");
  const target = seed("target.txt", "one\ntwo\n");
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 2 } }, { call: { callId: "ins-1" } });
  expect(readFileSync(target, "utf8")).toBe("one\ninsert\ntwo\n");
  await editUndo({ path: target, editId: "ins-1" });
  expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
});

test("splice treats matching at/from/to as insertion and supports undo", async () => {
  const source = seed("source.txt", "insert\n");
  const target = seed("target.txt", "one\ntwo\n");
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 2, from: 2, to: 2 } }, { call: { callId: "equal-1" } });
  expect(readFileSync(target, "utf8")).toBe("one\ninsert\ntwo\n");
  await editUndo({ path: target, editId: "equal-1" });
  expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 3, from: 3, to: 3 } });
  expect(readFileSync(target, "utf8")).toBe("one\ntwo\ninsert\n");
});

test("edit-undo refuses a deletion after any drift, without consuming the record", async () => {
  const target = seed("target.txt", "one\ntwo\nthree\n");
  await edit({ path: target, edits: [{ oldText: "two\n", newText: "" }] }, { call: { callId: "del-1" } });
  writeFileSync(target, "one\nother\nthree\n");
  await expect(editUndo({ path: target, editId: "del-1" })).rejects.toThrow(/changed since this edit/);
  expect(readFileSync(target, "utf8")).toBe("one\nother\nthree\n");
  writeFileSync(target, "one\nthree\n");
  await editUndo({ path: target, editId: "del-1" });
  expect(readFileSync(target, "utf8")).toBe("one\ntwo\nthree\n");
});

test("splice appends after an unterminated last line and undo restores it", async () => {
  const source = seed("source.txt", "added");
  const target = seed("target.txt", "last");
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 2 } }, { call: { callId: "append-1" } });
  expect(readFileSync(target, "utf8")).toBe("last\nadded");
  await editUndo({ path: target, editId: "append-1" });
  expect(readFileSync(target, "utf8")).toBe("last");
});

test("splice refuses drift in the inserted range before edit-undo", async () => {
  const source = seed("source.txt", "replacement\n");
  const target = seed("target.txt", "old\n");
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, from: 1, to: 1 } }, { call: { callId: "drift-1" } });
  writeFileSync(target, "changed\n");
  await expect(editUndo({ path: target, editId: "drift-1" })).rejects.toThrow(/changed since this edit/);
  expect(readFileSync(target, "utf8")).toBe("changed\n");
});

test("splice rejects paths outside the agent and symbolic links", async () => {
  const project = `${root}/project`;
  const folder = `${project}/agent`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/source.txt`, "replacement\n");
  writeFileSync(`${folder}/target.txt`, "old\n");
  writeFileSync(`${project}/sibling.txt`, "outside\n");
  symlinkSync("source.txt", `${folder}/link.txt`);
  symlinkSync("target.txt", `${folder}/target-link.txt`);
  const context = { agent: { folder }, env: { folder: project } };
  await expect(splice({ source: { path: "../sibling.txt", from: 1, to: 1 }, target: { path: "target.txt", from: 1, to: 1 } }, context)).rejects.toThrow(/boundary/);
  await expect(splice({ source: { path: "link.txt", from: 1, to: 1 }, target: { path: "target.txt", from: 1, to: 1 } }, context)).rejects.toThrow(/symbolic links/);
  await expect(splice({ source: { path: "source.txt", from: 1, to: 1 }, target: { path: "../sibling.txt", from: 1, to: 1 } }, context)).rejects.toThrow(/boundary/);
  await expect(splice({ source: { path: "source.txt", from: 1, to: 1 }, target: { path: "target-link.txt", from: 1, to: 1 } }, context)).rejects.toThrow(/symbolic links/);
  expect(readFileSync(`${folder}/target.txt`, "utf8")).toBe("old\n");
});

test("splice copies pre-approved content without a second permission prompt", async () => {
  const restricted = ["", "etc", "passwd"].join("/");
  const source = seed("source.txt", `cat ${restricted}\n`);
  const target = seed("target.txt", "old\n");
  let prompted = false;
  await splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, from: 1, to: 1 } }, {
    question: { ask: async () => { prompted = true; throw new Error("unexpected prompt"); } },
  });
  expect(prompted).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(`cat ${restricted}\n`);
  expect(toolDescription().splice.inputSchema.properties.ask).toBeUndefined();
  await expect(splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, from: 1, to: 1 }, ask: true })).rejects.toThrow(/only source and target/);
});

test("splice refuses out-of-range coordinates and same-file copies", async () => {
  const source = seed("source.txt", "a\n");
  const target = seed("target.txt", "b\n");
  await expect(splice({ source: { path: source, from: 1, to: 2 }, target: { path: target, from: 1, to: 1 } })).rejects.toThrow(RangeError);
  await expect(splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, from: 0, to: 1 } })).rejects.toThrow(RangeError);
  await expect(splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 1, from: 1, to: 2 } })).rejects.toThrow(RangeError);
  await expect(splice({ source: { path: source, from: 1, to: 1 }, target: { path: target, at: 1, from: 1 } })).rejects.toThrow(RangeError);
  await expect(splice({ source: { path: target, from: 1, to: 1 }, target: { path: target, from: 1, to: 1 } })).rejects.toThrow(/different files/);
  expect(readFileSync(target, "utf8")).toBe("b\n");
});
