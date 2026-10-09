// test/agent-tool-system.test.js — proof for tool-attached SYSTEM
// messages: a tool returning { result, system } answers briefly via
// the tool result while guidance follows the whole tool-call batch
// and queued user input. Covers the `skill` tool
// (tools/skill.js over Env's own skill registry — lib/env/registry.js).
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { Agent } from "../lib/agent.js";
import { MessageType } from "../lib/context.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";
import { toolEntry, toolsLoad } from "./env-internals.js";
import AnthropicProvider from "../providers/anthropic.js";
import ClaudeProvider from "../providers/claude.js";

const SKILL_TOOL = { description: "loads", safe: true, inputSchema: { type: "object", properties: {} } };

describe("agent: tool-attached system messages", () => {
  for (const safe of [true, false]) {
    test(`the whole tool batch precedes guidance across ${safe ? "parallel" : "sequential"} calls and barriers`, async () => {
      const env = await testEnv();
      const executed = [];
      const finished = [];
      let releaseFirst;
      const first = new Promise((resolve) => { releaseFirst = resolve; });
      env.toolAdd("loader", async ({ id }) => {
        executed.push(id);
        if (safe && id === "a") await first;
        if (id === "b") releaseFirst();
        finished.push(id);
        return { result: id, system: [`guidance ${id}`, `extra ${id}`] };
      }, { ...SKILL_TOOL, safe });
      env.toolAdd("barrier", () => { executed.push("barrier"); return "changed"; }, { ...SKILL_TOOL, safe: false });
      const io = scriptedIO([
        [...TOOLCALL(0, "a", "loader", { id: "a" }), ...TOOLCALL(1, "b", "loader", { id: "b" }),
          ...TOOLCALL(2, "w", "barrier", {}), ...TOOLCALL(3, "c", "loader", { id: "c" })],
        [{ type: "done", message: { type: 3, content: [
          { type: "thinking", text: "plan", signature: "preserve-signature" }, { type: "text", text: "done" },
        ] } }], TEXT(0, "next answer"),
      ]);
      const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
      try {
        await agent.run();
        const sent = io.writes[1].context.filter((message) => typeof message.type === "number");
        expect(executed).toEqual(["a", "b", "barrier", "c"]);
        expect(finished).toEqual(safe ? ["b", "a", "c"] : ["a", "b", "c"]);
        expect(sent.map((message) => message.type)).toEqual([2, 3, 4, 4, 4, 4, 1, 1, 1, 1, 1, 1]);
        expect(sent.filter((message) => message.type === 4).map((message) => message.callId)).toEqual(["a", "b", "w", "c"]);
        expect(sent.filter((message) => message.type === 1).map((message) => message.content[0].text)).toEqual([
          "guidance a", "extra a", "guidance b", "extra b", "guidance c", "extra c",
        ]);
        await agent.send(USER("next"));
        for (const Provider of [AnthropicProvider, ClaudeProvider]) {
          const provider = new Provider("https://api.anthropic.com/v1", {
            model: "test/claude-haiku-5-5", settings: { auth: { type: "oauth", token: "fake" } }, tools: () => [],
          });
          const first = provider.context2msg(sent)[1];
          expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
          expect(first.messages[2].content.map((block) => block.tool_use_id)).toEqual(["a", "b", "w", "c"]);
          const next = provider.context2msg(io.writes[2].context.filter((message) => typeof message.type === "number"))[1];
          expect(next.system).toEqual(first.system);
          expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
          expect(next.messages[first.messages.length].content[0]).toEqual({ type: "thinking", thinking: "plan", signature: "preserve-signature" });
        }
      } finally { await agent.close(); await env.close(); }
    });
  }

  test("cancellation keeps completed guidance after repaired results on continuation", async () => {
    const env = await testEnv();
    env.toolAdd("loader", () => ({ result: "loaded", system: "keep this guidance" }), { ...SKILL_TOOL, safe: false });
    let unstarted = 0;
    env.toolAdd("unstarted", () => { unstarted++; return "wrong"; }, SKILL_TOOL);
    const io = scriptedIO([
      [...TOOLCALL(0, "a", "loader", {}), ...TOOLCALL(1, "b", "unstarted", {})],
      TEXT(0, "resumed"),
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const off = agent.onEvent(Agent.EVENT.TOOL_RESULT, () => { void agent.cancel(); });
    try {
      expect(await agent.run()).toMatchObject({ kind: "cancelled" });
      expect(unstarted).toBe(0);
      expect(agent.context.messages().filter((message) => typeof message.type === "number").map((message) => message.type)).toEqual([2, 3, 4, 4, 1]);
      expect(agent.context.messages().find((message) => message.callId === "b")).toMatchObject({ error: true });
      agent.offEvent(off);
      await agent.send(USER("continue"));
      const sent = io.writes[1].context.filter((message) => typeof message.type === "number");
      expect(sent.map((message) => message.type)).toEqual([2, 3, 4, 4, 2, 1]);
      expect(sent.at(-1).content[0].text).toBe("keep this guidance");
    } finally { await agent.close(); await env.close(); }
  });

  test("cancelled batch guidance persists and resumes after queued input without re-executing tools", async () => {
    const env = await testEnv();
    env.toolAdd("loader", () => ({ result: "loaded", system: "durable guidance" }), { ...SKILL_TOOL, safe: false });
    const io = scriptedIO([[...TOOLCALL(0, "a", "loader", {}), ...TOOLCALL(1, "b", "loader", {})]]);
    const agent = await Agent.create({ env, model: "p/m", contextId: "batch-guidance", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, () => { void agent.cancel(); });
    let resumed;
    try {
      expect(await agent.run()).toMatchObject({ kind: "cancelled" });
      const saved = (await Bun.file(agent.context.file).text()).trim().split("\n").map(JSON.parse)
        .filter((message) => typeof message.type === "number");
      expect(saved.map((message) => message.type)).toEqual([2, 3, 4, 4, 1]);
      await agent.close();
      const next = scriptedIO([TEXT(0, "resumed")]);
      resumed = await Agent.create({ env, contextId: "batch-guidance", createIO: () => next });
      await resumed.send(USER("continue"));
      expect(next.writes[0].context.filter((message) => typeof message.type === "number").map((message) => message.type)).toEqual([2, 3, 4, 4, 2, 1]);
      expect(next.writes[0].context.at(-1).content[0].text).toBe("durable guidance");
      expect(next.writes).toHaveLength(1);
    } finally { await resumed?.close(); await agent.close(); await env.close(); }
  });

  test("a thrown payload follows all batch results, including a later successful call", async () => {
    const env = await testEnv();
    env.toolAdd("failing", () => { throw Object.assign(new Error("failed"), { system: "error guidance" }); }, SKILL_TOOL);
    env.toolAdd("later", () => "later result", SKILL_TOOL);
    const io = scriptedIO([
      [...TOOLCALL(0, "a", "failing", {}), ...TOOLCALL(1, "b", "later", {})], TEXT(0, "done"),
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    try {
      await agent.run();
      expect(io.writes[1].context.map((message) => message.type)).toEqual([2, 3, 4, 4, 1]);
      expect(io.writes[1].context[2].error).toBe(true);
      expect(io.writes[1].context.at(-1).content[0].text).toBe("error guidance");
    } finally { await agent.close(); await env.close(); }
  });

  test("a THROWN error's `system` payload appends after the tool-result error", async () => {
    const env = await testEnv();
    env.toolAdd("failing", () => {
      const err = new Error("path traversal refused: test");
      err.system = "Stay in the current directory tree.";
      throw err;
    }, SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "failing", {}),
      [...TEXT(0, "understood")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const types = agent.context.messages().map((m) => m.type);
    // user, assistant(calls), toolResult(ERROR), SYSTEM payload, assistant
    expect(types).toEqual([2, 3, 4, 1, 3]);
    expect(agent.context.at(2).error).toBe(true);
    expect(agent.context.at(3).content[0].text).toBe("Stay in the current directory tree.");
  });

  test("{ result, system }: queued user input joins the results BEFORE batch guidance", async () => {
    const env = await testEnv();
    let agent;
    env.toolAdd("loader", () => {
      agent.send(USER("queued mid-turn")); // flushes after this iteration's tool outcomes
      return { result: "skill loading: core", system: "<skill>payload</skill>" };
    }, SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "loaded it")],
    ]);
    agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const terminal = await agent.run({});

    expect(terminal.type).toBe("done");
    const types = agent.context.messages().map((m) => m.type);
    // user, assistant(calls), toolResult, queued user, SYSTEM payload, assistant
    expect(types).toEqual([2, 3, 4, 2, 1, 3]);
    const system = agent.context.at(4);
    expect(system.content[0].text).toBe("<skill>payload</skill>");
    const result = agent.context.at(2);
    expect(result.content[0].text).toBe("skill loading: core"); // the answer stays brief
  });

  test("a system ARRAY appends each payload as its own system message", async () => {
    const env = await testEnv();
    env.toolAdd("loader", () => ({ result: "ok", system: ["one", "two"] }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.messages().filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(2);
    expect(systems.map((m) => m.content[0].text)).toEqual(["one", "two"]);
  });

  test("onToolResult fires once after its result and display; guidance waits for the batch", async () => {
    const env = await testEnv();
    env.toolAdd("complete", () => ({ result: "brief", display: "shown", system: "system payload" }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "complete", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    let agent;
    agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result: message, display }) => seen.push({
      message, display, resultAppended: agent.context.messages().includes(message),
      systemAppended: agent.context.messages().some((m) => m.type === MessageType.System && m.content.some((b) => b.text === "system payload")),
    }));
    await agent.run({});

    expect(seen).toHaveLength(1);
    expect(seen[0].resultAppended).toBe(true);
    expect(seen[0].systemAppended).toBe(false);
    expect(agent.context.messages().some((message) => message.type === 1 && message.content[0].text === "system payload")).toBe(true);
    expect(seen[0].display).toEqual([{ type: "text", text: "shown" }]);
  });

  test("{ result, display }: the display payload rides onToolResult only — NEVER the context", async () => {
    const env = await testEnv();
    env.toolAdd("diffy", () => ({ result: "edited", display: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }), SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "diffy", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result: m, display }) => seen.push({ m, display }));
    await agent.run({});

    // the tool result carries ONLY the brief answer
    const result = agent.context.messages().find((m) => m.type === MessageType.ToolResult);
    expect(result.content[0].text).toBe("edited");
    // no System message; display is preserved on the result for context viewers
    expect(agent.context.messages().filter((m) => m.type === MessageType.System)).toHaveLength(0);
    expect(result.display).toEqual([{ type: "text", text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }]);
    // the binding saw the display payload as onToolResult's second argument
    expect(seen).toHaveLength(1);
    expect(seen[0].display).toEqual([{ type: "text", text: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new" }]);
  });

  test("the shared tool context carries the call's linkage ({callId, name})", async () => {
    const env = await testEnv();
    let got;
    env.toolAdd("probe", (args, context) => { got = context?.call; return "ok"; }, {
      ...SKILL_TOOL,
    });
    const io = scriptedIO([
      TOOLCALL(0, "c1", "probe", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});
    expect(got).toEqual({ callId: "c1", name: "probe" });
  });

  test("ordinary returns carry NO system key into the context; onToolResult sees only the result", async () => {
    const env = await testEnv();
    env.toolAdd("plain", () => "just text", SKILL_TOOL);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "plain", {}),
      [...TEXT(0, "done")],
    ]);
    const seen = [];
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    agent.onEvent(Agent.EVENT.TOOL_RESULT, ({ result }) => seen.push(result));
    await agent.run({});

    expect(agent.context.messages().filter((m) => m.type === MessageType.System)).toHaveLength(0);
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
    await toolsLoad(env, { dirs: [dir] });
    const io = scriptedIO([
      TOOLCALL(0, "c1", "loader", {}),
      [...TEXT(0, "done")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.messages().filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(1);
    expect(systems[0].content[0].text).toBe("payload via fork");
    const result = agent.context.messages().find((m) => m.type === MessageType.ToolResult);
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
    mkdirSync(`${global}/second`);
    writeFileSync(`${global}/second/SKILL.md`, "---\ndescription: another skill\n---\nSECOND BODY\n");
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

  test("unknown skills fail atomically and identify the missing names", async () => {
    fakeSkillDirs();
    const { skill } = await import("../tools/skill.js");
    await expect(skill({ names: ["nope"] })).rejects.toThrow("Unknown skills: nope");
    await expect(skill({ names: ["demo", "nope"] })).rejects.toThrow("Unknown skills: nope");
  });

  test("published safe (read-only) with the catalog-loading schema", async () => {
    const { toolDescription } = await import("../tools/skill.js");
    const schema = toolDescription().skill;
    expect(schema.safe).toBe(true);
    expect(schema.inputSchema.properties.names.type).toBe("array");
    expect(schema.inputSchema.properties.names.items.type).toBe("string");
  });

  test("end to end through the Agent: answer in the result, payload in the context", async () => {
    fakeSkillDirs();
    const env = await testEnv();
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolEntry(env, "skill")?.safe).toBe(true);
    const io = scriptedIO([
      TOOLCALL(0, "c1", "skill", { names: ["demo"] }),
      [...TEXT(0, "using the demo skill")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("load demo")], createIO: () => io });
    await agent.run({});

    const result = agent.context.messages().find((m) => m.type === MessageType.ToolResult);
    expect(result.content[0].text).toBe("Loaded skills: demo.");
    const system = agent.context.messages().find((m) => m.type === MessageType.System);
    expect(system.content[0].text).toContain("DEMO BODY");
  });

  test("end to end: multiple skills remain separate system messages", async () => {
    fakeSkillDirs();
    const env = await testEnv();
    await toolsLoad(env, { dirs: ["./tools"] });
    const io = scriptedIO([
      // the calling Env answers: its own (temporary) package folder has no
      // packaged skills, so both come from the environment root
      TOOLCALL(0, "c1", "skill", { names: ["demo", "second"] }),
      [...TEXT(0, "using both skills")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("load both")], createIO: () => io });
    await agent.run({});

    const systems = agent.context.messages().filter((m) => m.type === MessageType.System);
    expect(systems).toHaveLength(2);
    expect(systems[0].content[0].text).toContain('<skill name="demo">');
    expect(systems[1].content[0].text).toContain('<skill name="second">');
  });
});
