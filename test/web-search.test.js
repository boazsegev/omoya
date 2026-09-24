import { beforeEach, describe, expect, test } from "bun:test";
import { __resetPackageSearchForTest, packageSearch } from "../tools/web/search/index.js";

const response = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? { "content-type": "text/html" } });

function createFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const href = url.toString();
    calls.push({ url: href, headers: Object.fromEntries(init.headers.entries()) });
    const route = routes.find(([pattern]) => typeof pattern === "string" ? href.startsWith(pattern) : pattern.test(href));
    if (!route) throw new Error(`unexpected fetch ${href}`);
    const value = typeof route[1] === "function" ? route[1](url, init) : route[1];
    return value;
  };
}

const ddgHtml = `
<html><body>
<div class="result">
  <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx">Alpha DDG</a>
  <a class="result__snippet">Duck&#x27;s snippet &quot;quoted&quot;</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/b">Beta DDG</a>
  <a class="result__snippet">Second duck</a>
</div>
</body></html>`;

const swissPayload = Buffer.from(JSON.stringify({ items: [{ type: "WebPage", name: "Swiss result", url: "https://swiss.test/", description: "Swiss snippet" }] })).toString("base64url");
const swissJson = JSON.stringify({ payload: `x.${swissPayload}.y` });

const mojeekHtml = `
<html><body><ul>
<li class="result"><a href="https://example.com/a?fbclid=1">Alpha Mojeek</a><p class="s">Mojeek snippet</p></li>
<li class="result"><a href="https://example.org/c">Gamma</a><p class="s">Third</p></li>
</ul></body></html>`;

