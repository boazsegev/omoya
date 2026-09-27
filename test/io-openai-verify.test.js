// test/io-openai-verify.test.js — proof for the codex login chain:
// the OpenAI catalog defaults' testConnection honors the endpoint's
// `verify: "jwt"` mode (the codex backend has no GET /models — the
// freshly issued OAuth JWT IS the verification), the default probe
// throws a status-carrying error (never a ReferenceError), the
// chatgpt-account-id header rides codex requests, and loginEndpoint
// persists a known preset's verify/models extras.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Env } from "../lib/env.js";
import { loginEndpoint } from "../lib/cli.js";
import { context2msg, msg2events, send, reportPlanUsage } from "../lib/io/openai.js";
import { testConnection, models as openaiModels } from "../lib/env/openai-models.js";
import { thinkingNative } from "../lib/io/thinking.js";
import OpenAIProvider from "../providers/openai.js";
import { endpointOf, modelsOf, providerAdd, settingsOf } from "./env-internals.js";

const DIRS = [];
afterEach(() => { while (DIRS.length) rmSync(DIRS.pop(), { recursive: true, force: true }); });

/** An unsigned JWT with the given claims (verification is shape+expiry). */
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
const ACCOUNT = "acct-123";
const freshJwt = () => jwt({ exp: Date.now() / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });

describe("GitHub Copilot OAuth preset", () => {
  test("uses the client id's device flow instead of an unregistered localhost redirect", () => {
    const preset = OpenAIProvider.knownEndpoints.find(({ name }) => name === "github-copilot-oauth");
    expect(preset?.oauth).toMatchObject({
      clientId: "01ab8ac9400c4e429b23",
      deviceAuthorizationUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
    });
    expect(preset?.oauth?.redirectUri).toBeUndefined();
  });
});

/** A duck-typed connection carrying the given endpoint settings
 *  ({token, ...} flat — wrapped under settings.auth as the real
 *  schema requires). */
function conn({ token, ...rest } = {}) {
  const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
  return { baseUrl: "https://chatgpt.com/backend-api/codex", aiio: { settings } };
}
/** The static catalog arguments Env passes for a duck-typed connection. */
const statics = (c) => ({ url: c.baseUrl, auth: c.aiio.settings.auth, settings: c.aiio.settings });
/** The catalog default called the way Env calls it (`this` = the provider class). */
const catalog = (c) => openaiModels.call(c.constructor, statics(c));

