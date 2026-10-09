// test/agent-safe.test.js — proof for the tool `safe` key and the
// Agent's write capability: read-only tools (schemas with safe: true) are the
// only ones published and executed in safe mode; a missing key means
// false; the key never leaks into the provider-facing catalog.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { Env } from "../lib/env.js";
import Sandbox from "../lib/sandbox.js";
const osSandboxKind = () => Sandbox.osKind();
import { scriptedIO, recordingFactory, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const SAFE_READER = { description: "read only", safe: true, inputSchema: { type: "object", properties: {} } };
const WRITER = { description: "mutates", inputSchema: { type: "object", properties: {} } };

/** The catalog a connection publishes for its creation options (IO.tools):
 *  Env.tools(safe) narrowed by the availability selection, secrets hidden. */
async function published(opts) {
  const selection = opts.tools;
  const all = selection === undefined || (selection.length === 1 && selection[0] === "*");
  return [...(await opts.env.tools(opts.safe === true)).values()]
    .filter((info) => !info.secret && (all || selection.includes(info.name)))
    .map((info) => info.name).sort();
}

describe("env: the tool `safe` key", () => {
  test("safe: true marks the entry; a missing key means false", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "r", SAFE_READER);
    env.toolAdd("writer", () => "w", WRITER);
    const catalog = await env.tools();
    expect(catalog.get("reader").safe).toBe(true);
    expect(catalog.get("writer").safe).toBe(false);
    expect([...(await env.tools(true)).keys()]).toEqual(["reader"]);
    expect(catalog.has("writer")).toBe(true); // registration itself is unaffected
  });

  test("`safe` is harness metadata: never part of the published schema", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "r", SAFE_READER);
    const { schema } = (await env.tools()).get("reader");
    expect(schema.description).toBe("read only");
    expect("safe" in schema).toBe(false);
  });

  test("file-scanned tools derive `safe` from their schema too", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync("./ai-tmp/tools-");
    writeFileSync(`${dir}/probe.js`, `
      export function probe() { return "p"; }
      export function toolDescription() {
        return { probe: { description: "d", safe: true, inputSchema: {} } };
      }
    `);
    const env = await Env.open(dir, { dir, settingsDir: dir, toolDirs: [dir], init: { providers: false, models: false } });
    const probe = (await env.tools(true)).get("probe");
    expect(probe.safe).toBe(true);
    expect("safe" in probe.schema).toBe(false);
  });
});

describe("agent: safe mode", () => {
  test("the published catalog is limited to safe tools", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "r", SAFE_READER);
    env.toolAdd("writer", () => "w", WRITER);
    const factory = recordingFactory(() => scriptedIO([[...TEXT(0, "hi")]]));
    const agent = await Agent.create({ env, model: "p/m", context: [USER("hi")], createIO: factory, can: { write: false } });
    await agent.run({});
    expect(await published(factory.made[0].opts)).toEqual(["reader", "tool-refresh", "writer"]);
    expect(agent.can.write).toBe(false);
  });

  test("an explicit availability selection INTERSECTS the safe list", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "r", SAFE_READER);
    env.toolAdd("other", () => "o", SAFE_READER);
    env.toolAdd("writer", () => "w", WRITER);
    const factory = recordingFactory(() => scriptedIO([[...TEXT(0, "hi")]]));
    const agent = await Agent.create({
      env, model: "p/m", context: [USER("hi")],
      createIO: factory, tools: ["reader", "writer"], can: { write: false },
    });
    await agent.run({});
    expect(await published(factory.made[0].opts)).toEqual(["reader", "writer"]); // permission does not change publication
  });

  test("an unsafe call is REFUSED with a tool-result error, never executed", async () => {
    const env = await testEnv();
    let ran = 0;
    env.toolAdd("reader", () => "fresh data", SAFE_READER);
    env.toolAdd("writer", () => { ran++; return "mutated"; }, WRITER);
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "reader", {}), ...TOOLCALL(1, "c2", "writer", {})],
      [...TEXT(0, "done")],
    ]);
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: () => io, can: { write: false } });
    const terminal = await agent.run({});

    expect(terminal.type).toBe("done");
    expect(ran).toBe(0); // the unsafe tool NEVER executed
    const results = agent.context.messages().filter((m) => m.type === 4);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined(); // the safe call ran
    expect(results[0].content[0].text).toBe("fresh data");
    expect(results[1].error).toBe(true);
    expect(results[1].content[0].text).toBe("User set read only mode, this tool can't be called right now");
    // the loop continued: the model saw both results and answered
    expect(io.turns()).toBe(2);
  });

  test("without safe mode everything publishes and runs (unchanged)", async () => {
    const env = await testEnv();
    let ran = 0;
    env.toolAdd("writer", () => { ran++; return "mutated"; }, WRITER);
    const factory = recordingFactory(() => scriptedIO([
      TOOLCALL(0, "c1", "writer", {}),
      [...TEXT(0, "done")],
    ]));
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: factory });
    await agent.run({});
    expect(factory.made[0].opts.tools).toBeUndefined(); // no narrowing
    expect(factory.made[0].opts.safe).toBe(false);
    expect(ran).toBe(1);
    expect(agent.can.write).toBe(true);
  });
});

