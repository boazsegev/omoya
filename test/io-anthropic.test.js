// test/io-anthropic.test.js — proof for the Anthropic provider
// (providers/anthropic.js): the Messages dialect (context2msg /
// msg2events with signed-thinking replay), the login-wizard presets
// (Anthropic + the Anthropic-compatible third-party routes), the
// environment detection (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN),
// the Anthropic-shaped /models listing with registry auto-detection,
// the two verification modes, and the ratelimit plan report.
import { describe, expect, test, afterEach } from "bun:test";
import { providerClass } from "./fakes.js";
import { resetAtMs } from "../lib/app/shared/format.js";
import AnthropicPlugin, * as anthropicExports from "../providers/anthropic.js";

const Protocol = await providerClass(AnthropicPlugin, "anthropic");
const URL = "https://api.anthropic.com/v1";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_WORKSPACE_ID"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const aiio = (over = {}) => ({
  modelCurrent: "claude-opus-5",
  settings: { auth: { token: "sk-ant-test" } },
  tools: () => [],
  ...over,
});

const user = (text) => ({ type: 2, content: [{ type: "text", text }] });
const system = (text) => ({ type: 1, content: [{ type: "text", text }] });
const assistant = (content) => ({ type: 3, content });
const toolResult = (callId, text, extra = {}) => ({ type: 4, callId, name: "read", content: [{ type: "text", text }], ...extra });

