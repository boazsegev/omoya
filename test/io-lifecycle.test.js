// test/io-lifecycle.test.js — proof for the IO instance lifecycle:
// live settings, tools(), authSet routing, state machine, timeout.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO, ProviderError } from "../lib/io.js";

let dir, env;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-life-")));
  env = new Env({ dir, cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Scripted in-memory provider class. */
function fakeProvider(script = [], hooks = {}) {
  return class FakeProvider {
    static provider = { capabilities: { tools: false, thinking: false, streaming: true } };
    constructor(url, aiio) { this.url = url; this.aiio = aiio; this.queue = [...script]; this.closed = false; }
    context2msg(context, aiio) {
      return (hooks.context2msg ?? ((value, owner) => [{ "x-model": owner.currentModel ?? "" }, { context: value }]))(context, aiio);
    }
    msg2events(native, state, aiio) {
      return (hooks.msg2events ?? ((value) => value.events ?? []))(native, state, aiio);
    }
    async send(msg) {
      if (hooks.send) return hooks.send(this, msg);
      this.msg = msg;
    }
    async read() {
      if (hooks.read) return hooks.read(this);
      return this.queue.shift() ?? null;
    }
    async close() {
      if (hooks.close) return hooks.close(this);
      this.closed = true;
    }
  };
}

function makeIO({ Protocol = fakeProvider(), environment = env, endpoint = {}, ...options } = {}) {
  if (!environment.provider("fake")) environment.registerProvider("fake", Protocol);
  environment.endpoints.fake = {
    provider: "fake",
    url: "http://default",
    ...(environment.endpoints.fake ?? {}),
    ...endpoint,
  };
  return new IO({ env: environment, model: "fake/m", ...options });
}

const doneScript = [
  { events: [{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, text: "hi" }] },
  { events: [{ type: "done", usage: { inputTokens: 3, outputTokens: 1 } }] },
];

describe("IO context-usage reporting (provider → IO → consumer)", () => {
  test("setContextUsage merges finite numbers; the getter copies", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.contextUsage).toEqual({ used: undefined, total: undefined });
    aiio.setContextUsage({ used: 1200.9 });
    aiio.setContextUsage({ total: 128000, used: "junk" });
    expect(aiio.contextUsage).toEqual({ used: 1200, total: 128000 });
    // the getter copies: mutating its result never leaks back
    const copy = aiio.contextUsage;
    copy.used = 0;
    expect(aiio.contextUsage.used).toBe(1200);
  });

  test("a provider-reported done envelope auto-fills `used`; the report resets per request", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    const ctx = [{ type: 2, content: [{ type: "text", text: "hello there" }] }];
    const terminal = await aiio.write(ctx);
    expect(terminal.usage.source).toBe("provider");
    expect(aiio.contextUsage).toEqual({ used: 3, total: undefined });
    // a second request without provider usage resets the report (used stays
    // unset — an estimate never masquerades as an exact readout)
    const sparse = fakeProvider([{ events: [{ type: "text_delta", contentIndex: 0, text: "x" }] }]);
    env.providers.fake = null;
    delete env.providers.fake;
    env.registerProvider("fake", sparse);
    const aiio2 = makeIO();
    await aiio2.write(ctx);
    expect(aiio2.contextUsage.used).toBeUndefined();
  });

  test("a connector can report through the aiio passed to its translators", async () => {
    const Protocol = fakeProvider(
      [{ events: [{ type: "done", usage: { inputTokens: 5, outputTokens: 1 } }] }],
      {
        msg2events: (native, state, aiio) => {
          aiio?.setContextUsage?.({ total: 99999 });
          return native.events ?? [];
        },
      },
    );
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.contextUsage).toEqual({ used: 5, total: 99999 });
  });
});

