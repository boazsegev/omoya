// test/agent-mcp.test.js — proof for the `mcp` tool (tools/mcp.js):
// zero-dep stdio JSON-RPC client over settings.mcp — lazy
// connect + initialize handshake, servers/tools/call actions, error
// surfaces (isError, unknown server/tool, dead connection), and the
// in-process connection pool reused across calls.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { mcp } from "../tools/mcp.js";

const SERVER = "./test/fixtures/mcp-server.js";
const ENV_PREFIX = NAMES.NAMESPACE;
const MCP_CFG_ENV = `${ENV_PREFIX}_MCP_CFG`;
const MCP_LEAK_ENV = `${ENV_PREFIX}_MCP_LEAK`;

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

describe("the mcp tool", () => {
  test("servers lists the configured servers with their connection state", async () => {
    const { context } = await fixtureContext();
    const before = await mcp({ action: "servers" }, context);
    expect(before).toContain("fixture:");
    expect(before).toContain("not connected");
    // no servers configured: the configuration hint, never a crash
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({ dir, settingsDir: dir, settings: {} });
    expect(await mcp({ action: "servers" }, { env })).toMatch(/^No MCP servers are available\. Ask the user/);
  });

  test("tools connects lazily (handshake) and lists the server's tools", async () => {
    const { context } = await fixtureContext();
    const out = await mcp({ action: "tools", server: "fixture" }, context);
    expect(out).toContain("fixture (5 tools)");
    expect(out).toContain("echo — Echo the given text back.");
    // the connection now shows as connected, and the report reached the registry status
    expect(await mcp({ action: "servers" }, context)).toContain("connected");
    expect(context.env.toolEntry("mcp")).toBeUndefined(); // not registered here — direct calls only
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
    const pool = Env.mcpPool;
    expect(pool.size).toBeGreaterThan(0);
    const before = [...pool.values()].filter((c) => !c.closed).length;
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "b" } }, context);
    const after = [...pool.values()].filter((c) => !c.closed).length;
    expect(after).toBe(before); // the same live connection answered both calls
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
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.hasTool("mcp")).toBe(true);
    const [schema] = env.toolSchemas(["mcp"]);
    expect(schema.name).toBe("mcp");
    expect(schema.safe).toBeUndefined(); // stripped from the published catalog too
    // the tool IS published in safe mode — the per-SERVER "safe": true
    // config decides what it can reach there (safety is the server's,
    // never the tool's)
    expect(env.safeToolNames()).toContain("mcp");
  });
});

describe("the mcp tool — per-server shortcuts (mcp-<name>)", () => {
  test("one shortcut tool is published per configured server, folding in its description", async () => {
    const { env } = await fixtureContext({ mcp: { fixture: { command: process.execPath, args: [SERVER], description: "Test fixture." } } });
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.hasTool("mcp-fixture")).toBe(true);
    const [schema] = env.toolSchemas(["mcp-fixture"]);
    expect(schema.description).toContain("fixture");
    expect(schema.description).toContain("Test fixture.");
    expect(schema.inputSchema.required).toEqual(["tool"]);
  });

  test("calling the shortcut forwards to the fixed server, no `server` argument needed", async () => {
    const { env } = await fixtureContext();
    await env.loadTools({ dirs: ["./tools"] });
    const out = await env.callTool("mcp-fixture", { tool: "echo", arguments: { text: "shortcut" } }, { env });
    expect(out).toBe("shortcut");
  });

  test("an unmarked server's shortcut is absent from the safe view; a safe one is reachable", async () => {
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
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.safeToolNames()).toContain("mcp-safe-fixture");
    expect(env.safeToolNames()).not.toContain("mcp-plain-fixture");
    expect(await env.safe.callTool("mcp-safe-fixture", { tool: "echo", arguments: { text: "hi" } }, { env: env.safe }))
      .toBe("hi");
    await expect(env.safe.callTool("mcp-plain-fixture", { tool: "echo" }, { env: env.safe }))
      .rejects.toThrow(/not available in safe mode/);
  });

  test("removing a server from settings and refreshing drops its shortcut tool", async () => {
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({
      dir,
      settingsDir: dir,
      settings: { mcp: { fixture: { command: process.execPath, args: [SERVER] } } },
    });
    await env.loadTools({ dirs: ["./tools"] });
    expect(env.hasTool("mcp-fixture")).toBe(true);
    env.settings.mcp = {};
    await env.refreshTools();
    expect(env.hasTool("mcp-fixture")).toBe(false);
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
    return { env, context: { env: env.safe } }; // the SAFE VIEW, as the Agent hands it
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
    const safeContext = { env: env.safe };
    expect(await mcp({ action: "servers" }, safeContext)).toMatch(/^No MCP servers are available\. Ask the user/);
    expect(await mcp({ action: "tools" }, safeContext)).toMatch(/^No MCP servers are available\. Ask the user/);
  });
});

describe("the mcp tool — the child environment (tools/guard/env.js)", () => {
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
