// test/io-ollama.test.js — proof for the Ollama connector: translators,
// metadata surface, models()/login(), and error/timeout surfacing in the
// consistent auth/network/provider/malformed shape.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import OllamaPlugin from "../providers/ollama.js";
import { defineProvider } from "../lib/io.js";

const Ollama = defineProvider(OllamaPlugin, { name: "ollama" });
const connection = (aiio = {}) => new Ollama(aiio.url, aiio);
const ollama = {
  provider: Ollama.provider,
  models: (aiio) => connection(aiio).models(),
  login: (aiio) => connection(aiio).login(),
  context2msg: (context, aiio) => connection(aiio).context2msg(context, aiio),
  msg2events: (message, state, aiio) => connection(aiio).msg2events(message, state, aiio),
};

let dir, env;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-oll-")));
  env = new Env({ dir, cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
let mock;
beforeEach(() => {
  mock = { calls: [], handler: () => new Response("") };
  globalThis.fetch = (...args) => {
    mock.calls.push(args);
    return mock.handler(...args);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ndjson(frames) {
  return new Response(frames.map((f) => JSON.stringify(f) + "\n").join(""));
}

describe("Ollama thinking control", () => {
  test("booleans pass through; levels clamp to Ollama's low/medium/high", () => {
    const think = (value) => ollama.context2msg([{ type: 2, content: [{ type: "text", text: "q" }] }],
      { settings: { think: value }, currentModel: "gpt-oss:20b" })[1].think;
    expect(think(undefined)).toBeUndefined();
    expect(think(false)).toBe(false);
    expect(think(true)).toBe(true);
    expect(think("low")).toBe("low");
    expect(think("xhigh")).toBe("high");
  });
});

describe("Ollama metadata surface", () => {
  test("static id/capability metadata", () => {
    expect(ollama.provider.name).toBe("ollama");
    expect(typeof ollama.provider.label).toBe("string");
    expect(ollama.provider.capabilities).toEqual({
      tools: true,
      thinking: true,
      streaming: true,
    });
    expect(ollama.provider.url).toBeUndefined(); // URLs belong to endpoints
  });

  test("models() lists the local API and refreshes the cached snapshot", async () => {
    mock.handler = () =>
      new Response(JSON.stringify({
        models: [
          { name: "qwen3:8b", size: 100, details: { family: "qwen3" } },
          { name: "llama3.1:8b", size: 200, details: { family: "llama" } },
        ],
      }));
    const authed = [];
    const aiio = { url: "http://localhost:11434", settings: {}, authSet: (a) => authed.push(a) };
    const models = await ollama.models(aiio);
    expect(mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
    expect(Object.keys(models)).toEqual(["qwen3:8b", "llama3.1:8b"]);
    expect(models["qwen3:8b"]).toMatchObject({ reasoning: false, input: ["text"], family: "qwen3" });
    expect(authed).toEqual([{ models }]); // cache updated on access
  });

  test("models() probes /api/show for each model's context window (best-effort metadata)", async () => {
    mock.handler = (url, init) => {
      if (String(url).endsWith("/api/show")) {
        const model = JSON.parse(init.body).model;
        return new Response(JSON.stringify({
          model_info: model === "qwen3:8b" ? { "qwen3.context_length": 40960 } : {},
        }));
      }
      return new Response(JSON.stringify({
        models: [
          { name: "qwen3:8b", size: 100, details: { family: "qwen3" } },
          { name: "mystery:1b", size: 50, details: { family: "x" } },
        ],
      }));
    };
    const map = await ollama.models({ url: "http://localhost:11434", settings: {} });
    expect(map["qwen3:8b"].contextWindow).toBe(40960);
    expect(map["mystery:1b"].contextWindow).toBeUndefined(); // unknown stays absent
  });

  test("models() falls back to the cached list when unreachable", async () => {
    mock.handler = () => Promise.reject(new TypeError("fetch failed"));
    const cached = { "cached:1": { label: "cached:1" } };
    const models = await ollama.models({ url: "http://x", settings: { models: cached } });
    expect(models).toBe(cached);
    expect(await ollama.models({ url: "http://x", settings: {} })).toEqual({});
  });

  test("login() is a trivial no-auth procedure routed through endpoint auth", async () => {
    env.registerProvider("ollama", OllamaPlugin);
    env.endpoints.ollama = { provider: "ollama", url: "http://localhost:11434" };
    const aiio = new IO({ env, model: "ollama/m" });
    const auth = await ollama.login(aiio);
    expect(auth).toEqual({ type: "none" });
    expect(env.endpointSettings("ollama")).toEqual({
      provider: "ollama", url: "http://localhost:11434", auth: { type: "none" },
    });
  });
});

describe("Ollama context2msg (outgoing shape)", () => {
  const aiio = {
    currentModel: "qwen3:8b",
    settings: {},
    tools: () => [],
  };

  test("system/user/assistant text messages map to roles", () => {
    const [headers, body] = ollama.context2msg(
      [
        { type: 1, content: [{ type: "text", text: "be terse" }] },
        { type: 2, content: [{ type: "text", text: "hello" }] },
        { type: 3, content: [{ type: "text", text: "hi " }, { type: "text", text: "there" }] },
      ],
      aiio,
    );
    expect(headers).toEqual({ "content-type": "application/json" });
    expect(body.model).toBe("qwen3:8b");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(body.tools).toBeUndefined(); // empty catalog omits the key
  });

  test("thinking blocks stay local-only", () => {
    const [, body] = ollama.context2msg(
      [{ type: 3, content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "answer" }] }],
      aiio,
    );
    expect(body.messages[0]).toEqual({ role: "assistant", content: "answer" });
  });

  test("image and binary blocks ride Ollama's sole images channel (user + tool result)", () => {
    const [, body] = ollama.context2msg(
      [
        { type: 2, content: [
          { type: "text", text: "what is this?" },
          { type: "image", mime: "image/png", content: "aW1n" },
        ] },
        { type: 4, callId: "c1", name: "file-read", content: [
          { type: "text", text: "[bytes 0–3 of 4 total, image/png]" },
          { type: "binary", mime: "image/png", content: "Ymlu" },
          { type: "binary", mime: "application/zip", content: "emlw" }, // generic binary shares Ollama's only binary channel
        ] },
      ],
      aiio,
    );
    expect(body.messages[0]).toEqual({ role: "user", content: "what is this?", images: ["aW1n"] });
    expect(body.messages[1]).toEqual({
      role: "tool", name: "file-read",
      content: "[bytes 0–3 of 4 total, image/png]\n[attachment]",
      images: ["Ymlu", "emlw"], // generic binary payloads use Ollama's sole binary channel
    });
  });

  test("auth token from settings adds an authorization header", () => {
    const [headers] = ollama.context2msg([], { ...aiio, settings: { auth: { token: "t-1" } } });
    expect(headers.authorization).toBe("Bearer t-1");
  });

  test("tool catalog maps to function schemas", () => {
    const withTools = {
      ...aiio,
      tools: () => [{ name: "file-read", description: "read a file", inputSchema: { type: "object" } }],
    };
    const [, body] = ollama.context2msg([], withTools);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "file-read", description: "read a file", parameters: { type: "object" } } },
    ]);
  });
});