describe("IO plan-usage reporting (provider → IO → consumer)", () => {
  test("setPlanUsage keeps only numbers/non-empty strings and merges quotas key-by-key", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.planUsage).toBeNull();
    aiio.setPlanUsage({ label: "Plan", quotas: { requests: { total: 500, remaining: 480, junk: undefined, bad: NaN } } });
    aiio.setPlanUsage({ quotas: { requests: { remaining: 470, reset: "1s" }, tokens: { total: 100000 } } });
    expect(aiio.planUsage).toEqual({
      label: "Plan",
      quotas: {
        requests: { total: 500, remaining: 470, reset: "1s" },
        tokens: { total: 100000 },
      },
    });
    // the getter copies: mutating it never leaks back
    const copy = aiio.planUsage;
    copy.quotas.requests.remaining = 0;
    expect(aiio.planUsage.quotas.requests.remaining).toBe(470);
  });

  test("the reportPlanUsage hook fires after send with the response headers (OpenAI x-ratelimit-* default)", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) {
        this.msg = msg;
        this.response = {
          headers: new Headers({
            "x-ratelimit-limit-requests": "500",
            "x-ratelimit-remaining-requests": "499",
            "x-ratelimit-reset-requests": "20ms",
            "x-ratelimit-limit-tokens": "100000",
            "x-ratelimit-remaining-tokens": "99000",
          }),
        };
      }
      // reportPlanUsage completed from the OpenAI defaults (defineProvider)
    };
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.planUsage).toEqual({
      quotas: {
        requests: { total: 500, remaining: 499, reset: "20ms" },
        tokens: { total: 100000, remaining: 99000 },
      },
    });
  });

  test("the reportPlanUsage default also picks up the project-scoped x-ratelimit-*-project-tokens family", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) {
        this.msg = msg;
        this.response = {
          headers: new Headers({
            "x-ratelimit-limit-project-tokens": "1000000",
            "x-ratelimit-remaining-project-tokens": "998000",
            "x-ratelimit-reset-project-tokens": "5m",
          }),
        };
      }
    };
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.planUsage).toEqual({
      quotas: { projectTokens: { total: 1000000, remaining: 998000, reset: "5m" } },
    });
  });

  test("the reportPlanUsage default falls back to the Anthropic-subscription unified-window dialect when the OpenAI family is absent", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) {
        this.msg = msg;
        this.response = {
          headers: new Headers({
            "some-gateway-ratelimit-unified-5h-utilization": "0.25",
            "some-gateway-ratelimit-unified-5h-reset": "2026-09-19T22:00:00Z",
          }),
        };
      }
    };
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.planUsage).toEqual({
      quotas: { "5h": { total: 100, used: 25, remaining: 75, reset: "2026-09-19T22:00:00Z", windowSeconds: 18000 } },
    });
  });

  test("the reportPlanUsage default falls back to the Kimi/Moonshot bare X-RateLimit-* dialect only when nothing has claimed \"requests\"", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) {
        this.msg = msg;
        this.response = { headers: new Headers({ "X-RateLimit-Limit": "300", "X-RateLimit-Remaining": "150" }) };
      }
    };
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.planUsage).toEqual({ quotas: { requests: { total: 300, remaining: 150 } } });
  });

  test("all three dialects can coexist in one response; the OpenAI \"requests\" family wins over the bare Kimi one", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) {
        this.msg = msg;
        this.response = {
          headers: new Headers({
            "x-ratelimit-limit-requests": "50",
            "x-ratelimit-remaining-requests": "49",
            "anthropic-ratelimit-unified-7d-utilization": "0.1",
            "X-RateLimit-Limit": "999", // ignored: "requests" already claimed by the OpenAI family
          }),
        };
      }
    };
    const aiio = makeIO({ Protocol });
    await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(aiio.planUsage).toEqual({
      quotas: {
        requests: { total: 50, remaining: 49 },
        "7d": { total: 100, used: 10, remaining: 90, windowSeconds: 604800 },
      },
    });
  });

  test("a hook failure never breaks the request", async () => {
    const Protocol = class extends fakeProvider(doneScript) {
      async send(msg) { this.msg = msg; this.response = { headers: new Headers() }; }
      reportPlanUsage() { throw new Error("quota parser exploded"); }
    };
    const aiio = makeIO({ Protocol });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("done");
    expect(aiio.planUsage).toBeNull();
  });
});

describe("IO provider surface", () => {
  test("provider-namespaced live settings view", async () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.settings).toEqual({ provider: "fake", url: "http://default" });
    env.authSet("fake", { token: "t-1" });
    expect(aiio.settings).toEqual({ provider: "fake", url: "http://default", auth: { token: "t-1" } });
  });

  test("model/url resolution: explicit options override endpoint settings", () => {
    const Protocol = fakeProvider();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { fake: { provider: "fake", url: "http://settings", model: "m-settings" } },
    }));
    const env2 = new Env({ dir, cwd: dir });
    const configured = makeIO({ environment: env2, Protocol });
    expect(configured.url).toBe("http://settings");
    expect(configured.model).toBe("m"); // explicit selector owns the model
    expect(makeIO({ environment: env2, Protocol, url: "http://explicit", model: "fake/m-x" }).url).toBe("http://explicit");
    expect(makeIO({ environment: env2, Protocol, model: "fake/m-x" }).model).toBe("m-x");
  });

  test("tools() returns the current Env catalog", () => {
    env.registerTool("file-read", () => {}, { description: "read", inputSchema: {} });
    const aiio = makeIO({ Protocol: fakeProvider() });
    // the built-in tool-refresh is always registered (AI-AGENT unit)
    expect(aiio.tools().find((t) => t.name === "file-read")).toEqual({ name: "file-read", description: "read", inputSchema: {} });
    expect(aiio.tools().map((t) => t.name)).toEqual(["tool-refresh", "file-read"]);
    env.registerTool("file-write", () => {}, { description: "write", inputSchema: {} });
    expect(aiio.tools().map((t) => t.name)).toEqual(["tool-refresh", "file-read", "file-write"]);
  });

  test("aiio.authSet routes to Env.authSet under the provider name", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    const section = aiio.authSet({ token: "abc" });
    expect(section).toEqual({ provider: "fake", url: "http://default", auth: { token: "abc" } });
    expect(env.endpointSettings("fake")).toMatchObject({
      provider: "fake", url: "http://default", auth: { token: "abc" },
    });
  });

  test("endpoint resolves its protocol through the Env registry", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.endpoint).toBe("fake");
    expect(aiio.protocol).toBe("fake");
  });

  test("unknown endpoint name is a classified error", () => {
    expect(() => new IO({ env, model: "nope/m" })).toThrow(TypeError);
  });
});