describe("anthropic provider: construction and metadata", () => {
  test("exports only the provider class", () => {
    expect(Object.keys(anthropicExports)).toEqual(["default"]);
  });

  test("the URL targets /messages; OpenAI defaults complete the transport only", () => {
    const connection = new Protocol(URL, aiio());
    expect(connection.baseUrl).toBe(URL);
    expect(connection.url).toBe(`${URL}/messages`);
    for (const method of ["send", "read", "close", "reportPlanUsage"]) {
      expect(typeof connection[method], method).toBe("function");
    }
    for (const method of ["models", "login", "testConnection", "detect"]) {
      expect(typeof Protocol[method], method).toBe("function");
    }
    expect(typeof Protocol.provider.label).toBe("string"); // the label text is content
    // native thinking modes; the proven server web tools are its provider tools
    expect(Protocol.provider.capabilities).toEqual({
      streaming: true,
      thinking: ["none", "low", "medium", "high", "xhigh", "max"],
      tools: { "web-search": { function: expect.any(Function) }, "web-fetch": { function: expect.any(Function) } },
    });
  });

  test("knownEndpoints: Anthropic (registry + offline models) and message-verified compatible routes", () => {
    const names = Protocol.knownEndpoints.map((e) => e.name);
    expect(names).toEqual(["anthropic", "deepseek-anthropic", "zai-anthropic", "minimax-anthropic"]);
    const [anthropic, deepseek, zai, minimax] = Protocol.knownEndpoints;
    expect(anthropic.url).toBe(URL);
    expect(anthropic.registry).toEqual({ url: "https://models.dev/api.json", provider: "anthropic" });
    // model CATALOG is content — the contract is only the entry shape
    // (plain typeof checks: expect.any() asymmetric matchers MUTATE the
    // matched object in Bun — never point them at shared built-in state)
    expect(Object.keys(anthropic.models).length).toBeGreaterThan(0);
    for (const entry of Object.values(anthropic.models)) {
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.contextWindow).toBe("number");
      expect(typeof entry.maxTokens).toBe("number");
    }
    expect(anthropic.verify).toBeUndefined(); // GET /models exists
    expect(anthropic.oauth).toBeUndefined(); // the key preset: no browser flow
    // the third-party routes have NO /models: a 1-token message verifies the login
    for (const preset of [deepseek, zai, minimax]) {
      expect(preset.verify).toBe("messages");
      expect(preset.registry).toBeUndefined(); // the static list persists with the endpoint
      expect(Object.keys(preset.models).length).toBeGreaterThan(0);
    }
    expect(deepseek.url).toBe("https://api.deepseek.com/anthropic");
    expect(zai.url).toBe("https://api.z.ai/api/anthropic");
    expect(minimax.url).toBe("https://api.minimax.io/anthropic");
  });

  test("detect: ANTHROPIC_API_KEY (x-api-key) or ANTHROPIC_AUTH_TOKEN (bearer), base URL overridable", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(await Protocol.detect({ endpoints: {} })).toEqual({});
    process.env.ANTHROPIC_AUTH_TOKEN = "oat-1";
    let found = await Protocol.detect({ endpoints: {} });
    expect(found.anthropic).toMatchObject({
      provider: "anthropic", url: URL, dynamic: true, auth: { type: "bearer", token: "oat-1" },
      models: expect.any(Object),
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-key"; // the key wins over the bearer (the SDK's order)
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example/v1";
    found = await Protocol.detect({ endpoints: {} });
    expect(found.anthropic).toMatchObject({
      provider: "anthropic", url: "https://proxy.example/v1", dynamic: true, auth: { type: "api_key", token: "sk-ant-key" },
      models: expect.any(Object),
    });
    // an already-configured endpoint is never overridden
    found = await Protocol.detect({ endpoints: { anthropic: { provider: "anthropic", url: "x" } } });
    expect(found.anthropic).toBeUndefined();
  });

  test("detection is network-free, reads workspace configuration, and returns static models", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";
    process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_team";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
    try {
      const found = await Protocol.detect({ endpoints: {} });
      expect(calls).toBe(0);
      expect(found.anthropic.auth.workspaceId).toBe("wrkspc_team");
      expect(found.anthropic.models).toBe(Protocol.knownEndpoints.find((e) => e.name === "anthropic").models);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("login shapes an API-key auth record", () => {
    expect(Protocol.login({ token: "sk-ant-api03-x", workspaceId: "wrkspc_team" }, { settings: {} })).toEqual({
      type: "api_key", token: "sk-ant-api03-x", workspaceId: "wrkspc_team",
    });
    expect(() => Protocol.login({ token: "sk-ant-api03-x", workspaceId: "default" })).toThrow(/wrkspc_/);
    expect(() => Protocol.login({ token: "sk-ant-oat01-test" })).toThrow(/claude provider/);
    expect(() => Protocol.login({}, { settings: {} })).toThrow(/API key/);
  });
});

describe("anthropic provider: context2msg (Messages dialect)", () => {
  test("system, merged tool results, signed thinking replay, tools, max_tokens from the model", () => {
    const connection = new Protocol(URL, aiio({
      tools: () => [{ name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    }));
    const context = [
      system("be terse"),
      system("and kind"),
      user("hi"),
      assistant([
        { type: "thinking", text: "plan", signature: "sig-1" },
        { type: "thinking", text: "unsigned — dropped" },
        { type: "thinking", text: "", data: "redacted-blob", redacted: true },
        { type: "text", text: "checking" },
        { type: "toolCall", callId: "toolu_1", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", callId: "toolu_2", name: "read", arguments: "{\"path\":\"b.txt\"}" },
      ]),
      toolResult("toolu_1", "A"),
      toolResult("toolu_2", "boom", { isError: true }),
    ];
    const [headers, body] = connection.context2msg(context);
    expect(headers).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-test",
    });
    expect(body.model).toBe("claude-opus-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64000); // the streaming default, under the preset's 128K cap
    expect(body.system).toBe("be terse\n\nand kind");
    expect(body.thinking).toBeUndefined(); // the model's default (no think setting)
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "plan", signature: "sig-1" },
        { type: "redacted_thinking", data: "redacted-blob" },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
        { type: "tool_use", id: "toolu_2", name: "read", input: { path: "b.txt" } },
      ] },
      // BOTH results in ONE user message (parallel tool use contract)
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "A" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true },
      ] },
    ]);
    expect(body.tools).toEqual([{
      name: "read", description: "read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    }]);
  });

  test("tool schema anyOf collapses to a merged required (Anthropic rejects anyOf)", () => {
    const connection = new Protocol(URL, aiio({
      tools: () => [{
        name: "edit",
        description: "edit a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: { type: "array" },
            rollback: { type: "string" },
          },
          anyOf: [
            { required: ["path", "edits"] },
            { required: ["path", "rollback"] },
          ],
        },
      }],
    }));
    const [, body] = connection.context2msg([user("x")]);
    expect(body.tools[0].input_schema).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        edits: { type: "array" },
        rollback: { type: "string" },
      },
      required: ["path"], // only the field common to every anyOf branch
    });
  });

  test("max_tokens follows a smaller known model cap; unknown models get the default", () => {
    // a known model's cap comes from the preset itself — never restated as a literal
    const presetEntry = Protocol.knownEndpoints.find((e) => e.url === "https://api.deepseek.com/anthropic").models["deepseek-chat"];
    const small = new Protocol("https://api.deepseek.com/anthropic", aiio({ modelCurrent: "deepseek-chat" }));
    expect(small.context2msg([user("x")])[1].max_tokens).toBe(presetEntry.maxTokens); // the preset's static cap
    const cached = new Protocol(URL, aiio({
      modelCurrent: "claude-x", settings: { auth: { token: "t" }, models: { "claude-x": { maxTokens: 4096 } } },
    }));
    expect(cached.context2msg([user("x")])[1].max_tokens).toBe(4096); // the cached catalog wins
    const unknown = new Protocol(URL, aiio({ modelCurrent: "mystery" }));
    expect(unknown.context2msg([user("x")])[1].max_tokens).toBe(64000);
  });

  test("environment bearer tokens ride authorization without subscription headers", () => {
    const connection = new Protocol(URL, aiio({ settings: { auth: { type: "bearer", token: "external" } } }));
    const [headers] = connection.context2msg([user("hi")]);
    expect(headers.authorization).toBe("Bearer external");
    expect(headers["anthropic-beta"]).toBeUndefined();
    expect(headers["x-app"]).toBeUndefined();
  });

  test("a configured real workspace ID scopes ordinary model choices", () => {
    const connection = new Protocol(URL, aiio({ settings: {
      auth: { token: "t", workspaceId: "wrkspc_team" },
    } }));
    const [headers, body] = connection.context2msg([user("hi")]);
    expect(headers["anthropic-workspace-id"]).toBe("wrkspc_team");
    expect(body.model).toBe("claude-opus-5");
  });

  test("an API key sends no client identity (the subscription attestation is OAuth-only)", () => {
    const connection = new Protocol(URL, aiio({ settings: { auth: { type: "api_key", token: "sk-ant-test" } } }));
    const [headers] = connection.context2msg([user("hi")]);
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers["x-app"]).toBeUndefined();
  });

  test("Anthropic sends the supplied system prompt unchanged", () => {
    const at = (auth, context) => new Protocol(URL, aiio({ settings: { auth } })).context2msg(context)[1].system;
    expect(at({ type: "bearer", token: "t" }, [system("be terse"), user("q")])).toBe("be terse");
    expect(at({ token: "t" }, [user("q")])).toBeUndefined();
  });

  test("native thinking modes: none disables, an effort adapts at that effort, undefined omits", () => {
    const at = (think) => new Protocol(URL, aiio())
      .context2msg([user("q")], aiio({ settings: { auth: { token: "t" }, think }, modelCurrent: "m" }))[1];
    expect(at(undefined).thinking).toBeUndefined();
    expect(at("none").thinking).toEqual({ type: "disabled" });
    expect(at("none").output_config).toBeUndefined();
    expect(at("xhigh")).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
  });

  test("user images/PDF/text-like binaries ride inline; empty text is never sent", () => {
    const connection = new Protocol(URL, aiio());
    const [, body] = connection.context2msg([
      { type: 2, content: [
        { type: "text", text: "what is this?" },
        { type: "image", mime: "image/png", content: "QUJD" },
        { type: "binary", mime: "application/pdf", content: "UERG" },
        { type: "binary", mime: "text/plain", filename: "notes.txt", content: "aGVsbG8=" },
      ] },
      assistant([{ type: "text", text: "" }]), // nothing sendable: the message is skipped
      user("more"),
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } },
        { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" }, title: "notes.txt" },
        { type: "text", text: "more" }, // the skipped turn leaves two user messages adjacent: MERGED
      ] },
    ]);
  });

  test("no anthropic-beta header for a plain document request (Files API is no longer used)", () => {
    const connection = new Protocol(URL, aiio());
    const [headers] = connection.context2msg([{ type: 2, content: [{ type: "binary", mimetype: "text/plain", content: "eA==" }] }]);
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  test("a binary format document blocks cannot carry (e.g. .docx/.zip) is refused with a clear error, no request sent", async () => {
    const connection = new Protocol(URL, aiio());
    expect(() => connection.context2msg([{ type: 2, content: [
      { type: "binary", mimetype: "application/zip", filename: "archive.zip", content: "WklQ" },
    ] }])).toThrow(/document blocks only accept PDF or plain-text/);
  });
});

