// test/agent-mcp.test.js — proof for the built-in `mcp` tool (lib/env/mcp-tools.js):
// zero-dep stdio JSON-RPC client over settings.mcp — lazy
// connect + initialize handshake, servers/tools/call actions, error
// surfaces (isError, unknown server/tool, dead connection), and the
// in-process connection pool reused across calls.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Env } from "../lib/env.js";
import { NAMES } from "../lib/namespace.js";
import { toolEntry, toolExists, toolNamesSafe, toolSchemas, toolsLoad, toolsRefresh } from "./env-internals.js";
import { startMcpHttp } from "./fixtures/mcp-http.js";

const SERVER = resolve("./test/fixtures/mcp-server.js"); // absolute: servers start in env.cwd
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
    expect(before).toContain("ready (connects on first use)");
    // no servers configured: no tool to call
    const dir = mkdtempSync("./ai-tmp/mcp-");
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir, settingsDir: dir, settings: {} });
    expect([...(await env.tools()).keys()].filter((name) => name.startsWith("mcp"))).toEqual([]); // no MCP tools at all
  });

  test("tools connects lazily (handshake) and lists the server's tools", async () => {
    const { context } = await fixtureContext();
    const out = await mcp({ action: "tools", server: "fixture" }, context);
    expect(out).toContain("fixture (6 tools)");
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
    const entry = context.env._mcpServers.entries.get("fixture");
    const before = entry.client.transport;
    expect(before.closed).toBe(false);
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "b" } }, context);
    expect(entry.client.transport).toBe(before); // the same live connection answered both calls
  });

  test("env.close() stops every pooled server and writes held settings; a later call reconnects", async () => {
    const { env, context } = await fixtureContext();
    await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "a" } }, context);
    const conn = env._mcpServers.entries.get("fixture").client.transport;
    env.settings.closeProbe = 1; // a held (deferred) settings write
    env.close();
    expect(conn.closed).toBe(true);
    expect(env._mcpServers.status().connected).toEqual([]);
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
    expect((await context.env.tools()).get("mcp").status.connected).toEqual([]);
    expect(await mcp({ action: "servers" }, context)).toContain("fixture: failed — server");
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
    expect(tools).toContain("safe-fixture (6 tools)");
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

  test("servers start in the Env project folder, not the process cwd", async () => {
    const dir = realpathSync(mkdtempSync("./ai-tmp/mcp-cwd-"));
    const env = new Env({
      dir,
      cwd: dir,
      settingsDir: dir,
      settings: { mcp: { "cwd-fixture": { command: process.execPath, args: [SERVER] } } },
    });
    try {
      const reported = await mcp({ action: "call", server: "cwd-fixture", tool: "cwd" }, { env });
      expect(realpathSync(reported)).toBe(dir);
    } finally {
      env.close();
    }
  });
});

