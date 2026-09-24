// test/io-kimi.test.js — proof for the Kimi (Moonshot AI) provider
// (providers/kimi.js): the chat-completions dialect (context2msg /
// msg2events), the login-wizard presets (both Moonshot sites), the
// environment detection (MOONSHOT_API_KEY / KIMI_API_KEY), and the
// OpenAI-default completion (transport, /models, login, verify).
import { describe, expect, test, afterEach } from "bun:test";
import { defineProvider, HttpStatusError } from "../lib/io.js";
import KimiPlugin from "../providers/kimi.js";

const Protocol = defineProvider(KimiPlugin, { name: "kimi" });

const ENV_KEYS = ["MOONSHOT_API_KEY", "KIMI_API_KEY", "MOONSHOT_BASE_URL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const aiio = (over = {}) => ({
  currentModel: "kimi-k2-0905-preview",
  settings: { auth: { token: "sk-test" } },
  tools: () => [],
  ...over,
});

const user = (text) => ({ type: 2, content: [{ type: "text", text }] });
const system = (text) => ({ type: 1, content: [{ type: "text", text }] });
const assistant = (content) => ({ type: 3, content });

describe("kimi provider: construction and metadata", () => {
  test("the URL targets /chat/completions; OpenAI defaults complete the rest", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    expect(connection.baseUrl).toBe("https://api.moonshot.ai/v1");
    expect(connection.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    for (const method of ["send", "read", "close", "models", "login", "testConnection"]) {
      expect(typeof connection[method], method).toBe("function"); // completed defaults
    }
    expect(typeof Protocol.provider.label).toBe("string"); // the label text is content
    // flags stay boolean; the proven $web_search builtin joins the
    // surface (Kimi documents no fetch tool)
    expect(Protocol.provider.capabilities).toEqual({
      tools: true,
      thinking: true,
      streaming: true,
      "web-search": expect.any(Function),
    });
  });

  // Endpoint names and model catalogs are CONTENT (free to change
  // without touching tests); the contract is well-formed presets.
  test("knownEndpoints offers the Moonshot sites + the coding subscription, with offline fallback models", () => {
    const names = Protocol.knownEndpoints.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["kimi", "kimi-cn", "kimi-coding"]));
    const byName = Object.fromEntries(Protocol.knownEndpoints.map((e) => [e.name, e]));
    const { kimi: intl, "kimi-cn": cn, "kimi-coding": coding } = byName;
    expect(intl.url).toBe("https://api.moonshot.ai/v1");
    expect(cn.url).toBe("https://api.moonshot.cn/v1");
    // model CATALOG is content — the contract is only the entry shape
    // (typeof checks: expect.any() matchers MUTATE the matched object in
    // Bun — never point them at shared built-in state)
    expect(Object.keys(intl.models).length).toBeGreaterThan(0);
    for (const entry of Object.values(intl.models)) {
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.contextWindow).toBe("number");
    }
    expect(coding.url).toBe("https://api.kimi.com/coding/v1");
    expect(Object.keys(coding.models).length).toBeGreaterThan(0);
    // every preset declares its models.dev registry (auto model detection)
    expect(intl.registry).toEqual({ url: "https://models.dev/api.json", provider: "moonshotai" });
    expect(cn.registry.provider).toBe("moonshotai-cn");
    expect(coding.registry.provider).toBe("kimi-for-coding");
    // the coding endpoint signs in with its OAuth DEVICE flow (RFC 8628)
    expect(typeof coding.oauth.label).toBe("string"); // label text is content
    expect(coding.oauth.deviceAuthorizationUrl).toBe("https://auth.kimi.com/api/oauth/device_authorization");
    expect(coding.oauth.tokenUrl).toBe("https://auth.kimi.com/api/oauth/token");
    expect(typeof coding.oauth.clientId).toBe("string");
    expect(coding.oauth.authorizeUrl).toBeUndefined(); // not the PKCE shape
  });

  test("detectEndpoints: MOONSHOT_API_KEY / KIMI_API_KEY configure dynamically, base URL overridable", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(await Protocol.detectEndpoints({ endpoints: {} })).toEqual({});
    process.env.MOONSHOT_API_KEY = "sk-moon";
    let found = await Protocol.detectEndpoints({ endpoints: {} });
    expect(found.kimi).toEqual({
      provider: "kimi",
      url: "https://api.moonshot.ai/v1",
      dynamic: true,
      auth: { type: "api_key", token: "sk-moon" },
    });
    process.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
    process.env.KIMI_API_KEY = "sk-alt";
    found = await Protocol.detectEndpoints({ endpoints: {} });
    expect(found.kimi.url).toBe("https://api.moonshot.cn/v1");
    // KIMI_API_KEY belongs to the coding subscription endpoint (pi's naming)
    expect(found["kimi-coding"]).toEqual({
      provider: "kimi",
      url: "https://api.kimi.com/coding/v1",
      dynamic: true,
      auth: { type: "api_key", token: "sk-alt" },
    });
    // an already-configured endpoint is never overridden
    found = await Protocol.detectEndpoints({ endpoints: { kimi: { provider: "kimi", url: "x" } } });
    expect(found.kimi).toBeUndefined();
  });
});

