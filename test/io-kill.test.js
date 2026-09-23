// Cancellation preserves the IO lifecycle with endpoint-backed protocols.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";

let dir, env;
beforeEach(() => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-kill-")));
  env = new Env({ dir, cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeProvider(script = [], hooks = {}) {
  return class FakeProvider {
    static provider = {};
    constructor(url, aiio) { this.url = url; this.aiio = aiio; this.queue = [...script]; this.closed = false; }
    context2msg(context) { return [{}, { context }]; }
    msg2events(native) { return native.events ?? []; }
    async send(message) { return hooks.send?.(this, message); }
    async read() { return hooks.read ? hooks.read(this) : this.queue.shift() ?? null; }
    async close() { if (hooks.close) return hooks.close(this); this.closed = true; }
  };
}
function makeIO({ Protocol = fakeProvider(), ...options } = {}) {
  env.registerProvider("fake", Protocol);
  env.endpoints.fake = { provider: "fake", url: "http://fake" };
  return new IO({ env, model: "fake/m", ...options });
}
function streamThenHang() {
  return async (connection) => {
    const next = connection.queue.shift();
    if (next) return next;
    return new Promise((_, reject) => connection.aiio.requestSignal.addEventListener("abort", () => reject(connection.aiio.requestSignal.reason)));
  };
}

describe("aiio.kill()", () => {
  test("cancels an active request, preserves its partial response, and closes", async () => {
    const closed = [];
    const aiio = makeIO({ Protocol: fakeProvider(
      [{ events: [{ type: "text_delta", contentIndex: 0, text: "partial answer" }] }],
      { read: streamThenHang(), close: async (connection) => { closed.push(connection); connection.closed = true; } },
    ) });
    const pending = aiio.write([{ type: 2, content: [] }]);
    await Bun.sleep(10);
    await aiio.kill();
    const terminal = await pending;
    expect(terminal).toMatchObject({ type: "error", cancelled: true, kind: "cancelled" });
    expect(terminal.message.content).toEqual([{ type: "text", text: "partial answer" }]);
    expect(closed.length).toBeGreaterThan(0);
    expect(aiio.state).toBe("closed");
  });

  test("kill without data omits a message, is idempotent, and permanently closes", async () => {
    const aiio = makeIO({ Protocol: fakeProvider([], { read: streamThenHang() }) });
    const pending = aiio.write([{ type: 2, content: [] }]);
    await Bun.sleep(10);
    await aiio.kill();
    expect((await pending).message).toBeUndefined();
    await aiio.kill();
    expect(aiio.state).toBe("closed");
    await expect(aiio.write([{ type: 2, content: [] }])).rejects.toThrow(/permanently disconnected/);
  });

  test("a replacement instance works after a killed instance", async () => {
    const first = makeIO({ Protocol: fakeProvider([], { read: streamThenHang() }) });
    const pending = first.write([{ type: 2, content: [] }]);
    await Bun.sleep(10);
    await first.kill();
    await pending;
    // A new endpoint name permits a fresh class registration in this fixture.
    const Protocol = fakeProvider([{ events: [{ type: "done" }] }]);
    env.registerProvider("replacement", Protocol);
    env.endpoints.replacement = { provider: "replacement", url: "http://replacement" };
    const second = new IO({ env, model: "replacement/m" });
    expect((await second.write([{ type: 2, content: [] }])).type).toBe("done");
    expect(second.state).toBe("idle");
  });

  test("kill during send aborts the transport", async () => {
    const aiio = makeIO({ Protocol: fakeProvider([], { send: (connection) => new Promise((_, reject) => {
      connection.aiio.requestSignal.addEventListener("abort", () => reject(connection.aiio.requestSignal.reason));
    }) }) });
    const pending = aiio.write([{ type: 2, content: [] }]);
    await Bun.sleep(10);
    await aiio.kill();
    expect((await pending).cancelled).toBe(true);
  });
});