describe("OpenAI Responses reasoning", () => {
  test("requests a streamed reasoning summary at the native effort IO mapped", () => {
    const [, body] = context2msg.call(conn({}), [{ type: 2, content: [{ type: "text", text: "hi" }] }], {
      settings: { think: "high" }, tools: () => [], modelCurrent: "gpt-5.5",
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  const reasoningOf = (settings, model = "gpt-x") => context2msg.call(conn({}), [{ type: 2, content: [{ type: "text", text: "hi" }] }], {
    settings, tools: () => [], modelCurrent: model,
  })[1].reasoning;

  test("no effort leaves the model default (the summary is still requested)", () => {
    expect(reasoningOf({})).toEqual({ summary: "auto" });
  });

  test("IO's default: the model's declared default wins over the provider's high", () => {
    const modes = ["none", "minimal", "low", "medium", "high", "xhigh"];
    expect(thinkingNative(undefined, modes, "high")).toBe("high");
    expect(thinkingNative("default", modes, "high")).toBe("high");
    expect(thinkingNative(undefined, ["none", "low"], "high")).toBe("low"); // mapped onto the model's modes
    expect(thinkingNative(undefined, modes)).toBeUndefined(); // nothing declared: the endpoint's own default
  });

  test("IO maps levels to the nearest native mode at or below", () => {
    expect(thinkingNative(false, ["none", "low", "medium"])).toBe("none");
    expect(thinkingNative(false, ["low", "medium", "high", "xhigh", "max"])).toBe("low");
    expect(thinkingNative("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(thinkingNative("xhigh", ["low", "medium", "high", "max"])).toBe("high");
    expect(thinkingNative("xhigh", ["none", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(thinkingNative("low", ["none", "high"])).toBe("high"); // nothing at or below: the weakest effort
  });

  test("models without thinking omit reasoning; summary-less models omit only the summary", () => {
    expect(reasoningOf({ models: { "gpt-x": { thinking: [] } } })).toBeUndefined();
    expect(reasoningOf({ think: "high", models: { "gpt-x": { reasoningSummary: false } } })).toEqual({ effort: "high" });
  });

  test("maps the documented reasoning-summary lifecycle to one thinking block", () => {
    const state = {};
    expect(msg2events({ type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 4, content_index: 0 }, state))
      .toEqual([{ type: "thinking_start", contentIndex: 0 }]);
    expect(msg2events({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 4, content_index: 0, delta: "first second" }, state))
      .toEqual([{ type: "thinking_delta", contentIndex: 0, text: "first second" }]);
    expect(msg2events({ type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 4, content_index: 0 }, state))
      .toEqual([{ type: "thinking_end", contentIndex: 0 }]);
  });

  test("passes the final text to the normalized text end event", () => {
    const events = msg2events({
      type: "response.output_text.done", output_index: 0, text: "final answer",
    }, {}, { contextUsageSet() {} });
    expect(events).toEqual([{ type: "text_end", contentIndex: 0, text: "final answer" }]);
  });
});

describe("send: a reasoning rejection self-corrects once", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const rejection = (param, code, message) =>
    new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param, code } }), { status: 400 });
  function connection(models) {
    const saved = [];
    return { saved, url: "https://api.openai.com/v1/responses", aiio: { settings: { models }, authSet: (data) => saved.push(data) } };
  }

  test("an unsupported effort resends the nearest listed value and caches the model's levels", async () => {
    const efforts = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      efforts.push(body.reasoning.effort);
      if (body.reasoning.effort === "max") {
        return rejection("reasoning.effort", "unsupported_value",
          "Unsupported value: 'max' is not supported with the 'gpt-x' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.");
      }
      return new Response("data: {}\n\n");
    };
    const conn = connection({ "gpt-x": { label: "X" } });
    await send.call(conn, [{}, { model: "gpt-x", reasoning: { effort: "max", summary: "auto" } }]);
    expect(efforts).toEqual(["max", "xhigh"]);
    expect(conn.response.ok).toBe(true);
    expect(conn.saved.at(-1).models["gpt-x"]).toEqual({ label: "X", thinking: ["none", "low", "medium", "high", "xhigh"] });
  });

  test("a rejected summary or reasoning parameter is dropped and remembered", async () => {
    const bodies = [];
    const serve = (reject) => async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return reject(body) ?? new Response("data: {}\n\n");
    };
    globalThis.fetch = serve((body) => body.reasoning?.summary &&
      rejection("reasoning.summary", "unsupported_parameter", "Unsupported parameter: 'reasoning.summary'."));
    const summaryConn = connection({ "gpt-x": {} });
    await send.call(summaryConn, [{}, { model: "gpt-x", reasoning: { effort: "medium", summary: "auto" } }]);
    expect(bodies.at(-1).reasoning).toEqual({ effort: "medium" });
    expect(summaryConn.saved.at(-1).models["gpt-x"]).toEqual({ reasoningSummary: false });

    globalThis.fetch = serve((body) => body.reasoning &&
      rejection("reasoning.effort", "unsupported_parameter", "Unsupported parameter: 'reasoning.effort' is not supported with this model."));
    const plainConn = connection({ "gpt-x": {} });
    await send.call(plainConn, [{}, { model: "gpt-x", reasoning: { effort: "medium" } }]);
    expect(bodies.at(-1).reasoning).toBeUndefined();
    expect(plainConn.saved.at(-1).models["gpt-x"]).toEqual({ thinking: [] });
  });

  test("other rejections (and a second rejection) throw untouched", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return rejection("reasoning.effort", "invalid_value", "Invalid value: 'bogus'. Supported values are: 'none', 'low'.");
    };
    await expect(send.call(connection({}), [{}, { model: "gpt-x", reasoning: { effort: "bogus" } }])).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});

describe("reportPlanUsage: the Codex backend has no rate-limit response headers — it fetches its own separate usage endpoint", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** A codex connection/aiio pair; setPlanUsage reports collect on aiio.reports. */
  function codexConn(token = "sk-codex-token") {
    const aiio = {
      settings: { auth: { token } },
      reports: [],
      planUsageSet(report) { this.reports.push(report); },
    };
    return { conn: { baseUrl: "https://chatgpt.com/backend-api/codex", aiio }, aiio };
  }

  test("fetches GET .../wham/usage with the bearer token; the window's quota key comes from limit_window_seconds, not an assumed 5h/7d", async () => {
    let requested;
    globalThis.fetch = async (url, init) => {
      requested = { url: String(url), authorization: init.headers.authorization };
      return new Response(JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: "2026-09-19T23:00:00Z" },
          secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: "2026-09-26T00:00:00Z" },
        },
      }), { status: 200 });
    };
    const { conn, aiio } = codexConn();
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(requested).toEqual({ url: "https://chatgpt.com/backend-api/wham/usage", authorization: "Bearer sk-codex-token" });
    expect(aiio.reports).toEqual([{
      label: "pro",
      quotas: {
        "5h": { total: 100, used: 12, remaining: 88, reset: "2026-09-19T23:00:00Z", windowSeconds: 18000 },
        "7d": { total: 100, used: 55, remaining: 45, reset: "2026-09-26T00:00:00Z", windowSeconds: 604800 },
      },
    }]);
  });

  test("a plan with different window lengths (3h / 30d) labels its quotas accordingly — nothing about 5h/7d is hardcoded", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 10800 }, // 3h
        secondary_window: { used_percent: 5, limit_window_seconds: 2592000 }, // 30d
      },
    }), { status: 200 });
    const { conn, aiio } = codexConn();
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(aiio.reports).toEqual([{
      quotas: {
        "3h": { total: 100, used: 40, remaining: 60, windowSeconds: 10800 },
        "30d": { total: 100, used: 5, remaining: 95, windowSeconds: 2592000 },
      },
    }]);
  });

  test("a window with no limit_window_seconds falls back to the neutral primary/secondary label — never a guessed duration", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 20 }, secondary_window: { used_percent: 30 } },
    }), { status: 200 });
    const { conn, aiio } = codexConn();
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(aiio.reports).toEqual([{
      quotas: {
        primary: { total: 100, used: 20, remaining: 80 },
        secondary: { total: 100, used: 30, remaining: 70 },
      },
    }]);
  });

  test("caches per aiio (CODEX_USAGE_TTL) — a second call right after does not re-fetch", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } } }), { status: 200 });
    };
    const { conn, aiio } = codexConn();
    await reportPlanUsage.call(conn, new Headers(), aiio);
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(fetches).toBe(1);
    expect(aiio.reports.length).toBe(1);
  });

  test("no token — no fetch, nothing reported", async () => {
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response("{}", { status: 200 }); };
    const { conn, aiio } = codexConn(null); // null, not undefined — a default param would mask the latter
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(fetches).toBe(0);
    expect(aiio.reports).toEqual([]);
  });

  test("a failed fetch (network error) never throws and never reports", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const { conn, aiio } = codexConn();
    await expect(reportPlanUsage.call(conn, new Headers(), aiio)).resolves.toBeUndefined();
    expect(aiio.reports).toEqual([]);
  });

  test("a non-2xx response never throws and never reports", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    const { conn, aiio } = codexConn();
    await reportPlanUsage.call(conn, new Headers(), aiio);
    expect(aiio.reports).toEqual([]);
  });
});

