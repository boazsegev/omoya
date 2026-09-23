// Proof for IO's overall, connection, and stuck-model timeouts.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO, connectBudget, bodyBytes } from "../lib/io.js";

let dir, env;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-time-")));
  env = new Env({ dir, cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeProvider(hooks = {}) {
  return class FakeProvider {
    static provider = { capabilities: {} };
    constructor(url, aiio) { this.url = url; this.aiio = aiio; }
    context2msg(context) { return [{}, { context }]; }
    msg2events(native) { return native.events ?? []; }
    async send(message) { return hooks.send?.(this, message); }
    async read() { return hooks.read ? hooks.read(this) : null; }
    async close() { this.closed = true; }
  };
}

function makeIO({ Protocol = fakeProvider(), environment = env, endpoint = {}, ...options } = {}) {
  if (!environment.provider("fake")) environment.registerProvider("fake", Protocol);
  environment.endpoints.fake = {
    provider: "fake",
    url: "http://fake",
    ...(environment.endpoints.fake ?? {}),
    ...endpoint,
  };
  return new IO({ env: environment, model: "fake/m", ...options });
}

const hangUntilAbort = (connection) => new Promise((_, reject) => {
  connection.aiio.requestSignal.addEventListener("abort", () => reject(connection.aiio.requestSignal.reason));
});

describe("IO timeouts: the three-timeout model", () => {
  test("defaults: overall 1048575ms, connect 30s, stuck 120s", () => {
    const aiio = makeIO();
    expect(aiio.timeout).toBe(1_048_575);
    expect(aiio.connectTimeout).toBe(30_000);
    expect(aiio.stuckTimeout).toBe(120_000);
  });

  test("durations accept unit strings at every layer", () => {
    const aiio = makeIO({ timeout: "17m", connectTimeout: "5s", stuckTimeout: "1.5m" });
    expect(aiio.timeout).toBe(1_020_000);
    expect(aiio.connectTimeout).toBe(5_000);
    expect(aiio.stuckTimeout).toBe(90_000);
  });

  test("endpoint settings carry timeouts", () => {
    const configured = new Env({ dir, cwd: dir, settings: {
      providers: { fake: { provider: "fake", url: "http://fake", stuckTimeout: "45s", timeout: "2h" } },
    } });
    const aiio = makeIO({ environment: configured });
    expect(aiio.stuckTimeout).toBe(45_000);
    expect(aiio.timeout).toBe(7_200_000);
  });

  test("connection timeout aborts a provider with no response", async () => {
    const aiio = makeIO({
      Protocol: fakeProvider({ send: hangUntilAbort }),
      connectTimeout: 30, timeout: 60_000, stuckTimeout: 60_000,
    });
    const message = [{ type: 2, content: [{ type: "text", text: "hi" }] }];
    const terminal = await aiio.write(message);
    const budget = connectBudget(30, bodyBytes({ context: message }));
    expect(terminal).toMatchObject({ type: "error", kind: "network" });
    expect(terminal.error).toContain(`connection timeout after ${budget}ms`);
  });

  test("connection budget grows with request body bytes", async () => {
    expect(connectBudget(30_000, 12_345)).toBe(42_345);
    expect(bodyBytes(null)).toBe(0);
    expect(bodyBytes({ a: "é" })).toBe(Buffer.byteLength(JSON.stringify({ a: "é" }), "utf8"));
    const aiio = makeIO({
      Protocol: fakeProvider({ send: () => new Promise((resolve) => setTimeout(resolve, 100)) }),
      connectTimeout: 30, timeout: 60_000, stuckTimeout: 60_000,
    });
    expect((await aiio.write([{ type: 2, content: [{ type: "text", text: "x".repeat(200) }] }])).type).toBe("done");
  });

  test("stuck model timeout resets after every native message", async () => {
    const script = [
      { events: [{ type: "thinking_start", contentIndex: 0 }] },
      { events: [{ type: "thinking_delta", contentIndex: 0, text: "slow" }] },
      { events: [{ type: "thinking_end", contentIndex: 0 }] },
      { events: [{ type: "text_start", contentIndex: 1 }, { type: "text_delta", contentIndex: 1, text: "answer" }] },
      { events: [{ type: "done" }] },
    ];
    let index = 0;
    const slowRead = async () => { await Bun.sleep(40); return script[index++] ?? null; };
    const aiio = makeIO({ Protocol: fakeProvider({ read: slowRead }), stuckTimeout: 90, timeout: 60_000, connectTimeout: 60_000 });
    const terminal = await aiio.write([{ type: 2, content: [] }]);
    expect(terminal.type).toBe("done");
    expect(terminal.message.content[1]).toEqual({ type: "text", text: "answer" });
  });

  test("a silent read and a forever-active stream both obey their caps", async () => {
    const silent = makeIO({ Protocol: fakeProvider({ read: hangUntilAbort }), stuckTimeout: 30, timeout: 60_000, connectTimeout: 60_000 });
    expect((await silent.write([{ type: 2, content: [] }])).error).toContain("model stuck: no data for 30ms");
    let index = 0;
    const chatty = makeIO({
      Protocol: fakeProvider({ read: (connection) => new Promise((resolve, reject) => {
        connection.aiio.requestSignal.addEventListener("abort", () => reject(connection.aiio.requestSignal.reason), { once: true });
        setTimeout(() => resolve({ events: [{ type: "text_delta", contentIndex: 0, text: `${index++}` }] }), 5);
      }) }),
      timeout: 60, stuckTimeout: 60_000, connectTimeout: 60_000,
    });
    expect((await chatty.write([{ type: 2, content: [] }])).error).toContain("overall cap");
  });
});
