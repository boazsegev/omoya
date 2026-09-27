import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { webFetch, webSearch } from "../tools/web.js";
import { __resetWebRateForTests } from "../tools/web/shared.js";
import AnthropicProvider from "../providers/anthropic.js";
import ClaudeProvider from "../providers/claude.js";
import KimiProvider from "../providers/kimi.js";
import OpenAIProvider from "../providers/openai.js";
import { IO } from "../lib/io.js";
import { providerClass } from "./fakes.js";
import { toolsLoad } from "./env-internals.js";

const OpenAI = await providerClass(OpenAIProvider, "openai");

// The web tools' rate ledger is process-global: each test starts clean so a
// busy earlier test can't pace a timing-budget assertion.
beforeEach(() => __resetWebRateForTests());

/** An Env with the bundled web providers registered and the two endpoints
 *  the provider-tool tests select (their catalogs list the tested models). */
function env(settings = {}) {
  const dir = mkdtempSync("./ai-tmp/web-dispatch-");
  const endpoints = {
    "kimi-coding": { provider: "kimi", url: "https://api.kimi.com/coding/v1" },
    test: { provider: "anthropic", url: "https://api.anthropic.com/v1" },
    codex: { provider: "openai", url: "https://chatgpt.com/backend-api/codex" },
  };
  // each endpoint section's catalog, merged under the test's own section
  const section = (name, model) => ({ ...(settings[name] ?? {}), models: { [model]: {}, ...(settings[name]?.models ?? {}) } });
  return new Env({ dir, settingsDir: dir, providers: { kimi: KimiProvider, anthropic: AnthropicProvider, openai: OpenAIProvider },
    settings: { ...settings, providers: { ...endpoints, ...(settings.providers ?? {}) },
      "kimi-coding": section("kimi-coding", "kimi-for-coding"), test: section("test", "m"), codex: section("codex", "gpt-6-sol") } });
}

const SEARCH = { safe: true, description: "search", inputSchema: { type: "object" } };
const FETCH = { safe: true, description: "fetch", inputSchema: { type: "object" } };

/** An Env with the package web tools registered as the global tools a
 *  pair's provider tools shadow. */
function webEnv(settings) {
  const e = env(settings);
  e.toolAdd("web-search", webSearch, SEARCH);
  e.toolAdd("web-fetch", webFetch, FETCH);
  return e;
}

/** An IO-shaped fake: the surface provider tools read, with IO's own
 *  fetch/connectionCreate (a wire-completed OpenAI connection by default). */
function fakeAiio({ url, auth, settings = {}, env: fakeEnv, Provider = OpenAI, modelCurrent = "test-model" } = {}) {
  return {
    url, modelCurrent, settings: { auth, ...settings }, env: fakeEnv ?? env(),
    Provider, provider: Provider.provider,
    fetch(...args) { return IO.prototype.fetch.call(this, ...args); },
    connectionCreate(options) { return IO.prototype.connectionCreate.call(this, options); },
  };
}

