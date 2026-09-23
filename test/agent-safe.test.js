// test/agent-safe.test.js — proof for the tool `safe` key and the
// Agent's safe mode: read-only tools (schemas with safe: true) are the
// only ones published and executed in safe mode; a missing key means
// false; the key never leaks into the provider-facing catalog.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { Env, osSandboxKind } from "../lib/env.js";
import { scriptedIO, recordingFactory, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const SAFE_READER = { description: "read only", safe: true, inputSchema: { type: "object", properties: {} } };
const WRITER = { description: "mutates", inputSchema: { type: "object", properties: {} } };

describe("env: the tool `safe` key", () => {
  test("safe: true marks the entry; a missing key means false", async () => {
    const env = await testEnv();
    env.registerTool("reader", () => "r", SAFE_READER);
    env.registerTool("writer", () => "w", WRITER);
    expect(env.toolEntry("reader").safe).toBe(true);
    expect(env.toolEntry("writer").safe).toBeUndefined();
    expect(env.safeToolNames()).toEqual(["reader"]);
    expect(env.toolNames()).toContain("writer"); // registration itself is unaffected
  });

  test("`safe` is harness metadata: stripped from the published catalog", async () => {
    const env = await testEnv();
    env.registerTool("reader", () => "r", SAFE_READER);
    const [published] = env.toolSchemas(["reader"]);
    expect(published.name).toBe("reader");
    expect(published.description).toBe("read only");
    expect("safe" in published).toBe(false);
  });

  test("file-scanned tools derive `safe` from their schema too", async () => {
    const env = await testEnv();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync("./ai-tmp/tools-");
    writeFileSync(`${dir}/probe.js`, `
      export function probe() { return "p"; }
      export function toolDescription() {
        return { probe: { description: "d", safe: true, inputSchema: {} } };
      }
    `);
    await env.loadTools({ dirs: [dir] });
    expect(env.toolEntry("probe").safe).toBe(true);
    expect(env.safeToolNames()).toContain("probe");
    expect("safe" in env.toolSchemas(["probe"])[0]).toBe(false);
  });
});

describe("agent: safe mode", () => {
  test("the published catalog is limited to safe tools", async () => {
    const env = await testEnv();
    env.registerTool("reader", () => "r", SAFE_READER);
    env.registerTool("writer", () => "w", WRITER);
    const factory = recordingFactory(() => scriptedIO([[...TEXT(0, "hi")]]));
    const agent = new Agent({ env, model: "p/m", context: [USER("hi")], createIO: factory, safe: true });
    await agent.run({});
    expect(factory.made[0].opts.tools).toEqual(["reader"]);
    expect(agent.safe).toBe(true);
  });

  test("an explicit availability selection INTERSECTS the safe list", async () => {
    const env = await testEnv();
    env.registerTool("reader", () => "r", SAFE_READER);
    env.registerTool("other", () => "o", SAFE_READER);
    env.registerTool("writer", () => "w", WRITER);
    const factory = recordingFactory(() => scriptedIO([[...TEXT(0, "hi")]]));
    const agent = new Agent({
      env, model: "p/m", context: [USER("hi")],
      createIO: factory, tools: ["reader", "writer"], safe: true,
    });
    await agent.run({});
    expect(factory.made[0].opts.tools).toEqual(["reader"]); // writer drops out
  });

  test("an unsafe call is REFUSED with a tool-result error, never executed", async () => {
    const env = await testEnv();
    let ran = 0;
    env.registerTool("reader", () => "fresh data", SAFE_READER);
    env.registerTool("writer", () => { ran++; return "mutated"; }, WRITER);
    const io = scriptedIO([
      [...TOOLCALL(0, "c1", "reader", {}), ...TOOLCALL(1, "c2", "writer", {})],
      [...TEXT(0, "done")],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io, safe: true });
    const terminal = await agent.run({});

    expect(terminal.type).toBe("done");
    expect(ran).toBe(0); // the unsafe tool NEVER executed
    const results = agent.context.filter((m) => m.type === 4);
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined(); // the safe call ran
    expect(results[0].content[0].text).toBe("fresh data");
    expect(results[1].error).toBe(true);
    expect(results[1].content[0].text).toContain("not available in safe mode");
    // the loop continued: the model saw both results and answered
    expect(io.turns()).toBe(2);
  });

  test("without safe mode everything publishes and runs (unchanged)", async () => {
    const env = await testEnv();
    let ran = 0;
    env.registerTool("writer", () => { ran++; return "mutated"; }, WRITER);
    const factory = recordingFactory(() => scriptedIO([
      TOOLCALL(0, "c1", "writer", {}),
      [...TEXT(0, "done")],
    ]));
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: factory });
    await agent.run({});
    expect(factory.made[0].opts.tools).toBeUndefined(); // no narrowing
    expect(ran).toBe(1);
    expect(agent.safe).toBe(false);
  });
});

