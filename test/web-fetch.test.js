import { beforeEach, describe, expect, test } from "bun:test";
import { __resetPackageFetchForTests, packageFetch } from "../tools/web/fetch/index.js";

const fixedNow = () => new Date("2026-09-24T12:00:00.000Z");

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response("missing", { status: 404 });
    if (route instanceof Response) return route.clone();
    if (typeof route === "function") return route(url, init);
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe("packageFetch", () => {
  beforeEach(() => {
    __resetPackageFetchForTests();
  });

  test("renders semantic HTML as Markdown with provenance, links, base, tables, and code", async () => {
    const fetchImpl = makeFetch({
      "https://example.com/article": {
        headers: { "content-type": "text/html" },
        body: `<!doctype html><html><head><base href="https://cdn.example/assets/"></head><body>
          <nav>chrome</nav><main>
          <h1>Article &amp; Test</h1>
          <p>Hello <strong>world</strong> <a href="page.html">read</a> and it&#x27;s done &#8212; fine.</p>
          <pre><code>const x = 1;
console.log(x);</code></pre>
          <table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>
          </main></body></html>`,
      },
    });

    const result = await packageFetch({ url: "https://example.com/article" }, { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } }, { fetch: fetchImpl, now: fixedNow });

    expect(result).toStartWith("Source: https://example.com/article\nRetrieved: 2026-09-24T12:00:00.000Z");
    expect(result).toContain("# Article & Test");
    expect(result).toContain("Hello **world** [read](https://cdn.example/assets/page.html) and it's done — fine.");
    expect(result).toContain("```\nconst x = 1;\nconsole.log(x);\n```");
    expect(result).toContain("| Name | Value |\n| --- | --- |\n| A | 1 |");
    expect(fetchImpl.calls[0].init.credentials).toBe("omit");
    expect(fetchImpl.calls[0].init.redirect).toBe("manual");
  });

  test("follows validated manual redirects and reports final URL", async () => {
    const fetchImpl = makeFetch({
      "http://localhost/start": { status: 302, headers: { location: "/final" } },
      "http://localhost/final": { headers: { "content-type": "text/plain" }, body: "done" },
    });

    const result = await packageFetch({ url: "http://localhost/start" }, { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } }, { fetch: fetchImpl, now: fixedNow });

    expect(result).toContain("Source: http://localhost/start");
    expect(result).toContain("Final URL: http://localhost/final");
    expect(result.endsWith("done")).toBe(true);
  });

  test("rejects redirect targets with embedded credentials", async () => {
    const fetchImpl = makeFetch({
      "https://example.com/start": { status: 302, headers: { location: "https://user:pass@example.com/secret" } },
    });

    await expect(packageFetch({ url: "https://example.com/start" }, {}, { fetch: fetchImpl, now: fixedNow })).rejects.toThrow(/embedded credentials/);
  });

  test("pretty prints JSON and labels clipped JSON as incomplete", async () => {
    const fetchImpl = makeFetch({
      "https://api.example/data": { headers: { "content-type": "application/json" }, body: JSON.stringify({ alpha: 1, beta: [true, false] }) },
    });

    const result = await packageFetch(
      { url: "https://api.example/data" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0, maxCharacters: 20 } } } } },
      { fetch: fetchImpl, now: fixedNow },
    );

    expect(result).toContain("Truncated: yes (20 of ");
    expect(result).toContain("incomplete JSON");
    expect(result).toContain('{\n  "alpha": 1,');
  });

  test("fails malformed JSON, unsupported media, challenge pages, script shells, and byte overflow", async () => {
    const common = { env: { settings: { web: { fetch: { cacheSeconds: 0, maxBytes: 1_000, burstCalls: 100 } } } } };
    await expect(packageFetch({ url: "https://x/json" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/json": { headers: { "content-type": "application/json" }, body: "{" } }) })).rejects.toThrow(/malformed JSON/);
    await expect(packageFetch({ url: "https://x/bin" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/bin": { headers: { "content-type": "application/octet-stream" }, body: "abc" } }) })).rejects.toThrow(/unsupported media type/);
    await expect(packageFetch({ url: "https://x/cf" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/cf": { headers: { "content-type": "text/html" }, body: "<html><title>Just a moment</title>checking your browser cloudflare captcha</html>" } }) })).rejects.toThrow(/challenge/);
    await expect(packageFetch({ url: "https://x/app" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/app": { headers: { "content-type": "text/html" }, body: "<div id=app></div><script>" + "x".repeat(200) + "</script>" } }) })).rejects.toThrow(/JavaScript-rendered/);
    const bounded = { env: { settings: { web: { fetch: { cacheSeconds: 0, maxBytes: 20, burstCalls: 100 } } } } };
    await expect(packageFetch({ url: "https://x/large" }, bounded, { now: fixedNow, fetch: makeFetch({ "https://x/large": { headers: { "content-type": "text/plain" }, body: "x".repeat(21) } }) })).rejects.toThrow(/exceeded 20 bytes/);
  });

  test("caches successful bounded results with original retrieval timestamp", async () => {
    let count = 0;
    const fetchImpl = makeFetch({
      "https://cache.example/page": () => new Response(`call ${++count}`, { headers: { "content-type": "text/plain", "cache-control": "max-age=60" } }),
    });
    const context = { env: { settings: { web: { fetch: { burstCalls: 100 } } } } };
    const first = await packageFetch({ url: "https://cache.example/page" }, context, { fetch: fetchImpl, now: fixedNow });
    const second = await packageFetch({ url: "https://cache.example/page" }, context, { fetch: fetchImpl, now: () => new Date("2026-09-24T12:00:10.000Z") });

    expect(first).toEqual(second);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(second).toContain("Retrieved: 2026-09-24T12:00:00.000Z");
  });

  test("web.readability false forces the built-in extractor", async () => {
    const fetchImpl = makeFetch({
      "https://disabled.example/page": { headers: { "content-type": "text/html" }, body: "<html><body><main><h1>Built in</h1><p>Fallback body</p></main></body></html>" },
    });
    class ForbiddenReadability {
      constructor() { throw new Error("Readability must be disabled"); }
    }
    const result = await packageFetch(
      { url: "https://disabled.example/page" },
      { env: { settings: { web: { readability: false, fetch: { cacheSeconds: 0, burstCalls: 100 } } } } },
      { fetch: fetchImpl, now: fixedNow, readability: { Readability: ForbiddenReadability, createDocument: () => ({}) } },
    );
    expect(result).toContain("# Built in");
    expect(result).toContain("Fallback body");
  });

  test("rejects a non-boolean web.readability setting", async () => {
    const fetchImpl = makeFetch({ "https://invalid.example/": { headers: { "content-type": "text/html" }, body: "<main>body</main>" } });
    await expect(packageFetch(
      { url: "https://invalid.example/" },
      { env: { settings: { web: { readability: "yes", fetch: { cacheSeconds: 0 } } } } },
      { fetch: fetchImpl, now: fixedNow },
    )).rejects.toThrow(/web\.readability must be a boolean/);
  });

  test("detects and uses the actual globally installed Mozilla Readability and DOM provider", async () => {
    const imports = [];
    const importModule = async (specifier) => {
      imports.push(specifier);
      return import(specifier);
    };
    const fetchImpl = makeFetch({
      "https://real-readability.example/page": {
        headers: { "content-type": "text/html" },
        body: `<html><head><title>Real package</title></head><body><nav>Navigation chrome</nav><article>
          <h1>Actual Mozilla extraction</h1>
          <p>${"Substantive article sentence. ".repeat(20)}</p>
        </article><footer>Footer chrome</footer></body></html>`,
      },
    });
    const result = await packageFetch(
      { url: "https://real-readability.example/page" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0, burstCalls: 100 } } } } },
      { fetch: fetchImpl, now: fixedNow, importModule },
    );
    expect(imports.some((specifier) => specifier.startsWith("file:") && specifier.includes("/install/global/node_modules/@mozilla/readability"))).toBe(true);
    expect(imports.some((specifier) => specifier.startsWith("file:") && /\/install\/global\/node_modules\/(?:linkedom|happy-dom|jsdom)/.test(specifier))).toBe(true);
    expect(result).toContain("# Actual Mozilla extraction");
    expect(result).toContain("Substantive article sentence.");
    expect(result).not.toContain("Navigation chrome");
    expect(result).not.toContain("Footer chrome");
  });

  test("uses injectable Readability-compatible resolver when available", async () => {
    const fetchImpl = makeFetch({
      "https://read.example/page": { headers: { "content-type": "text/html" }, body: "<html><body><article><h1>Fallback</h1></article></body></html>" },
    });
    class FakeReadability {
      parse() {
        return { content: "<article><h1>Readable</h1><p>Main body</p></article>" };
      }
    }
    const result = await packageFetch(
      { url: "https://read.example/page" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0, burstCalls: 100 } } } } },
      { fetch: fetchImpl, now: fixedNow, readability: { Readability: FakeReadability, createDocument: () => ({}) } },
    );

    expect(result).toContain("# Readable");
    expect(result).toContain("Main body");
    expect(result).not.toContain("Fallback");
  });
});
