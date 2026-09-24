import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { webSearch } from "../tools/web.js";
import AnthropicProvider from "../providers/anthropic.js";
import KimiProvider from "../providers/kimi.js";
import OpenAIProvider from "../providers/openai.js";

function env(settings = {}) {
  const dir = mkdtempSync("./ai-tmp/web-dispatch-");
  return new Env({ dir, settingsDir: dir, settings });
}

describe("conventional web dispatch", () => {
  test("publishes conventional web tools through the package scanner", async () => {
    const e = env({ web: { readability: false } });
    await e.loadTools({ dirs: ["./tools"] });
    expect(e.toolNames()).toContain("web-search");
    expect(e.toolNames()).toContain("web-fetch");
    expect(e.safeToolNames()).toContain("web-search");
    expect(e.safeToolNames()).toContain("web-fetch");
  });

  test("bundled provider metadata declares only proven web capabilities", () => {
    // Anthropic: the documented server tools web_search_20250305 and
    // web_fetch_20250910 on api.anthropic.com only
    expect(typeof AnthropicProvider.provider.capabilities["web-search"]).toBe("function");
    expect(typeof AnthropicProvider.provider.capabilities["web-fetch"]).toBe("function");
    // Kimi: the documented $web_search builtin on the platform endpoints
    expect(typeof KimiProvider.provider.capabilities["web-search"]).toBe("function");
    expect(KimiProvider.provider.capabilities["web-fetch"]).toBeUndefined();
    // OpenAI: the documented Responses API web_search tool on
    // api.openai.com only (no documented fetch tool)
    expect(typeof OpenAIProvider.provider.capabilities["web-search"]).toBe("function");
    expect(OpenAIProvider.provider.capabilities["web-fetch"]).toBeUndefined();
  });

  test("normalizes search arguments before provider success", async () => {
    const seen = [];
    const result = await webSearch({ query: "  hello  ", limit: -99 }, {
      env: env({ web: { debug: true } }),
      agent: { callProviderCapability: async (_, args) => { seen.push(args); return { status: "success", content: "provider" }; } },
    });
    expect(result).toBe("Code Path: provider\n\nprovider");
    expect(seen).toEqual([{ query: "hello", limit: 40, wasClamped: true }]);
  });

  test("environment SearXNG participates through the public dispatch", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    process.env.SEARXNG_BASE = "http://unused.invalid";
    try {
      const { packageSearch } = await import("../tools/web/search/index.js");
      const markdown = await packageSearch({ query: "x", limit: 1 }, {
        env: env({ web: { debug: true, search: { engines: [] } } }),
      }, { fetchImpl: async (url) => new Response(JSON.stringify({ results: [{ title: "Local", url: "https://local.test/", content: "Snippet" }] }), { headers: { "content-type": "application/json" } }) });
      expect(markdown).toStartWith("Code Path: SearXNG (searxng-env)");
      expect(markdown).toContain("Snippet");
    } finally {
      delete process.env.SEARXNG_URL;
      delete process.env.SEARXNG_BASE;
    }
  });

  test("rejects malformed input before dispatch", async () => {
    let called = false;
    await expect(webSearch({ query: " ", limit: 2 }, { env: env(), agent: { callProviderCapability: async () => { called = true; } } }))
      .rejects.toThrow(/non-empty/);
    expect(called).toBe(false);
    await expect(webSearch({ query: "x", limit: 1.5 }, { env: env() })).rejects.toThrow(/finite integer/);
  });

  test("a declared provider web capability is attempted first", async () => {
    const e = env({ web: { debug: true } });
    class WebProvider {}
    WebProvider.provider = { capabilities: { "web-search": async ({ args }) => `provider answered ${args.query}` } };
    const io = { Provider: WebProvider, provider: WebProvider.provider };
    const agent = new Agent({ env: e });
    agent.endpoint = "test";
    agent.model = "m";
    agent._connection = () => io;
    const result = await webSearch({ query: "provider path" }, { env: e, agent });
    expect(result).toBe("Code Path: provider\n\nprovider answered provider path");
    await agent.close();
  });

  test("Agent tool authorization preserves explicit allow-lists", async () => {
    const e = env();
    e.registerTool("mcp-webfetch", async () => "ok", { safe: true, description: "x", inputSchema: { type: "object" } });
    const allowed = new Agent({ env: e, tools: ["web-search", "mcp-webfetch"] });
    const denied = new Agent({ env: e, tools: ["web-search"] });
    expect(allowed.canCallTool("mcp-webfetch")).toBe(true);
    expect(denied.canCallTool("mcp-webfetch")).toBe(false);
    await allowed.close();
    await denied.close();
  });
});

