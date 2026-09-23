// test/agent-tool-system.test.js — proof for tool-attached SYSTEM
// messages: a tool returning { result, system } answers briefly via
// the tool result while the payload appends as System messages right
// after it (before any queued user messages). Covers the `skill` tool
// (tools/skill.js over Env's own skill registry — lib/env/registry.js).
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const SKILL_TOOL = { description: "loads", safe: true, inputSchema: { type: "object", properties: {} } };

describe("agent: tool-attached system messages", () => {
  test("a THROWN error's `system` payload appends after the tool-result error", async () => {
    const env = await testEnv();
    env.registerTool("failing", () => {
      const err = new Error("path traversal refused: test");
      err.system = "Stay in the current directory tree.";
      throw err;
    }, SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "failing", {}),
      [...TEXT(0, "understood")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const types = agent.context.map((m) => m.type);
    // user, assistant(calls), toolResult(ERROR), SYSTEM payload, assistant
    expect(types).toEqual([2, 3, 4, 1, 3]);
    expect(agent.context[2].error).toBe(true);
    expect(agent.context[3].content[0].text).toBe("Stay in the current directory tree.");
  });

  test("{ result, system }: payload appends AFTER the result, BEFORE queued user messages", async () => {
    const env = await testEnv();
    let agent;
    env.registerTool("loader", () => {
      agent.enqueue(USER("queued mid-turn")); // flushes after this iteration's tool outcomes
      return { result: "skill loading: core", system: "<skill>payload</skill>" };
    }, SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "loaded it")],
    ]);
    agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run({});

    expect(terminal.type).toBe("done");
    const types = agent.context.map((m) => m.type);
    // user, assistant(calls), toolResult, SYSTEM payload, queued user, assistant
    expect(types).toEqual([2, 3, 4, 1, 2, 3]);
    const system = agent.context[3];
    expect(system.content[0].text).toBe("<skill>payload</skill>");
    const result = agent.context[2];
    expect(result.content[0].text).toBe("skill loading: core"); // the answer stays brief
  });

  test("a system ARRAY appends each payload as its own system message", async () => {
    const env = await testEnv();
    env.registerTool("loader", () => ({ result: "ok", system: ["one", "two"] }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(2);
    expect(systems.map((m) => m.content[0].text)).toEqual(["one", "two"]);
  });

  test("onToolResult fires once only after its result, display, and system payload are appended", async () => {
    const env = await testEnv();
    env.registerTool("complete", () => ({ result: "brief", display: "shown", system: "system payload" }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "complete", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    let agent;
    agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result: message, display }) => seen.push({
      message, display, resultAppended: agent.context.includes(message),
      systemAppended: agent.context.some((m) => m.type === MessageType.System && m.content.some((b) => b.text === "system payload")),
    }));
    await agent.run({});

    expect(seen).toHaveLength(1);
    expect(seen[0].resultAppended).toBe(true);
    expect(seen[0].systemAppended).toBe(true);
    expect(seen[0].display).toEqual([{ type: "text", text: "shown" }]);
  });

  test("{ result, display }: the display payload rides onToolResult only — NEVER the context", async () => {
    const env = await testEnv();
    env.registerTool("diffy", () => ({ result: "edited", display: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "diffy", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result: m, display }) => seen.push({ m, display }));
    await agent.run({});

    // the tool result carries ONLY the brief answer
    const result = agent.context.find((m) => m.type === MessageType.ToolResult);
    expect(result.content[0].text).toBe("edited");
    // no System message; display is preserved on the result for context viewers
    expect(agent.context.filter((m) => m.type === MessageType.System)).toHaveLength(0);
    expect(result.display).toEqual([{ type: "text", text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }]);
    // the binding saw the display payload as onToolResult's second argument
    expect(seen).toHaveLength(1);
    expect(seen[0].display).toEqual([{ type: "text", text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }]);
  });

  test("the shared tool context carries the call's linkage ({callId, name})", async () => {
    const env = await testEnv();
    let got;
    env.registerTool("probe", (args, context) => { got = context?.call; return "ok"; }, {
      ...SKILL_TOOL,
    });
    const io = scriptedIO([
      TOOLCALL(0, "c1", "probe", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});
    expect(got).toEqual({ callId: "c1", name: "probe" });
  });

  test("ordinary returns carry NO system key into the context; onToolResult sees only the result", async () => {
    const env = await testEnv();
    env.registerTool("plain", () => "just text", SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "plain", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result }) => seen.push(result));
    await agent.run({});

    expect(agent.context.filter((m) => m.type === MessageType.System)).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe(MessageType.ToolResult);
    expect(seen[0].content[0].text).toBe("just text");
    expect("system" in seen[0]).toBe(false);
  });

  test("the FORKED sandbox passes { result, system } through (file-scanned tool)", async () => {
    const env = await testEnv();
    const dir = mkdtempSync("./ai-tmp/tools-");
    writeFileSync(`${dir}/loader.js`, `
      export function loader() { return { result: "brief", system: "payload via fork" }; }
      export function toolDescription() {
        return { loader: { description: "d", safe: true, inputSchema: {} } };
      }
    `);
    await env.loadTools({ dirs: [dir] });
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(1);
    expect(systems[0].content[0].text).toBe("payload via fork");
    const result = agent.context.find((m) => m.type === MessageType.ToolResult);
    expect(result.content[0].text).toBe("brief");
  });
});

