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
beforeEach(async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  root = mkdtempSync("./ai-tmp/skill-contracts-");
  env = await Env.open(resolve(root), { settingsDir: null, settings: {}, skillDirs: [join(root, "base"), join(root, "later")], init: { providers: false, tools: false, detect: false, models: false } });
});
afterEach(async () => { await env.close(); rmSync(root, { recursive: true, force: true }); });

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
  test("self references select each previous definition across three layers", async () => {
    put("base", "web", "one\ntwo\nthree");
    put("later", "web", "{{web[2-3]}}\nfour");
    put("last", "web", "{{web[2-3]}}\nfive");
    const layered = await Env.open(process.cwd(), { settingsDir: null, settings: {}, skillDirs: [join(root, "base"), join(root, "later"), join(root, "last")] });
    try { expect(layered.skills().get("web").body).toBe("three\nfour\nfive"); }
    finally { await layered.close(); }
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
  test("without a borrowed Env, opens and closes the agent folder environment", async () => {
    const folder = resolve(root);
    const result = await skill({}, { agent: { folder } });
    expect(result).toContain("core");
    expect(Env.envs[folder]).toBeUndefined();
    expect(env.closed).toBe(false);
  });
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
    const agent = await Agent.create({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      put("base", "web", "edited body");
      const again = await skill({ names: ["web"] }, agent._toolContext({ name: "skill" }));
      expect(again.result).toBe("Loaded skills: web.");
      expect(again.system).toEqual([]);
      const fresh = await Agent.create({ env: host, model: "p/m", contextId: false, createIO: () => scriptedIO([]) });
      try {
        expect((await skill({ names: "web" }, fresh._toolContext({ name: "skill" }))).system[0]).toContain("edited body");
        expect(loadedSkills(agent.context).has("web")).toBe(true);
      } finally { await fresh.close(); }
    } finally { await agent.close(); await host.close(); }
  });
});

describe("skill activation lifecycle", () => {
  test("compaction refreshes available skills in system guidance while retaining unavailable ones", async () => {
    put("base", "web", "updated body");
    const old = env.skillSection({ name: "web", body: "old body" });
    const missing = env.skillSection({ name: "missing", body: "retained body" });
    const context = new Context({ messages: [Context.messageSystem(`Before\n${old}\nBetween\n${missing}\nAfter`), USER("work")] });
    const agent = {
      context, env, _append: (message) => agent.context.append(message),
      _contextReplace: (next) => { agent.context = next; },
      _emit: () => {}, pending: [],
    };
    try {
      await compactContext(agent, "", async () => {
        context.append(Context.messageAssistant([{ type: "text", text: "summary" }]));
        return { type: "done" };
      });
      const guidance = agent.context.at(0).content[0].text;
      expect(guidance).toContain(env.skillSection(env.skills().get("web")));
      expect(guidance).not.toContain("old body");
      expect(guidance).toContain(`Between\n${missing}\nAfter`);
      expect(guidance).toStartWith("Before\n");
      expect(loadedSkills(agent.context)).toEqual(new Set(["web", "missing"]));
    } finally { await context.close(); if (agent.context !== context) await agent.context.close(); }
  });
  test("compaction keeps existing guidance if skill discovery fails", async () => {
    const original = env.skills;
    env.skills = () => { throw new Error("unavailable registry"); };
    const section = env.skillSection({ name: "web", body: "retained body" });
    const context = new Context({ messages: [Context.messageSystem(section), USER("work")] });
    const agent = { context, env, _append: (message) => agent.context.append(message),
      _contextReplace: (next) => { agent.context = next; }, _emit: () => {}, pending: [] };
    try {
      await compactContext(agent, "", async () => {
        context.append(Context.messageAssistant([{ type: "text", text: "summary" }]));
        return { type: "done" };
      });
      expect(agent.context.at(0).content[0].text).toBe(section);
    } finally { env.skills = original; await context.close(); if (agent.context !== context) await agent.context.close(); }
  });
  test("prefilled guidance counts as active even when the file disappears", async () => {
    const context = new Context({ messages: [Context.messageSystem(env.skillSection({ name: "web build", body: "prefilled" }))] });
    const loaded = await skill({ names: " web build " }, { env, loadedSkills: () => loadedSkills(context) });
    expect(loaded.system).toEqual([]);
    await context.close();
  });
  test("compaction, fork, and resume retain active wrappers", async () => {
    const context = new Context({ id: "skill-resume", dir: join(root, "sessions"), save: true, messages: [Context.messageSystem(env.skillSection({ name: 'web "quoted"', body: "body" })), USER("work")] });
    const agent = {
      context, env, _append: (message) => agent.context.append(message),
      _contextReplace: (next) => { const previous = agent.context; agent.context = next; return previous; },
      _emit: () => {}, _lastUsage: null, pending: [],
    };
    await compactContext(agent, "", async () => {
      context.append(Context.messageAssistant([{ type: "text", text: "summary" }]));
      return { type: "done" };
    });
    expect(loadedSkills(agent.context).has('web "quoted"')).toBe(true);
    const forkedContext = new Context({ messages: agent.context.messages(), dir: context.dir,
      origin: env.folder, save: context.save, settings: context.settings });
    const forked = await Agent.create({ env, context: forkedContext, createIO: () => null });
    expect(forked.context).toBe(forkedContext);
    expect(loadedSkills(forked.context).has('web "quoted"')).toBe(true);
    await forked.close(); context.flush(); await context.close(); await agent.context.close();
    const resumed = Context.resume({ id: "skill-resume", dir: join(root, "sessions") });
    try { expect(loadedSkills(resumed).has('web "quoted"')).toBe(true); }
    finally { await resumed.close(); }
  });
  test("concurrent duplicate activations append a single instruction payload", async () => {
    put("base", "web", "body");
    const host = await testEnv(); host.skills = () => env.skills();
    host.toolAdd("skill", skill, { safe: true, inputSchema: {} });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "skill", { names: "web" }), ...TOOLCALL(1, "c2", "skill", { names: "web" })], TEXT(0, "done")]);
    const agent = await Agent.create({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      const systems = agent.context.messages().filter((message) => message.type === 1 && message.content.some((block) => block.text?.includes('<skill name="web">')));
      expect(systems).toHaveLength(1);
    } finally { await agent.close(); await host.close(); }
  });
  test("unknown names produce a tool error with no partial activation", async () => {
    put("base", "web", "body");
    const host = await testEnv(); host.skills = () => env.skills();
    host.toolAdd("skill", skill, { safe: true, inputSchema: {} });
    const io = scriptedIO([TOOLCALL(0, "c1", "skill", { names: ["web", "missing"] }), TEXT(0, "done")]);
    const agent = await Agent.create({ env: host, model: "p/m", context: [USER("load")], createIO: () => io });
    try {
      await agent.run({});
      expect(loadedSkills(agent.context).size).toBe(0);
      expect(agent.context.messages().find((message) => message.type === 4).error).toBe(true);
    } finally { await agent.close(); await host.close(); }
  });
});

describe("resource scheduling", () => {
  test("copy is a sequential barrier and reads remain parallelizable", async () => {
    const { toolDescription } = await import("../tools/resource.js");
    const descriptor = toolDescription().resource;
    await env.tools(); env.toolAdd("resource", descriptor.fn, descriptor);
    const info = (await env.tools()).get("resource");
    expect(isReadOnlyCall(info, { arguments: { name: "web", path: "example.js" } })).toBe(true);
    expect(isReadOnlyCall(info, { arguments: { name: "web", path: "example.js", target: "saved.js" } })).toBe(false);
  });
});