describe("kimi provider: context2msg (chat-completions dialect)", () => {
  test("system/user/assistant/tool-result mapping, tools, streaming usage", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio({
      tools: () => [{ name: "read", description: "read a file", inputSchema: { type: "object", properties: {} } }],
    }));
    const context = [
      system("be terse"),
      user("hi"),
      assistant([
        { type: "text", text: "checking" },
        { type: "toolCall", callId: "c1", name: "read", arguments: { path: "a.txt" } },
      ]),
      { type: 4, callId: "c1", name: "read", content: [{ type: "text", text: "file body" }] },
    ];
    const [headers, body] = connection.context2msg(context);
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(body.model).toBe("kimi-k2-0905-preview");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ]);
    expect(body.tools).toEqual([{
      type: "function",
      function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
    }]);
  });

  test("parallel tool results precede attached system payloads on the strict Kimi wire", () => {
    const connection = new Protocol("https://api.kimi.com/coding/v1", aiio());
    const [, body] = connection.context2msg([
      user("find both"),
      assistant([
        { type: "toolCall", callId: "read:3", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", callId: "bash:4", name: "bash", arguments: { command: "pwd" } },
      ]),
      { type: 4, callId: "read:3", name: "read", content: [{ type: "text", text: "a" }] },
      system("read tool payload"),
      { type: 4, callId: "bash:4", name: "bash", content: [{ type: "text", text: "cwd" }] },
      system("bash tool payload"),
      user("continue"),
    ]);
    expect(body.messages.map((message) => [message.role, message.tool_call_id, message.content])).toEqual([
      ["user", undefined, "find both"],
      ["assistant", undefined, null],
      ["tool", "read:3", "a"],
      ["tool", "bash:4", "cwd"],
      ["system", undefined, "read tool payload"],
      ["system", undefined, "bash tool payload"],
      ["user", undefined, "continue"],
    ]);
  });

  test("user images ride as image_url parts", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const [, body] = connection.context2msg([
      { type: 2, content: [{ type: "text", text: "what is this?" }, { type: "image", mime: "image/png", content: "QUJD" }] },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  test("uploads user files to Kimi, fetches extracted content, then folds it in as text", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/files")) return new Response(JSON.stringify({ id: "file-123" }), { status: 200 });
      if (String(url).endsWith("/files/file-123/content")) return new Response("hello", { status: 200 });
      return new Response("", { status: 200 });
    };
    try {
      const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
      const message = connection.context2msg([{
        type: 2,
        content: [
          { type: "text", text: "Before" },
          { type: "binary", mimetype: "text/plain", filename: "notes.txt", content: "aGVsbG8=" },
          { type: "text", text: "After" },
        ],
      }]);
      await connection.send(message);
      expect(calls).toHaveLength(3);
      expect(calls[0].url).toBe("https://api.moonshot.ai/v1/files");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers.authorization).toBe("Bearer sk-test");
      expect(calls[0].init.headers["content-type"]).toBeUndefined();
      expect(calls[0].init.body.get("purpose")).toBe("file-extract");
      const uploaded = calls[0].init.body.get("file");
      expect(uploaded.name).toBe("notes.txt");
      expect(await uploaded.text()).toBe("hello");
      expect(calls[1].url).toBe("https://api.moonshot.ai/v1/files/file-123/content");
      expect(calls[1].init.headers.authorization).toBe("Bearer sk-test");
      expect(JSON.parse(calls[2].init.body).messages[0].content).toEqual([
        { type: "text", text: "Before" },
        { type: "text", text: "[notes.txt]\nhello" },
        { type: "text", text: "After" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the coding endpoint refuses a non-image binary with a clear error, no upload", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetches += 1; return new Response("{}", { status: 200 }); };
    try {
      const connection = new Protocol("https://api.kimi.com/coding/v1", aiio());
      const message = connection.context2msg([{
        type: 2,
        content: [{ type: "binary", mimetype: "application/pdf", filename: "quote.pdf", content: "JVBERi0=" }],
      }]);
      const err = await connection.send(message).catch((e) => e);
      expect(err?.kind).toBe("provider");
      expect(err?.message).toContain("cannot accept file attachments");
      expect(err?.message).toContain("api.kimi.com/coding");
      expect(fetches).toBe(0); // refused before any upload/chat request
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the coding endpoint still sends images (image_url) without touching /files", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response("{}", { status: 200 }); };
    try {
      const connection = new Protocol("https://api.kimi.com/coding/v1", aiio());
      const message = connection.context2msg([{
        type: 2,
        content: [{ type: "image", mimetype: "image/png", content: "QUJD" }],
      }]);
      await connection.send(message);
      expect(calls.some((u) => u.endsWith("/files"))).toBe(false); // no upload for an image
      expect(calls.some((u) => u.includes("/chat/completions"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("kimi provider: models() — live list + registry auto-detection", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const stubFetch = (routes) => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const route = Object.entries(routes).find(([path]) => String(url).includes(path));
      if (!route) throw new Error(`unexpected fetch ${url}`);
      const [status, body] = typeof route[1] === "function" ? route[1]() : route[1];
      return new Response(JSON.stringify(body), { status });
    };
    return calls;
  };

  const connection = ({ token, ...rest } = {}, url = "https://api.moonshot.ai/v1") => {
    const writes = {};
    const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
    const io = aiio({
      settings,
      authSet: (data) => Object.assign(writes, data),
    });
    return { conn: new Protocol(url, io), writes };
  };

  test("live ids merge with registry metadata (existing + newly released models)", async () => {
    stubFetch({
      "models.dev": [200, { moonshotai: { models: {
        "kimi-k2-0905-preview": { name: "Kimi K2 0905", reasoning: false, limit: { context: 262144, output: 262144 } },
        "kimi-k3": { name: "Kimi K3", reasoning: true, limit: { context: 1048576, output: 131072 } },
      } } }],
      "/v1/models": [200, { data: [{ id: "kimi-k2-0905-preview" }, { id: "kimi-k3" }] }],
    });
    const { conn, writes } = connection();
    const map = await conn.models();
    expect(map["kimi-k2-0905-preview"]).toEqual({
      label: "Kimi K2 0905", reasoning: false, contextWindow: 262144, maxTokens: 262144,
    });
    // kimi-k3 was never in the static list — the registry auto-detected it
    expect(map["kimi-k3"]).toEqual({
      label: "Kimi K3", reasoning: true, contextWindow: 1048576, maxTokens: 131072,
    });
    expect(writes.models["kimi-k3"]).toBeDefined(); // the cache refreshed
    expect(writes.registry.models["kimi-k3"]).toBeDefined();
  });

  test("the registry snapshot caches (TTL); a live id missing everywhere still lists", async () => {
    const calls = stubFetch({
      "models.dev": () => { throw new Error("registry down"); },
      "/v1/models": [200, { data: [{ id: "kimi-k2-thinking" }, { id: "brand-new-model" }] }],
    });
    const cachedRegistry = { fetchedAt: Date.now(), models: { "kimi-k2-thinking": { label: "K2T", reasoning: true, contextWindow: 262144 } } };
    const { conn } = connection({ token: "sk", registry: cachedRegistry });
    const map = await conn.models();
    expect(calls.filter((u) => u.includes("models.dev"))).toHaveLength(0); // the TTL cache served it
    expect(map["kimi-k2-thinking"]).toEqual({ label: "K2T", reasoning: true, contextWindow: 262144, maxTokens: 262144 });
    expect(map["brand-new-model"]).toEqual({ label: "brand-new-model", reasoning: false }); // bare but listed
  });

  test("fully offline: the static preset list is the fallback (coding endpoint)", async () => {
    stubFetch({
      "models.dev": () => { throw new Error("offline"); },
      "/v1/models": () => { throw new Error("offline"); },
    });
    const { conn } = connection({}, "https://api.kimi.com/coding/v1");
    const map = await conn.models();
    // every static-preset model merges through (the catalog itself is content)
    const preset = Protocol.knownEndpoints.find((e) => e.name === "kimi-coding");
    for (const [id, entry] of Object.entries(preset.models)) {
      expect(map[id]?.reasoning ?? false, id).toBe(entry.reasoning === true);
    }
  });
});

describe("kimi provider: msg2events (chunk translation)", () => {
  test("thinking, text, indexed tool calls, and the trailing usage chunk", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const state = {};
    const feed = (chunk) => connection.msg2events(chunk, state, aiio());
    const flat = (events) => events.map((e) => `${e.type}${e.text ?? e.arguments ?? ""}`);

    expect(flat(feed({ choices: [{ delta: { reasoning_content: "hmm " } }] })))
      .toEqual(["thinking_start", "thinking_deltahmm "]);
    expect(flat(feed({ choices: [{ delta: { reasoning_content: "yes" } }] })))
      .toEqual(["thinking_deltayes"]);
    // text closes thinking
    expect(flat(feed({ choices: [{ delta: { content: "answer" } }] })))
      .toEqual(["thinking_end", "text_start", "text_deltaanswer"]);
    // two indexed tool calls, argument fragments stream
    const callEvents = feed({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_1", function: { name: "read", arguments: "{\"pa" } },
    ] } }] });
    expect(callEvents).toEqual([
      { type: "text_end", contentIndex: 1 },
      { type: "toolcall_start", contentIndex: 2, callId: "call_1", name: "read", arguments: "" },
      { type: "toolcall_delta", contentIndex: 2, arguments: "{\"pa" },
    ]);
    expect(flat(feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.txt\"}" } }] } }] })))
      .toEqual(["toolcall_deltath\":\"a.txt\"}"]);
    // finish closes the open call; the usage chunk terminates with tokens
    expect(flat(feed({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })))
      .toEqual(["toolcall_end"]);
    const io = aiio();
    const usageEvents = connection.msg2events(
      { id: "chatcmpl-1", model: "kimi-k2-0905-preview", choices: [], usage: { prompt_tokens: 321, completion_tokens: 42 } },
      state, io,
    );
    expect(usageEvents).toEqual([{
      type: "done",
      doneReason: "tool_calls",
      usage: { inputTokens: 321, outputTokens: 42 },
      native: { id: "chatcmpl-1", model: "kimi-k2-0905-preview" },
    }]);
  });

  test("an error chunk surfaces as an error event", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    expect(connection.msg2events({ error: { message: "invalid key" } }, {}, aiio()))
      .toEqual([{ type: "error", error: "invalid key", native: { error: { message: "invalid key" } } }]);
  });

  test("setContextUsage receives the endpoint-measured input tokens", () => {
    const io = aiio();
    let reported;
    io.setContextUsage = (u) => { reported = u; };
    const connection = new Protocol("https://api.moonshot.ai/v1", io);
    connection.msg2events({ choices: [], usage: { prompt_tokens: 99, completion_tokens: 1 } }, {}, io);
    expect(reported).toEqual({ used: 99 });
  });
});