describe("tools/skill.js: the skill tool", () => {
  const savedSkillsDir = process.env[NAMES.skillsEnv];
  afterEach(() => {
    if (savedSkillsDir === undefined) delete process.env[NAMES.skillsEnv];
    else process.env[NAMES.skillsEnv] = savedSkillsDir;
  });

  /** The namespace skill path accumulates onto the package's own
   *  `skills/` folder (which always has at least `core`). */
  function fakeSkillDirs() {
    const global = mkdtempSync("./ai-tmp/skills-");
    mkdirSync(`${global}/demo`);
    writeFileSync(`${global}/demo/SKILL.md`, "---\ndescription: a demo skill\n---\nDEMO BODY\n");
    process.env[NAMES.skillsEnv] = global;
  }

  test("no names: the catalog is the answer (no system payload), including the packaged 'core' skill", async () => {
    fakeSkillDirs();
    const { skill } = await import("../tools/skill.js");
    const answer = await skill({});
    expect(typeof answer).toBe("string");
    expect(answer).toContain("# Skill Catalog");
    expect(answer).toContain("`core`"); // packaged skills/core/SKILL.md, no special-casing needed
    expect(answer).toContain("`demo` — a demo skill");
  });

  test("found: a brief public confirmation + the bodies as the system payload", async () => {
    fakeSkillDirs();
    const { skill } = await import("../tools/skill.js");
    const answer = await skill({ names: ["core", "demo"] });
    expect(answer.result).toBe("Loaded skills: core, demo.");
    expect(answer.system).toHaveLength(2);
    expect(answer.system[0]).toContain('<skill name="core">');
    expect(answer.system[1]).toContain('<skill name="demo">');
    expect(answer.system[1]).toContain("DEMO BODY");
  });

  test("unknown skills give an actionable catalog instruction; a mix loads the found", async () => {
    fakeSkillDirs();
    const { skill } = await import("../tools/skill.js");
    expect(await skill({ names: ["nope"] })).toBe("No requested skills are available. Call skill with no names to list available skills, then try again.");
    const mixed = await skill({ names: ["demo", "nope"] });
    expect(mixed.result).toBe("Loaded skills: demo. Call skill with no names to find the unavailable skills.");
    expect(mixed.system).toHaveLength(1);
    expect(mixed.system[0]).toContain("DEMO BODY");
  });

  test("published safe (read-only) with the catalog-loading schema", async () => {
    const { toolDescription } = await import("../tools/skill.js");
    const schema = toolDescription().skill;
    expect(schema.safe).toBe(true);
    expect(schema.inputSchema.properties.names.type).toBe("array");
  });

  test("end to end through the Agent: answer in the result, payload in the context", async () => {
    fakeSkillDirs();
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.toolEntry("skill")?.safe).toBe(true);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "skill", { names: ["demo"] }),
      [...TEXT(0, "using the demo skill")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("load demo")], createIO: () => io });
    await agent.run({});

    const result = agent.context.find((m) => m.type === MessageType.ToolResult);
    expect(result.content[0].text).toBe("Loaded skills: demo.");
    const system = agent.context.find((m) => m.type === MessageType.System);
    expect(system.content[0].text).toContain("DEMO BODY");
  });

  test("end to end: multiple skills remain separate system messages", async () => {
    fakeSkillDirs();
    const env = await testEnv();
    await env.loadTools({ dirs: ["./tools"] });
    const io = scriptedIO([
      TOOLCALL(0, "c1", "skill", { names: ["core", "demo"] }),
      [...TEXT(0, "using both skills")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("load both")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(2);
    expect(systems[0].content[0].text).toContain('<skill name="core">');
    expect(systems[1].content[0].text).toContain('<skill name="demo">');
  });
});