describe("packageSearch", () => {
  beforeEach(() => __resetPackageSearchForTest());

  test("uses default DuckDuckGo, Mojeek, and credentialed Brave engines with consensus ranking", async () => {
    const brave = JSON.stringify({ web: { results: [
      { title: "Solo Brave", url: "https://brave.test/solo", description: "First but unconfirmed" },
      { title: "Alpha Brave", url: "https://example.com/a", description: "Confirmed" },
    ] } });
    const fetchImpl = createFetch([
      ["https://html.duckduckgo.com/html/", response(ddgHtml)],
      ["https://www.mojeek.com/search", response(mojeekHtml)],
      ["https://api.search.brave.com/res/v1/web/search", response(brave, { headers: { "content-type": "application/json" } })],
    ]);
    const markdown = await packageSearch(
      { query: "alpha", limit: 10 },
      { env: { settings: { web: { debug: true, search: { cacheSeconds: 0 } } } } },
      { fetchImpl, env: { BRAVE_API_KEY: "brave-secret" } },
    );

    expect(markdown).toStartWith("Code Path: engine aggregate");
    expect(markdown).toContain('Search Results for "alpha"');
    expect(markdown).toContain("URL: https://example.com/a?utm_source=x");
    expect(markdown).toContain("Engine Attempt: duckduckgo: success (2 results)");
    expect(markdown).toContain("Engine Attempt: mojeek: success (2 results)");
    expect(markdown).toContain("Engine Attempt: brave: success (2 results)");
    expect(markdown).toContain("Engines: duckduckgo, mojeek, brave");
    const soloStart = markdown.indexOf("**Solo Brave**");
    const soloBlock = markdown.slice(soloStart, markdown.indexOf("\n\n", soloStart));
    expect(soloBlock).toContain("Engines: brave");
    expect(soloBlock).not.toContain("duckduckgo");
    expect(soloBlock).not.toContain("mojeek");
    expect(markdown.indexOf("https://example.com/a?utm_source=x")).toBeLessThan(markdown.indexOf("https://brave.test/solo"));
    expect(markdown).toContain("Duck's snippet \"quoted\"");
    expect(markdown).toContain("Found 4 results");
  });

  test("tries configured SearXNG before direct engines and stops on recognized success", async () => {
    const calls = [];
    const fetchImpl = createFetch([
      ["http://localhost:8080/", response(JSON.stringify({ results: [{ title: "Local", url: "https://local.test/", content: "Local snippet" }] }), { headers: { "content-type": "application/json" } })],
      ["https://html.duckduckgo.com/html/", response(ddgHtml)],
    ], calls);

    const markdown = await packageSearch(
      { query: "local", limit: 5 },
      { env: { settings: { web: { debug: true, search: { cacheSeconds: 0, backends: [{ type: "searxng", url: "http://localhost:8080/" }] } } } } },
      { fetchImpl },
    );

    expect(markdown).toStartWith("Code Path: SearXNG (searxng)");
    expect(markdown).toContain("URL: https://local.test/");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("format=json");
  });

  test("uses SEARXNG_URL environment when settings have no SearXNG backend", async () => {
    // ambient SEARXNG_URL/SEARXNG_BASE must not leak in: these tests exercise explicit config only
    const savedEnv = { SEARXNG_URL: process.env.SEARXNG_URL, SEARXNG_BASE: process.env.SEARXNG_BASE };
    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_BASE;
    try {
      const calls = [];
      const fetchImpl = createFetch([
        ["http://searx.test/search", response(JSON.stringify({ results: [{ title: "Local", url: "https://local.test/", content: "Local snippet" }], unresponsive_engines: [["other", "Suspended: CAPTCHA"]] }), { headers: { "content-type": "application/json" } })],
      ], calls);

      const markdown = await packageSearch(
        { query: "none", limit: 5 },
        { env: { settings: { web: { search: { cacheSeconds: 0, engines: [] } } } } },
        { fetchImpl, env: { SEARXNG_URL: "http://searx.test/search" } },
      );

      expect(markdown).toContain("URL: https://local.test/");
      expect(markdown).toContain("Local snippet");
      expect(calls[0].url).toStartWith("http://searx.test/search");
    } finally {
      if (savedEnv.SEARXNG_URL === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = savedEnv.SEARXNG_URL;
      if (savedEnv.SEARXNG_BASE === undefined) delete process.env.SEARXNG_BASE; else process.env.SEARXNG_BASE = savedEnv.SEARXNG_BASE;
    }
  });

  test("implements explicit empty engine-list semantics", async () => {
    await expect(packageSearch(
      { query: "x", limit: 5 },
      { env: { settings: { web: { search: { cacheSeconds: 0, engines: [] } } } } },
      { fetchImpl: createFetch([]) },
    )).rejects.toThrow(/no configured search engines/);
  });

  test("implements explicit plus default engine-list semantics", async () => {
    const calls = [];
    const fetchImpl = createFetch([
      ["https://api.search.brave.com/res/v1/web/search", response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://brave.test/", description: "B" }] } }), { headers: { "content-type": "application/json" } })],
      ["https://html.duckduckgo.com/html/", response("no results")],
      ["https://www.mojeek.com/search", response("no results")],
    ], calls);

    const markdown = await packageSearch(
      { query: "brave", limit: 5 },
      { env: { settings: { web: { search: { cacheSeconds: 0, default: true, engines: [{ type: "brave-api", url: "https://api.search.brave.com/res/v1/web/search", token: { header: "X-Subscription-Token", value: "secret" } }] } } } } },
      { fetchImpl },
    );

    expect(markdown).toContain("URL: https://brave.test/");
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(expect.arrayContaining(["api.search.brave.com", "html.duckduckgo.com", "www.mojeek.com"]));
  });

  test("supports the explicit Swisscows adapter (signature headers + JWT payload) with snippets", async () => {
    // ambient SEARXNG_URL/SEARXNG_BASE must not leak in: this test exercises explicit engines only
    const savedEnv = { SEARXNG_URL: process.env.SEARXNG_URL, SEARXNG_BASE: process.env.SEARXNG_BASE };
    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_BASE;
    try {
      const calls = [];
      const fetchImpl = createFetch([
        ["https://api.swiss.test/v5/web/search", response(swissJson, { headers: { "content-type": "application/json" } })],
      ], calls);
      const engines = [{ type: "swisscows-api", url: "https://api.swiss.test/v5/web/search" }];
      const markdown = await packageSearch(
        { query: "privacy", limit: 10 },
        { env: { settings: { web: { debug: true, search: { cacheSeconds: 0, engines } } } } },
        { fetchImpl },
      );
      expect(markdown).toContain("Swiss snippet");
      expect(markdown).toContain("Engines: swisscows");
      const swissCall = calls[0];
      expect(swissCall.url).toContain("query=privacy");
      expect(swissCall.headers["x-request-nonce"]).toBeTruthy();
      expect(swissCall.headers["x-request-signature"]).toBeTruthy();
    } finally {
      if (savedEnv.SEARXNG_URL === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = savedEnv.SEARXNG_URL;
      if (savedEnv.SEARXNG_BASE === undefined) delete process.env.SEARXNG_BASE; else process.env.SEARXNG_BASE = savedEnv.SEARXNG_BASE;
    }
  });

  test("rejects the removed qwant-api and metager-html engine types", async () => {
    const fetchImpl = createFetch([
      ["https://api.swisscows.com/v5/web/search", response(swissJson, { headers: { "content-type": "application/json" } })],
    ]);
    for (const type of ["qwant-api", "metager-html"]) {
      await expect(packageSearch(
        { query: "x", limit: 5 },
        { env: { settings: { web: { search: { cacheSeconds: 0, engines: [{ type, url: "https://removed.test/search" }] } } } } },
        { fetchImpl },
      )).rejects.toThrow(new RegExp(`unsupported: ${type.replace("-", "\\-")}`));
    }
  });

  test("confines token to configured origin across bounded redirects", async () => {
    const calls = [];
    const fetchImpl = createFetch([
      ["http://searx.test/", response("", { status: 302, headers: { location: "https://other.test/search" } })],
      ["https://other.test/search", response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })],
    ], calls);

    await packageSearch(
      { query: "token", limit: 5 },
      { env: { settings: { web: { search: { cacheSeconds: 0, backends: [{ type: "searxng", url: "http://searx.test/", token: { header: "Authorization", value: "Bearer secret" } }], engines: [] } } } } },
      { fetchImpl },
    );

    expect(calls[0].headers.authorization).toBe("Bearer secret");
    expect(calls[0].headers["user-agent"]).toContain("Mozilla/5.0");
    expect(calls[0].headers.accept).toContain("text/html");
    expect(calls[0].headers["accept-language"]).toBe("en-US,en;q=0.5");
    expect(calls[0].headers["upgrade-insecure-requests"]).toBe("1");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  test("returns aggregate errors after partial group failure only when all engines fail", async () => {
    const fetchImpl = createFetch([
      ["https://html.duckduckgo.com/html/", response("captcha challenge")],
      ["https://www.mojeek.com/search", response("<html><body>unrecognized</body></html>")],
    ]);

    await expect(packageSearch(
      { query: "fail", limit: 5 },
      { env: { settings: { web: { search: { cacheSeconds: 0 } } } } },
      { fetchImpl },
    )).rejects.toThrow(/all configured search engines failed.*duckduckgo-html.*mojeek-html/);
  });

  test("uses bounded process cache", async () => {
    // ambient SEARXNG_URL/SEARXNG_BASE must not leak in: this test exercises explicit engines only
    const savedEnv = { SEARXNG_URL: process.env.SEARXNG_URL, SEARXNG_BASE: process.env.SEARXNG_BASE };
    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_BASE;
    try {
      const calls = [];
      const fetchImpl = createFetch([
        ["https://html.duckduckgo.com/html/", response(ddgHtml)],
        ["https://www.mojeek.com/search", response(mojeekHtml)],
      ], calls);
      const context = { env: { settings: { web: { search: { cacheSeconds: 300, cacheMaxEntries: 1, engines: [{ type: "duckduckgo-html", url: "https://html.duckduckgo.com/html/" }] } } } } };

      await packageSearch({ query: "cache", limit: 5 }, context, { fetchImpl });
      await packageSearch({ query: "cache", limit: 5 }, context, { fetchImpl });

      expect(calls).toHaveLength(1);
    } finally {
      if (savedEnv.SEARXNG_URL === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = savedEnv.SEARXNG_URL;
      if (savedEnv.SEARXNG_BASE === undefined) delete process.env.SEARXNG_BASE; else process.env.SEARXNG_BASE = savedEnv.SEARXNG_BASE;
    }
  });

  test("adds clamp notice after cached content", async () => {
    const fetchImpl = createFetch([
      ["https://html.duckduckgo.com/html/", response(ddgHtml)],
      ["https://www.mojeek.com/search", response(mojeekHtml)],
    ]);

    const markdown = await packageSearch({ query: "clamp", limit: 40, wasClamped: true }, { env: { settings: { web: { search: { cacheSeconds: 0 } } } } }, { fetchImpl });

    expect(markdown).toContain("returns at most 40 results");
  });
});