describe("safe mode is the caller's argument (one Env, any number of consumers)", () => {
  const twoTools = async () => {
    const env = await testEnv();
    env.toolAdd("read-thing", () => "read", { description: "r", inputSchema: {}, safe: true });
    env.toolAdd("write-thing", () => "write", { description: "w", inputSchema: {} });
    return env;
  };

  test("tools(true) lists read-only tools; the full catalog is unchanged", async () => {
    const env = await twoTools();
    expect([...(await env.tools(true)).keys()]).toEqual(["read-thing"]); // tool-refresh mutates: not safe
    expect((await env.tools()).has("write-thing")).toBe(true);
  });

  test("toolCall refuses an unsafe tool under context.safe; safe tools run", async () => {
    const env = await twoTools();
    await expect(env.toolCall("write-thing", {}, { safe: true })).rejects.toThrow(/safe mode/);
    expect(await env.toolCall("read-thing", {}, { safe: true })).toBe("read");
    expect(await env.toolCall("write-thing", {})).toBe("write"); // no safe flag: the call's own choice
  });

  test("two agents over one Env carry their own mode into every tool context", async () => {
    const env = await twoTools();
    const cautious = await Agent.create({ env, model: "p/m", context: [], can: { write: false } });
    const bold = await Agent.create({ env, model: "p/m", context: [] });
    expect(cautious._toolContext().safe).toBe(true);
    expect(bold._toolContext().safe).toBe(false);
    // flipping one agent's mode never touches the other
    (bold.can.write = false);
    expect(bold._toolContext().safe).toBe(true);
    (bold.can.write = true);
    expect(bold._toolContext().safe).toBe(false);
    expect(cautious._toolContext().safe).toBe(true);
  });
});