describe("conventional web dispatch", () => {
  test("publishes conventional web tools through the package scanner; a pair's provider tools shadow them", async () => {
    const e = env({ web: { readability: false } });
    await toolsLoad(e, { dirs: ["./tools"] });
    const all = await e.tools();
    const safe = await e.tools(true);
    for (const name of ["web-search", "web-fetch"]) {
      expect(all.has(name)).toBe(true);
      expect(safe.has(name)).toBe(true);
      expect(all.get(name).provider).toBeUndefined();
    }
    const paired = await e.tools(false, "test/m");
    expect(paired.get("web-search")).toMatchObject({ provider: true, shadows: true, safe: true });
    expect(paired.get("web-search").schema.inputSchema).toEqual(all.get("web-search").schema.inputSchema);
  });

  test("bundled provider metadata declares only proven web capabilities", () => {
    // Anthropic: the documented server tools web_search_20250305 and
    // web_fetch_20250910 on api.anthropic.com only
    expect(typeof AnthropicProvider.provider.capabilities.tools["web-search"].function).toBe("function");
    expect(typeof AnthropicProvider.provider.capabilities.tools["web-fetch"].function).toBe("function");
    // Kimi: the direct /tools/search and /tools/fetch REST endpoints on the
    // platform endpoints (the coding relay has search only — no fetch endpoint)
    expect(typeof KimiProvider.provider.capabilities.tools["web-search"].function).toBe("function");
    expect(typeof KimiProvider.provider.capabilities.tools["web-fetch"].function).toBe("function");
    // OpenAI Responses: hosted web_search only. Its agentic open_page action
    // cannot reliably meet the provider-fetch budget, so fetch is bypassed.
    expect(typeof OpenAIProvider.provider.capabilities.tools["web-search"].function).toBe("function");
    expect(OpenAIProvider.provider.capabilities.tools["web-fetch"]).toBeUndefined();
  });

  test("a pair's provider tool is attempted first; without a selector the global tool serves", async () => {
    class WebProvider {}
    WebProvider.provider = { capabilities: { tools: { "web-search": { function: async ({ args }) => `provider answered ${args.query}` } } } };
    const dir = mkdtempSync("./ai-tmp/web-dispatch-");
    const e = new Env({ dir, settingsDir: dir, providers: { web: WebProvider },
      settings: { web: { debug: true, search: { backends: [{ type: "searxng", url: "http://local.test/" }], engines: [], cacheSeconds: 0 } },
        providers: { w: { provider: "web", url: "https://w.test/" } }, w: { models: { m: {} } } } });
    e.toolAdd("web-search", webSearch, SEARCH);
    expect(await e.toolCall("web-search", { query: "provider path" }, { env: e, selector: "w/m", io: {} })).toBe("provider answered provider path");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ title: "L", url: "https://l.test/", content: "local" }] }), { headers: { "content-type": "application/json" } });
    try {
      expect(await e.toolCall("web-search", { query: "x", limit: 2 }, { env: e })).toStartWith("HTTP: local SearXNG");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failing or declining provider tool falls through to the configured package backend", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://fallback.test/", content: "found" }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      for (const fn of [async () => { throw new Error("empty provider answer"); }, async () => undefined]) {
        class WebProvider {}
        WebProvider.provider = { capabilities: { tools: { "web-search": { function: fn } } } };
        const dir = mkdtempSync("./ai-tmp/web-dispatch-");
        const e = new Env({ dir, settingsDir: dir, providers: { web: WebProvider },
          settings: { web: { debug: true, search: { backends: [{ type: "searxng", url: "http://fallback.test/search" }], engines: [], cacheSeconds: 0 } },
            providers: { w: { provider: "web", url: "https://w.test/" } }, w: { models: { m: {} } } } });
        e.toolAdd("web-search", webSearch, SEARCH);
        const result = await e.toolCall("web-search", { query: "missing" }, { env: e, selector: "w/m", io: {} });
        expect(result).toContain("URL: https://fallback.test/");
      }
      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("web-fetch debug names the local access point", async () => {
    // Distinct URL so the package-fetch cache (keyed by URL) cannot collide with other tests.
    const e = env({ web: { debug: true, readability: false } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("<html><body><article><h1>Local Page</h1><p>local body content here</p></article></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    try {
      expect(await webFetch({ url: "https://debug-local.test/" }, { env: e })).toStartWith("HTTP: local");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider tools opt out per model -> endpoint -> global (each tool by name)", async () => {
    // The opt-out is the pair's catalog entry: caps.tools lists the provider
    // tools left after <ep>.models.<m>.tools.<name>, <ep>.tools.<name>,
    // providerTools.<name>; only those shadow the global tools.
    const SELECTOR = "kimi-coding/kimi-for-coding";
    const caps = (settings) => env(settings).models(true).get(SELECTOR).caps.tools;
    expect(caps({})).toEqual(expect.arrayContaining(["web-search", "web-fetch"]));
    // global search off; fetch still allowed
    expect(caps({ providerTools: { "web-search": false } })).toEqual(["web-fetch"]);
    // endpoint re-enables what global disabled
    expect(caps({ providerTools: { "web-search": false }, "kimi-coding": { tools: { "web-search": true } } })).toContain("web-search");
    // endpoint disables fetch independently of search
    expect(caps({ "kimi-coding": { tools: { "web-fetch": false } } })).toEqual(["web-search"]);
    // model beats endpoint and global
    expect(caps({
      providerTools: { "web-fetch": true },
      "kimi-coding": { tools: { "web-fetch": true }, models: { "kimi-for-coding": { tools: { "web-fetch": false } } } },
    })).not.toContain("web-fetch");
    // model re-enables what endpoint disabled
    expect(caps({
      "kimi-coding": { tools: { "web-search": false }, models: { "kimi-for-coding": { tools: { "web-search": true } } } },
    })).toContain("web-search");
    // the published catalog follows caps.tools
    const off = env({ providerTools: { "web-search": false } });
    const catalog = await off.tools(false, SELECTOR);
    expect(catalog.has("web-search")).toBe(false); // no global web-search registered, provider opted out
    expect(catalog.get("web-fetch")?.provider).toBe(true);

    // default: the provider serves (a real /search call is made)
    const e = env({});
    const io = fakeAiio({ url: "https://api.kimi.com/coding/v1", modelCurrent: "kimi-for-coding", auth: { type: "api_key", token: "relay" }, env: e, Provider: KimiProvider });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ search_results: [{ title: "R", url: "https://r.test/", snippet: "s" }] }), { headers: { "content-type": "application/json" } });
    try {
      expect(await e.toolCall("web-search", { query: "x" }, { env: e, selector: SELECTOR, io })).toContain("https://r.test/");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an opted-out provider tool falls to the local package backend", async () => {
    const e = webEnv({
      web: { debug: true, search: { backends: [{ type: "searxng", url: "http://local.test/" }], engines: [], cacheSeconds: 0 } },
      "kimi-coding": { tools: { "web-search": false } }, // endpoint opts out of the provider search tool
    });
    const originalFetch = globalThis.fetch;
    const providerCalls = [];
    globalThis.fetch = async (url) => {
      providerCalls.push(String(url));
      return new Response(JSON.stringify({ results: [{ title: "Local", url: "https://local.test/", content: "local" }] }), { headers: { "content-type": "application/json" } });
    };
    try {
      const io = fakeAiio({ url: "https://api.kimi.com/coding/v1", modelCurrent: "kimi-for-coding", auth: { type: "api_key", token: "relay" }, env: e, Provider: KimiProvider });
      const result = await e.toolCall("web-search", { query: "x", limit: 2 }, { env: e, selector: "kimi-coding/kimi-for-coding", io });
      // provider search path (/search) must NOT be hit; only the local SearXNG fallback ran
      expect(providerCalls.some((u) => u.includes("/search"))).toBe(false);
      expect(providerCalls.some((u) => u.startsWith("http://local.test/"))).toBe(true);
      expect(result).toStartWith("HTTP: local");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("environment SearXNG participates through the public dispatch", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    process.env.SEARXNG_BASE = "http://unused.invalid";
    try {
      const { packageSearch } = await import("../tools/web/search/index.js");
      const markdown = await packageSearch({ query: "x", limit: 1 }, {
        env: env({ web: { debug: true, search: { engines: [] } } }),
      }, { fetchImpl: async (url) => new Response(JSON.stringify({ results: [{ title: "Local", url: "https://local.test/", content: "Snippet" }] }), { headers: { "content-type": "application/json" } }) });
      expect(markdown).toStartWith("HTTP: SearXNG (searxng-env)");
      expect(markdown).toContain("Snippet");
    } finally {
      delete process.env.SEARXNG_URL;
      delete process.env.SEARXNG_BASE;
    }
  });

  test("rejects malformed input before dispatch", async () => {
    await expect(webSearch({ query: " ", limit: 2 }, { env: env() })).rejects.toThrow(/non-empty/);
    await expect(webSearch({ query: "x", limit: 1.5 }, { env: env() })).rejects.toThrow(/finite integer/);
  });

  test("Agent tool authorization preserves explicit allow-lists", async () => {
    const e = env();
    e.toolAdd("mcp-webfetch", async () => "ok", { safe: true, description: "x", inputSchema: { type: "object" } });
    const allowed = new Agent({ env: e, tools: ["web-search", "mcp-webfetch"] });
    const denied = new Agent({ env: e, tools: ["web-search"] });
    expect(await allowed.toolCallable("mcp-webfetch")).toBe(true);
    expect(await denied.toolCallable("mcp-webfetch")).toBe(false);
    await allowed.close();
    await denied.close();
  });
});

describe("provider web backends", () => {
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
      const handler = AnthropicProvider.provider.capabilities.tools["web-search"].function;
      const result = await handler({ aiio, args: { query: "  omoya  " } });
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
      const handler = AnthropicProvider.provider.capabilities.tools["web-fetch"].function;
      const result = await handler({ aiio, args: { url: "https://example.com/" } });
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
      const handler = AnthropicProvider.provider.capabilities.tools["web-search"].function;
      const failure = await handler({ aiio, args: { query: "x" } })
        .then(() => null, (error) => error);
      expect(failure).not.toBeNull();
      expect(failure.status).toBe(400);
    } finally {
      restore();
    }
  });

  test("Claude subscription exposes provider web capabilities (wire details: io-claude.test.js)", () => {
    for (const name of ["web-search", "web-fetch"]) {
      expect(ClaudeProvider.provider.capabilities.tools[name].function).toBeInstanceOf(Function);
    }
  });

  test("Anthropic capability is unsupported on third-party /messages routes", async () => {
    const aiio = fakeAiio({
      url: "https://api.deepseek.com/anthropic",
      auth: { type: "api_key", token: "sk-test" },
    });
    const handler = AnthropicProvider.provider.capabilities.tools["web-search"].function;
    expect(await handler({ aiio, args: { query: "x" } })).toBeUndefined();
  });

  test("Kimi platform web-search uses the direct /tools/search endpoint (no LLM echo loop)", async () => {
    // platform.kimi.ai/docs/api/tools-search (verified 2026-09-29): POST
    // {base}/tools/search {text_query} -> {search_results:[{title,url,snippet}]},
    // a direct REST lookup — the same fast pattern as the coding relay /search,
    // replacing the slow multi-round `$web_search` chat-completions builtin.
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      search_results: [
        { title: "Direct One", url: "https://one.test/", snippet: "snippet one" },
        { title: "Direct Two", url: "https://two.test/", snippet: "" },
        { title: "", url: "not-a-url" }, // dropped: unusable entries never reach the model
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({ url: "https://api.moonshot.ai/v1", auth: { type: "api_key", token: "kimi-test" } });
      const handler = KimiProvider.provider.capabilities.tools["web-search"].function;
      const result = await handler({ aiio, args: { query: "kimi k3" } });
      expect(result).toBe("- [Direct One](https://one.test/) — snippet one\n- [Direct Two](https://two.test/)");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.moonshot.ai/v1/tools/search");
      expect(options.method).toBe("POST");
      expect(options.headers.authorization).toBe("Bearer kimi-test");
      expect(JSON.parse(options.body)).toEqual({ text_query: "kimi k3" });
      expect(calls).toHaveLength(1); // one direct request, no echo rounds
    } finally {
      restore();
    }
  });

  test("Kimi platform web-fetch uses the direct /tools/fetch endpoint (page -> Markdown)", async () => {
    // platform.kimi.ai/docs/api/tools-fetch (verified 2026-09-29): POST
    // {base}/tools/fetch {url} -> {url, title, markdown} — a direct REST content
    // extraction, no LLM, same pattern as /tools/search.
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      url: "https://example.test/page",
      title: "Example Page",
      markdown: "# Example Page\n\nBody **content** here.",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({ url: "https://api.moonshot.ai/v1", auth: { type: "api_key", token: "kimi-test" } });
      const handler = KimiProvider.provider.capabilities.tools["web-fetch"].function;
      expect(typeof handler).toBe("function");
      const result = await handler({ aiio, args: { url: "https://example.test/page" } });
      expect(result).toContain("Example Page");
      expect(result).toContain("Body **content** here.");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.moonshot.ai/v1/tools/fetch");
      expect(options.method).toBe("POST");
      expect(options.headers.authorization).toBe("Bearer kimi-test");
      expect(JSON.parse(options.body)).toEqual({ url: "https://example.test/page" });
    } finally {
      restore();
    }
  });

  test("Kimi coding-relay web-fetch uses the relay's /fetch endpoint", async () => {
    // Verified live (ai-cache/2026-09-28 011): the relay exposes POST /fetch
    // -> {url, markdown} (its /tools/fetch 404s). The relay must NOT fall
    // through to the package path for fetch.
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({
      url: "https://example.com/",
      title: "Relay Page",
      markdown: "# Relay Page\n\nRelay fetched body.",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({ url: "https://api.kimi.com/coding/v1", auth: { type: "api_key", token: "relay-test" } });
      const handler = KimiProvider.provider.capabilities.tools["web-fetch"].function;
      const result = await handler({ aiio, args: { url: "https://example.com/" } });
      expect(result).toContain("Relay Page");
      expect(result).toContain("Relay fetched body.");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.kimi.com/coding/v1/fetch");
      expect(options.method).toBe("POST");
      expect(options.headers.authorization).toBe("Bearer relay-test");
      expect(JSON.parse(options.body)).toEqual({ url: "https://example.com/" });
    } finally {
      restore();
    }
  });

  test("Kimi platform web-fetch rejects an empty extraction (failure => fallback)", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({ url: "https://x.test/", title: "", markdown: "  " }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const aiio = fakeAiio({ url: "https://api.moonshot.ai/v1", auth: { type: "api_key", token: "kimi-test" } });
      const handler = KimiProvider.provider.capabilities.tools["web-fetch"].function;
      await expect(handler({ aiio, args: { url: "https://x.test/" } })).rejects.toThrow(/no usable|no content|empty/i);
    } finally {
      restore();
    }
  });

  test("Kimi platform web-search never hangs (bounded by the shared deadline)", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => new Promise(() => {})); // never settles
    try {
      const aiio = fakeAiio({ url: "https://api.moonshot.ai/v1", auth: { type: "api_key", token: "kimi-test" } });
      const handler = KimiProvider.provider.capabilities.tools["web-search"].function;
      const start = Date.now();
      await expect(handler({ aiio, args: { query: "x" }, deadline: start + 2_500 }))
        .rejects.toThrow(/timed out|deadline/i);
      expect(Date.now() - start).toBeLessThan(5_000);
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
      const handler = KimiProvider.provider.capabilities.tools["web-search"].function;
      const result = await handler({ aiio, args: { query: "  relay query  " } });
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

  test("Kimi hosted and relay searches reject empty responses", async () => {
    const calls = [];
    const handler = KimiProvider.provider.capabilities.tools["web-search"].function;
    const restore = stubFetch(calls, async (url) => new Response(JSON.stringify(
      String(url).endsWith("/search") ? { search_results: [{ url: "invalid" }] } : { choices: [{ message: { content: " " } }] },
    ), { headers: { "content-type": "application/json" } }));
    try {
      for (const url of ["https://api.moonshot.ai/v1", "https://api.kimi.com/coding/v1"]) {
        await expect(handler({ aiio: fakeAiio({ url, auth: { token: "test" } }), args: { query: "x" } }))
          .rejects.toThrow(/no (usable )?search results/i);
      }
    } finally {
      restore();
    }
  });

  test("Kimi capability is unsupported on arbitrary endpoints", async () => {
    const handler = KimiProvider.provider.capabilities.tools["web-search"].function;
    for (const url of ["https://example.com/v1", "https://api.deepseek.com/v1"]) {
      const aiio = fakeAiio({ url, auth: { type: "api_key", token: "k" } });
      expect(await handler({ aiio, args: { query: "x" } })).toBeUndefined();
    }
  });

  /** A Responses SSE body from finished output items. */
  function responsesStream(items) {
    const events = items.map((item) => ({ type: "response.output_item.done", item }));
    events.push({ type: "response.completed", response: { status: "completed" } });
    const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  const answer = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

  test("OpenAI web-search forces the hosted Responses web_search tool and needs its call as proof", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => responsesStream([
      { type: "web_search_call", action: { type: "search", query: "x" } },
      answer("OpenAI result"),
    ]));
    try {
      const aiio = fakeAiio({
        url: "https://api.openai.com/v1",
        auth: { type: "api_key", token: "oai-test" },
      });
      const handler = OpenAIProvider.provider.capabilities.tools["web-search"].function;
      const result = await handler({ aiio, args: { query: "omoya" } });
      expect(result).toBe("OpenAI result");
      const [url, options] = calls[0];
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(options.headers.authorization).toBe("Bearer oai-test");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(true);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toBe("required");
      expect(JSON.stringify(body.input)).toContain("omoya");
    } finally {
      restore();
    }
  });

  test("OpenAI web-search reaches the Codex backend with its subscription framing", async () => {
    const calls = [];
    const restore = stubFetch(calls, async () => responsesStream([
      { type: "web_search_call", action: { type: "search", query: "omoya" } },
      answer("- Codex result"),
    ]));
    try {
      const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
      const aiio = fakeAiio({
        url: "https://chatgpt.com/backend-api/codex",
        auth: { type: "oauth", token: `h.${claims}.s` },
        settings: { verify: "jwt" },
      });
      const handler = OpenAIProvider.provider.capabilities.tools["web-search"].function;
      expect(await handler({ aiio, args: { query: "omoya" } })).toBe("- Codex result");
      const [url, options] = calls[0];
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(options.headers["chatgpt-account-id"]).toBe("acct-1");
      expect(options.headers["OpenAI-Beta"]).toBe("responses=experimental");
      const body = JSON.parse(options.body);
      expect(body.store).toBe(false);
      expect(body.instructions).toBe("");
      expect(JSON.stringify(body.input)).toContain("omoya");
    } finally {
      restore();
    }
  });

  test("OpenAI probe remembers endpoints that reject or ignore the hosted tool", async () => {
    const handler = OpenAIProvider.provider.capabilities.tools["web-search"].function;
    const calls = [];
    const restore = stubFetch(calls, async (url) => url.startsWith("http://localhost:1234")
      ? new Response(JSON.stringify({ error: { message: "Unsupported tool type: web_search" } }), { status: 400, statusText: "Bad Request" })
      : responsesStream([answer("answered from memory")]));
    try {
      const local = fakeAiio({ url: "http://localhost:1234/v1", auth: { type: "api_key", token: "k" } });
      expect(await handler({ aiio: local, args: { query: "x" } })).toBeUndefined();
      expect(await handler({ aiio: local, args: { query: "x" } })).toBeUndefined();
      expect(calls).toHaveLength(1);
      // an answer without a web_search_call item is not proof: the tool was ignored
      const ignoring = fakeAiio({ url: "https://ignores.test/v1", auth: { type: "api_key", token: "k" } });
      expect(await handler({ aiio: ignoring, args: { query: "x" } })).toBeUndefined();
      expect(await handler({ aiio: ignoring, args: { query: "x" } })).toBeUndefined();
      expect(calls).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test("Codex web-search stalled response head yields to the package backend before the tool deadline", async () => {
    const e = env({ web: { debug: true, search: {
      backends: [{ type: "searxng", url: "https://searx.test/" }], engines: [],
    } } });
    const calls = [];
    const restore = stubFetch(calls, async (url) => {
      if (String(url).includes("/responses")) return new Promise(() => {});
      return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://result.test/", content: "found" }] }),
        { headers: { "content-type": "application/json" } });
    });
    const io = fakeAiio({ url: "https://chatgpt.com/backend-api/codex", auth: { type: "api_key", token: "test" }, env: e });
    e.toolAdd("web-search", webSearch, SEARCH);
    try {
      const started = Date.now();
      const result = await e.toolCall("web-search", { query: "stalled codex head" }, { env: e, selector: "codex/gpt-6-sol", io });
      expect(result).toContain("Fallback");
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(calls.some(([url]) => String(url).includes("/responses"))).toBe(true);
      expect(calls.some(([url]) => String(url).includes("searx.test"))).toBe(true);
    } finally {
      restore();
    }
  }, 35_000);

  test("Codex web-search stalled SSE body yields to fallback before tool deadline", async () => {
    const e = env({ web: { debug: true, search: {
      backends: [{ type: "searxng", url: "https://searx-body.test/" }], engines: [],
    } } });
    const restore = stubFetch([], async (url) => String(url).includes("/responses")
      ? new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ results: [{ title: "Body fallback", url: "https://body-result.test/" }] }),
        { headers: { "content-type": "application/json" } }));
    const io = fakeAiio({ url: "https://chatgpt.com/backend-api/codex", auth: { type: "api_key", token: "test" }, env: e });
    const agent = new Agent({ env: e });
    agent.endpoint = "test";
    agent.model = "gpt-6-sol";
    agent._connection = () => io;
    try {
      const started = Date.now();
      const result = await webSearch({ query: "stalled codex SSE" }, { env: e, agent });
      expect(result).toContain("Body fallback");
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      restore();
      await agent.close();
    }
  }, 35_000);

  test("Codex web-search falls back within 1200ms of the last SSE byte", async () => {
    const e = env({ web: { search: { backends: [{ type: "searxng", url: "https://searx-idle.test/" }], engines: [] } } });
    const restore = stubFetch([], async (url) => String(url).includes("/responses")
      ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: ")); } }),
        { headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ results: [{ title: "Idle fallback", url: "https://idle.test/" }] }),
        { headers: { "content-type": "application/json" } }));
    const io = fakeAiio({ url: "https://chatgpt.com/backend-api/codex", auth: { type: "api_key", token: "test" }, env: e });
    const agent = new Agent({ env: e });
    agent.endpoint = "test";
    agent.model = "gpt-6-sol";
    agent._connection = () => io;
    try {
      const started = Date.now();
      expect(await webSearch({ query: "idle stream" }, { env: e, agent })).toContain("Idle fallback");
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      restore();
      await agent.close();
    }
  }, 8_000);

  test("Codex web-search keeps reading bytes even without a complete SSE event", async () => {
    const chunks = responsesStream([
      { type: "web_search_call", action: { type: "search", query: "x" } }, answer("Slow result"),
    ]);
    const body = await chunks.text();
    const restore = stubFetch([], async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const parts = [body.slice(0, 8), body.slice(8, 16), body.slice(16, 24), body.slice(24)];
        parts.forEach((part, index) => setTimeout(() => {
          controller.enqueue(encoder.encode(part));
          if (index === parts.length - 1) controller.close();
        }, index * 900));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const io = fakeAiio({ url: "https://chatgpt.com/backend-api/codex", auth: { type: "api_key", token: "test" } });
      const handler = OpenAIProvider.provider.capabilities.tools["web-search"].function;
      expect(await handler({ aiio: io, args: { query: "slow bytes" } })).toBe("Slow result");
    } finally {
      restore();
    }
  }, 8_000);

  test("OpenAI web-fetch bypasses the provider and uses package fetch immediately", async () => {
    const e = env({ web: { debug: true, readability: false } });
    const calls = [];
    const restore = stubFetch(calls, async () => new Response("package result", {
      status: 200, headers: { "content-type": "text/plain" },
    }));
    const io = fakeAiio({ url: "https://api.openai.com/v1", auth: { type: "api_key", token: "k" }, env: e });
    const agent = new Agent({ env: e });
    agent.endpoint = "test";
    agent.model = "m";
    agent._connection = () => io;
    try {
      const result = await webFetch({ url: "https://x.test/" }, { env: e, agent });
      expect(result).toContain("package result");
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("https://x.test/");
    } finally {
      restore();
      await agent.close();
    }
  });

  test("providers no longer self-gate on web.provider (caps.tools is the single opt-out point)", async () => {
    // Opt-out lives ONLY in the pair's catalog entry (caps.tools). A provider
    // handler serves any endpoint it hosts regardless of legacy flags.
    const e = env();
    const make = (url, auth) => fakeAiio({ url, auth, env: e });
    const anthropic = make("https://api.anthropic.com/v1", { type: "api_key", token: "sk" });
    expect(typeof AnthropicProvider.provider.capabilities.tools["web-search"].function).toBe("function");
    // unsupported on a third-party URL is the ONLY remaining provider-side gate
    const deepseek = make("https://api.deepseek.com/anthropic", { type: "api_key", token: "sk" });
    expect(await AnthropicProvider.provider.capabilities.tools["web-search"].function({ aiio: deepseek, args: { query: "x" } })).toBeUndefined();
  });

  test("an opted-out provider tool is not called; the rest of the provider's tools still serve", async () => {
    const e = env({ providerTools: { "web-search": false } });
    const io = fakeAiio({ url: "https://api.anthropic.com/v1", auth: { type: "api_key", token: "sk-test" }, env: e, Provider: AnthropicProvider });
    const calls = [];
    const restore = stubFetch(calls, async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      // no global web tool registered: an opted-out provider tool is simply unknown
      await expect(e.toolCall("web-search", { query: "x" }, { env: e, selector: "test/m", io })).rejects.toThrow(/unknown tool/);
      expect(calls).toHaveLength(0);
      expect(await e.toolCall("web-fetch", { url: "https://x.test/" }, { env: e, selector: "test/m", io })).toContain("ok");
    } finally {
      restore();
    }
    // control: without the opt-out the same pair reaches the provider
    const open = env();
    const calls2 = [];
    const restore2 = stubFetch(calls2, async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const io2 = fakeAiio({ url: "https://api.anthropic.com/v1", auth: { type: "api_key", token: "sk-test" }, env: open, Provider: AnthropicProvider });
      expect(await open.toolCall("web-search", { query: "x" }, { env: open, selector: "test/m", io: io2 })).toBe("ok");
      expect(calls2.length).toBe(1);
    } finally {
      restore2();
    }
  });
});
