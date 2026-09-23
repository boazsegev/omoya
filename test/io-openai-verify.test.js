// test/io-openai-verify.test.js — proof for the codex login chain:
// the OpenAI defaults' testConnection honors the endpoint's
// `verify: "jwt"` mode (the codex backend has no GET /models — the
// freshly issued OAuth JWT IS the verification), the default probe
// throws a REAL HttpStatusError (never a ReferenceError), the
// chatgpt-account-id header rides codex requests, and loginEndpoint
// persists a known preset's verify/models extras.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Env } from "../lib/env.js";
import { loginEndpoint } from "../lib/cli.js";
import { context2msg, msg2events, send, testConnection, models as openaiModels, reportPlanUsage } from "../lib/env/openai.js";
import OpenAIProvider from "../providers/openai.js";

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

describe("OpenAI Responses reasoning", () => {
  test("requests a streamed reasoning summary at the selected effort", () => {
    const [, body] = context2msg.call(conn({}), [{ type: 2, content: [{ type: "text", text: "hi" }] }], {
      settings: { think: "high" }, tools: () => [], currentModel: "gpt-5.5",
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  const reasoningOf = (settings, model = "gpt-x") => context2msg.call(conn({}), [{ type: 2, content: [{ type: "text", text: "hi" }] }], {
    settings, tools: () => [], currentModel: model,
  })[1].reasoning;

  test("implicit and explicit default use DEFAULT_THINKING high; a model default wins", () => {
    expect(reasoningOf({})).toEqual({ effort: "high", summary: "auto" });
    expect(reasoningOf({ think: "default" })).toEqual({ effort: "high", summary: "auto" });
    expect(reasoningOf({ models: { "gpt-x": { defaultReasoning: "low" } } })).toEqual({ effort: "low", summary: "auto" });
  });

  test("levels translate to the nearest native symbol the model accepts", () => {
    const models = (reasoningLevels) => ({ "gpt-x": { reasoningLevels } });
    expect(reasoningOf({ think: false, models: models(["none", "low", "medium"]) }).effort).toBe("none");
    expect(reasoningOf({ think: false, models: models(["low", "medium", "high", "xhigh", "max"]) }).effort).toBe("low");
    expect(reasoningOf({ think: "xhigh", models: models(["low", "medium", "high"]) }).effort).toBe("high");
    expect(reasoningOf({ think: "xhigh", models: models(["none", "low", "medium", "high", "xhigh"]) }).effort).toBe("xhigh");
  });

  test("known non-reasoning models omit reasoning; summary-less models omit only the summary", () => {
    expect(reasoningOf({ models: { "gpt-x": { reasoning: false } } })).toBeUndefined();
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
    }, {}, { setContextUsage() {} });
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
    expect(conn.saved.at(-1).models["gpt-x"]).toEqual({ label: "X", reasoningLevels: ["none", "low", "medium", "high", "xhigh"] });
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
    expect(plainConn.saved.at(-1).models["gpt-x"]).toEqual({ reasoning: false });
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
      setPlanUsage(report) { this.reports.push(report); },
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
    const report = await testConnection.call(conn({
      verify: "jwt", token: freshJwt(), models: { "gpt-5.5": {}, "gpt-5-codex": {} },
    }));
    expect(report).toEqual({ models: 2 });
  });

  test("an opaque API key can never verify as JWT — the error says to sign in with the browser", async () => {
    await expect(testConnection.call(conn({ verify: "jwt", token: "sk-opaque" })))
      .rejects.toThrow(/not a JWT — sign in with the browser/);
  });

  test("an expired JWT fails verification", async () => {
    const expired = jwt({ exp: Date.now() / 1000 - 10 });
    await expect(testConnection.call(conn({ verify: "jwt", token: expired })))
      .rejects.toThrow(/expired — sign in again/);
  });
});

describe("testConnection: the default probe (the HttpStatusError regression)", () => {
  test("a non-2xx response throws a REAL HttpStatusError with the status", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const c = { baseUrl: `http://127.0.0.1:${port}`, aiio: { settings: { auth: { token: "sk-x" } } } };
      await expect(testConnection.call(c)).rejects.toThrow(/HTTP 401/);
      await expect(testConnection.call(c)).rejects.toMatchObject({ name: "HttpStatusError", status: 401 });
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
  const io = { settings: { auth: { token: freshJwt() } }, tools: () => [], currentModel: "gpt-5.5" };
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

describe("codexModels: only account-usable models are listed", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const CANDIDATES = {
    "gpt-yes": { label: "GPT Yes", reasoning: true },
    "gpt-no": { label: "GPT No", reasoning: true },
    "gpt-flaky": { label: "GPT Flaky", reasoning: true },
  };
  /** Mock the codex backend: gpt-yes streams, gpt-no is unsupported, gpt-flaky 401s. */
  function mockBackend() {
    globalThis.fetch = async (url, init) => {
      const model = JSON.parse(init.body).model;
      if (model === "gpt-yes") return new Response("data: [DONE]\n");
      if (model === "gpt-no") {
        return new Response(JSON.stringify({ detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.` }), { status: 400 });
      }
      return new Response("unauthorized", { status: 401 });
    };
  }
  function codexConn({ token, ...rest } = {}, authSet) {
    const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
    return { baseUrl: "https://chatgpt.com/backend-api/codex", aiio: { settings, authSet } };
  }

  test("supported models stay, backend-rejected models drop, the cache refreshes", async () => {
    mockBackend();
    let saved;
    const map = await openaiModels.call(codexConn(
      { token: freshJwt(), models: { "gpt-yes": CANDIDATES["gpt-yes"], "gpt-no": CANDIDATES["gpt-no"] } },
      (data) => { saved = data; },
    ));
    expect(Object.keys(map)).toEqual(["gpt-yes"]);
    expect(saved.models).toEqual(map);
  });

  test("an undecidable probe (auth/quota/network) keeps the model's cached entry", async () => {
    mockBackend();
    const map = await openaiModels.call(codexConn({
      token: freshJwt(),
      models: { "gpt-yes": CANDIDATES["gpt-yes"], "gpt-flaky": CANDIDATES["gpt-flaky"] },
    }));
    expect(Object.keys(map).sort()).toEqual(["gpt-flaky", "gpt-yes"]);
  });

  test("a total probe failure throws (the caller keeps the stale cache untouched)", async () => {
    mockBackend();
    await expect(openaiModels.call(codexConn({
      token: freshJwt(),
      models: { "gpt-flaky": CANDIDATES["gpt-flaky"] },
    }))).rejects.toThrow(/no model answered/);
  });
});

describe("codexModels: registry-driven candidates (new models need no code update)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const REGISTRY_URL = "https://models.dev/api.json";
  class CodexPreset {
    static knownEndpoints = [{
      name: "openai-codex", url: "https://chatgpt.com/backend-api/codex", verify: "jwt",
      registry: { url: REGISTRY_URL, provider: "openai" },
      models: { "gpt-static": { label: "GPT Static" } },
    }];
  }
  function codexConn({ token, ...rest } = {}, authSet) {
    const settings = { ...rest, ...(token !== undefined ? { auth: { token } } : {}) };
    const conn = new CodexPreset();
    conn.baseUrl = "https://chatgpt.com/backend-api/codex";
    conn.aiio = { settings, authSet };
    return conn;
  }
  /** Registry serves gpt-new + gpt-old; probes support gpt-new only. */
  function mockRegistryAndBackend() {
    const calls = { registry: 0, probes: [] };
    globalThis.fetch = async (url, init) => {
      if (url === REGISTRY_URL) {
        calls.registry++;
        return new Response(JSON.stringify({ openai: { models: {
          "gpt-new": { name: "GPT New", reasoning: true, limit: { context: 272000, output: 128000 } },
          "gpt-old": { name: "GPT Old", reasoning: false },
        } } }));
      }
      const model = JSON.parse(init.body).model;
      calls.probes.push(model);
      if (model === "gpt-new") return new Response("data: [DONE]\n");
      return new Response(JSON.stringify({ detail: `The '${model}' model is not supported` }), { status: 400 });
    };
    return calls;
  }

  test("registry models are probed and mapped (descriptor fields), static list ignored", async () => {
    const calls = mockRegistryAndBackend();
    let saved;
    const map = await openaiModels.call(codexConn({ token: freshJwt() }, (data) => { saved = { ...saved, ...data }; }));
    expect(calls.registry).toBe(1);
    expect(calls.probes.sort()).toEqual(["gpt-new", "gpt-old"]);
    expect(map).toEqual({ "gpt-new": { label: "GPT New", reasoning: true, contextWindow: 272000, maxTokens: 128000 } });
    expect(saved.registry.models["gpt-new"]).toBeDefined();
    expect(typeof saved.modelsProbedAt).toBe("number");
  });

  test("a fresh registry cache skips the fetch; a fresh probe cache skips probing", async () => {
    const calls = mockRegistryAndBackend();
    const now = Date.now();
    const map = await openaiModels.call(codexConn({
      token: freshJwt(),
      models: { "gpt-new": { label: "GPT New" } },
      modelsProbedAt: now,
      registry: { fetchedAt: now, models: { "gpt-new": { label: "GPT New" } } },
    }));
    expect(map).toEqual({ "gpt-new": { label: "GPT New" } });
    expect(calls.registry).toBe(0);
    expect(calls.probes).toEqual([]);
  });

  test("a registry fetch failure falls back to the preset's static list", async () => {
    const calls = mockRegistryAndBackend();
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === REGISTRY_URL) throw new TypeError("offline");
      return real(url, init);
    };
    // gpt-static becomes the only candidate; the mock deems it
    // unsupported, so the probe reports nothing usable (throw => the
    // caller keeps its stale cache) — but the probe list proves the
    // static fallback was the candidate source
    await expect(openaiModels.call(codexConn({ token: freshJwt() }))).rejects.toThrow(/no model answered/);
    expect(calls.probes).toEqual(["gpt-static"]);
  });

  test("registry effort options and the backend catalog annotate reasoning levels and defaults", async () => {
    globalThis.fetch = async (url) => {
      if (url === REGISTRY_URL) {
        return new Response(JSON.stringify({ openai: { models: {
          "gpt-new": { name: "GPT New", reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high"] }] },
        } } }));
      }
      if (String(url).includes("/models?client_version=")) {
        return new Response(JSON.stringify({ models: [{
          slug: "gpt-new", default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low", description: "" }, { effort: "xhigh", description: "" }],
          supports_reasoning_summary_parameter: true,
        }] }));
      }
      return new Response("data: [DONE]\n");
    };
    const map = await openaiModels.call(codexConn({ token: freshJwt() }));
    expect(map).toEqual({ "gpt-new": {
      label: "GPT New", reasoning: true, defaultReasoning: "low",
      reasoningLevels: ["none", "low", "medium", "high", "xhigh"],
    } });
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
      constructor(url, aiio) { this.url = url; this.aiio = aiio; }
      async login({ token }) { return { type: "oauth", token, access: token }; }
      async testConnection() { return { models: 1 }; }
      async models() { return {}; } // the backend has no GET /models
      async close() {}
    }
    env.registerProvider("codexish", Codexish);
    const login = await loginEndpoint(env, {
      name: "cloud-codex", provider: "codexish", url: "https://codex.test/backend-api/codex", token: "t-1",
    });
    expect(login.verified).toEqual({ models: 1 });
    const settings = env.endpointSettings("cloud-codex");
    expect(settings.verify).toBe("jwt");
    expect(settings.models).toEqual({ "gpt-9": { label: "gpt-9" } });
    // and the model surface serves the static list without a fetch
    expect(await env.endpointModels("cloud-codex")).toEqual({ "gpt-9": { label: "gpt-9" } });
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
      constructor(url, aiio) { this.url = url; this.aiio = aiio; }
      async login({ token }) { return { type: "oauth", token, access: token }; }
      async testConnection() { return { models: 1 }; }
      async models() { return {}; }
      async close() {}
    }
    env.registerProvider("regcodex", RegistryCodex);
    await loginEndpoint(env, {
      name: "reg-codex", provider: "regcodex", url: "https://codex.test/backend-api/codex", token: "t-1",
    });
    const config = env.endpoint("reg-codex");
    expect(config.verify).toBe("jwt");
    expect("models" in config).toBe(false);
  });
});