describe("agent: runtime write-capability switching", () => {
  test("the published catalog switches from the next request", async () => {
    const env = await testEnv();
    env.toolAdd("unsafe-tool", () => "ran", { description: "u", inputSchema: {} });
    env.toolAdd("safe-tool", () => "ok", { description: "s", inputSchema: {}, safe: true });
    const io = scriptedIO([[...TEXT(0, "done"), { type: "done" }]]);
    const seen = [];
    const factory = recordingFactory((opts) => {
      seen.push(published(opts));
      return io;
    });
    const agent = await Agent.create({ env, model: "p/m", context: [], createIO: factory });
    agent.context.append(USER("one"));
    await agent.run();
    (agent.can.write = false);
    agent.context.append(USER("two"));
    await agent.run();
    (agent.can.write = true);
    agent.context.append(USER("three"));
    await agent.run();
    const catalogs = await Promise.all(seen);
    expect(catalogs[0]).toContain("unsafe-tool"); // before the toggle
    expect(catalogs).toHaveLength(1); // connection reused across mode changes // after: read-only only
    expect((await agent.tools).has("unsafe-tool")).toBe(true); // and back
  });

  test("a toggle MID-TURN changes the catalog of the very next request (between tool rounds)", async () => {
    const env = await testEnv();
    env.toolAdd("unsafe-tool", () => "ran", { description: "u", inputSchema: {} });
    env.toolAdd("lockdown", (_args, context) => { (context.agent.can.write = false); return "locked"; }, { description: "l", inputSchema: {}, safe: true });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "lockdown", {})], [...TEXT(0, "done")]]);
    const seen = [];
    let current;
    const write = io.write.bind(io);
    io.write = async (...args) => { seen.push(await published(current)); return write(...args); };
    const agent = await Agent.create({ env, model: "p/m", context: [USER("go")], createIO: (opts) => { current = opts; return io; } });
    await agent.run();
    expect(seen).toHaveLength(2); // one turn, two provider requests
    expect(seen[0]).toContain("unsafe-tool"); // before the tool flipped safe mode
    expect(seen[1]).toContain("unsafe-tool"); // the very next request: read-only only
  });

  test("a safe tool registered after the connection exists is published on the next request", async () => {
    const env = await testEnv();
    env.toolAdd("reader", () => "r", SAFE_READER);
    env.toolAdd("writer", () => "w", WRITER);
    const io = scriptedIO([[...TEXT(0, "done")]]);
    const seen = [];
    let current;
    const write = io.write.bind(io);
    io.write = async (...args) => { seen.push(await published(current)); return write(...args); };
    let made = 0;
    const agent = await Agent.create({ env, model: "p/m", context: [], can: { write: false }, createIO: (opts) => { made++; current = opts; return io; } });
    agent.context.append(USER("one"));
    await agent.run();
    env.toolAdd("late-reader", () => "l", SAFE_READER); // e.g. an MCP server connecting later
    env.toolAdd("late-writer", () => "w", WRITER);
    agent.context.append(USER("two"));
    await agent.run();
    expect(made).toBe(1); // the same cached connection served both requests
    expect(seen).toEqual([["reader", "tool-refresh", "writer"], ["late-reader", "late-writer", "reader", "tool-refresh", "writer"]]);
  });

  test("effective safety from a parent refuses unsafe EXECUTION at the Agent gate", async () => {
    const env = await testEnv();
    let ran = 0;
    env.toolAdd("writer", () => { ran++; return "mutated"; }, WRITER);
    const parent = await Agent.create({ env, model: "p/m", can: { write: false } });
    const io = scriptedIO([[...TOOLCALL(0, "c1", "writer", {})], [...TEXT(0, "done")]]);
    const child = await Agent.create({ env, model: "p/m", parent, context: [USER("go")], createIO: () => io });
    expect(child.can.write).toBe(false);
    expect((await child.tools).has("writer")).toBe(true);
    await child.run();
    expect(ran).toBe(0);
    // the Agent-level refusal (which also guards the forked worker path)
    const result = child.context.messages().find((m) => m.type === 4);
    expect(result.content[0].text).toBe("User set read only mode, this tool can't be called right now");
  });

  test("a safe Agent's tool context makes Env refuse unsafe execution (in-process path)", async () => {
    const env = await testEnv();
    env.toolAdd("unsafe-builtin", () => "ran", { description: "u", inputSchema: {} });
    const agent = await Agent.create({ env, model: "p/m", context: [] });
    (agent.can.write = false);
    await expect(env.toolCall("unsafe-builtin", {}, agent._toolContext())).rejects.toThrow(/safe mode/);
    expect((agent.can.write = false)).toBe(false); // idempotent
  });

  test("effective safety is evaluated from the parent on every access", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env, model: "p/m" });
    const child = await Agent.create({ env, model: "p/m", parent });
    expect(child.can.write).toBe(true);
    (parent.can.write = false);
    expect(child.can.write).toBe(false);
    child.can.write = true;
    expect(child.can.write).toBe(false);
    (parent.can.write = true);
    expect(child.can.write).toBe(true);
  });
});

describe("agent: FORCED safe mode (no supported OS sandbox)", () => {
  // The namespace sandbox gate simulates a mechanism-less platform
  // (read per call, so suite ordering cannot matter).
  const withoutSandbox = async (run) => {
    const savedOs = process.env[NAMES.osSandboxEnv];
    process.env[NAMES.osSandboxEnv] = "none";
    try {
      return await run();
    } finally {
      if (savedOs === undefined) delete process.env[NAMES.osSandboxEnv]; else process.env[NAMES.osSandboxEnv] = savedOs;
    }
  };

  test("Sandbox states OS-sandbox availability from the one supported gate", async () => {
    await withoutSandbox(() => {
      expect(Sandbox.osAvailable()).toBe(false);
      expect(osSandboxKind()).toBe(null); // the wrapper has no mechanism either
    });
    // the real platform: availability and the active kind agree
    expect(Sandbox.osAvailable()).toBe(osSandboxKind() !== null);
  });

  test("an Agent forces safe:true when no OS sandbox is available (setSafe(false) can't undo it)", async () => {
    const env = await testEnv();
    await withoutSandbox(async () => {
      const agent = await Agent.create({ env, model: "p/m", context: [] });
      expect(agent.can.write).toBe(false); // forced — the caller never asked
      agent.can.write = true;
      expect(agent.can.write).toBe(false); // refused: stays safe
      const explicit = await Agent.create({ env, model: "p/m", context: [], can: { write: true } });
      expect(explicit.can.write).toBe(false); // even an explicit safe:false is overridden
    });
  });

});