describe("testConnection: verify jwt mode (codex — no GET /models exists)", () => {
  test("a fresh OAuth JWT verifies locally, counting the static models", async () => {
    const report = await testConnection(statics(conn({
      verify: "jwt", token: freshJwt(), models: { "gpt-5.5": {}, "gpt-5-codex": {} },
    })));
    expect(report).toEqual({ models: 2 });
  });

  test("an opaque API key can never verify as JWT — the error says to sign in with the browser", async () => {
    await expect(testConnection(statics(conn({ verify: "jwt", token: "sk-opaque" }))))
      .rejects.toThrow(/not a JWT — sign in with the browser/);
  });

  test("an expired JWT fails verification", async () => {
    const expired = jwt({ exp: Date.now() / 1000 - 10 });
    await expect(testConnection(statics(conn({ verify: "jwt", token: expired }))))
      .rejects.toThrow(/expired — sign in again/);
  });
});

describe("testConnection: the default probe (the status-error regression)", () => {
  test("a non-2xx response throws an error carrying the status", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const c = { baseUrl: `http://127.0.0.1:${port}`, aiio: { settings: { auth: { token: "sk-x" } } } };
      await expect(testConnection(statics(c))).rejects.toThrow(/HTTP 401/);
      await expect(testConnection(statics(c))).rejects.toMatchObject({ status: 401 });
    } finally {
      server.close();
    }
  });
});

