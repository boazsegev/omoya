import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { providerClass } from "./fakes.js";
import { oauthPasteOnly } from "../lib/cli.js";
import Env from "../lib/env.js";
import AnthropicPlugin from "../providers/anthropic.js";
import ClaudePlugin from "../providers/claude.js";
import { providerNamesOf, providersLoad } from "./env-internals.js";

const Anthropic = await providerClass(AnthropicPlugin, "anthropic");
const Claude = await providerClass(ClaudePlugin, "claude");
const URL = "https://api.anthropic.com/v1";
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
const io = (auth, tools = []) => ({ modelCurrent: "test/claude-sonnet-4-6", settings: { auth }, tools: () => tools });
const user = [{ type: 2, content: [{ type: "text", text: "hello" }] }];

describe("Claude subscription provider", () => {
  test("package scan registers Claude independently and publishes its OAuth preset", async () => {
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), settingsDir: null, settings: { providers: {} } });
    await providersLoad(env, { detect: false });
    expect(providerNamesOf(env)).toContain("claude");
    expect(env.loginPresets().find((entry) => entry.name === "claude")?.provider).toBe("claude");
    expect(env.loginPresets().find((entry) => entry.name === "anthropic-claude")).toBeUndefined();
  });

  test("subscription login is its own provider, not an Anthropic preset", () => {
    expect(Claude.knownEndpoints.map((entry) => entry.name)).toEqual(["claude"]);
    expect(Claude.knownEndpoints[0]).toMatchObject({ name: "claude", url: URL, verify: "messages", oauth: { clientId: expect.any(String) } });
    expect(Anthropic.knownEndpoints.some((entry) => entry.oauth)).toBe(false);
    expect(Claude.knownEndpoints[0].oauth.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
    expect(oauthPasteOnly(Claude.knownEndpoints[0].oauth)).toBe(false);
    expect(Claude.knownEndpoints[0].oauth.redirectUri).toBe("http://localhost:53692/callback");
    expect(Claude.knownEndpoints[0].oauth.scope).toContain("user:sessions:claude_code");
  });

  test("OAuth sends Claude Code identity, headers and reversible tool names", () => {
    const tools = [
      { name: "read", description: "read", inputSchema: { type: "object", properties: {} } },
      { name: "mcp_search", description: "search", inputSchema: { type: "object", properties: {} } },
    ];
    const connection = new Claude(URL, io({ type: "oauth", token: "sk-ant-oat-test" }, tools));
    const [headers, body] = connection.context2msg(user);
    expect(headers.authorization).toBe("Bearer sk-ant-oat-test");
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["user-agent"]).toBe("claude-cli/2.1.280");
    expect(headers.accept).toBe("application/json");
    expect(body.system).toEqual([{ type: "text", text: identity, cache_control: { type: "ephemeral" } }]);
    expect(body.tools.map((tool) => tool.name)).toEqual(["Read", "mcp_search"]);
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    const state = {};
    const start = connection.msg2events({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: body.tools[0].name } }, state);
    expect(start[0].name).toBe("read");
    const end = connection.msg2events({ type: "message_stop" }, state);
    expect(end[0].message.content[0].name).toBe("read");
  });

  test("each request keeps provider identity separate from context and bounds explicit cache breakpoints", () => {
    const auth = { type: "oauth", token: "t" };
    const tools = [{ name: "read" }, { name: "edit" }];
    const connection = new Claude(URL, io(auth, tools));
    const context = [
      { type: 1, content: [{ type: "text", text: "Agent instructions" }] },
      ...Array.from({ length: 8 }, (_, n) => ({ type: 2, content: [{ type: "text", text: `turn ${n}` }] })),
    ];
    const original = structuredClone(context);
    const bodies = [connection.context2msg(context)[1], connection.context2msg(context)[1]];
    expect(context).toEqual(original);
    for (const body of bodies) {
      expect(body.system).toEqual([
        { type: "text", text: identity, cache_control: { type: "ephemeral" } },
        { type: "text", text: "Agent instructions", cache_control: { type: "ephemeral", ttl: "5m" } },
      ]);
      expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
      const marks = [
        ...body.system, ...body.tools,
        ...body.messages.flatMap((message) => message.content),
      ].filter((block) => block.cache_control);
      expect(marks).toHaveLength(4);
      expect(body.messages.slice(0, -1).every((message) => message.content.every((block) => !block.cache_control))).toBe(true);
    }
    const swapped = connection.context2msg(user)[1];
    expect(swapped.system).toEqual([{ type: "text", text: identity, cache_control: { type: "ephemeral" } }]);
  });

  test("tool replay keeps the subscription wire name while public context remains local", () => {
    const connection = new Claude(URL, io({ type: "oauth", token: "t" }, [{ name: "read" }]));
    const [, body] = connection.context2msg([
      { type: 3, content: [{ type: "toolCall", callId: "toolu_1", name: "read", arguments: {} }] },
      { type: 4, callId: "toolu_1", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(body.messages[0].content[0].name).toBe("Read");
    expect(body.messages[1].content[0].tool_use_id).toBe("toolu_1");
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    const state = {};
    expect(connection.msg2events({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } }, state)[0].name).toBe("read");
    expect(connection.msg2events({ type: "message_stop" }, state)[0].message.content[0].name).toBe("read");
  });

  test("leaves assistant replay blocks unmarked, with only the provider identity breakpoint", () => {
    const connection = new Claude(URL, io({ type: "oauth", token: "t" }));
    const [, body] = connection.context2msg([{ type: 3, content: [{ type: "text", text: "prior reply" }] }]);
    expect(body.system).toEqual([{ type: "text", text: identity, cache_control: { type: "ephemeral" } }]);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });

  test("login verification uses a catalog model when no model is selected yet", async () => {
    const originalFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    };
    try {
      expect(await Claude.testConnection({ url: URL, auth: { type: "oauth", token: "sk-ant-oat-test" } }))
        .toEqual({ models: Object.keys(Claude.knownEndpoints[0].models).length });
      expect(sent.model).toBe(Object.keys(Claude.knownEndpoints[0].models)[0]);
      expect(sent.system).toEqual([{ type: "text", text: identity, cache_control: { type: "ephemeral" } }]);
      expect(sent.stream).toBe(false);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("web-search/web-fetch capabilities use Anthropic server tools with the subscription wire", async () => {
    const originalFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, options) => {
      sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "- result" }] }), { status: 200 });
    };
    try {
      const aiio = { url: URL, modelCurrent: "test/claude-sonnet-4-6", settings: { auth: { type: "oauth", token: "sk-ant-oat-test" } },
        fetch: (url, init) => globalThis.fetch(url, init) };
      const { tools } = Claude.provider.capabilities;
      expect(await tools["web-search"].function({ aiio, args: { query: "bun" } })).toBe("- result");
      expect(await tools["web-fetch"].function({ aiio, args: { url: "https://example.com/" } })).toBe("- result");
      expect(sent.map((request) => request.url)).toEqual([`${URL}/messages`, `${URL}/messages`]);
      expect(sent.map((request) => request.body.tools[0].type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
      for (const request of sent) {
        expect(request.headers.authorization).toBe("Bearer sk-ant-oat-test");
        expect(request.headers["x-api-key"]).toBeUndefined();
        expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
        expect(request.body.system).toEqual([{ type: "text", text: identity }]);
      }
      expect(sent).toHaveLength(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("login only accepts subscription access tokens", () => {
    expect(() => Claude.login({ token: "sk-ant-api03-test" })).toThrow(/OAuth access token/);
    expect(Claude.login({ token: "sk-ant-oat01-test" })).toEqual({ type: "oauth", token: "sk-ant-oat01-test" });
  });

  test("API key provider does not acquire subscription identity or name changes", () => {
    const connection = new Anthropic(URL, io({ type: "api_key", token: "key" }, [{ name: "read" }]));
    const [headers, body] = connection.context2msg(user);
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(body.system).toBeUndefined();
    expect(body.tools[0].name).toBe("read");
  });
});