describe("kimi provider: classifyError (403 usage-limit vs a dead credential)", () => {
  test("a 403 with no credential-shaped body classifies \"provider\", NOT \"auth\" — never forces a re-login", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const err = new HttpStatusError(403, "Forbidden", JSON.stringify({ error: { message: "rate limit exceeded, try again later" } }));
    const classified = connection.classifyError(err);
    expect(classified.kind).toBe("provider");
    expect(classified.message).toContain("temporary usage/rate limit");
  });

  test("a 403 whose body names the credential itself still classifies \"auth\"", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const err = new HttpStatusError(403, "Forbidden", JSON.stringify({ error: { message: "invalid api key" } }));
    expect(connection.classifyError(err).kind).toBe("auth");
  });

  test("a 401 is always \"auth\" regardless of body (unambiguous)", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const err = new HttpStatusError(401, "Unauthorized", JSON.stringify({ error: { message: "rate limit" } }));
    expect(connection.classifyError(err).kind).toBe("auth");
  });

  test("every other error kind still routes through the shared taxonomy unchanged", () => {
    const connection = new Protocol("https://api.moonshot.ai/v1", aiio());
    const err = new HttpStatusError(500, "Internal Server Error", "boom");
    expect(connection.classifyError(err).kind).toBe("provider");
  });
});