describe("the chatgpt-account-id header", () => {
  test("a codex JWT adds the account-id header; opaque tokens add nothing", () => {
    const msg = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    const token = freshJwt(); // ONE token — a second freshJwt() can land in a later millisecond
    const [codexHeaders] = context2msg.call(conn({}), msg, { settings: { auth: { token } }, tools: () => [] });
    expect(codexHeaders["chatgpt-account-id"]).toBe(ACCOUNT);
    expect(codexHeaders.authorization).toBe(`Bearer ${token}`);
    const [plainHeaders] = context2msg.call(conn({}), msg, { settings: { auth: { token: "sk-opaque" } }, tools: () => [] });
    expect("chatgpt-account-id" in plainHeaders).toBe(false);
    const [noToken] = context2msg.call(conn({}), msg, { settings: {}, tools: () => [] });
    expect("chatgpt-account-id" in noToken).toBe(false);
  });
});

describe("the codex backend request shape", () => {
  const msg = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
  const io = { settings: { auth: { token: freshJwt() } }, tools: () => [], modelCurrent: "gpt-5.5" };
  test("codex demands store: false, present instructions, and the experimental beta header", () => {
    const [headers, body] = context2msg.call(conn({ verify: "jwt" }), msg, io);
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("");
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
  });
  test("the codex URL alone (no preset extras) also triggers the codex shape", () => {
    const [, body] = context2msg.call(conn({}), msg, io);
    expect(body.store).toBe(false);
  });
  test("a plain OpenAI endpoint keeps the API defaults (no store, no forced instructions)", () => {
    const c = { baseUrl: "https://api.openai.com/v1", aiio: { settings: {} } };
    const [headers, body] = context2msg.call(c, msg, io);
    expect("store" in body).toBe(false);
    expect("instructions" in body).toBe(false);
    expect("OpenAI-Beta" in headers).toBe(false);
  });
});

