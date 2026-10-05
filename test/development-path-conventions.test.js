import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { findTraversal, findWriteTraversal, findCommandTraversal } from "../tools/guard/paths.js";
import { write } from "../tools/write.js";
import { read } from "../tools/read/read.js";
import { edit } from "../tools/edit.js";
import { bash } from "../tools/bash.js";

const ROOT = `./ai-tmp/development-conventions-${process.pid}`;
const systemPath = (...parts) => ["", ...parts].join("/");
const temporaryRoots = [systemPath("tmp"), systemPath("var", "tmp"), systemPath("private", "tmp"), systemPath("private", "var", "tmp"), tmpdir()];
const devices = ["null", "stdin", "stdout", "stderr", "tty", "zero", "full", "random", "urandom"].map((name) => systemPath("dev", name));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function setup() {
  mkdirSync(ROOT, { recursive: true });
  return { env: { cwd: resolve(ROOT), settings: {} } };
}

async function expectConvention(path, cwd) {
  const text = `const sink = ${JSON.stringify(path)};`;
  expect(findTraversal(text, { cwd })).toEqual([]);
  expect(await findWriteTraversal(text, { cwd })).toEqual([]);
  expect(await findCommandTraversal(`printf '%s' '${path}'`, { cwd })).toEqual([]);
}

describe("development path conventions", () => {
  test("temporary roots and children pass content and command trip-wires", async () => {
    const context = setup();
    for (const root of temporaryRoots) {
      await expectConvention(root, context.env.cwd);
      await expectConvention(`${root}/omoya-development-probe/file.txt`, context.env.cwd);
    }
    const fixture = `import { join } from 'node:path';\nconst probe = join(process.env.HOME ?? ${JSON.stringify(temporaryRoots[0])}, '.probe');\n`;
    await write({ path: "jailed.js", content: fixture }, context);
    expect(readFileSync(`${ROOT}/jailed.js`, "utf8")).toBe(fixture);
    const original = readFileSync("./test/tool-fixtures/jailed.js", "utf8");
    await write({ path: "actual-jailed.js", content: original }, context);
    expect(readFileSync(`${ROOT}/actual-jailed.js`, "utf8")).toBe(original);
    await read({ path: "jailed.js", target: "copy.js" }, context);
    expect(readFileSync(`${ROOT}/copy.js`, "utf8")).toBe(fixture);
    writeFileSync(`${ROOT}/edit.js`, "old");
    await edit({ path: "edit.js", edits: [{ oldText: "old", newText: fixture }] }, context);
    expect(readFileSync(`${ROOT}/edit.js`, "utf8")).toBe(fixture);
  });

  test("device and process descriptor conventions pass without rewriting scripts", async () => {
    const context = setup();
    for (const path of [...devices, systemPath("dev", "fd", "1"), systemPath("proc", "self", "fd", "2")]) {
      await expectConvention(path, context.env.cwd);
    }
    const script = `printf '\\n' >${devices[0]}\nprintf '%s' '${temporaryRoots[0]}'\n`;
    await write({ path: "script.sh", content: script }, context);
    expect(readFileSync(`${ROOT}/script.sh`, "utf8")).toBe(script);
    expect(await bash({ command: script }, context)).toBe(temporaryRoots[0]);
  });

  test("exceptions are component-bounded and do not relax real destination guards", async () => {
    const context = setup();
    const outside = systemPath("etc", "passwd");
    for (const path of [outside, `${temporaryRoots[0]}/../etc/passwd`, `${devices[0]}/../../etc/passwd`]) {
      const text = `cat ${path}`;
      expect(findTraversal(text, { cwd: context.env.cwd })).not.toEqual([]);
      expect(await findWriteTraversal(text, { cwd: context.env.cwd })).not.toEqual([]);
      expect(await findCommandTraversal(text, { cwd: context.env.cwd })).not.toEqual([]);
    }
    await expect(write({ path: `${temporaryRoots[0]}/omoya-destination-probe`, content: "x" }, context)).rejects.toThrow(/boundary/);
    const sibling = resolve(ROOT, "outside-existing.txt");
    writeFileSync(sibling, "outside");
    const narrowed = resolve(ROOT, "agent");
    mkdirSync(narrowed);
    expect((await findWriteTraversal(`const path = ${JSON.stringify(sibling)};`, { cwd: narrowed }))[0].kind).toBe("outside");
    const temporaryProject = resolve(tmpdir(), "project");
    expect(findTraversal(`cat ${temporaryRoots[0]}-not-a-temp-root/file`, { cwd: temporaryProject })).not.toEqual([]);
    const local = resolve(ROOT, "existing.txt");
    writeFileSync(local, "x");
    await expect(write({ path: "reference.js", content: `const path = ${JSON.stringify(local)};` }, context)).rejects.toThrow(/relative reference/);
    expect(await findWriteTraversal(`const path = ${JSON.stringify(resolve(ROOT, "missing.txt"))};`, { cwd: context.env.cwd })).toEqual([]);
  });
});