describe("anthropic provider: msg2events (SSE event translation)", () => {
  test("a full stream: thinking with signature, text, tool_use json deltas, usage, done with the mirror", () => {
    const io = aiio();
    let contextUsed;
    io.contextUsageSet = (u) => { contextUsed = u; };
    const connection = new Protocol(URL, io);
    const state = {};
    const feed = (event) => connection.msg2events(event, state, io);
    const flat = (events) => events.map((e) => `${e.type}${e.text ?? (typeof e.arguments === "string" ? e.arguments : "")}`);

    expect(feed({ type: "message_start", message: {
      id: "msg_1", model: "claude-opus-5",
      usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 },
    } })).toEqual([]);
    expect(contextUsed).toEqual({ used: 125 }); // input + cache reads + creation
    expect(feed({ type: "ping" })).toEqual([]);

    expect(flat(feed({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })))
      .toEqual(["thinking_start"]);
    expect(flat(feed({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })))
      .toEqual(["thinking_deltahmm"]);
    expect(feed({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-A" } })).toEqual([]);
    expect(feed({ type: "content_block_stop", index: 0 })).toEqual([{ type: "thinking_end", contentIndex: 0 }]);

    expect(feed({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "blob" } })).toEqual([]);
    expect(feed({ type: "content_block_stop", index: 1 })).toEqual([]);

    expect(feed({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }))
      .toEqual([{ type: "text_start", contentIndex: 1 }]); // contentIndex is sequential over EMITTED blocks
    expect(feed({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Let me read" } }))
      .toEqual([{ type: "text_delta", contentIndex: 1, text: "Let me read" }]);
    expect(feed({ type: "content_block_stop", index: 2 })).toEqual([{ type: "text_end", contentIndex: 1 }]);

    expect(feed({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_9", name: "read", input: {} } }))
      .toEqual([{ type: "tool_call_start", contentIndex: 2, callId: "toolu_9", name: "read", arguments: "" }]);
    expect(feed({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"pa" } }))
      .toEqual([{ type: "tool_call_delta", contentIndex: 2, arguments: "{\"pa" }]);
    expect(feed({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "th\":\"a.txt\"}" } }))
      .toEqual([{ type: "tool_call_delta", contentIndex: 2, arguments: "th\":\"a.txt\"}" }]);
    expect(feed({ type: "content_block_stop", index: 3 }))
      .toEqual([{ type: "tool_call_end", contentIndex: 2, arguments: { path: "a.txt" } }]);

    expect(feed({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } })).toEqual([]);
    expect(feed({ type: "message_stop" })).toEqual([{
      type: "done",
      doneReason: "tool_use",
      // the MIRROR carries what the assembler cannot: signatures + redacted data
      message: { type: 3, content: [
        { type: "thinking", text: "hmm", signature: "sig-A" },
        { type: "thinking", text: "", data: "blob", redacted: true },
        { type: "text", text: "Let me read" },
        { type: "toolCall", callId: "toolu_9", name: "read", arguments: { path: "a.txt" } },
      ] },
      usage: { inputTokens: 125, outputTokens: 42 },
      native: { id: "msg_1", model: "claude-opus-5" },
    }]);
  });

  test("the mirrored message replays verbatim through context2msg (signature round trip)", () => {
    const connection = new Protocol(URL, aiio());
    const state = {};
    for (const event of [
      { type: "message_start", message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "t" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ]) connection.msg2events(event, state, aiio());
    const [done] = connection.msg2events({ type: "message_stop" }, state, aiio());
    const [, body] = connection.context2msg([user("q"), done.message, user("next")]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [
      { type: "thinking", thinking: "t", signature: "S" },
      { type: "text", text: "ok" },
    ] });
  });

  test("an error event surfaces as an error event", () => {
    const connection = new Protocol(URL, aiio());
    const native = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    expect(connection.msg2events(native, {}, aiio()))
      .toEqual([{ type: "error", error: "Overloaded", native }]);
  });
});

describe("anthropic provider: models(), testConnection(), reportPlanUsage()", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const stubFetch = (routes) => {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const route = Object.entries(routes).find(([path]) => String(url).includes(path));
      if (!route) throw new Error(`unexpected fetch ${url}`);
      const [status, body] = typeof route[1] === "function" ? route[1](init) : route[1];
      return new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Error" });
    };
    return calls;
  };

  // the static catalog side, called the way Env calls it
  const connection = ({ token, ...rest } = {}, url = URL) => {
    const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
    const options = { url, auth: settings.auth, settings };
    return { conn: { models: () => Protocol.models(options), testConnection: () => Protocol.testConnection(options) } };
  };
  const statics = (settings, url = URL) => ({ url, auth: settings.auth, settings });

  test("unscoped keys are classified in one request with an actionable error", async () => {
    const calls = stubFetch({
      "/v1/models": [400, { error: { message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace" } }],
    });
    const { conn } = connection({ token: "sk-ant-multi" });
    await expect(conn.testConnection()).rejects.toThrow(/set ANTHROPIC_WORKSPACE_ID.*wrkspc_/);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers["anthropic-workspace-id"]).toBeUndefined();
  });

  test("identity-linked wording is unscoped; configured workspace is sent on models and messages", async () => {
    let calls = stubFetch({
      "/v1/models": [400, { error: { message: "anthropic-workspace-id is required when authenticating with an identity-linked API key" } }],
    });
    const { conn } = connection({ token: "sk-ant-identity" });
    await expect(conn.testConnection()).rejects.toThrow(/works across workspaces/);
    expect(calls).toHaveLength(1);

    calls = stubFetch({ "/v1/models": [200, { data: [{ id: "claude-opus-5" }] }] });
    const settings = { auth: { token: "sk-ant-multi", workspaceId: "wrkspc_x" } };
    expect(await Protocol.testConnection(statics(settings))).toEqual({ models: 1 });
    expect(calls[0].init.headers["anthropic-workspace-id"]).toBe("wrkspc_x");
    const configured = new Protocol(URL, aiio({ modelCurrent: "claude-opus-5", settings }));
    expect(configured.context2msg([user("hi")])[0]["anthropic-workspace-id"]).toBe("wrkspc_x");
  });

  test("invalid workspace and auth failures stop after one request", async () => {
    let calls = stubFetch({
      "/v1/models": [400, { error: { message: "anthropic-workspace-id header must be a valid workspace ID" } }],
    });
    await expect(Protocol.testConnection(statics({ auth: { token: "sk-ant", workspaceId: "wrkspc_bad" } })))
      .rejects.toThrow(/not a valid workspace for this key/);
    expect(calls).toHaveLength(1);
    calls = stubFetch({ "/v1/models": [401, { error: { message: "invalid x-api-key" } }] });
    const { conn } = connection({ token: "bad" });
    await expect(conn.testConnection()).rejects.toThrow(/HTTP 401/);
    expect(calls).toHaveLength(1);
  });

  test("the live Anthropic-shaped list merges with the registry; the call authenticates with x-api-key", async () => {
    const calls = stubFetch({
      "models.dev": [200, { anthropic: { models: {
        "claude-opus-5": { name: "Claude Opus 5 (registry)", reasoning: true, limit: { context: 1000000, output: 128000 } },
        "claude-next": { name: "Claude Next", reasoning: true, limit: { context: 2000000, output: 256000 } },
      } } }],
      "/v1/models": [200, { data: [
        { id: "claude-opus-5", display_name: "Claude Opus 5", max_input_tokens: 1000000, max_tokens: 128000,
          capabilities: { thinking: { types: { adaptive: { supported: true } } } } },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_input_tokens: 200000, max_tokens: 64000,
          capabilities: { thinking: { types: { adaptive: { supported: false }, enabled: { supported: true } } } } },
        { id: "claude-plain", display_name: "Plain", capabilities: { thinking: { types: { adaptive: { supported: false } } } } },
      ] }],
    });
    const { conn } = connection({ token: "sk-ant-k" });
    const map = await conn.models();
    const listCall = calls.find((c) => c.url.includes("/v1/models"));
    expect(listCall.url).toBe(`${URL}/models?limit=1000`);
    expect(listCall.init.headers["x-api-key"]).toBe("sk-ant-k");
    expect(listCall.init.headers["anthropic-version"]).toBe("2023-06-01");
    // the live list is authoritative for ids; its label wins over the registry's
    expect(Object.keys(map)).toEqual(["claude-opus-5", "claude-haiku-4-5", "claude-plain"]);
    expect(map["claude-opus-5"]).toEqual({ label: "Claude Opus 5", contextWindow: 1000000, maxTokens: 128000 });
    expect(map["claude-haiku-4-5"].thinking).toBeUndefined(); // a supported thinking type of any kind: every mode
    expect(map["claude-plain"]).toEqual({ label: "Plain", thinking: [] });
    expect(calls.filter((call) => call.url.includes("models.dev"))).toHaveLength(0); // a live list needs no registry
  });

  test("a live list never fetches the registry or includes its obsolete ids", async () => {
    const calls = stubFetch({
      "models.dev": () => { throw new Error("registry must not be queried"); },
      "/v1/models": [200, { data: [{ id: "claude-new", display_name: "Claude New" }] }],
    });
    const { conn } = connection({ registry: { fetchedAt: Date.now(), models: { "claude-old": { label: "Old" } } } });
    expect(Object.keys(await conn.models())).toEqual(["claude-new"]);
    expect(calls.filter((call) => call.url.includes("models.dev"))).toHaveLength(0);
  });

  test("malformed live list falls back to the static + cached catalog instead of wiping models", async () => {
    stubFetch({ "/v1/models": [200, { invalid: true }] });
    const { conn } = connection({ models: { "claude-next": { label: "Next" } } });
    const map = await conn.models();
    expect(map["claude-next"]).toMatchObject({ label: "Next" });
    expect(map["claude-opus-5"]).toBeDefined();
  });

  test("offline: static preset + cached map merge, with no blocking registry download", async () => {
    const calls = stubFetch({
      "models.dev": () => { throw new Error("registry must not be queried"); },
      "/v1/models": () => { throw new Error("offline"); },
    });
    const { conn } = connection({
      token: "t",
      models: { "claude-old": { label: "Old", thinking: [], contextWindow: 100000 } },
    });
    const map = await conn.models();
    // every static-preset model merges through (the catalog itself is content)
    for (const [id, entry] of Object.entries(Protocol.knownEndpoints.find((e) => e.name === "anthropic").models)) {
      expect(map[id]?.contextWindow, id).toBe(entry.contextWindow);
    }
    expect(map["claude-old"]).toEqual({ label: "Old", thinking: [], contextWindow: 100000 }); // cached
    expect(calls.filter((call) => call.url.includes("models.dev"))).toHaveLength(0);
    const { conn: bare } = connection({ token: "t" });
    expect(Object.keys(await bare.models())).toEqual(Object.keys(Protocol.knownEndpoints[0].models));
  });

  test("message-verified presets never list: static catalog only, no /models fetch", async () => {
    const calls = stubFetch({ "/models": [200, { data: [{ id: "nope" }] }] });
    const { conn } = connection({ token: "t" }, "https://api.deepseek.com/anthropic");
    const map = await conn.models();
    expect(calls).toHaveLength(0);
    expect(Object.keys(map)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(map["deepseek-reasoner"].thinking).toBeUndefined(); // every mode
    expect(map["deepseek-chat"].thinking).toEqual([]); // no thinking control
  });

  test("testConnection: GET /models on Anthropic — a 401 THROWS with its status", async () => {
    stubFetch({ "/v1/models": [200, { data: [{ id: "a" }, { id: "b" }] }] });
    const { conn } = connection({ token: "sk-ant-k" });
    expect(await conn.testConnection()).toEqual({ models: 2 });
    stubFetch({ "/v1/models": [401, { error: { type: "authentication_error", message: "invalid x-api-key" } }] });
    const failed = await conn.testConnection().catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed.status).toBe(401);
    expect(failed.message).toMatch(/HTTP 401/);
    expect(failed.message).toMatch(/invalid x-api-key/);
  });

  test("testConnection: a message-verified preset POSTs one token to its first model (settings.verify persisted)", async () => {
    let posted;
    const calls = stubFetch({ "/anthropic/messages": (init) => { posted = JSON.parse(init.body); return [200, { id: "msg" }]; } });
    // the endpoint's own settings carry `verify` (loginEndpoint persists the preset extra)
    const { conn } = connection({ token: "ds-key", verify: "messages", models: { "deepseek-chat": { label: "x" } } },
      "https://api.deepseek.com/anthropic");
    expect(await conn.testConnection()).toEqual({ models: 2 }); // preset (2) ∪ cached (1)
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-api-key"]).toBe("ds-key");
    expect(posted).toEqual({ model: "deepseek-chat", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    stubFetch({ "/anthropic/messages": [403, { error: { message: "forbidden" } }] });
    const failed = await conn.testConnection().catch((e) => e);
    expect(failed.status).toBe(403);
  });

  test("reportPlanUsage: the anthropic-ratelimit-* families land in the plan-usage channel", () => {
    let reported;
    const io = aiio({ planUsageSet: (u) => { reported = u; } });
    const conn = new Protocol(URL, io);
    conn.reportPlanUsage(new Headers({
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "49",
      "anthropic-ratelimit-requests-reset": "2026-09-07T10:00:00Z",
      "anthropic-ratelimit-tokens-limit": "48000",
      "anthropic-ratelimit-tokens-remaining": "47000",
      "anthropic-ratelimit-input-tokens-limit": "40000",
      "anthropic-ratelimit-input-tokens-remaining": "39000",
      "anthropic-ratelimit-output-tokens-limit": "8000",
    }), io);
    expect(reported).toEqual({ quotas: {
      requests: { total: 50, remaining: 49, reset: "2026-09-07T10:00:00Z" },
      tokens: { total: 48000, remaining: 47000 },
    } });
    reported = undefined;
    conn.reportPlanUsage(new Headers({ "content-type": "text/event-stream" }), io);
    expect(reported).toBeUndefined(); // nothing published: nothing reported
  });

  test("reportPlanUsage: subscription (OAuth) anthropic-ratelimit-unified-<window>-utilization lands as a {total:100, used, remaining, windowSeconds} quota per window", () => {
    let reported;
    const io = aiio({ planUsageSet: (u) => { reported = u; } });
    const conn = new Protocol(URL, io);
    // The unified-*-reset headers are UNPUBLISHED: observed captures are
    // bare Unix epoch SECONDS (e.g. 1774933200), some deployments epoch
    // ms — unlike the documented anthropic-ratelimit-*-reset family
    // (RFC 3339, see the families test above). The provider passes the
    // raw value through; the shared format layer (resetAtMs) normalizes
    // the unit for display.
    conn.reportPlanUsage(new Headers({
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.018416969696969696",
      "anthropic-ratelimit-unified-5h-reset": "1789755600",
      "anthropic-ratelimit-unified-7d-utilization": "0.4231",
      "anthropic-ratelimit-unified-7d-reset": "1790294400000",
    }), io);
    expect(reported).toEqual({ quotas: {
      "5h": { total: 100, used: 2, remaining: 98, reset: "1789755600", windowSeconds: 18000 },
      "7d": { total: 100, used: 42, remaining: 58, reset: "1790294400000", windowSeconds: 604800 },
    } });
    // ...and both epoch shapes normalize to their moment through the
    // shared format layer (resetAtMs) — a countdown, never a verbatim number.
    expect(resetAtMs(reported.quotas["5h"].reset)).toBe(1789755600000); // epoch s -> ms
    expect(resetAtMs(reported.quotas["7d"].reset)).toBe(1790294400000); // epoch ms pass-through
    expect(resetAtMs(reported.quotas["7d"].reset)).toBe(resetAtMs(new Date(1790294400000).toISOString()));
  });

  test("reportPlanUsage: an OAuth response's unified windows and a request's own ratelimit-* families combine into one report", () => {
    let reported;
    const io = aiio({ planUsageSet: (u) => { reported = u; } });
    const conn = new Protocol(URL, io);
    conn.reportPlanUsage(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "49",
    }), io);
    expect(reported).toEqual({ quotas: {
      "5h": { total: 100, used: 50, remaining: 50, windowSeconds: 18000 },
      requests: { total: 50, remaining: 49 },
    } });
  });

  test("reportPlanUsage: non-duration unified metadata such as overage is excluded from the two plan windows", () => {
    let reported;
    const io = aiio({ planUsageSet: (u) => { reported = u; } });
    const conn = new Protocol(URL, io);
    conn.reportPlanUsage(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.39",
      "anthropic-ratelimit-unified-overage-utilization": "0.0",
    }), io);
    expect(reported).toEqual({ quotas: {
      "5h": { total: 100, used: 39, remaining: 61, windowSeconds: 18000 },
    } });
  });
});