describe("provider web backends", () => {
  /** A fake aiio with the IO-shaped surface the handlers read. */
  function fakeAiio({ url, auth, settings = {}, env: fakeEnv } = {}) {
    return {
      url,
      currentModel: "test-model",
      settings: { auth, ...settings },
      env: fakeEnv ?? env(),
    };
  }

  function stubFetch(calls, impl) {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls.push(args); return impl(...args); };
    return () => { globalThis.fetch = original; };
  }

  test("Anthropic web-search sends the documented tool block and maps text blocks", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      content: [
        { type: "web_search_tool_result", content: [] },
        { type: "text", text: "- [One](https://one.test/) — snippet one\n" },
        { type: "text", text: "- [Two](https://two.test/) — snippet two" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.anthropic.com/v1",
        auth: { type: "api_key", token: "sk-test" },
      });
      const handler = AnthropicProvider.provider.capabilities["web-search"];
      const result = await handler.call(AnthropicProvider, { aiio, args: { query: "  omoya  " } });
      expect(result).toBe("- [One](https://one.test/) — snippet one\n- [Two](https://two.test/) — snippet two");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(options.method).toBe("POST");
      expect(options.headers["x-api-key"]).toBe("sk-test");
      expect(options.headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model");
      expect(body.max_tokens).toBe(1024);
      expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
      expect(body.messages).toEqual([{ role: "user", content: expect.stringContaining("omoya") }]);
      expect(body.stream).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("Anthropic web-fetch sends the documented fetch tool block", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      content: [{ type: "web_fetch_tool_result", content: [] }, { type: "text", text: "# Fetched" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.anthropic.com/v1",
        auth: { type: "api_key", token: "sk-test" },
      });
      const handler = AnthropicProvider.provider.capabilities["web-fetch"];
      const result = await handler.call(AnthropicProvider, { aiio, args: { url: "https://example.com/" } });
      expect(result).toBe("# Fetched");
      const body = JSON.parse(calls[0][1].body);
      expect(body.tools).toEqual([{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }]);
      expect(body.messages[0].content).toContain("https://example.com/");
    } finally {
      restore();
    }
  });

  test("Anthropic capability throws with the status when the API rejects", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      type: "error", error: { type: "invalid_request_error", message: "tool not allowed" },
    }), { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.anthropic.com/v1",
        auth: { type: "api_key", token: "sk-test" },
      });
      const handler = AnthropicProvider.provider.capabilities["web-search"];
      const failure = await handler.call(AnthropicProvider, { aiio, args: { query: "x" } })
        .then(() => null, (error) => error);
      expect(failure).not.toBeNull();
      expect(failure.status).toBe(400);
    } finally {
      restore();
    }
  });

  test("Anthropic subscription (OAuth) auth falls through as unsupported", async () => {
    const aiio = fakeAiio({
      url: "https://api.anthropic.com/v1",
      auth: { type: "oauth", token: "sk-ant-oat-test" },
    });
    for (const name of ["web-search", "web-fetch"]) {
      const handler = AnthropicProvider.provider.capabilities[name];
      expect(await handler.call(AnthropicProvider, { aiio, args: { query: "x", url: "https://x.test/" } })).toBeUndefined();
    }
  });

  test("Anthropic capability is unsupported on third-party /messages routes", async () => {
    const aiio = fakeAiio({
      url: "https://api.deepseek.com/anthropic",
      auth: { type: "api_key", token: "sk-test" },
    });
    const handler = AnthropicProvider.provider.capabilities["web-search"];
    expect(await handler.call(AnthropicProvider, { aiio, args: { query: "x" } })).toBeUndefined();
  });

  test("Kimi web-search sends the documented $web_search builtin tool", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "1. Kimi result" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.moonshot.ai/v1",
        auth: { type: "api_key", token: "kimi-test" },
      });
      const handler = KimiProvider.provider.capabilities["web-search"];
      const result = await handler.call(KimiProvider, { aiio, args: { query: "kimi k3" } });
      expect(result).toBe("1. Kimi result");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
      expect(options.headers.authorization).toBe("Bearer kimi-test");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(false);
      expect(body.tools).toEqual([{ type: "builtin_function", function: { name: "$web_search" } }]);
      expect(body.messages[0].content).toContain("kimi k3");
    } finally {
      restore();
    }
  });

  test("Kimi web-search uses the coding relay's /search API on api.kimi.com/coding", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      search_results: [
        { title: "One", url: "https://one.test/", snippet: "snippet one" },
        { title: "Two", url: "https://two.test/", snippet: "" },
        { title: "", url: "not-a-url" }, // dropped: unparseable/empty entries never reach the model
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.kimi.com/coding/v1",
        auth: { type: "api_key", token: "kimi-coding-test" },
      });
      const handler = KimiProvider.provider.capabilities["web-search"];
      const result = await handler.call(KimiProvider, { aiio, args: { query: "  relay query  " } });
      expect(result).toBe("- [One](https://one.test/) — snippet one\n- [Two](https://two.test/)");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.kimi.com/coding/v1/search");
      expect(options.method).toBe("POST");
      expect(options.headers.authorization).toBe("Bearer kimi-coding-test");
      expect(JSON.parse(options.body)).toEqual({ text_query: "relay query" });
    } finally {
      restore();
    }
  });

  test("Kimi capability is unsupported on arbitrary endpoints", async () => {
    const handler = KimiProvider.provider.capabilities["web-search"];
    for (const url of ["https://example.com/v1", "https://api.deepseek.com/v1"]) {
      const aiio = fakeAiio({ url, auth: { type: "api_key", token: "k" } });
      expect(await handler.call(KimiProvider, { aiio, args: { query: "x" } })).toBeUndefined();
    }
  });

  test("OpenAI web-search sends the documented Responses web_search tool", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      output: [
        { type: "web_search_call", action: { type: "search", query: "x" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OpenAI result" }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({
        url: "https://api.openai.com/v1",
        auth: { type: "api_key", token: "oai-test" },
      });
      const handler = OpenAIProvider.provider.capabilities["web-search"];
      const result = await handler.call(OpenAIProvider, { aiio, args: { query: "omoya" } });
      expect(result).toBe("OpenAI result");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(options.headers.authorization).toBe("Bearer oai-test");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(false);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.input).toContain("omoya");
    } finally {
      restore();
    }
  });

  test("OpenAI capability is unsupported on the Codex backend and local endpoints", async () => {
    const handler = OpenAIProvider.provider.capabilities["web-search"];
    for (const url of ["https://chatgpt.com/backend-api/codex", "http://localhost:1234/v1"]) {
      const aiio = fakeAiio({ url, auth: { type: "api_key", token: "k" } });
      expect(await handler.call(OpenAIProvider, { aiio, args: { query: "x" } })).toBeUndefined();
    }
  });

  test("web.provider === false makes every handler fall through", async () => {
    const e = env({ web: { provider: false } });
    const make = (url, auth) => fakeAiio({ url, auth, env: e });
    const anthropic = make("https://api.anthropic.com/v1", { type: "api_key", token: "sk" });
    expect(await AnthropicProvider.provider.capabilities["web-search"].call(AnthropicProvider, { aiio: anthropic, args: { query: "x" } })).toBeUndefined();
    expect(await AnthropicProvider.provider.capabilities["web-fetch"].call(AnthropicProvider, { aiio: anthropic, args: { url: "https://x.test/" } })).toBeUndefined();
    const kimi = make("https://api.moonshot.ai/v1", { type: "api_key", token: "k" });
    expect(await KimiProvider.provider.capabilities["web-search"].call(KimiProvider, { aiio: kimi, args: { query: "x" } })).toBeUndefined();
    const openai = make("https://api.openai.com/v1", { type: "api_key", token: "k" });
    expect(await OpenAIProvider.provider.capabilities["web-search"].call(OpenAIProvider, { aiio: openai, args: { query: "x" } })).toBeUndefined();
  });

  test("web.provider === false makes the Agent report the real provider capability unsupported", async () => {
    const e = env({ web: { provider: false } });
    // the REAL Anthropic handler wired through the Agent's capability
    // surface; the fake io carries the gated Env
    const io = { Provider: AnthropicProvider, provider: AnthropicProvider.provider };
    io.settings = { auth: { type: "api_key", token: "sk-test" } };
    io.currentModel = "test-model";
    io.url = "https://api.anthropic.com/v1";
    io.env = e;
    const agent = new Agent({ env: e });
    agent.endpoint = "test";
    agent.model = "m";
    agent._connection = () => io;
    const gated = await agent.callProviderCapability("web-search", { query: "x" });
    expect(gated.status).toBe("unsupported");
    await agent.close();
    // control: without the gate the same surface reaches the provider
    // (fetch stubbed, so no network)
    const open = env();
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const io2 = { Provider: AnthropicProvider, provider: AnthropicProvider.provider };
      io2.settings = { auth: { type: "api_key", token: "sk-test" } };
      io2.currentModel = "test-model";
      io2.url = "https://api.anthropic.com/v1";
      io2.env = open;
      const agent2 = new Agent({ env: open });
      agent2.endpoint = "test";
      agent2.model = "m";
      agent2._connection = () => io2;
      const ungated = await agent2.callProviderCapability("web-search", { query: "x" });
      expect(ungated.status).toBe("success");
      expect(ungated.content).toBe("ok");
      expect(calls.length).toBe(1);
      await agent2.close();
    } finally {
      restore();
    }
  });
});