describe("codexModels: catalog is the single discovery path (no registry, no probes)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  class CodexPreset {
    static knownEndpoints = [{
      name: "openai-codex", url: "https://chatgpt.com/backend-api/codex", verify: "jwt",
      models: { "gpt-static": { label: "GPT Static" } },
    }];
  }
  function codexConn({ token, ...rest } = {}) {
    const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
    const conn = new CodexPreset();
    conn.baseUrl = "https://chatgpt.com/backend-api/codex";
    conn.aiio = { settings };
    return conn;
  }

  test("a successful catalog is the listing; hidden models become secret", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models?client_version=")) return new Response(JSON.stringify({ models: [
        { slug: "gpt-6-luna", display_name: "GPT-6 Luna", context_window: 272000, max_context_window: 872000,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "medium" },
        { slug: "gpt-hidden", visibility: "hide" },
      ] }));
      throw new Error(`unexpected fetch: ${url}`);
    };
    const map = await catalog(codexConn({ token: freshJwt(), models: { "gpt-old": { label: "Old" } } }));
    expect(Object.keys(map).sort()).toEqual(["gpt-6-luna", "gpt-hidden"]);
    expect(map["gpt-6-luna"]).toMatchObject({ label: "GPT-6 Luna", contextWindow: 872000, maxContextWindow: 872000, thinking: ["low", "high"], thinkingDefault: "medium" });
    expect(map["gpt-hidden"]).toMatchObject({ secret: true });
  });

  test("visibility hide translates to secret; visibility list does not", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ models: [
      { slug: "gpt-hidden", visibility: "hide" },
      { slug: "gpt-shown", visibility: "list" },
    ] }));
    const map = await catalog(codexConn({ token: freshJwt() }));
    expect(map["gpt-hidden"].secret).toBe(true);
    expect(map["gpt-shown"].secret).toBeUndefined();
  });

  test("supported_in_api false and supports_search_tool false are retained", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ models: [
      { slug: "gpt-limited", supported_in_api: false, supports_search_tool: false, input_modalities: ["text", "image"] },
    ] }));
    const map = await catalog(codexConn({ token: freshJwt() }));
    expect(map["gpt-limited"]).toMatchObject({ supportedInApi: false, webSearch: false, input: ["text", "image"] });
  });

  test("a Codex catalog's larger max_context_window replaces a stale cached window", async () => {
    globalThis.fetch = async () => Response.json({ models: [
      { slug: "gpt-6-sol", context_window: 262144, max_context_window: 1050000 },
    ] });
    const map = await catalog(codexConn({ token: freshJwt(), models: { "gpt-6-sol": { contextWindow: 262144 } } }));
    expect(map["gpt-6-sol"].contextWindow).toBe(1050000);
    expect(map["gpt-6-sol"].maxContextWindow).toBe(1050000);
  });

  test("a failed catalog throws (Env keeps the cached listing)", async () => {
    globalThis.fetch = async () => { throw new Error("offline"); };
    await expect(catalog(codexConn({ token: freshJwt(), models: { "gpt-6-luna": { label: "Luna" } } }))).rejects.toBeDefined();
  });

  test("an empty catalog throws (Env keeps the cached listing)", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }));
    await expect(catalog(codexConn({ token: freshJwt(), models: { "gpt-6-luna": { label: "Luna" } } }))).rejects.toThrow(/empty Codex model catalog/);
  });

  test("a malformed catalog throws (Env keeps the cached listing)", async () => {
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    await expect(catalog(codexConn({ token: freshJwt(), models: { "gpt-6-luna": { label: "Luna" } } }))).rejects.toBeDefined();
  });

  test("a non-2xx catalog throws (Env keeps the cached listing)", async () => {
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    await expect(catalog(codexConn({ token: freshJwt(), models: { "gpt-6-luna": { label: "Luna" } } }))).rejects.toBeDefined();
  });

  test("catalog request uses codex CLI version when available, 99.99.99 otherwise", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }));
    };
    await catalog(codexConn({ token: freshJwt() }));
    // codex CLI is installed in this environment — extract its semantic
    // version whether the output is bare or prefixed (for example codex-cli).
    const installedVersion = /\d+\.\d+\.\d+/.exec(Bun.spawnSync(["codex", "--version"]).stdout.toString())?.[0];
    expect(installedVersion).toBeTruthy();
    expect(urls[0]).toContain(`client_version=${installedVersion}`);
  });

  test("catalog request falls back to 99.99.99 when codex CLI is absent", async () => {
    // Temporarily hide the codex binary by clearing PATH
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }));
    };
    try {
      // Clear the version cache so it re-detects
      const mod = await import("../lib/env/openai-models.js");
      // The module-level cache is private; we need a fresh import to reset it
      const freshModule = await import(`../lib/env/openai-models.js?t=${Date.now()}`);
      const { models: freshModels } = freshModule;
      const fresh = codexConn({ token: freshJwt() });
      await freshModels.call(fresh.constructor, statics(fresh));
      expect(urls[0]).toContain("client_version=99.99.99");
    } finally {
      process.env.PATH = saved;
    }
  });

  test("no per-model probes are issued after the catalog answers", async () => {
    let postCount = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") postCount++;
      if (String(url).includes("/models?client_version=")) return new Response(JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }));
      return new Response("unexpected", { status: 500 });
    };
    await catalog(codexConn({ token: freshJwt() }));
    expect(postCount).toBe(0);
  });
});
describe("models(): the /models listing captures every metadata field the endpoint publishes (dynamic data only, no registry)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  // A duck-typed NON-codex connection: the listing path, not codexModels.
  const plainConn = (settings = {}) => ({ baseUrl: "https://api.openai.com/v1", aiio: { settings } });

  test("context_window and the other published fields land in the model map (the status bar's context gauge reads contextWindow from here)", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: "gpt-6-luna", context_window: 1050000, max_output_tokens: 128000, max_context_window: 1050000,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "medium",
        visibility: "list", input_modalities: ["text", "image"] },
      { id: "gpt-6-draft", visibility: "hide" },
    ] }));
    const map = await catalog(plainConn({}));
    expect(map["gpt-6-luna"]).toMatchObject({
      label: "gpt-6-luna",
      contextWindow: 1050000, maxContextWindow: 1050000, maxTokens: 128000,
      thinking: ["low", "high"], thinkingDefault: "medium",
      input: ["text", "image"],
    });
    expect(map["gpt-6-draft"]).toMatchObject({ secret: true });
  });

  test("a bare id-only listing still maps cleanly (older endpoints publish nothing extra)", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-old" }] }));
    const map = await catalog(plainConn());
    expect(map["gpt-old"]).toEqual({ label: "gpt-old", input: ["text"] });
  });
});