describe("MCP dual-era transports", () => {
  for (const mode of ["modern", "legacy", "dual"]) {
    test(`HTTP ${mode} parses SSE, pagination and mirrors annotated headers`, async () => {
      const fixture = startMcpHttp(mode);
      const dir = mkdtempSync("./ai-tmp/mcp-http-");
      const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir, settingsDir: dir, settings: { mcp: { remote: { url: fixture.url } } } });
      try {
        const context = { env };
        const list = await mcp({ action: "tools", server: "remote" }, context);
        expect(list).toContain("remote (1 tool)");
        expect(list).toContain("dropped: invalid — invalid x-mcp-header at count");
        expect(await callMcp({ server: "remote", tool: "echo", arguments: { text: "padded value" } }, context)).toBe("padded value");
        const call = fixture.seen.find((item) => item.method === "tools/call");
        expect(call.headers["mcp-name"]).toBe("echo");
        expect(call.headers["mcp-method"]).toBe("tools/call");
        expect(call.headers["mcp-param-text"]).toBe("padded value");
        expect(fixture.seen.some((item) => item.method === "initialize")).toBe(mode === "legacy");
        expect((await env.tools()).get("mcp").status.connected).toEqual(["remote"]);
        if (mode === "legacy") {
          fixture.expireSession();
          expect(await callMcp({ server: "remote", tool: "echo", arguments: { text: "again" } }, context)).toBe("again");
          expect(fixture.seen.filter((item) => item.method === "initialize").length).toBe(2);
        }
        env.close();
        if (mode === "legacy") await Bun.sleep(10);
        if (mode === "legacy") expect(fixture.seen.some((item) => item.method === "DELETE")).toBe(true);
      } finally { env.close(); fixture.stop(); }
    });
  }
  test("a silent stdio discovery probe falls back within the short probe deadline", async () => {
    const { env } = await fixtureContext({ mcp: { fixture: {
      command: process.execPath, args: [resolve("./test/fixtures/mcp-cancel-server.js"), "server/discover"],
      timeout: 8_000,
    } } });
    try {
      const start = Date.now();
      expect(await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "ok" } }, { env }))
        .toBe("ok");
      expect(Date.now() - start).toBeLessThan(7_000);
    } finally { env.close(); }
  }, 10_000);
  test("modern stdio skips initialize", async () => {
    const { env } = await fixtureContext({ mcp: { fixture: { command: process.execPath, args: [SERVER, "modern"] } } });
    try { expect(await mcp({ action: "call", server: "fixture", tool: "echo", arguments: { text: "modern" } }, { env })).toBe("modern"); }
    finally { env.close(); }
  });
  test("HTTP headers expand from the filtered child env without exposing values", async () => {
    const fixture = startMcpHttp("modern");
    const dir = mkdtempSync("./ai-tmp/mcp-http-");
    const name = "OMOYA_MCP_HEADER_TEST";
    process.env[name] = "secret-header-value";
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir, settingsDir: dir, settings: { "env-allow": [name], mcp: { remote: { url: fixture.url, headers: { Authorization: `Bearer ${"${" + name + "}"}` } } } } });
    try {
      expect(await mcp({ action: "call", server: "remote", tool: "echo", arguments: { text: " 世界 " } }, { env })).toBe(" 世界 ");
      const request = fixture.seen.find((item) => item.method === "tools/call");
      expect(request.headers.authorization).toBe("Bearer secret-header-value");
      expect(request.headers["mcp-param-text"]).toBe(`=?base64?${Buffer.from(" 世界 ").toString("base64")}?=`);
      expect(await mcp({ action: "servers" }, { env })).not.toContain("secret-header-value");
    } finally { env.close(); fixture.stop(); delete process.env[name]; }
  });
  test("URL policy and missing header variables report safe reasons", async () => {
    const dir = mkdtempSync("./ai-tmp/mcp-http-");
    const env = new Env({ dir, settingsDir: dir, settings: { mcp: {
      bad: { url: "http://example.com/mcp" }, both: { url: "https://example.com", command: "x" },
      missing: { url: "http://localhost:1234/mcp", headers: { Authorization: "Bearer ${MCP_NOT_SET_223344}" } },
    } } });
    try {
      expect(await mcp({ action: "servers" }, { env })).toContain("bad: invalid config — url must be https or loopback http");
      expect(await mcp({ action: "servers" }, { env })).toContain("both: invalid config — exactly one");
      await expect(mcp({ action: "tools", server: "missing" }, { env })).rejects.toThrow(/header Authorization: environment variable MCP_NOT_SET_223344 is unset/);
      expect(await mcp({ action: "servers" }, { env })).toContain("missing: failed — MCP header Authorization:");
    } finally { env.close(); }
  });
  test("HTTP transport failures demote connected status and retry on the next use", async () => {
    const fixture = startMcpHttp("modern");
    const dir = mkdtempSync("./ai-tmp/mcp-http-");
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir, settingsDir: dir, settings: { mcp: { remote: { url: fixture.url } } } });
    try {
      const context = { env };
      await mcp({ action: "tools", server: "remote" }, context);
      fixture.failOnce();
      await expect(mcp({ action: "call", server: "remote", tool: "echo", arguments: { text: "x" } }, context))
        .rejects.toThrow(/MCP HTTP 503/);
      expect((await env.tools()).get("mcp").status.connected).toEqual([]);
      expect(await mcp({ action: "servers" }, context)).toContain("remote: failed — MCP HTTP 503");
      expect(await callMcp({ server: "remote", tool: "echo", arguments: { text: "recovered" } }, context)).toBe("recovered");
      expect((await env.tools()).get("mcp").status.connected).toEqual(["remote"]);
      fixture.stop();
      await expect(callMcp({ server: "remote", tool: "echo", arguments: { text: "down" } }, context)).rejects.toThrow();
      expect((await env.tools()).get("mcp").status.connected).toEqual([]);
    } finally { env.close(); fixture.stop(); }
  });
  test("settings refresh closes changed transport and updates connected status", async () => {
    const fixture = startMcpHttp("modern");
    const dir = mkdtempSync("./ai-tmp/mcp-http-");
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), dir, settingsDir: dir, settings: { mcp: { remote: { url: fixture.url } } } });
    try {
      await mcp({ action: "tools", server: "remote" }, { env });
      const transport = env._mcpServers.entries.get("remote").client.transport;
      env.settings.mcp = { remote: { url: `${fixture.url}?changed=1` } };
      await toolsRefresh(env);
      expect(transport.closed).toBe(true);
      expect((await env.tools()).get("mcp").status.connected).toEqual([]);
      expect(await mcp({ action: "servers" }, { env })).toContain("remote: ready (connects on first use)");
    } finally { env.close(); fixture.stop(); }
  });
});