describe("Env.safe — the safe VIEW (multi-consumer facade)", () => {
  const viewEnv = async () => {
    const env = await testEnv();
    env.registerTool("read-thing", () => "read", { description: "r", inputSchema: {}, safe: true });
    env.registerTool("write-thing", () => "write", { description: "w", inputSchema: {} });
    return env;
  };

  test("the view filters the catalog and names; the base env is untouched", async () => {
    const env = await viewEnv();
    const safeNames = env.safe.toolSchemas().map((t) => t.name).sort();
    expect(safeNames).toEqual(["read-thing"]); // tool-refresh mutates: not safe
    expect(env.safe.toolNames().sort()).toEqual(safeNames);
    // an explicit selection intersects the safe list
    expect(env.safe.toolSchemas(["read-thing", "write-thing"]).map((t) => t.name)).toEqual(["read-thing"]);
    // the base environment is NOT in safe mode: full catalog
    expect(env.toolNames()).toContain("write-thing");
  });

  test("the view refuses unsafe execution but runs safe tools; everything else delegates", async () => {
    const env = await viewEnv();
    await expect(env.safe.callTool("write-thing", {})).rejects.toThrow(/safe mode/);
    expect(await env.safe.callTool("read-thing", {})).toBe("read");
    expect(env.safe.safe).toBe(env.safe); // safe of safe is the same view
    expect(env.safe.endpointSettings("nowhere")).toEqual({});
    expect(env.safe.toolEntry("write-thing")?.safe).toBeUndefined(); // metadata intact
  });

  test("two agents over one Env pick their views independently", async () => {
    const env = await viewEnv();
    const cautious = new Agent({ env, model: "p/m", context: [], safe: true });
    const bold = new Agent({ env, model: "p/m", context: [] });
    expect(cautious._toolEnv()).not.toBe(env);
    expect(bold._toolEnv()).toBe(env);
    // flipping one agent's mode never touches the other
    bold.setSafe(true);
    expect(bold._toolEnv()).toBe(env.safe);
    expect(cautious._toolEnv()).toBe(env.safe);
    bold.setSafe(false);
    expect(bold._toolEnv()).toBe(env);
  });
});

describe("agent: runtime safe-mode switching (setSafe)", () => {
  test("the published catalog switches from the next request", async () => {
    const env = await testEnv();
    env.registerTool("unsafe-tool", () => "ran", { description: "u", inputSchema: {} });
    env.registerTool("safe-tool", () => "ok", { description: "s", inputSchema: {}, safe: true });
    const io = scriptedIO([[...TEXT(0, "done"), { type: "done" }]]);
    const seen = [];
    const factory = recordingFactory((opts) => {
      // the catalog the connection would publish: env view + selection
      seen.push(opts.env.toolSchemas(opts.tools).map((t) => t.name).sort());
      return io;
    });
    const agent = new Agent({ env, model: "p/m", context: [], createIO: factory });
    agent.append(USER("one"));
    await agent.run();
    agent.setSafe(true);
    agent.append(USER("two"));
    await agent.run();
    expect(seen[0]).toContain("unsafe-tool"); // before the toggle
    expect(seen[1]).toEqual(["safe-tool"]); // after: the safe view's catalog
    agent.setSafe(false);
    agent.append(USER("three"));
    await agent.run();
    expect(seen[2]).toContain("unsafe-tool"); // and back
  });

  test("setSafe refuses unsafe EXECUTION via the safe view (in-process path)", async () => {
    const env = await testEnv();
    env.registerTool("unsafe-builtin", () => "ran", { description: "u", inputSchema: {} });
    const agent = new Agent({ env, model: "p/m", context: [] });
    agent.setSafe(true);
    await expect(agent._toolEnv().callTool("unsafe-builtin", {})).rejects.toThrow(/safe mode/);
    expect(agent.setSafe(true)).toBe(true); // idempotent
  });

  test("effective safety is evaluated from the environment and parent on every access", async () => {
    const env = await testEnv();
    const parent = new Agent({ env, model: "p/m" });
    const child = new Agent({ env, model: "p/m", parent });
    expect(child.safe).toBe(false);
    parent.setSafe(true);
    expect(child.safe).toBe(true);
    expect(child.setSafe(false)).toBe(true);
    parent.setSafe(false);
    expect(child.safe).toBe(false);

    const baseSafe = env.safe;
    Object.defineProperty(env, "safe", { configurable: true, get: () => true });
    expect(child.safe).toBe(true);
    expect(child.setSafe(false)).toBe(true);
    Object.defineProperty(env, "safe", { configurable: true, get: () => baseSafe });
    expect(child.safe).toBe(false);
  });
});

describe("agent: FORCED safe mode (no supported OS sandbox)", () => {
  // The namespace sandbox gate simulates a mechanism-less platform
  // (read per call, so suite ordering cannot matter).
  const withoutSandbox = (run) => {
    const savedOs = process.env[NAMES.osSandboxEnv];
    process.env[NAMES.osSandboxEnv] = "none";
    try {
      return run();
    } finally {
      if (savedOs === undefined) delete process.env[NAMES.osSandboxEnv]; else process.env[NAMES.osSandboxEnv] = savedOs;
    }
  };

  test("Env states OS-sandbox availability from the one supported gate", () => {
    withoutSandbox(() => {
      expect(Env.osSandboxAvailable()).toBe(false);
      expect(osSandboxKind()).toBe(null); // the wrapper has no mechanism either
    });
    // the real platform: availability and the active kind agree
    expect(Env.osSandboxAvailable()).toBe(osSandboxKind() !== null);
  });

  test("an Agent forces safe:true when no OS sandbox is available (setSafe(false) can't undo it)", async () => {
    const env = await testEnv();
    withoutSandbox(() => {
      const agent = new Agent({ env, model: "p/m", context: [] });
      expect(agent.safe).toBe(true); // forced — the caller never asked
      expect(agent.setSafe(false)).toBe(true); // refused: stays safe
      const explicit = new Agent({ env, model: "p/m", context: [], safe: false });
      expect(explicit.safe).toBe(true); // even an explicit safe:false is overridden
    });
  });

});
