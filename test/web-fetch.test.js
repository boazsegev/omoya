import { beforeEach, describe, expect, test } from "bun:test";
import { __resetPackageFetchForTests, packageFetch as rawpackageFetch } from "../tools/web/fetch/index.js";
import { __resetWebRateForTests, rateEnter } from "../tools/web/shared.js";

function packageFetch(args, context = {}, options = {}) {
  return rawpackageFetch(args, context, { sleep: async () => {}, ...options });
}

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

  test("fails a pending connection after the 2s connect timeout instead of waiting for the full timeout", async () => {
    const fetchImpl = async (url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason ?? new Error("aborted")); }, { once: true });
      });
      return new Response("late", { headers: { "content-type": "text/plain" } });
    };
    const startedAt = Date.now();
    await expect(packageFetch(
      { url: "http://dead-backend.test/page" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0, timeout: 20_000 } } } } },
      { fetch: fetchImpl, now: fixedNow },
    )).rejects.toThrow(/could not connect/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  test("keeps waiting for a trickling body after the connection succeeds", async () => {
    const fetchImpl = makeFetch({
      "https://slow.example/page": () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("slow but "));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("connected"));
              controller.close();
            }, 2_600); // body trickles past the connect window, still within the overall budget
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
    });
    const result = await packageFetch(
      { url: "https://slow.example/page" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } },
      { fetch: fetchImpl, now: fixedNow },
    );
    expect(result.endsWith("slow but connected")).toBe(true);
  }, 15_000);

  test("honors the overall fetch timeout once connected", async () => {
    const fetchImpl = makeFetch({
      "https://trickle.example/page": () => new Response(
        new ReadableStream({ start() { /* never enqueues */ } }),
        { headers: { "content-type": "text/plain" } },
      ),
    });
    const startedAt = Date.now();
    await expect(packageFetch(
      { url: "https://trickle.example/page" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0, timeout: 2_500 } } } } },
      { fetch: fetchImpl, now: fixedNow },
    )).rejects.toThrow(/timed out after 2500 ms/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  test("sends the shared browser headers to minimize anti-bot friction", async () => {
    const fetchImpl = makeFetch({
      "https://headers.example/page": { headers: { "content-type": "text/plain" }, body: "ok" },
    });
    await packageFetch({ url: "https://headers.example/page" }, { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } }, { fetch: fetchImpl, now: fixedNow });
    const headers = fetchImpl.calls[0].init.headers;
    expect(headers["user-agent"]).toContain("Mozilla/5.0");
    expect(headers["accept-language"]).toBe("en-US,en;q=0.5");
    expect(headers["upgrade-insecure-requests"]).toBe("1");
    expect(headers.accept).toContain("text/html");
    expect(headers.accept).toContain("application/json");
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

  test("accepts readable HTML that embeds CAPTCHA configuration", async () => {
    const result = await packageFetch(
      { url: "https://docs.example/overview" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } },
      { now: fixedNow, readability: null, fetch: makeFetch({
        "https://docs.example/overview": {
          headers: { "content-type": "text/html" },
          body: `<html><head><script>window.config = {"hcaptchaInvisibleSitekey":"example-key"};</script></head>
            <body><main><h1>API overview</h1><p>This is the real documentation content, not a CAPTCHA challenge page.</p></main></body></html>`,
        },
      }) },
    );
    expect(result).toContain("# API overview");
    expect(result).toContain("real documentation content");
  });

  test("returns substantial extracted Markdown despite a challenge signature", async () => {
    const article = "The requested documentation explains the API contract and its operational constraints. ".repeat(8);
    const result = await packageFetch(
      { url: "https://docs.example/challenged-article" },
      { env: { settings: { web: { fetch: { cacheSeconds: 0 } } } } },
      { now: fixedNow, readability: null, fetch: makeFetch({
        "https://docs.example/challenged-article": {
          headers: { "content-type": "text/html" },
          body: `<html><head><title>Just a moment...</title></head><body><main><h1>API guide</h1><p>${article}</p></main></body></html>`,
        },
      }) },
    );
    expect(result).toContain("Warning: The response matched a possible anti-bot or challenge page.");
    expect(result).toContain("# API guide");
    expect(result).toContain(article.trim());
  });

  test("fails malformed JSON, unsupported media, challenge pages, script shells, and byte overflow", async () => {
    const common = { env: { settings: { web: { limit: { calls: 100 }, fetch: { cacheSeconds: 0, maxBytes: 1_000 } } } } };
    await expect(packageFetch({ url: "https://x/json" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/json": { headers: { "content-type": "application/json" }, body: "{" } }) })).rejects.toThrow(/malformed JSON/);
    await expect(packageFetch({ url: "https://x/bin" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/bin": { headers: { "content-type": "application/octet-stream" }, body: "abc" } }) })).rejects.toThrow(/unsupported media type/);
    await expect(packageFetch({ url: "https://x/cf" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/cf": { headers: { "content-type": "text/html" }, body: "<html><title>Just a moment</title>checking your browser cloudflare captcha</html>" } }) })).rejects.toThrow(/challenge/);
    await expect(packageFetch({ url: "https://x/app" }, common, { now: fixedNow, fetch: makeFetch({ "https://x/app": { headers: { "content-type": "text/html" }, body: "<div id=app></div><script>" + "x".repeat(200) + "</script>" } }) })).rejects.toThrow(/JavaScript-rendered/);
    const bounded = { env: { settings: { web: { limit: { calls: 100 }, fetch: { cacheSeconds: 0, maxBytes: 20 } } } } };
    await expect(packageFetch({ url: "https://x/large" }, bounded, { now: fixedNow, fetch: makeFetch({ "https://x/large": { headers: { "content-type": "text/plain" }, body: "x".repeat(21) } }) })).rejects.toThrow(/exceeded 20 bytes/);
  });

  test("caches successful bounded results with original retrieval timestamp", async () => {
    let count = 0;
    const fetchImpl = makeFetch({
      "https://cache.example/page": () => new Response(`call ${++count}`, { headers: { "content-type": "text/plain", "cache-control": "max-age=60" } }),
    });
    const context = { env: { settings: { web: { limit: { calls: 1 }, throttle: { stepMs: 0 } } } } };
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
      { env: { settings: { web: { readability: false, limit: { calls: 100 }, fetch: { cacheSeconds: 0 } } } } },
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
      { env: { settings: { web: { limit: { calls: 100 }, fetch: { cacheSeconds: 0 } } } } },
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
      { env: { settings: { web: { limit: { calls: 100 }, fetch: { cacheSeconds: 0 } } } } },
      { fetch: fetchImpl, now: fixedNow, readability: { Readability: FakeReadability, createDocument: () => ({}) } },
    );

    expect(result).toContain("# Readable");
    expect(result).toContain("Main body");
    expect(result).not.toContain("Fallback");
  });

  test("throttles instead of failing: a successful call pauses per the capacity fill", async () => {
    const counted = async (url) => new Response(`body ${url}`, { headers: { "content-type": "text/plain" } });
    const pauses = [];
    const sleep = async (ms) => { pauses.push(ms); };
    // Configured 4 slots and 4s maximum: occupancy produces 1/2/3/4s pauses.
    const context = { env: { settings: { web: { limit: { calls: 4 }, throttle: { startAt: 0.25, step: 0.25, stepMs: 1_000 }, fetch: { cacheSeconds: 0 } } } } };
    const options = { fetch: counted, now: fixedNow, sleep };
    for (let i = 0; i < 4; i++) {
      await packageFetch({ url: `https://throttle.example/page/${i}` }, context, options);
    }
    expect(pauses).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  test("the graded pause steps follow the ledger's fill exactly", async () => {
    const pauses = [];
    const sleep = async (ms) => { pauses.push(ms); };
    const ledger = { calls: 4, windowMs: 40_000, startAt: 0.25, startAt: 0.25, step: 0.25, stepMs: 1_000 };
    const at = Date.parse("2026-09-24T12:00:00.000Z");
    __resetWebRateForTests();
    __resetPackageFetchForTests();
    for (let i = 0; i < 4; i++) {
      const leave = await rateEnter(ledger, () => at, undefined, sleep);
      await leave(true); // the (i+1)-th successful call pauses (i+1)s
    }
    expect(pauses).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  test("waits for burst capacity instead of reporting a rate error", async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches += 1; return new Response("ok", { headers: { "content-type": "text/plain" } }); };
    let now = Date.parse("2026-09-24T12:00:00.000Z");
    const context = { env: { settings: { web: { limit: { calls: 4 }, throttle: { startAt: 0.25, step: 0.25, stepMs: 1_000 }, fetch: { cacheSeconds: 0 } } } } };
    context.env.settings.web.limit = { calls: 2, windowMs: 100 };
    context.env.settings.web.throttle.stepMs = 0;
    const options = { fetch: fetchImpl, now: () => new Date(now), sleep: async (ms) => { now += ms; } };
    await packageFetch({ url: "https://wait.example/page/1" }, context, options);
    await packageFetch({ url: "https://wait.example/page/2" }, context, options);
    // Third call: the burst window is full — it must WAIT for the oldest
    // call to age out (and its own success pause), never throw.
    await packageFetch({ url: "https://wait.example/page/3" }, context, options);
    expect(fetches).toBe(3);
    expect(now).toBeGreaterThan(Date.parse("2026-09-24T12:00:00.000Z"));
  });

  test("errored calls count against the ledger but do not pause afterwards", async () => {
    const routing = async (url) => {
      if (String(url).includes("bad")) return new Response("missing", { status: 500 });
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    };
    const pauses = [];
    const options = { fetch: routing, now: fixedNow, sleep: async (ms) => { pauses.push(ms); },  };
    const context = { env: { settings: { web: { limit: { calls: 4 }, throttle: { startAt: 0.25, step: 0.25, stepMs: 1_000 }, fetch: { cacheSeconds: 0 } } } } };
    await expect(packageFetch({ url: "https://mix.example/bad" }, context, options)).rejects.toThrow(/HTTP 500/);
    expect(pauses).toEqual([]); // the failure owed no pause
    await packageFetch({ url: "https://mix.example/good" }, context, options);
    // 2 of 4 burst slots are used (the error's too): the success pauses at 50%.
    expect(pauses).toEqual([2_000]);
  });

  test("a capacity wait longer than half the remaining timeout fails fast, busy", async () => {
    const routing = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
    const context = { env: { settings: { web: { limit: { calls: 4 }, throttle: { startAt: 0.25, step: 0.25, stepMs: 1_000 }, fetch: { cacheSeconds: 0 } } } } };
    // burst window of 1, held by a prior call whose slot frees only in 30s:
    // a caller with a 20s deadline gets the fast busy error, not a 30s wait.
    context.env.settings.web.limit = { calls: 1, windowMs: 30_000 };
    context.env.settings.web.throttle.stepMs = 0;
    const options = { fetch: routing, now: fixedNow };
    await packageFetch({ url: "https://busy.example/one" }, context, options);
    await expect(packageFetch(
      { url: "https://busy.example/two" },
      { ...context, deadline: Date.now() + 20_000 },
      options,
    )).rejects.toThrow(/web-fetch busy for \d+ ms, please wait/);
  });
});
