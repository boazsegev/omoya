// test/agent-mcp.test.js — proof for the built-in `mcp` tool (lib/env/mcp-tools.js):
// zero-dep stdio JSON-RPC client over settings.mcp — lazy
// connect + initialize handshake, servers/tools/call actions, error
// surfaces (isError, unknown server/tool, dead connection), and the
// in-process connection pool reused across calls.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { toolEntry, toolExists, toolNamesSafe, toolSchemas, toolsLoad, toolsRefresh } from "./env-internals.js";

const SERVER = "./test/fixtures/mcp-server.js";
const ENV_PREFIX = NAMES.NAMESPACE;
const MCP_CFG_ENV = `${ENV_PREFIX}_MCP_CFG`;
const MCP_LEAK_ENV = `${ENV_PREFIX}_MCP_LEAK`;

/** The built-in `mcp` tool, called through its Env (context.env). */
const mcp = (args, context) => context.env.toolCall("mcp", args, context);
/** One remote call (the action the shortcuts and web.js use). */
const callMcp = ({ server, tool, arguments: args }, context) => mcp({ action: "call", server, tool, arguments: args }, context);

/** An env with the fixture server configured; the tool context it yields. */
async function fixtureContext(settings = {}) {
  const dir = mkdtempSync("./ai-tmp/mcp-");
  const env = new Env({
    dir,
    settingsDir: dir,
    settings: { mcp: { fixture: { command: process.execPath, args: [SERVER] } }, ...settings },
  });
  return { env, context: { env } };
}

describe("package startup after the MCP API migration", () => {
  async function packageEnv(settings = {}) {
    const dir = mkdtempSync("./ai-tmp/mcp-startup-");
    return Env.create({ dir, cwd: dir, settingsDir: dir, settings }, { providers: false, models: false });
  }

  test("loads and refreshes package tools without MCP configuration", async () => {
    const env = await packageEnv();
    try {
      expect((await env.tools()).has("read")).toBe(true);
      expect([...(await env.tools()).keys()].filter((name) => name.startsWith("mcp"))).toEqual([]);
      await env.toolCall("tool-refresh", {});
      expect((await env.tools()).has("read")).toBe(true);
      expect([...(await env.tools()).keys()].filter((name) => name.startsWith("mcp"))).toEqual([]);
    } finally {
      env.close();
    }
  });

  test("keeps configured MCP tools Env-owned across package scans and drops them when unconfigured", async () => {
    const env = await packageEnv({ mcp: { fixture: { command: process.execPath, args: [SERVER], safe: true } } });
    try {
      expect((await env.tools()).get("mcp").builtin).toBe(true);
      expect((await env.tools(true)).get("mcp-fixture").builtin).toBe(true);
      expect(await env.toolCall("mcp-fixture", { tool: "echo", arguments: { text: "startup" } }, { safe: true })).toBe("startup");
      await env.toolCall("tool-refresh", {});
      expect((await env.tools()).get("mcp").builtin).toBe(true);
      expect(await env.toolCall("mcp", { action: "servers" }, { safe: true })).toBe("fixture: connected");
      env.settings.mcp = {};
      await env.toolCall("tool-refresh", {});
      expect([...(await env.tools()).keys()].filter((name) => name.startsWith("mcp"))).toEqual([]);
    } finally {
      env.close();
    }
  });
});

