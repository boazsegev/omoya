// test/io-provider-test.test.js — proof for the scripted "test"
// connector: predetermined turns (array of block arrays), script from
// settings/inline-JSON/file/env, turn advance + last-turn repeat,
// block translation (thinking/text/toolCall/error), the full IO
// request path (assembled message), fixed local models(), no-script
// failure — all WITHOUT any network or real model.
import { NAMES } from "../lib/namespace.js";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { Env } from "../lib/env.js";
import { IO, defineProvider } from "../lib/io.js";
import TestPlugin from "../providers/test.js";

const TestProvider = defineProvider(TestPlugin, { name: "test" });

const SCRIPT_FILE = `./ai-tmp/test-provider-script-${process.pid}.json`;

beforeEach(() => {
  delete process.env[NAMES.testScriptEnv];
});
afterEach(() => {
  delete process.env[NAMES.testScriptEnv];
  rmSync(SCRIPT_FILE, { force: true });
});

function env() {
  const root = "./ai-tmp/test-provider-env";
  const value = new Env({
    dir: root,
    cwd: root,
    settings: { providers: { test: { provider: "test", url: "test://script", secret: true } } },
  });
  value.registerProvider("test", TestPlugin);
  return value;
}

/** One IO request over the test provider; collects every event. */
async function request(settings, context = [{ type: 2, content: [{ type: "text", text: "hi" }] }]) {
  const aiio = new IO({ env: env(), model: "test/test-model", settings });
  const events = [];
  const terminal = await aiio.write(
    context,
    new Proxy({}, { get: () => (e) => events.push(e) }),
  );
  return { aiio, events, terminal };
}

describe("test provider: metadata + models/login", () => {
  test("provider metadata exposes the pi-pattern surface", () => {
    expect(TestProvider.provider.name).toBe("test");
    expect(typeof TestProvider.provider.label).toBe("string");
    expect(TestProvider.provider).toMatchObject({ secret: true, spawn: true });
    expect(TestProvider.provider.capabilities).toEqual({
      tools: true, thinking: true, streaming: true,
    });
  });

  test("models() is a fixed local map (no network, no auth cache)", async () => {
    const models = await new TestProvider("test://script", {}).models();
    expect(Object.keys(models)).toContain("test-model");
    expect(models["test-model"]).toMatchObject({ label: "Test Model", secret: true });
    expect(models.ui).toMatchObject({ label: "UI demonstration" });
    expect(models["ui-response"]).toMatchObject({ label: "UI worker response" });
  });

  test("login() is a no-auth marker and persists nothing", async () => {
    expect(await new TestProvider("test://script", {}).login()).toEqual({ type: "none" });
  });
});

describe("test provider: script sources", () => {
  test("inline array via settings.script", async () => {
    const { terminal } = await request({ script: [[{ text: "from settings" }]] });
    expect(terminal.type).toBe("done");
    expect(terminal.message.content[0]).toEqual({ type: "text", text: "from settings" });
  });

  test("JSON string via settings.script", async () => {
    const { terminal } = await request({ script: JSON.stringify([[{ text: "from json" }]]) });
    expect(terminal.message.content[0].text).toBe("from json");
  });

  test("file path via settings.script (re-read per request)", async () => {
    writeFileSync(SCRIPT_FILE, JSON.stringify([[{ text: "v1" }], [{ text: "v2" }]]));
    const aiio = new IO({
      env: env(), model: "test/m", settings: { script: SCRIPT_FILE },
    });
    const ctx = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    const first = await aiio.write(ctx);
    // extend the file between turns: the next request re-reads it
    writeFileSync(SCRIPT_FILE, JSON.stringify([[{ text: "v1" }], [{ text: "extended" }]]));
    const second = await aiio.write(ctx);
    expect(first.message.content[0].text).toBe("v1");
    expect(second.message.content[0].text).toBe("extended");
  });

  test("the namespace test-script variable is the fallback source", async () => {
    process.env[NAMES.testScriptEnv] = JSON.stringify([[{ text: "from env" }]]);
    const { terminal } = await request({});
    expect(terminal.message.content[0].text).toBe("from env");
  });

  test("settings.script wins over the namespace test-script variable", async () => {
    process.env[NAMES.testScriptEnv] = JSON.stringify([[{ text: "env" }]]);
    const { terminal } = await request({ script: [[{ text: "settings" }]] });
    expect(terminal.message.content[0].text).toBe("settings");
  });

  test("built-in UI scripts are selected by model", async () => {
    const aiio = new IO({ env: env(), model: "test/ui" });
    const context = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    const turns = [];
    for (let index = 0; index < 10; index++) turns.push(await aiio.write(context));
    expect(turns[0].type).toBe("done");
    expect(turns[0].message.content.some((block) => block.name === "note")).toBe(true);
    const workerCall = turns.flatMap((turn) => turn.message?.content ?? []).find((block) => block.name === "worker");
    expect(workerCall?.arguments).toMatchObject({ name: "ui-response-demo", model: "test/ui-response" });
    expect(turns.flatMap((turn) => turn.message?.content ?? []).some((block) => block.name?.startsWith("chat"))).toBe(false);
  });

  test("no script anywhere fails with an explicit error event", async () => {
    const { terminal } = await request({});
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("test provider: no script");
  });
});