describe("kimi provider: reportPlanUsage (Moonshot's unsuffixed X-RateLimit-* dialect)", () => {
  test("the bare X-RateLimit-Limit/-Remaining/-Reset family lands as a \"requests\" quota (no requests/tokens split, unlike OpenAI)", () => {
    let reported;
    const io = aiio({ setPlanUsage: (u) => { reported = u; } });
    const connection = new Protocol("https://api.moonshot.ai/v1", io);
    connection.reportPlanUsage(new Headers({
      "X-RateLimit-Limit": "300",
      "X-RateLimit-Remaining": "297",
      "X-RateLimit-Reset": "2026-09-19T22:00:00Z",
    }), io);
    expect(reported).toEqual({ quotas: {
      requests: { total: 300, remaining: 297, reset: "2026-09-19T22:00:00Z" },
    } });
  });

  test("an OpenAI-suffixed response (a compatible proxy) is honored too, and wins over the bare family when both are present", () => {
    let reported;
    const io = aiio({ setPlanUsage: (u) => { reported = u; } });
    const connection = new Protocol("https://api.moonshot.ai/v1", io);
    connection.reportPlanUsage(new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "49",
      "x-ratelimit-limit-tokens": "40000",
      "x-ratelimit-remaining-tokens": "39000",
      "X-RateLimit-Limit": "300", // suffixed "requests" takes precedence over this
      "X-RateLimit-Remaining": "1",
    }), io);
    expect(reported).toEqual({ quotas: {
      requests: { total: 50, remaining: 49 },
      tokens: { total: 40000, remaining: 39000 },
    } });
  });

  test("nothing published on a dialect with no balance fallback (the coding subscription endpoint), nothing reported", () => {
    let reported = "untouched";
    const io = aiio({ setPlanUsage: (u) => { reported = u; } });
    const connection = new Protocol("https://api.kimi.com/coding/v1", io);
    connection.reportPlanUsage(new Headers({ "content-type": "text/event-stream" }), io);
    expect(reported).toBe("untouched"); // setPlanUsage never called; no fetch attempted either
  });
});