describe("the mcp tool", () => {
  test("servers lists the configured servers with their connection state", async () => {
    const { context } = await fixtureContext();
    const before = await mcp({ action: "servers" }, context);
    expect(before).toContain("fixture:");
    expect(before).toContain("not connected");
    // no servers configured: no tool to call
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({ dir, settingsDir: dir, settings: {} });
    expect([...(await env.tools()).keys()].filter((name) => name.startsWith("mcp"))).toEqual([]); // no MCP tools at all
  });

  test("tools connects lazily (handshake) and lists the server's tools", async () => {
    const { context } = await fixtureContext();
    const out = await mcp({ action: "tools", server: "fixture" }, context);
    expect(out).toContain("fixture (5 tools)");
    expect(out).toContain("echo — Echo the given text back.");
    // the connection now shows as connected, and the report reached the registry status
    expect(await mcp({ action: "servers" }, context)).toContain("connected");
    expect((await context.env.tools()).get("mcp").status).toEqual({ configured: 1, connected: ["fixture"] }); // the pool state
  });

  test("call invokes a remote tool and returns its text content", async () => {
    const { context } = await fixtureContext();
    expect(await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "ping" } }, context)).toBe("ping");
    expect(await mcp({ action: "call", server: "fixture", tool: "add", arguments: { a: 2, b: 40 } }, context)).toBe("42");
  });

  test("an isError result surfaces as a tool error; unknown names are ordinary errors", async () => {
    const { context } = await fixtureContext();
    await expect(mcp({ action: "call", server: "fixture", tool: "fail" }, context))
      .rejects.toThrow(/^Fix the remote tool arguments/);
    try {
      await callMcp({ server: "fixture", tool: "fail" }, context);
      throw new Error("expected callMcp failure");
    } catch (error) {
      expect(error.mcpDetail).toBe("the fixture failed on purpose");
    }
    await expect(mcp({ action: "call", server: "nope", tool: "x" }, context))
      .rejects.toThrow(/^Choose a server listed by servers/);
    await expect(mcp({ action: "tools", server: "nope" }, context))
      .rejects.toThrow(/^Choose a server listed by servers/);
    await expect(mcp({ action: "call", server: "fixture" }, context))
      .rejects.toThrow(/^Choose a tool name/);
    await expect(mcp({ action: "bogus" }, context))
      .rejects.toThrow(/^Choose action servers, tools, or call/);
  });

  test("the connection pool is reused across calls (one server process)", async () => {
    const { context } = await fixtureContext();
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "a" } }, context);
    const pool = context.env._mcpPool; // the Env's own client pool
    expect(pool.size).toBeGreaterThan(0);
    const before = [...pool.values()].filter((c) => !c.closed).length;
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "b" } }, context);
    const after = [...pool.values()].filter((c) => !c.closed).length;
    expect(after).toBe(before); // the same live connection answered both calls
  });

  test("env.close() stops every pooled server and writes held settings; a later call reconnects", async () => {
    const { env, context } = await fixtureContext();
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "a" } }, context);
    const [conn] = env._mcpPool.values();
    env.settings.closeProbe = 1; // a held (deferred) settings write
    env.close();
    expect(conn.closed).toBe(true);
    expect(env._mcpPool.size).toBe(0);
    expect(JSON.parse(readFileSync(join(env._settingsDir, "settings.json"), "utf8")).closeProbe).toBe(1); // on disk already
    expect(await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "b" } }, context)).toBe("b");
    env.close(); // idempotent
    env.close();
  });

  test("a dying server rejects the in-flight request and the next call reconnects", async () => {
    const { context } = await fixtureContext();
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "warm" } }, context);
    await expect(mcp({ action: "call", server: "fixture", tool: "die" }, context))
      .rejects.toThrow(/exited \(code 3\)/);
    const again = await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "revived" } }, context);
    expect(again).toBe("revived"); // a dead pooled connection is replaced
  });

  test("the registry publishes mcp without harness metadata; safe-marked for safe-marked servers", async () => {
    const { env } = await fixtureContext();
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolExists(env, "mcp")).toBe(true);
    const [schema] = toolSchemas(env, ["mcp"]);
    expect(schema.name).toBe("mcp");
    expect(schema.safe).toBeUndefined(); // stripped from the published catalog too
    // the tool IS published in safe mode — the per-SERVER "safe": true
    // config decides what it can reach there (safety is the server's,
    // never the tool's)
    expect(toolNamesSafe(env)).toContain("mcp");
  });
});

describe("the mcp tool — per-server shortcuts (mcp-<name>)", () => {
  test("one shortcut tool is published per configured server, folding in its description", async () => {
    const { env } = await fixtureContext({ mcp: { fixture: { command: process.execPath, args: [SERVER], description: "Test fixture." } } });
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolExists(env, "mcp-fixture")).toBe(true);
    const [schema] = toolSchemas(env, ["mcp-fixture"]);
    expect(schema.description).toContain("fixture");
    expect(schema.description).toContain("Test fixture.");
    expect(schema.inputSchema.required).toEqual(["tool"]);
  });

  test("calling the shortcut forwards to the fixed server, no `server` argument needed", async () => {
    const { env } = await fixtureContext();
    await toolsLoad(env, { dirs: ["./tools"] });
    const out = await env.toolCall("mcp-fixture", { tool: "echo", arguments: { text: "shortcut" } }, { env });
    expect(out).toBe("shortcut");
  });

  test("an unmarked server's shortcut is absent from the safe catalog; a safe one is reachable", async () => {
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({
      dir,
      settingsDir: dir,
      settings: {
        mcp: {
          "safe-fixture": { command: process.execPath, args: [SERVER], safe: true },
          "plain-fixture": { command: process.execPath, args: [SERVER] },
        },
      },
    });
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolNamesSafe(env)).toContain("mcp-safe-fixture");
    expect(toolNamesSafe(env)).not.toContain("mcp-plain-fixture");
    expect(await env.toolCall("mcp-safe-fixture", { tool: "echo", arguments: { text: "hi" } }, { env, safe: true }))
      .toBe("hi");
    await expect(env.toolCall("mcp-plain-fixture", { tool: "echo" }, { env, safe: true }))
      .rejects.toThrow(/not available in safe mode/);
  });

  test("removing a server from settings and refreshing drops its shortcut tool", async () => {
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({
      dir,
      settingsDir: dir,
      settings: { mcp: { fixture: { command: process.execPath, args: [SERVER] } } },
    });
    await toolsLoad(env, { dirs: ["./tools"] });
    expect(toolExists(env, "mcp-fixture")).toBe(true);
    env.settings.mcp = {};
    await toolsRefresh(env);
    expect(toolExists(env, "mcp-fixture")).toBe(false);
  });
});

