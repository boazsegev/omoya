// test/io-lifecycle.test.js — proof for the IO instance lifecycle:
// live settings, tools(), authSet routing, state machine, timeout.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Context } from "../lib/context.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO, ProviderError } from "../lib/io.js";
import { authSetOf, providerAdd, providerOf, settingsOf } from "./env-internals.js";

let dir, env;
beforeEach(async () => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-life-")));
  env = await Env.open(dir, { dir, settingsDir: null, init: { providers: false, tools: false, detect: false, models: false } });
});
afterEach(async () => {
  await Promise.all(Object.values(Env.envs).filter((item) => item.folder === dir).map((item) => item.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** Scripted in-memory provider class. */
function fakeProvider(script = [], hooks = {}) {
  return class FakeProvider {
    static provider = { capabilities: { tools: false, thinking: false, streaming: true } };
    constructor(url, aiio) { this.url = url; this.aiio = aiio; this.queue = [...script]; this.closed = false; }
    context2msg(context, aiio) {
      return (hooks.context2msg ?? ((value, owner) => [{ "x-model": owner.model ?? "" }, { context: value }]))(context, aiio);
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

function makeIO({ Protocol = fakeProvider(), environment = env, endpoint = {}, timeout, ...options } = {}) {
  if (!providerOf(environment, "fake")) providerAdd(environment, "fake", Protocol);
  environment.settings.providers.fake = {
    provider: "fake",
    url: "http://default",
    ...(environment.settings.providers.fake ?? {}),
    ...endpoint,
    ...(timeout === undefined ? {} : { timeout }),
  };
  return new IO({ env: environment, model: "fake/m", ...options });
}

describe("IO qualified model contract", () => {
  test("publishes thinking and text deltas before the provider completes", async () => {
    let release;
    const second = new Promise((resolve) => { release = resolve; });
    const Protocol = fakeProvider([], {
      read: (() => {
        let count = 0;
        return async () => ++count === 1
          ? { events: [{ type: "thinking_start", contentIndex: 0 }, { type: "thinking_delta", contentIndex: 0, text: "reason" }] }
          : count === 2 ? await second : null;
      })(),
    });
    const io = makeIO({ Protocol });
    const seen = [];
    const pending = io.write(new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] }), {
      onThinkingDelta: (event) => seen.push(event.text),
      onTextDelta: (event) => seen.push(event.text),
    });
    try {
      for (let i = 0; i < 20 && seen.length < 1; i++) await Bun.sleep(5);
      expect(seen).toEqual(["reason"]);
      release({ events: [{ type: "thinking_end", contentIndex: 0 }, { type: "text_start", contentIndex: 1 }, { type: "text_delta", contentIndex: 1, text: "answer" }, { type: "done" }] });
      expect((await pending).type).toBe("done");
      expect(seen).toEqual(["reason", "answer"]);
    } finally { release(null); await pending; await io.close(); }
  });
  test("retains qualified current models, native metadata and tool selectors across overrides", async () => {
    const models = [], catalogs = [];
    const aiio = makeIO({ model: "fake/org/base", Protocol: fakeProvider([], {
      context2msg(context, io) {
        models.push([io.model, io.model, io.settings.think]);
        return [{}, { context }];
      },
    }), endpoint: { models: {
      "org/base": { thinking: ["off", "high"] },
      "org/next": { thinking: ["off", "low"] },
    } }, settings: { think: "high" } });
    const tools = env.tools.bind(env);
    env.tools = async (safe, model) => { catalogs.push(model); return tools(safe, model); };
    expect(aiio.endpoint).toBeUndefined();
    aiio.model = "fake/org/next";
    await aiio.write(new Context({ messages: [] }));
    aiio.model = "fake/org/base";
    await aiio.write(new Context({ messages: [] }));
    expect(models).toEqual([
      ["fake/org/next", "fake/org/next", "low"],
      ["fake/org/base", "fake/org/base", "high"],
    ]);
    expect(catalogs).toEqual(["fake/org/next", "fake/org/base"]);
    await aiio.close();
  });

  test("rejects split, bare, unknown and cross-endpoint overrides before reserving IO", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    env.settings.providers.other = { provider: "fake" };
    expect(() => new IO({ env, endpoint: "fake", model: "m" })).toThrow(/use model/);
    for (const model of ["m", "missing/m", "other/m"]) {
      await expect(aiio.write(new Context({ messages: [] }), {}, { model })).rejects.toThrow();
      expect(aiio.state).toBe("idle");
      expect(aiio.model).toBe("fake/m");
    }
    await expect(aiio.write(new Context({ messages: [] }), {}, { endpoint: "fake", model: "fake/m" })).rejects.toThrow(/overrides/);
    expect((await aiio.write(new Context({ messages: [] }))).type).toBe("done");
    await aiio.close();
  });
});

const doneScript = [
  { events: [{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, text: "hi" }] },
  { events: [{ type: "done", usage: { inputTokens: 3, outputTokens: 1 } }] },
];

describe("Context context-usage reporting (provider → Context → consumer)", () => {
  test("setContextUsage merges finite numbers; the getter returns a stable immutable snapshot", () => {
    const context = new Context({ messages: [] });
    expect(context.contextUsage).toEqual({ used: undefined, total: undefined });
    context.contextUsage = { used: 1200.9 };
    context.contextUsage = { total: 128000, used: "junk" };
    expect(context.contextUsage).toEqual({ used: 1200, total: 128000 });
    const snapshot = context.contextUsage;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(context.contextUsage).toBe(snapshot);
    context.contextUsage = { used: 1200 };
    expect(context.contextUsage).not.toBe(snapshot);
    expect(context.contextUsage.used).toBe(1200);
  });

  test("a provider-reported done envelope fills used on the supplied Context, surviving IO replacement", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    const ctx = [{ type: 2, content: [{ type: "text", text: "hello there" }] }];
    const context = new Context({ messages: ctx });
    const terminal = await aiio.write(context);
    expect(terminal.usage.source).toBe("provider");
    expect(context.contextUsage).toEqual({ used: 3, total: undefined });
    // Another Context starts without a report; the first survives replacing IO.
    const sparse = fakeProvider([{ events: [{ type: "text_delta", contentIndex: 0, text: "x" }] }]);
    env._providers.fake = null;
    delete env._providers.fake;
    providerAdd(env, "fake", sparse);
    const aiio2 = makeIO();
    await aiio2.write(new Context({ messages: ctx }));
    expect(aiio2.contextUsage).toBeUndefined();
    expect(context.contextUsage.used).toBe(3);
  });

  test("a connector can report through the aiio passed to its translators", async () => {
    const Protocol = fakeProvider(
      [{ events: [{ type: "done", usage: { inputTokens: 5, outputTokens: 1 } }] }],
      {
        msg2events: (native, state, aiio) => {
          if (aiio?.context) aiio.context.contextUsage = { total: 99999 };
          return native.events ?? [];
        },
      },
    );
    const aiio = makeIO({ Protocol });
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.contextUsage).toEqual({ used: 5, total: 99999 });
  });
});

describe("IO plan-usage reporting (provider → IO → consumer)", () => {
  test("planUsageSet keeps JSON-safe fields; each call is ONE COMPLETE SNAPSHOT that REPLACES the last report", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    aiio.context = new Context({ messages: [] });
    expect(aiio.context.planUsage).toBeNull();
    (aiio.context.planUsage = { label: "Plan", quotas: { requests: { total: 500, remaining: 480, junk: undefined, bad: NaN } } });
    (aiio.context.planUsage = { quotas: { requests: { remaining: 470, reset: "1s" }, tokens: { total: 100000 } } });
    expect(aiio.context.planUsage).toEqual({
      quotas: {
        requests: { remaining: 470, reset: "1s" }, // replaced, not merged: the first report's fields/label are gone
        tokens: { total: 100000 },
      },
    });
    // the getter copies: mutating it never leaks back
    const copy = aiio.context.planUsage;
    copy.quotas.requests.remaining = 0;
    expect(aiio.context.planUsage.quotas.requests.remaining).toBe(470);
  });

  test("a report that drops a quota never leaves the stale one behind (the endpoint-switch leak)", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    aiio.context = new Context({ messages: [] });
    // Endpoint A (an Anthropic key, say) publishes its windows…
    (aiio.context.planUsage = { quotas: { "5h": { total: 100, used: 50, remaining: 50 }, requests: { total: 500, remaining: 499 } } });
    // …then the agent switched to endpoint B whose responses publish only
    // a bare requests family: A's "5h" window must NOT keep showing.
    (aiio.context.planUsage = { quotas: { requests: { total: 500, remaining: 490 } } });
    expect(aiio.context.planUsage).toEqual({ quotas: { requests: { total: 500, remaining: 490 } } });
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
      // reportPlanUsage completed from IO's OpenAI wire defaults
    };
    const aiio = makeIO({ Protocol });
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.planUsage).toMatchObject({
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
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.planUsage).toMatchObject({
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
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.planUsage).toMatchObject({
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
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.planUsage).toMatchObject({ quotas: { requests: { total: 300, remaining: 150 } } });
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
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    await aiio.write(context);
    expect(context.planUsage).toMatchObject({
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
    const context = new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] });
    const terminal = await aiio.write(context);
    expect(terminal.type).toBe("done");
    expect(context.planUsage).toBeNull();
  });
});