describe("Ollama msg2events (incoming shape)", () => {
  test("content frames stream text deltas; done frame carries usage", () => {
    const state = {};
    const e1 = ollama.msg2events({ message: { role: "assistant", content: "Hello " }, done: false }, state);
    const e2 = ollama.msg2events({ message: { role: "assistant", content: "world" }, done: false }, state);
    const e3 = ollama.msg2events(
      { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 12, eval_count: 7 },
      state,
    );
    expect(e1).toEqual([
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, text: "Hello " },
    ]);
    expect(e2).toEqual([{ type: "text_delta", contentIndex: 0, text: "world" }]);
    expect(e3[0]).toEqual({ type: "text_end", contentIndex: 0 });
    expect(e3[1].type).toBe("done");
    expect(e3[1].usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  test("done without counts leaves usage undefined (estimate fallback)", () => {
    const events = ollama.msg2events({ message: { content: "" }, done: true }, {});
    expect(events.at(-1).type).toBe("done");
    expect(events.at(-1).usage).toBeUndefined();
  });

  test("stream-level error frames become error events", () => {
    const events = ollama.msg2events({ error: "model 'x' not found" }, {});
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].error).toContain("not found");
  });
});

describe("Ollama error/timeout surfacing (consistent classes)", () => {
  async function runWith(handler) {
    mock.handler = handler;
    env.registerProvider("ollama", OllamaPlugin);
    env.endpoints.ollama = { provider: "ollama", url: "http://localhost:11434" };
    const aiio = new IO({ env, model: "ollama/m", timeout: 50 });
    return aiio.write([{ type: 2, content: [{ type: "text", text: "hi" }] }]);
  }

  test("network failure class", async () => {
    const terminal = await runWith(() => Promise.reject(new TypeError("fetch failed")));
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("network");
  });

  test("provider error class (HTTP 404 model missing)", async () => {
    const terminal = await runWith(
      () => new Response(JSON.stringify({ error: "model 'm' not found" }), { status: 404, statusText: "Not Found" }),
    );
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("provider");
    expect(terminal.error).toContain("404");
  });

  test("auth class (HTTP 401/403)", async () => {
    const terminal = await runWith(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    expect(terminal.kind).toBe("auth");
  });

  test("malformed class (bad NDJSON frame)", async () => {
    const terminal = await runWith(() => new Response("{broken\n"));
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("malformed");
  });

  test("timeout surfaces as network class", async () => {
    const terminal = await runWith(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    );
    expect(terminal.type).toBe("error");
    expect(terminal.kind).toBe("network");
    expect(terminal.error).toMatch(/timeout/);
  });

  test("mid-stream error frame ends the request as an error event", async () => {
    const terminal = await runWith(() =>
      ndjson([
        { message: { role: "assistant", content: "partial " }, done: false },
        { error: "connection reset" },
      ]),
    );
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("connection reset");
    expect(terminal.message.content).toEqual([{ type: "text", text: "partial " }]);
  });
});