describe("kimi provider: reportBalance (platform-endpoint fallback when no header dialect publishes anything)", () => {
  test("headers empty on a platform endpoint — falls back to GET .../users/me/balance and reports a currency \"balance\" quota", async () => {
    let requested;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requested = { url: String(url), authorization: init.headers.authorization };
      return new Response(JSON.stringify({
        code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
      }), { status: 200 });
    };
    try {
      const io = aiio({ setPlanUsage: (u) => { io.reports = [...(io.reports ?? []), u]; } });
      const connection = new Protocol("https://api.moonshot.ai/v1", io);
      await connection.reportPlanUsage(new Headers(), io);
      expect(requested).toEqual({ url: "https://api.moonshot.ai/v1/users/me/balance", authorization: "Bearer sk-test" });
      expect(io.reports).toEqual([{ quotas: { balance: { remaining: 49.58894, unit: "usd" } } }]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("the China region endpoint reports the balance in CNY, not USD", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { available_balance: 120.5 } }), { status: 200 });
    try {
      const io = aiio({ setPlanUsage: (u) => { io.reports = [...(io.reports ?? []), u]; } });
      const connection = new Protocol("https://api.moonshot.cn/v1", io);
      await connection.reportPlanUsage(new Headers(), io);
      expect(io.reports).toEqual([{ quotas: { balance: { remaining: 120.5, unit: "cny" } } }]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("header data present — the balance endpoint is never fetched (headers are cheaper and already sufficient)", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetches += 1; return new Response("{}", { status: 200 }); };
    try {
      const io = aiio({ setPlanUsage: () => {} });
      const connection = new Protocol("https://api.moonshot.ai/v1", io);
      await connection.reportPlanUsage(new Headers({ "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "297" }), io);
      expect(fetches).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("caches per aiio (KIMI_BALANCE_TTL) — a second call right after does not re-fetch", async () => {
    let fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetches += 1; return new Response(JSON.stringify({ data: { available_balance: 1 } }), { status: 200 }); };
    try {
      const io = aiio({ setPlanUsage: () => {} });
      const connection = new Protocol("https://api.moonshot.ai/v1", io);
      await connection.reportPlanUsage(new Headers(), io);
      await connection.reportPlanUsage(new Headers(), io);
      expect(fetches).toBe(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("no token, a failed fetch, or a non-2xx/malformed response never throw and never report", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const noToken = aiio({ settings: { auth: {} }, setPlanUsage: () => { throw new Error("must not be called"); } });
      const conn1 = new Protocol("https://api.moonshot.ai/v1", noToken);
      await conn1.reportPlanUsage(new Headers(), noToken);

      globalThis.fetch = async () => { throw new Error("network down"); };
      const netErr = aiio({ setPlanUsage: () => { throw new Error("must not be called"); } });
      const conn2 = new Protocol("https://api.moonshot.ai/v1", netErr);
      await expect(conn2.reportPlanUsage(new Headers(), netErr)).resolves.toBeUndefined();

      globalThis.fetch = async () => new Response("nope", { status: 500 });
      const bad = aiio({ setPlanUsage: () => { throw new Error("must not be called"); } });
      const conn3 = new Protocol("https://api.moonshot.ai/v1", bad);
      await conn3.reportPlanUsage(new Headers(), bad);
    } finally { globalThis.fetch = originalFetch; }
  });
});
