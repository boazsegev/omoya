import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { Context } from "../lib/context.js";
import { compactContext } from "../lib/agent/compact.js";
import { loadedSkills } from "../lib/agent/skill-state.js";
import { isReadOnlyCall } from "../lib/agent/tool-scheduling.js";
import { skill } from "../tools/skill.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

let root;
let env;
function put(layer, name, body, resource) {
  const folder = join(root, layer, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill\n---\n${body}\n`);
  if (resource !== undefined) writeFileSync(join(folder, "example.js"), resource);
  return folder;
}
beforeEach(() => {
  mkdirSync("./ai-tmp", { recursive: true });
  root = mkdtempSync("./ai-tmp/skill-contracts-");
  env = new Env({ cwd: resolve(root), settingsDir: null, settings: {}, skillDirs: [join(root, "base"), join(root, "later")] });
});
afterEach(() => { env.close(); rmSync(root, { recursive: true, force: true }); });

describe("skill overlays and references", () => {
  test("later bodies replace instead of concatenate", () => {
    put("base", "web", "obsolete"); put("later", "web", "replacement");
    expect(env.skills().get("web").body).toBe("replacement");
  });
  test("self references explicitly include the previously effective body", () => {
    put("base", "web", "one\ntwo\nthree");
    put("later", "web", "before\n{{web[2-3]}}\n{{web}}\nafter");
    expect(env.skills().get("web").body).toBe("before\ntwo\nthree\none\ntwo\nthree\nafter");
  });
  test("self references select each previous definition across three layers", () => {
    put("base", "web", "one\ntwo\nthree");
    put("later", "web", "{{web[2-3]}}\nfour");
    put("last", "web", "{{web[2-3]}}\nfive");
    const layered = new Env({ settingsDir: null, settings: {}, skillDirs: [join(root, "base"), join(root, "later"), join(root, "last")] });
    try { expect(layered.skills().get("web").body).toBe("three\nfour\nfive"); }
    finally { layered.close(); }
  });
  test("cross references resolve forward definitions and internal whitespace names", () => {
    put("base", "alpha", "{{ web build[1-2] }}");
    put("base", "web build", "first\nsecond\nthird");
    put("later", "web build", "new first\nnew second");
    expect(env.skills().get("alpha").body).toBe("new first\nnew second");
  });
  test("unknown template placeholders remain literal", () => {
    put("base", "web", "{{title}} {{items}} {{web}}");
    expect(env.skills().get("web").body).toBe("{{title}} {{items}} {{web}}");
  });
  test("cycles and invalid known line ranges fail with logical names", () => {
    put("base", "alpha", "{{beta}}"); put("base", "beta", "{{alpha}}");
    expect(() => env.skills()).toThrow("Cyclic skill reference");
    put("base", "beta", "one"); put("base", "alpha", "{{beta[0-2]}}");
    expect(() => env.skills()).toThrow("Invalid skill line range");
  });
});

describe("atomic normalized activation", () => {
  test("strings, spaces and duplicate names normalize without splitting", async () => {
    put("base", "web build", "body");
    expect((await skill({ names: " web build " }, { env })).system).toHaveLength(1);
    const result = await skill({ names: ["web build", " web build "] }, { env });
    expect(result.result).toBe("Loaded skills: web build.");
    expect(result.system).toHaveLength(1);
  });
  test("unknown names fail the complete request", async () => {
    put("base", "web", "body");
    await expect(skill({ names: ["web", "missing"] }, { env })).rejects.toThrow("Unknown skills: missing");
  });
  test("malformed names are not silently converted into catalog queries", async () => {
    await expect(skill({ names: 3 }, { env })).rejects.toThrow(TypeError);
    await expect(skill({ names: [3] }, { env })).rejects.toThrow(TypeError);
  });
  test("live activations are no-ops until a new context", async () => {
    put("base", "web", "first body");
    const host = await testEnv();
    host.skills = () => env.skills();
    host.toolAdd("skill", skill, { safe: true, inputSchema: {} });
    const io = scriptedIO([TOOLCALL(0, "c1", "skill", { names: "web" }), TEXT(0, "done")]);
    const agent = new Agent({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      put("base", "web", "edited body");
      const again = await skill({ names: ["web"] }, agent._toolContext({ name: "skill" }));
      expect(again.result).toBe("Loaded skills: web.");
      expect(again.system).toEqual([]);
      agent.contextNew(false);
      expect((await skill({ names: "web" }, agent._toolContext({ name: "skill" }))).system[0]).toContain("edited body");
    } finally { agent.close(); host.close(); }
  });
});

describe("skill activation lifecycle", () => {
  test("prefilled guidance counts as active even when the file disappears", async () => {
    const context = new Context({ messages: [Context.messageSystem(Agent.skillSection({ name: "web build", body: "prefilled" }))] });
    const loaded = await skill({ names: " web build " }, { env, loadedSkills: () => loadedSkills(context) });
    expect(loaded.system).toEqual([]);
    context.close();
  });
  test("compaction, fork, and resume retain active wrappers", async () => {
    const context = new Context({ id: "skill-resume", dir: join(root, "sessions"), save: true, messages: [Context.messageSystem(Agent.skillSection({ name: 'web "quoted"', body: "body" })), USER("work")] });
    const agent = {
      context, _append: (message) => context.append(message),
      _lastUsage: null, pending: [],
    };
    await compactContext(agent, "", async () => {
      context.append(Context.messageAssistant([{ type: "text", text: "summary" }]));
      return { type: "done" };
    });
    expect(loadedSkills(context).has('web "quoted"')).toBe(true);
    const forked = new Context({ messages: context.messages() });
    expect(loadedSkills(forked).has('web "quoted"')).toBe(true);
    forked.close(); context.flush(); context.close();
    const resumed = Context.resume({ id: "skill-resume", dir: join(root, "sessions") });
    try { expect(loadedSkills(resumed).has('web "quoted"')).toBe(true); }
    finally { resumed.close(); }
  });
  test("concurrent duplicate activations append a single instruction payload", async () => {
    put("base", "web", "body");
    const host = await testEnv(); host.skills = () => env.skills();
    host.toolAdd("skill", skill, { safe: true, inputSchema: {} });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "skill", { names: "web" }), ...TOOLCALL(1, "c2", "skill", { names: "web" })], TEXT(0, "done")]);
    const agent = new Agent({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      const systems = agent.context.messages().filter((message) => message.type === 1 && message.content.some((block) => block.text?.includes('<skill name="web">')));
      expect(systems).toHaveLength(1);
    } finally { agent.close(); host.close(); }
  });
  test("unknown names produce a tool error with no partial activation", async () => {
    put("base", "web", "body");
    const host = await testEnv(); host.skills = () => env.skills();
    host.toolAdd("skill", skill, { safe: true, inputSchema: {} });
    const io = scriptedIO([TOOLCALL(0, "c1", "skill", { names: ["web", "missing"] }), TEXT(0, "done")]);
    const agent = new Agent({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      expect(loadedSkills(agent.context).size).toBe(0);
      expect(agent.context.messages().find((message) => message.type === 4).error).toBe(true);
    } finally { agent.close(); host.close(); }
  });
});

describe("skill-resource", () => {
  test("lists merged skill-relative resources without paths or activation", async () => {
    const base = put("base", "web", "base", "base bytes");
    const later = put("later", "web", "later", "later bytes");
    mkdirSync(join(base, "examples")); mkdirSync(join(later, "examples"));
    writeFileSync(join(base, "examples", "base.txt"), "base");
    writeFileSync(join(later, "examples", "later.txt"), "later");
    symlinkSync("SKILL.md", join(later, "linked.txt"));
    const { skillResource, toolDescription } = await import("../tools/skill-resource.js");
    expect(toolDescription()["skill-resource"].inputSchema.required).toEqual(["name"]);
    expect(await skillResource({ name: "web" }, { env, safe: true })).toEqual(["example.js", "examples/base.txt", "examples/later.txt"]);
    await expect(skillResource({ name: "missing" }, { env })).rejects.toThrow("Unknown skill");
    await expect(skillResource({ name: "web", target: "saved.txt" }, { env })).rejects.toThrow("path");
  });
  test("reads unlisted resources using last existing match and base fallback", async () => {
    put("base", "web", "base", "base bytes"); put("later", "web", "later");
    const { skillResource } = await import("../tools/skill-resource.js");
    expect(await skillResource({ name: "web", path: "example.js" }, { env })).toBe("base bytes");
    put("later", "web", "later", "later bytes");
    expect(await skillResource({ name: "web", path: "example.js" }, { env })).toBe("later bytes");
  });
  test("exports exact binary bytes, creates parents, and refuses existing targets", async () => {
    const folder = put("base", "web", "body");
    const bytes = Buffer.from([0, 255, 10, 13, 42]);
    writeFileSync(join(folder, "asset.bin"), bytes);
    const { skillResource } = await import("../tools/skill-resource.js");
    await skillResource({ name: "web", path: "asset.bin", target: "nested/asset.bin" }, { env });
    expect(readFileSync(join(root, "nested/asset.bin"))).toEqual(bytes);
    await expect(skillResource({ name: "web", path: "asset.bin", target: "nested/asset.bin" }, { env })).rejects.toThrow("already exists");
  });
  test("absolute project export targets produce relative labels", async () => {
    put("base", "web", "body", "exact bytes");
    const { skillResource } = await import("../tools/skill-resource.js");
    const target = resolve(root, "absolute-target.js");
    expect(await skillResource({ name: "web", path: "example.js", target }, { env })).toBe("Saved skill resource to absolute-target.js");
    expect(readFileSync(target, "utf8")).toBe("exact bytes");
  });
  test("binary reads and oversized resources give actionable bounded errors", async () => {
    const folder = put("base", "web", "body");
    writeFileSync(join(folder, "binary.bin"), Buffer.from([0, 255]));
    writeFileSync(join(folder, "large.txt"), "x"); truncateSync(join(folder, "large.txt"), 16 * 1024 * 1024 + 1);
    const { skillResource } = await import("../tools/skill-resource.js");
    await expect(skillResource({ name: "web", path: "binary.bin" }, { env })).rejects.toThrow("specify target");
    await expect(skillResource({ name: "web", path: "large.txt", target: "too-large.txt" }, { env })).rejects.toThrow("16 MiB");
  });
  test("later symlinks do not fall back and target parent symlinks are refused", async () => {
    put("base", "web", "body", "base");
    const folder = put("later", "web", "later");
    symlinkSync("SKILL.md", join(folder, "example.js"));
    const { skillResource } = await import("../tools/skill-resource.js");
    await expect(skillResource({ name: "web", path: "example.js" }, { env })).rejects.toThrow("symbolic");
    symlinkSync("base", join(root, "linked"));
    await expect(skillResource({ name: "web", path: "SKILL.md", target: "linked/copy.md" }, { env })).rejects.toThrow("symbolic");
  });
  test("exports are sequential barriers while resource reads remain parallelizable", async () => {
    const { toolDescription } = await import("../tools/skill-resource.js");
    const descriptor = toolDescription()["skill-resource"];
    env.toolAdd("skill-resource", descriptor.fn, descriptor);
    const info = (await env.tools()).get("skill-resource");
    expect(info.schema.readOnly).toBeUndefined();
    expect(isReadOnlyCall(info, { arguments: { name: "web", path: "example.js" } })).toBe(true);
    expect(isReadOnlyCall(info, { arguments: { name: "web", path: "example.js", target: "saved.js" } })).toBe(false);
    expect(isReadOnlyCall(info, { arguments: '{"target":"saved.js"}' })).toBe(false);
    expect(isReadOnlyCall(info, { arguments: "invalid JSON" })).toBe(false);
  });
  test("the Agent serializes an export before the following workspace read", async () => {
    put("base", "web", "body", "exact bytes");
    const { skillResource, toolDescription } = await import("../tools/skill-resource.js");
    env.close();
    const host = await testEnv({}, { cwd: resolve(root) });
    host.skillResource = (name, path) => env.skillResource(name, path);
    host.toolAdd("skill-resource", skillResource, toolDescription()["skill-resource"]);
    host.toolAdd("inspect", () => readFileSync(join(root, "saved.js"), "utf8"), { safe: true, inputSchema: {} });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "skill-resource", { name: "web", path: "example.js", target: "saved.js" }), ...TOOLCALL(1, "c2", "inspect", {})], TEXT(0, "done")]);
    const agent = new Agent({ env: host, model: "p/m", context: [USER("save and read")], createIO: () => io });
    try {
      await agent.run({});
      const result = agent.context.messages().find((message) => message.type === 4 && message.name === "inspect");
      expect(result.error).toBeUndefined();
      expect(result.content[0].text).toBe("exact bytes");
    } finally { agent.close(); host.close(); }
  });
  test("safe calls can read but never save", async () => {
    put("base", "web", "body", "safe text");
    const { skillResource, toolDescription } = await import("../tools/skill-resource.js");
    expect(toolDescription()["skill-resource"].safe).toBe(true);
    expect(await skillResource({ name: "web", path: "example.js" }, { env, safe: true })).toBe("safe text");
    await expect(skillResource({ name: "web", path: "example.js", target: "saved.js" }, { env, safe: true })).rejects.toThrow("safe mode");
  });
  test("missing, traversal, absolute paths, symlinks and outside targets are refused without host paths", async () => {
    const folder = put("base", "web", "body", "content");
    symlinkSync("example.js", join(folder, "link.js"));
    const { skillResource } = await import("../tools/skill-resource.js");
    for (const path of ["missing.js", "../web/example.js", resolve(folder, "example.js"), "link.js", "."]) {
      try { await skillResource({ name: "web", path }, { env }); throw new Error("accepted invalid resource"); }
      catch (error) { expect(error.message).not.toContain(resolve(root)); expect(error.message).not.toBe("accepted invalid resource"); }
    }
    await expect(skillResource({ name: "web", path: "example.js", target: "../escape.js" }, { env })).rejects.toThrow();
  });
});
