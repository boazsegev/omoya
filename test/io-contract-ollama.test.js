// test/io-contract-ollama.test.js — connector contract test (AI-CORE
// Testing list): mock HTTP, assert the normalized event/context shape
// for Ollama end to end. Later connectors add theirs as they land.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { isResponseEvent } from "../lib/context.js";
import { isMessage } from "../lib/context.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const realFetch = globalThis.fetch;
let mock;
beforeEach(() => {
  mock = { calls: [] };
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

describe("Ollama connector contract (mock HTTP, normalized shape)", () => {
  let dir, env;
  beforeEach(async () => {
    dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-contract-")));
    env = new Env({
      dir,
      cwd: dir,
      settings: { providers: { ollama: { provider: "ollama", url: "http://mock" } } },
    });
    await env.loadProviders({ dirs: [join(PACKAGE_ROOT, "providers")], detect: false });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("Env scan-load registers ollama from the package providers dir", async () => {
    const pkgEnv = new Env({ dir: PACKAGE_ROOT });
    const names = await pkgEnv.loadProviders();
    expect(names).toContain("ollama");
    const Ollama = pkgEnv.provider("ollama");
    for (const method of ["context2msg", "msg2events", "send", "read", "close", "models", "login"]) {
      expect(typeof Ollama.prototype[method]).toBe("function");
    }
    expect(Ollama.provider.capabilities).toMatchObject({ tools: true, streaming: true });
  });

  test("full request: every emitted event is a valid normalized event", async () => {
    mock.handler = () =>
      ndjson([
        { message: { role: "assistant", content: "The answer " }, done: false },
        { message: { role: "assistant", content: "is 42." }, done: false },
        { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 9, eval_count: 5 },
      ]);
    const aiio = new IO({ env, model: "ollama/qwen3:8b", url: "http://mock" });
    const events = [];
    const terminal = await aiio.write(
      [{ type: 2, content: [{ type: "text", text: "question" }] }],
      new Proxy({}, { get: () => (e) => events.push(e) }),
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(isResponseEvent(event)).toBe(true);

    // terminal envelope: valid message, provider usage, native metadata
    expect(terminal.type).toBe("done");
    expect(isMessage(terminal.message)).toBe(true);
    expect(terminal.message.type).toBe(3);
    expect(terminal.message.content).toEqual([{ type: "text", text: "The answer is 42." }]);
    expect(terminal.usage).toEqual({ inputTokens: 9, outputTokens: 5, source: "provider" });

    // wire shape: one POST to /api/chat with the model and context
    expect(mock.calls).toHaveLength(1);
    const [url, init] = mock.calls[0];
    expect(url).toBe("http://mock/api/chat");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "qwen3:8b",
      stream: true,
      messages: [{ role: "user", content: "question" }],
    });
  });

  test("tool round trip: request schema out, normalized toolCall back", async () => {
    env.registerTool("file-read", () => {}, {
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });
    mock.handler = () =>
      ndjson([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "file-read", arguments: { path: "./a.txt" } } }],
          },
          done: false,
        },
        { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 3, eval_count: 2 },
      ]);
    const aiio = new IO({ env, model: "ollama/m", url: "http://mock" });
    const terminal = await aiio.write([{ type: 2, content: [{ type: "text", text: "read it" }] }]);

    // outgoing: the tool catalog reached the wire as function schemas
    // (the always-registered built-in tool-refresh rides along)
    const body = JSON.parse(mock.calls[0][1].body);
    expect(body.tools.map((t) => t.function.name)).toEqual(["tool-refresh", "file-read"]);
    expect(body.tools.find((t) => t.function.name === "file-read")).toEqual({
      type: "function",
      function: {
        name: "file-read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });

    // incoming: normalized toolCall block with linkage fields intact
    const [block] = terminal.message.content;
    expect(block).toEqual({
      type: "toolCall",
      callId: "ollama-1",
      name: "file-read",
      arguments: { path: "./a.txt" },
    });
  });

  test("metadata passthrough: native frame data rides the terminal event", async () => {
    mock.handler = () =>
      ndjson([{ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 1, prompt_eval_count: 1 }]);
    const aiio = new IO({ env, model: "ollama/m", url: "http://mock" });
    const terminal = await aiio.write([{ type: 2, content: [] }]);
    expect(terminal.doneReason).toBe("stop");
    expect(terminal.native.done_reason).toBe("stop");
  });
});