describe("IO provider surface", () => {
  test("provider-namespaced live settings view", async () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.settings).toEqual({ provider: "fake", url: "http://default" });
    authSetOf(env, "fake", { token: "t-1" });
    expect(aiio.settings).toEqual({ provider: "fake", url: "http://default", auth: { token: "t-1" } });
  });

  test("model selection and Env URL edits apply to cached IO", async () => {
    const Protocol = fakeProvider();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      providers: { fake: { provider: "fake", url: "http://settings", model: "m-settings" } },
    }));
    await env.close();
    const env2 = await Env.open(dir, { dir, settingsDir: null, init: { providers: false, tools: false, detect: false, models: false } });
    providerAdd(env2, "fake", Protocol);
    env2.settings.providers.fake = { provider: "fake", url: "http://settings", model: "m-settings", models: { m: {}, "m-x": {} } };
    const configured = new IO({ env: env2, model: "fake/m" });
    expect(configured.url).toBe("http://settings");
    expect(configured.model).toBe("fake/m"); // explicit selector owns the model
    env2.settings.providers.fake.url = "http://explicit";
    expect(configured.url).toBe("http://explicit");
    expect(makeIO({ environment: env2, Protocol, model: "fake/m-x" }).model).toBe("fake/m-x");
  });

  test("tools() returns the request's Env catalog snapshot", async () => {
    env.toolAdd("file-read", () => {}, { description: "read", inputSchema: {} });
    const aiio = makeIO({ Protocol: fakeProvider() });
    // each request snapshots Env.tools() once (lib/io/request.js)
    aiio._toolCatalog = await env.tools();
    // the built-in tool-refresh is always registered (AI-AGENT unit)
    expect(aiio.tools().find((t) => t.name === "file-read")).toEqual({ name: "file-read", description: "read", inputSchema: {} });
    expect(aiio.tools().map((t) => t.name)).toEqual(["tool-refresh", "file-read"]);
    env.toolAdd("file-write", () => {}, { description: "write", inputSchema: {} });
    expect(aiio.tools().map((t) => t.name)).toEqual(["tool-refresh", "file-read"]); // fixed for the request
    aiio._toolCatalog = await env.tools();
    expect(aiio.tools().map((t) => t.name)).toEqual(["tool-refresh", "file-read", "file-write"]);
  });

  test("aiio.authSet routes to Env.authSet under the provider name", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    // Returns the auth file's own section; provider/url stay with the endpoint config.
    const section = aiio.authSet({ token: "abc" });
    expect(section).toEqual({ auth: { token: "abc" } });
    expect(settingsOf(env, "fake")).toMatchObject({
      provider: "fake", url: "http://default", auth: { token: "abc" },
    });
  });

  test("endpoint resolves its protocol through the Env registry", () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    expect(aiio.endpoint).toBeUndefined();
    expect(aiio.model).toBe("fake/m");
    expect(aiio.protocol).toBe("fake");
  });

  test("a preferences placeholder rides on the auth file's connection (protocol + url)", () => {
    // The providers entry carries ONLY preferences (filter/maxActive) — no
    // provider/url. The completing connection lives in the auth file (the
    // shape a login writes). IO must resolve protocol + URL from that merged
    // view, not fall back to the OpenAI defaults and POST an Anthropic-shaped
    // endpoint an OpenAI /responses request (the claude 404 regression).
    const Protocol = fakeProvider();
    if (!providerOf(env, "fake")) providerAdd(env, "fake", Protocol);
    env.settings.providers.fake = { filter: "[a-z]-[567]", maxActive: false }; // placeholder only
    authSetOf(env, "fake", { provider: "fake", url: "http://auth-file", auth: { token: "t" } });
    const aiio = new IO({ env, model: "fake/m" });
    expect(aiio.protocol).toBe("fake");
    expect(aiio.url).toBe("http://auth-file");
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
    const terminal = await aiio.write(new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] }));
    expect(terminal.type).toBe("done");
    expect(seen[0]).toBe("sending");
    expect(seen[1]).toBe("reading");
    expect(aiio.state).toBe("idle");
  });

  test("write() while a request is in flight is a contract error", async () => {
    const hanging = (conn) =>
      new Promise((_, reject) => {
        const signal = conn.signal;
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const aiio = makeIO({ Protocol: fakeProvider([], { read: hanging }) });
    const first = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    first.catch(() => {}); // settled by kill below
    // write() reserves the instance before asynchronous OAuth/acquisition
    // work starts; an immediate caller must never slip through that gap.
    expect(aiio.state).toBe("sending");
    await expect(aiio.write(new Context({ messages: [{ type: 2, content: [] }] }))).rejects.toThrow(/contract error/);
    await aiio.close();
  });

  test("malformed context is rejected as malformed, state untouched", async () => {
    const aiio = makeIO({ Protocol: fakeProvider() });
    await expect(aiio.write("not a context")).rejects.toThrow(/must be a Context/);
    expect(aiio.state).toBe("idle");
  });

  test("per-request timeout produces a classified network error", async () => {
    const hangingRead = (conn) =>
      new Promise((_, reject) => {
        conn.signal.addEventListener("abort", () =>
          reject(conn.signal.reason),
        );
      });
    const aiio = makeIO({ Protocol: fakeProvider([], { read: hangingRead }) });
    const events = [];
    const terminal = await aiio.write(new Context({ messages: [{ type: 2, content: [] }] }),
      { onTextDelta: false },
      { timeout: 30 },
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
    expect(makeIO({ Protocol: mod, endpoint: { timeout: 9_000 } }).timeout).toBe(9_000);
  });
});

describe("IO request/response flow", () => {
  test("events stream through callbacks; done carries message + usage", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    const events = [];
    const terminal = await aiio.write(new Context({ messages: [{ type: 2, content: [{ type: "text", text: "hi" }] }] }),
      {
        onTextDelta: (e) => events.push(e),
        onDone: (e) => events.push(e),
      },
    );
    expect(terminal.type).toBe("done");
    expect(terminal.message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(terminal.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4, source: "provider" });
    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
  });

  test("omitted callbacks flow through onData; explicit false is no-op", async () => {
    const data = [];
    const aiio = makeIO({ Protocol: fakeProvider(doneScript), onData: (e) => data.push(e.type) });
    await aiio.write(new Context({ messages: [{ type: 2, content: [] }] }), { onTextDelta: false });
    expect(data).toContain("start");
    expect(data).toContain("text_start");
    expect(data).not.toContain("text_delta");
    expect(data).toContain("done");
  });

  test("stream end without connector terminal synthesizes done with estimated usage", async () => {
    const aiio = makeIO({
      Protocol: fakeProvider([{ events: [{ type: "text_delta", contentIndex: 0, text: "some words here" }] }]),
    });
    const terminal = await aiio.write(new Context({ messages: [{ type: 2, content: [{ type: "text", text: "in" }] }] }));
    expect(terminal.type).toBe("done");
    expect(terminal.message.content[0].text).toBe("some words here");
    expect(terminal.usage.source).toBe("estimate");
    expect(terminal.usage.outputTokens).toBeGreaterThan(0);
  });

  test("sequential requests reuse one instance", async () => {
    const aiio = makeIO({ Protocol: fakeProvider(doneScript) });
    await aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    const second = await aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    expect(second.type).toBe("done");
    expect(aiio.state).toBe("idle");
  });
});