describe("IO state machine idle → sending → reading → idle", () => {
  test("states observed across one request", async () => {
    const seen = [];
    const mod = fakeProvider(doneScript, {
      send: async (conn, msg) => { seen.push(conn.aiio.state); },
      read: async (conn) => { seen.push(conn.aiio.state); return conn.queue.shift() ?? null; },
    });
    const aiio = makeIO({ Protocol: mod });
    expect(aiio.state).toBe("idle");
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
    expect(terminal.type).toBe("done");
    expect(seen[0]).toBe("sending");
    expect(seen[1]).toBe("reading");
    expect(aiio.state).toBe("idle");
  });

  test("write() while a request is in flight is a contract error", async () => {
    const hanging = (conn) =>
      new Promise((_, reject) => {
        const signal = conn.aiio.requestSignal;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const aiio = makeIO({ Protocol: fakeProvider([], { read: hanging }) });
    const first = aiio.write([{ type: 2, content: [] }]);
    first.catch(() => {}); // settled by kill below
    // write() reserves the instance before asynchronous OAuth/acquisition
    // work starts; an immediate caller must never slip through that gap.
    expect(aiio.state).toBe("sending");
    await expect(aiio.write([{ type: 2, content: [] }])).rejects.toThrow(/contract error/);
    await aiio.kill();
  });

  test("malformed context is rejected as malformed, state untouched", async () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    await expect(aiio.write("not a context")).rejects.toMatchObject({ kind: "malformed" });
    expect(aiio.state).toBe("idle");
  });

  test("per-request timeout produces a classified network error", async () => {
    const hangingRead = (conn) =>
      new Promise((_, reject) => {
        conn.aiio.requestSignal.addEventListener("abort", () =>
          reject(conn.aiio.requestSignal.reason),
        );
      });
    const aiio = makeIO({ Protocol: fakeProvider([], { read: hangingRead }), timeout: 30 });
    const events = [];
    const terminal = await aiio.write(
      [{ type: 2, content: [] }],
      { onTextDelta: false },
      {},
    );
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("network");
    expect(terminal.error).toMatch(/timeout/);
    expect(aiio.state).toBe("idle"); // recovered, instance reusable
  });

  test("provider metadata timeout overrides the default", () => {
    const mod = fakeProvider();
    mod.provider.timeout = 5_000;
    expect(makeIO({ Protocol: mod }).timeout).toBe(5_000);
    expect(makeIO({ Protocol: mod, timeout: 9_000 }).timeout).toBe(9_000);
  });
});

describe("IO request/response flow", () => {
  test("events stream through callbacks; done carries message + usage", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    const events = [];
    const terminal = await aiio.write(
      [{ type: 2, content: [{ type: "text", text: "hi" }] }],
      {
        onTextDelta: (e) => events.push(e),
        onDone: (e) => events.push(e),
      },
    );
    expect(terminal.type).toBe("done");
    expect(terminal.message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(terminal.usage).toEqual({ inputTokens: 3, outputTokens: 1, source: "provider" });
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
  });

  test("omitted callbacks flow through onData; explicit false is no-op", async () => {
    const data = [];
    const aiio = makeIO({ Protocol: fakeProvider(doneScript), onData: (e) => data.push(e.type) });
    await aiio.write([{ type: 2, content: [] }], { onTextDelta: false });
    expect(data).toContain("start");
    expect(data).toContain("text_start");
    expect(data).not.toContain("text_delta");
    expect(data).toContain("done");
  });

  test("stream end without connector terminal synthesizes done with estimated usage", async () => {
    const aiio = makeIO({
      Protocol: fakeProvider([{ events: [{ type: "text_delta", contentIndex: 0, text: "some words here" }] }]),
    });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "in" }] }]);
    expect(terminal.type).toBe("done");
    expect(terminal.message.content[0].text).toBe("some words here");
    expect(terminal.usage.source).toBe("estimate");
    expect(terminal.usage.outputTokens).toBeGreaterThan(0);
  });

  test("sequential requests reuse one instance", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    await aiio.write([{ type: 2, content: [] }]);
    const second = await aiio.write([{ type: 2, content: [] }]);
    expect(second.type).toBe("done");
    expect(aiio.state).toBe("idle");
  });
});
