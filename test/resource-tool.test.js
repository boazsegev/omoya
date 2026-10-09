import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { resource, toolDescription } from "../tools/resource.js";

let root, env, own, project, skills, ctx;
function file(folder, path, content) { mkdirSync(join(folder, path, ".."), { recursive: true }); writeFileSync(join(folder, path), content); }
function skill(layer, name, files = {}) {
  const dir = join(skills, layer, name);
  file(dir, "SKILL.md", `---\nname: ${name}\ndescription: fixture\n---\nbody\n`);
  for (const [path, content] of Object.entries(files)) file(dir, path, content);
  return dir;
}
beforeEach(async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  root = resolve(mkdtempSync("./ai-tmp/resource-tool-")); own = join(root, "own"); project = join(root, "lib"); skills = join(root, "skills");
  const settingsDir = join(root, "settings");
  for (const dir of [own, project, settingsDir]) mkdirSync(dir, { recursive: true });
  env = await Env.open(own, { dir: settingsDir, settingsDir, skillDirs: [join(skills, "base"), join(skills, "later")], init: { providers: false, tools: false, detect: false, models: false } });
  await env.ready();
  await Env.ready();
  Env.settings.projects[own] = { models: {}, groups: { team: true } };
  Env.settings.projects[project] = { models: {}, groups: { team: true } };
  ctx = { env, agent: { can: { request: true, write: true }, folder: own, parent: undefined } };
});
afterEach(async () => {
  delete Env.settings.projects[own];
  delete Env.settings.projects[project];
  await Env.settingsFlush();
  await env.close();
  rmSync(root, { recursive: true, force: true });
});

 test("skill read, merged root and subfolder listings, and source label", async () => {
  skill("base", "web", { "examples/first.txt": "first", "same.txt": "base" });
  skill("later", "web", { "examples/second.txt": "second", "same.txt": "later" });
  expect(await resource({ name: "web", list: true }, ctx)).toBe("skill web: examples/, same.txt");
  expect(await resource({ name: "web", path: "examples", list: true }, ctx)).toBe("skill web: first.txt, second.txt");
  expect(await resource({ name: "web", path: "same.txt" }, ctx)).toBe("skill web:\nlater");
});
 test("skill-first fallback is per path and requires project request permission", async () => {
  skill("base", "lib", { "skill.txt": "skill" });
  file(project, "project.txt", "project");
  expect(await resource({ name: "lib", path: "skill.txt" }, { ...ctx, agent: { ...ctx.agent, can: { request: false, write: true } } })).toContain("skill lib");
  for (const can of [false, undefined]) {
    const agent = { ...ctx.agent, can: { request: can, write: true } };
    await expect(resource({ name: "lib", path: "project.txt" }, { ...ctx, agent })).rejects.toThrow(/permit requests/);
  }
  expect(await resource({ name: "lib", path: "project.txt" }, ctx)).toBe("project lib:\nproject");
  await expect(resource({ name: "unknown", list: true }, ctx)).rejects.toThrow("Unknown project");
});
 test("list and target compose for roots, files, folders and globs", async () => {
  skill("base", "web", { "a.txt": "A", "dir/b.txt": "B", "dir/c.txt": "C" });
  for (const list of [false, true]) {
    const prefix = list ? "listed" : "plain";
    expect(await resource({ name: "web", list }, ctx)).toBe("skill web: a.txt, dir/");
    expect(await resource({ name: "web", path: "dir", list }, ctx)).toBe("skill web: b.txt, c.txt");
    expect(await resource({ name: "web", path: "dir/*.txt", list }, ctx)).toBe("skill web: dir/b.txt, dir/c.txt");
    for (const [path, suffix, contents] of [
      [undefined, "root", { "a.txt": "A", "dir/b.txt": "B" }],
      ["a.txt", "file", { "": "A" }],
      ["dir", "folder", { "b.txt": "B" }],
      ["dir/*.txt", "glob", { "b.txt": "B", "c.txt": "C" }],
    ]) {
      const target = `${prefix}-${suffix}`;
      expect(await resource({ name: "web", path, list, target }, ctx)).toContain(`Copied skill web to ${target}`);
      for (const [child, content] of Object.entries(contents)) expect(readFileSync(join(own, target, child), "utf8")).toBe(content);
    }
  }
  expect(await resource({ name: "web", path: "a.txt", list: true }, ctx)).toBe("skill web: a.txt");
});
 test("multiple matches preserve an existing file target and use a numbered folder", async () => {
  skill("base", "web", { "a.txt": "A", "b.txt": "B" });
  file(own, "existing.txt", "original");
  for (const list of [false, true]) {
    expect(await resource({ name: "web", path: "*.txt", list, target: "existing.txt" }, ctx)).toContain("existing.txt existed; saved as existing.txt 00");
  }
  expect(readFileSync(join(own, "existing.txt"), "utf8")).toBe("original");
  expect(readFileSync(join(own, "existing.txt 002/a.txt"), "utf8")).toBe("A");
  expect(readFileSync(join(own, "existing.txt 003/b.txt"), "utf8")).toBe("B");
});
 test("own-project root copying snapshots the source before creating its target", async () => {
  file(own, "a.txt", "A");
  expect(await resource({ name: "this", list: true, target: "snapshot" }, ctx)).toContain("Copied project this to snapshot");
  expect(readFileSync(join(own, "snapshot/a.txt"), "utf8")).toBe("A");
  expect(await resource({ name: "this", path: "snapshot", list: true }, ctx)).toBe("project this: a.txt");
});
 test("empty optional inputs normalize consistently with read-only classification", async () => {
  skill("base", "web", { "a.txt": "A" });
  const descriptor = toolDescription().resource;
  for (const empty of [undefined, null, "", false, true, 0, -1, []]) {
    expect(await resource({ name: " web ", path: empty }, ctx)).toBe("skill web: a.txt");
    const args = { name: "web", path: "a.txt", target: empty };
    expect(descriptor.readOnly(args)).toBe(true);
    expect(await resource(args, { ...ctx, safe: true })).toBe("skill web:\nA");
    if (empty !== true) expect(await resource({ name: "web", path: "a.txt", list: empty }, ctx)).toBe("skill web:\nA");
  }
  expect(await resource({ name: "web", path: ".", list: false }, ctx)).toBe("skill web: a.txt");
  await expect(resource({ name: "web", target: {} }, ctx)).rejects.toThrow("target");
  await expect(resource({ name: "web", path: {} }, ctx)).rejects.toThrow("path");
  await expect(resource({ name: "web", list: {} }, ctx)).rejects.toThrow("list");
});
 test("safe and write permissions prevent copy even with list", async () => {
  skill("base", "web", { "a.txt": "a" });
  await expect(resource({ name: "web", list: true, target: "x" }, { ...ctx, safe: true })).rejects.toThrow("safe mode");
  await expect(resource({ name: "web", list: true, target: "x" }, { ...ctx, agent: { ...ctx.agent, can: { write: false } } })).rejects.toThrow("write permission");
  await expect(resource({ name: "web", path: "a.txt", target: "x" }, { ...ctx, safe: true })).rejects.toThrow("safe mode");
  await expect(resource({ name: "web", path: "a.txt", target: "x" }, { ...ctx, agent: { ...ctx.agent, can: { write: false } } })).rejects.toThrow("write permission");
  expect(toolDescription().resource.readOnly({ path: "a" })).toBe(true);
  expect(toolDescription().resource.readOnly({ target: "x" })).toBe(false);
});
 test("file, folder and multi-match glob copies, preserving existing targets with numbered names", async () => {
  skill("base", "web", { "dir/a.txt": "A", "dir/b.txt": "B", "single.txt": "S", "bundle.zip/a.txt": "inside" });
  expect(await resource({ name: "web", path: "single.txt", target: "out/item.txt" }, ctx)).toContain("skill web");
  expect(await resource({ name: "web", path: "single.txt", target: "out/item.txt" }, ctx)).toContain("out/item.txt existed; saved as out/item 002.txt");
  expect(readFileSync(join(own, "out/item 002.txt"), "utf8")).toBe("S");
  await resource({ name: "web", path: "dir", target: "tree" }, ctx);
  expect(readFileSync(join(own, "tree/a.txt"), "utf8")).toBe("A");
  expect(await resource({ name: "web", path: "dir", target: "tree" }, ctx)).toContain("tree/dir");
  expect(await resource({ name: "web", path: "dir", target: "tree" }, ctx)).toContain("tree/dir existed; saved as tree/dir 002");
  await resource({ name: "web", path: "bundle.zip", target: "package.zip" }, ctx);
  expect(await resource({ name: "web", path: "bundle.zip", target: "package.zip" }, ctx)).toContain("package.zip/bundle.zip");
  expect(await resource({ name: "web", path: "bundle.zip", target: "package.zip" }, ctx)).toContain("package.zip/bundle.zip existed; saved as package.zip/bundle.zip 002");
  await resource({ name: "web", path: "dir/*.txt", target: "matches" }, ctx);
  expect(readFileSync(join(own, "matches/b.txt"), "utf8")).toBe("B");
  expect(await resource({ name: "web", path: "dir/*.txt", target: "matches" }, ctx)).toContain("matches/a.txt existed; saved as matches/a 002.txt");
  await resource({ name: "web", path: "single.txt", target: "matches" }, ctx);
  expect(readFileSync(join(own, "matches/single.txt"), "utf8")).toBe("S");
});
 test("skill listings skip symlinks, copying folders refuses them", async () => {
  const dir = skill("base", "web", { "dir/good.txt": "good" });
  symlinkSync("good.txt", join(dir, "dir/linked.txt"));
  expect(await resource({ name: "web", path: "dir", list: true }, ctx)).toBe("skill web: good.txt");
  await expect(resource({ name: "web", path: "dir", target: "copied" }, ctx)).rejects.toThrow("symbolic");
});
 test("project folders and paths reject symlinks/traversal and never disclose absolute roots", async () => {
  file(project, "nested/file.txt", "project bytes");
  expect(await resource({ name: "lib", path: "nested", target: "project-copy" }, ctx)).toContain("project lib");
  expect(readFileSync(join(own, "project-copy/file.txt"), "utf8")).toBe("project bytes");
  expect(await resource({ name: "this", list: true }, ctx)).toContain("project this");
  symlinkSync("nested", join(project, "linked"));
  symlinkSync("nested/file.txt", join(project, "nested/link.txt"));
  symlinkSync("project-copy", join(own, "unsafe"));
  for (const args of [
    { name: "lib", path: "../own/file.txt" },
    { name: "lib", path: "linked/file.txt" },
    { name: "lib", path: "nested", target: "unsafe/new" },
    { name: "lib", path: "nested", target: "safe-new" },
    { name: "lib", path: "nested/*", target: "glob-new" },
  ]) {
    try { await resource(args, ctx); throw new Error("unexpected success"); }
    catch (error) { expect(error.message).not.toBe("unexpected success"); expect(error.message).not.toContain(root); }
  }
});
