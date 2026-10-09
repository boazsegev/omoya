import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Context from "../lib/context.js";

const immutableFields = ["id", "dir", "uuid", "file", "origin", "created"];
const message = { type: 2, content: [{ type: "text", text: "hello" }] };

function temporarySessions(run) {
  const root = join(process.cwd(), "ai-tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "context-identity-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("identity getters reject external writes without shadowing or changing persistence", () => temporarySessions((dir) => {
  const context = new Context({ id: "first", dir, origin: "original", messages: [message] });
  context.flush();
  const before = Object.fromEntries(immutableFields.map((field) => [field, context[field]]));
  for (const field of immutableFields) {
    expect(() => { context[field] = `forged-${field}`; }).toThrow(TypeError);
    expect(context[field]).toBe(before[field]);
    expect(Object.hasOwn(context, field)).toBe(false);
  }
  context.flush();
  expect(JSON.parse(readFileSync(context.file, "utf8").split("\n")[0])).toMatchObject({
    id: before.id, uuid: before.uuid, cwd: before.origin, created: before.created,
  });
}));

test("rename and resume retain internal identity transitions and the loaded file", () => temporarySessions((dir) => {
  const context = new Context({ id: "first", dir, origin: "original", messages: [message] });
  context.flush();
  const originalUuid = context.uuid;
  const originalCreated = context.created;
  const oldFile = context.file;
  const renamed = context.rename("second");
  expect(renamed).toEqual({ id: "second", file: context.file });
  expect(context.file).not.toBe(oldFile);
  expect(context.uuid).toBe(originalUuid);
  expect(context.created).toBe(originalCreated);
  const loaded = Context.resume({ id: "second", dir });
  expect(loaded.id).toBe("second");
  expect(loaded.file).toBe(context.file);
  expect(loaded.origin).toBe("original");
  expect(loaded.created).toBe(originalCreated);
  expect(loaded.uuid).toBe(originalUuid);
  for (const field of immutableFields) expect(() => { loaded[field] = "forged"; }).toThrow(TypeError);
  loaded.append({ type: 3, content: [{ type: "text", text: "reply" }] });
  loaded.flush();
  expect(Context.resume({ id: "second", dir }).length).toBe(2);
}));

test("anonymous spellings normalize to a falsy id inside Context and never log until enabled", () => temporarySessions((dir) => {
  expect(Object.hasOwn(Context, "idAnonymous")).toBe(false);
  for (const id of [false, "0", "false", "anon"]) {
    const context = new Context({ id, dir, save: true, messages: [message] });
    expect(!context.id).toBe(true);
    expect(context.save).toBe(false);
    context.flush();
    context.save = true;
    expect(context.id).toBeTruthy();
    context.flush();
    expect(JSON.parse(readFileSync(context.file, "utf8").split("\n")[0]).id).toBe(context.id);
  }
}));

test("name remains assignable without silently changing the stable id", () => {
  const context = new Context({ id: "first", save: false });
  context.name = "display label";
  expect(context.name).toBe("display label");
  expect(context.id).toBe("first");
});