describe("the mcp tool — safe mode (the SERVER's config carries the safety decision)", () => {
  /** An env with one safe-marked and one unmarked fixture server. */
  async function mixedContext(extra = {}) {
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({
      dir,
      settingsDir: dir,
      settings: {
        mcp: {
          "safe-fixture": { command: process.execPath, args: [SERVER], safe: true },
          "plain-fixture": { command: process.execPath, args: [SERVER] },
        },
        ...extra,
      },
    });
    return { env, context: { env, safe: true } }; // a safe caller's context, as the Agent hands it
  }

  test("listings show only safe-marked servers; a safe one connects and answers", async () => {
    const { context } = await mixedContext();
    const servers = await mcp({ action: "servers" }, context);
    expect(servers).toContain("safe-fixture");
    expect(servers).not.toContain("plain-fixture");
    expect(servers).not.toContain("[Read Only]");
    const tools = await mcp({ action: "tools" }, context); // no server: every REACHABLE one
    expect(tools).toContain("safe-fixture (5 tools)");
    expect(tools).not.toContain("plain-fixture");
    expect(await mcp({ action: "call", server: "safe-fixture", tool: "echo", arguments: { text: "hi" } }, context)).toBe("hi");
  });

  test("an unavailable server gives the same public correction as an unknown server", async () => {
    const { context } = await mixedContext();
    await expect(mcp({ action: "call", server: "plain-fixture", tool: "echo" }, context))
      .rejects.toThrow(/^Choose a server listed by servers/);
    await expect(mcp({ action: "tools", server: "plain-fixture" }, context))
      .rejects.toThrow(/^Choose a server listed by servers/);
    await expect(mcp({ action: "call", server: "nope", tool: "x" }, context))
      .rejects.toThrow(/^Choose a server listed by servers/);
  });

  test("with no reachable servers listings give the ordinary configuration instruction", async () => {
    const { env } = await fixtureContext(); // fixture is unavailable in this view
    const safeContext = { env, safe: true };
    expect(await mcp({ action: "servers" }, safeContext)).toMatch(/^No MCP servers are available\. Ask the user/);
    expect(await mcp({ action: "tools" }, safeContext)).toMatch(/^No MCP servers are available\. Ask the user/);
  });
});

describe("the mcp tool — the child environment (lib/util.js childEnv)", () => {
  test("the config's env additions reach the server; env-refuse strips inherited keys", async () => {
    process.env[MCP_LEAK_ENV] = "top-secret";
    try {
      const dir = mkdtempSync("./ai-tmp/mcp-");
      const env = new Env({
        dir,
        settingsDir: dir,
        settings: {
          "env-refuse": [MCP_LEAK_ENV],
          mcp: {
            "env-fixture": { command: process.execPath, args: [SERVER], env: { [MCP_CFG_ENV]: "from-config" } },
          },
        },
      });
      const context = { env };
      expect(await mcp({ action: "call", server: "env-fixture", tool: "getenv", arguments: { name: MCP_CFG_ENV } }, context))
        .toBe("from-config"); // the explicit addition always lands
      const leaked = await mcp({ action: "call", server: "env-fixture", tool: "getenv", arguments: { name: MCP_LEAK_ENV } }, context);
      expect(leaked).not.toContain("top-secret"); // the inherited key was refused
    } finally {
      delete process.env[MCP_LEAK_ENV];
    }
  });
});