describe("loginEndpoint: preset extras persist", () => {
  test("a known preset's verify + models land in the endpoint config", async () => {
    const dir = mkdtempSync("./ai-tmp/verify-login-");
    DIRS.push(dir);
    const env = new Env({ dir, cwd: dir, settings: {} });
    class Codexish {
      static provider = { label: "C" };
      static knownEndpoints = [{
        name: "cloud-codex", label: "Cloud Codex", url: "https://codex.test/backend-api/codex",
        verify: "jwt",
        models: { "gpt-9": { label: "gpt-9" } },
      }];
      static login({ token }) { return { type: "oauth", token, access: token }; }
      static async testConnection() { return { models: 1 }; }
      static async models() { return {}; } // the backend has no GET /models
    }
    providerAdd(env, "codexish", Codexish);
    const login = await loginEndpoint(env, {
      name: "cloud-codex", provider: "codexish", url: "https://codex.test/backend-api/codex", token: "t-1",
    });
    expect(login.verified).toEqual({ models: 1 });
    const settings = settingsOf(env, "cloud-codex");
    expect(settings.verify).toBe("jwt");
    expect(settings.models).toEqual({ "gpt-9": { label: "gpt-9" } });
    // and the model surface serves the static list without a fetch
    expect(await modelsOf(env, "cloud-codex")).toEqual({ "gpt-9": { label: "gpt-9" } });
  });

  test("a registry-backed preset persists verify but NOT the static models (they would linger as stale config)", async () => {
    const dir = mkdtempSync("./ai-tmp/verify-login-");
    DIRS.push(dir);
    const env = new Env({ dir, cwd: dir, settings: {} });
    class RegistryCodex {
      static provider = { label: "R" };
      static knownEndpoints = [{
        name: "reg-codex", label: "Reg Codex", url: "https://codex.test/backend-api/codex",
        verify: "jwt",
        registry: { url: "https://models.dev/api.json", provider: "openai" },
        models: { "gpt-9": { label: "gpt-9" } },
      }];
      static login({ token }) { return { type: "oauth", token, access: token }; }
      static async testConnection() { return { models: 1 }; }
      static async models() { return {}; }
    }
    providerAdd(env, "regcodex", RegistryCodex);
    await loginEndpoint(env, {
      name: "reg-codex", provider: "regcodex", url: "https://codex.test/backend-api/codex", token: "t-1",
    });
    const config = endpointOf(env, "reg-codex");
    expect(config.verify).toBe("jwt");
    expect("models" in config).toBe(false);
  });
});