describe("test provider: turn consumption", () => {
  test("turns serve in order per IO; the last turn repeats", async () => {
    const script = [[{ text: "one" }], [{ text: "two" }]];
    const aiio = new IO({ env: env(), model: "test/m", settings: { script } });
    const ctx = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    const t1 = await aiio.write(ctx);
    const t2 = await aiio.write(ctx);
    const t3 = await aiio.write(ctx);
    expect(t1.message.content[0].text).toBe("one");
    expect(t2.message.content[0].text).toBe("two");
    expect(t3.message.content[0].text).toBe("two"); // exhausted: repeat last
  });

  test("a fresh IO restarts the script (per-conversation cursor)", async () => {
    const script = [[{ text: "one" }], [{ text: "two" }]];
    const a = await request({ script });
    const b = await request({ script });
    expect(a.terminal.message.content[0].text).toBe("one");
    expect(b.terminal.message.content[0].text).toBe("one");
  });
});

describe("test provider: block translation", () => {
  test("thinking + text + toolCall blocks become indexed event triples", async () => {
    const { events, terminal } = await request({
      script: [[
        { thinking: "let me think" },
        { text: "visible" },
        { toolCall: { name: "file-read", arguments: { path: "./x" } } },
      ]],
    });
    const types = events.map((e) => `${e.type}:${e.contentIndex ?? ""}`);
    expect(types).toContain("thinking_start:0");
    expect(types).toContain("thinking_delta:0");
    expect(types).toContain("thinking_end:0");
    expect(types).toContain("text_start:1");
    expect(types).toContain("text_end:1");
    expect(types).toContain("toolcall_start:2");
    expect(types).toContain("toolcall_end:2");
    const blocks = terminal.message.content;
    expect(blocks[0]).toEqual({ type: "thinking", text: "let me think" });
    expect(blocks[1]).toEqual({ type: "text", text: "visible" });
    expect(blocks[2].type).toBe("toolCall");
    expect(blocks[2].name).toBe("file-read");
    expect(blocks[2].arguments).toEqual({ path: "./x" });
    expect(blocks[2].callId).toMatch(/^test-/); // generated when omitted
  });

  test("a toolCall keeps a scripted callId", async () => {
    const { terminal } = await request({
      script: [[{ toolCall: { name: "t", callId: "fixed-1" } }]],
    });
    expect(terminal.message.content[0].callId).toBe("fixed-1");
  });

  test("delay blocks pause transport without entering the response", async () => {
    const start = Date.now();
    const { terminal } = await request({ script: [[{ delay: 20 }, { text: "after" }]] });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(terminal.message.content).toEqual([{ type: "text", text: "after" }]);
  });

  test("an error block terminates with the error event", async () => {
    const { terminal } = await request({ script: [[{ error: "boom" }]] });
    expect(terminal.type).toBe("error");
    expect(terminal.error).toBe("boom");
  });

  test("an unknown block fails loudly (never a silent pass)", async () => {
    const { terminal } = await request({ script: [[{ frobnicate: 1 }]] });
    expect(terminal.type).toBe("error");
    expect(terminal.error).toContain("unknown script block");
  });
});

describe("test provider: package scan registration", () => {
  test("Env scan-load registers test from the package providers dir", async () => {
    const pkgEnv = new Env();
    const names = await pkgEnv.loadProviders();
    expect(names).toContain("test");
    const Protocol = pkgEnv.provider("test");
    expect(typeof Protocol).toBe("function");
    expect(typeof Protocol.detectEndpoints).toBe("function");
    for (const method of ["context2msg", "msg2events", "send", "read", "close", "models", "login"]) {
      expect(typeof Protocol.prototype[method]).toBe("function");
    }
  });
});
