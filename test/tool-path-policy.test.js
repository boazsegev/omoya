import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import { resolveAgentPath } from "../lib/agent/path-info.js";
import { findWriteTraversal } from "../tools/guard/paths.js";
import { write } from "../tools/write.js";
import { edit } from "../tools/edit.js";
import { read } from "../tools/read/read.js";
import { bash } from "../tools/bash.js";
import { scriptedIO, TOOLCALL, TEXT } from "./fakes.js";

const ROOT = `./ai-tmp/path-policy-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function setup() {
  const project = resolve(ROOT, "project with spaces");
  const folder = resolve(project, "agent");
  mkdirSync(folder, { recursive: true });
  const file = resolve(project, "file with spaces.txt");
  writeFileSync(file, "old\n");
  return { project, folder, file, context: { env: { cwd: project }, agent: { folder } } };
}

function contentText(result) {
  return typeof result === "string" ? result : result.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

describe("material path policy and tool-owned labels", () => {
  test("resolves contained absolute paths and missing destinations, refuses actual escapes", () => {
    const { project, folder, file } = setup();
    expect(resolveAgentPath(file, { folder, boundary: project }).resolved).toBe(file);
    expect(resolveAgentPath(resolve(project, "new.txt"), { folder, boundary: project }).path).toBe("./new.txt");
    expect(resolveAgentPath(resolve(project, "..data/file"), { folder, boundary: project }).resolved).toBe(resolve(project, "..data/file"));
    for (const path of [resolve(ROOT, "escape"), resolve(`${project}-sibling`, "escape"), "../../escape"]) {
      expect(() => resolveAgentPath(path, { folder, boundary: project })).toThrow(/project boundary/);
    }
  });

  test("write, edit, rollback, and read localize their own absolute path labels", async () => {
    const { project, folder, file, context } = setup();
    const target = resolve(folder, "new.txt");
    expect(await read({ path: file, target }, context)).toBe("Successfully wrote 4 bytes to new.txt");
    expect(readFileSync(target, "utf8")).toBe("old\n");
    const edited = await edit({ path: target, edits: [{ oldText: "old", newText: "new" }] }, { ...context, call: { callId: "path-edit" } });
    expect(edited.result).toContain("new.txt");
    expect(edited.display).not.toContain(project);
    await edit({ path: "new.txt", rollback: "path-edit" }, context);
    expect(readFileSync(target, "utf8")).toBe("old\n");
    await edit({ path: "./new.txt", edits: [{ oldText: "old", newText: "new" }] }, { ...context, call: { callId: "relative-edit" } });
    await edit({ path: target, rollback: "relative-edit" }, context);
    expect(readFileSync(target, "utf8")).toBe("old\n");
    const listing = contentText(await read({ path: project }, context));
    expect(listing).toContain("ls ..");
    expect(listing).not.toContain(project);
    expect(contentText(await read({ path: target, info: true }, context))).not.toContain(project);
  });

  test("absolute spellings do not bypass symlink checks or outside refusal", async () => {
    const { project, context } = setup();
    const outside = resolve(ROOT, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, resolve(project, "link.txt"));
    symlinkSync(outside, resolve(context.agent.folder, "link.txt"));
    await expect(read({ path: resolve(project, "link.txt") }, context)).rejects.toThrow(/symbolic/);
    await expect(write({ path: resolve(context.agent.folder, "link.txt"), content: "x" }, context)).rejects.toThrow(/symbolic/);
    await expect(write({ path: outside, content: "x" }, context)).rejects.toThrow(/project boundary/);
    expect(readFileSync(outside, "utf8")).toBe("secret");
  });

  test("bash permits quoted absolute paths and dotdot-like folder names", async () => {
    const { project, file, context } = setup();
    expect(await bash({ command: `cat "${file}"` }, context)).toBe("old");
    expect(await bash({ command: `INPUT='${file}' cat "${file}"` }, context)).toBe("old");
    mkdirSync(resolve(project, "..data"));
    writeFileSync(resolve(project, "..data/file.txt"), "dotdot-name");
    expect(await bash({ command: `cat '${resolve(project, "..data/file.txt")}'` }, context)).toBe("dotdot-name");
    const outside = resolve(ROOT, "outside with spaces.txt");
    writeFileSync(outside, "outside");
    await expect(bash({ command: `cat '${outside}'` }, context)).rejects.toThrow(/Keep every visible path/);
  });

  test("Agent preserves tool-owned arguments, including refused originals", async () => {
    const { project, file } = setup();
    const env = await Env.create({ cwd: project, dir: project, settingsDir: project, settings: {
      providers: { fixture: { provider: "test", url: "test://script" } },
    } }, { providers: false, models: false });
    const calls = [file, resolve(ROOT, "outside.txt")];
    const io = scriptedIO([
      [...calls.flatMap((path, index) => TOOLCALL(index, `path-${index}`, "read", { path, annotate: false })), { type: "done" }],
      [...TEXT(0, "done"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "fixture/m", contextId: "path-policy", createIO: () => io });
    const callPaths = (messages) => messages.flatMap((message) => message.content ?? []).filter((block) => block.type === "toolCall").map((block) => block.arguments.path);
    try {
      await agent.run();
      const messages = agent.context.messages();
      expect(callPaths(messages)).toEqual(calls);
      expect(messages.find((message) => message.callId === "path-0").error).toBeUndefined();
      expect(messages.find((message) => message.callId === "path-1").error).toBe(true);
      const persisted = readFileSync(agent.context.file, "utf8").trim().split("\n").map(JSON.parse);
      expect(callPaths(persisted)).toEqual(calls);
    } finally { agent.close(); env.close(); }
  });
});

describe("weak content trip-wire", () => {
  test("flags existing absolute project files and folders but permits missing references", async () => {
    const { project, folder, file, context } = setup();
    for (const path of [file, project]) {
      const content = `const target = ${JSON.stringify(path)};`;
      expect((await findWriteTraversal(content, { cwd: project })).map((item) => item.kind)).toEqual(["absolute"]);
      await expect(write({ path: "out.js", content }, context)).rejects.toThrow(/outside the working folder/);
    }
    for (const path of [resolve(project, "missing file.txt"), resolve(ROOT, "missing outside.txt")]) {
      expect(await findWriteTraversal(`const target = ${JSON.stringify(path)};`, { cwd: project })).toEqual([]);
    }
    expect(await findWriteTraversal("const target = '../file with spaces.txt';", { cwd: project })).toEqual([]);
    const absoluteUrlSource = `new URL('${file}', ` + "import.meta.url)";
    expect((await findWriteTraversal(absoluteUrlSource, { cwd: project }))[0].kind).toBe("absolute");
    await write({ path: "missing-reference.js", content: `const path = ${JSON.stringify(resolve(project, "not created.js"))};` }, context);
  });

  test("source text and edits share the check while explicit permission preserves bytes", async () => {
    const { project, file, context } = setup();
    const content = `const target = ${JSON.stringify(file)};`;
    writeFileSync(resolve(project, "source.js"), content);
    await expect(read({ path: "../source.js", target: "copy.js" }, context)).rejects.toThrow(/outside the working folder/);
    writeFileSync(resolve(context.agent.folder, "own.txt"), "old");
    await expect(edit({ path: "own.txt", edits: [{ oldText: "old", newText: content }] }, context)).rejects.toThrow(/outside the working folder/);
    expect(readFileSync(file, "utf8")).toBe("old\n");
    const questions = [];
    await write({ path: "allowed.js", content, ask: true }, { ...context,
      question: { ask: async (items) => { questions.push(...items); return [{ labels: ["Allow write"] }]; } },
    });
    expect(questions[0].question).toContain("existing outside-tree path");
    expect(readFileSync(resolve(context.agent.folder, "allowed.js"), "utf8")).toBe(content);
  });

  test("scripts, escapes, URLs, devices and missing references remain unchanged", async () => {
    const { project, context } = setup();
    const interpreter = ["", "usr", "bin", "env"].join("/");
    const device = ["", "dev", "null"].join("/");
    const content = `#!${interpreter} bash\nprintf '\\n---\\n' >${device}\nconst url = 'https://example.test/api/path';\nconst missing = '/nonexistent-omoya-path-xyz/file.txt';\n`;
    expect(await findWriteTraversal(content, { cwd: project })).toEqual([]);
    await write({ path: "script.sh", content }, context);
    expect(readFileSync(resolve(context.agent.folder, "script.sh"), "utf8")).toBe(content);
    const temporary = ["", "tmp"].join("/");
    const temporarySource = `const temporary = '${temporary}';`;
    expect(await findWriteTraversal(temporarySource, { cwd: project })).toEqual([]);
    await write({ path: "temporary.js", content: temporarySource }, context);
    expect(readFileSync(resolve(context.agent.folder, "temporary.js"), "utf8")).toBe(temporarySource);
  });
});
