// Cancellation preserves the IO lifecycle with endpoint-backed protocols.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Context } from "../lib/context.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { IO } from "../lib/io.js";
import { providerAdd } from "./env-internals.js";

let dir, env;
beforeEach(async () => {
  dir = mkdtempSync((mkdirSync("./ai-tmp", { recursive: true }), join("./ai-tmp/", "io-kill-")));
  env = await Env.open(dir, { dir });
});
afterEach(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

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
  providerAdd(env, "fake", Protocol);
  env.settings.providers.fake = { provider: "fake", url: "http://fake" };
  return new IO({ env, model: "fake/m", ...options });
}
function streamThenHang() {
  return async (connection) => {
    const next = connection.queue.shift();
    if (next) return next;
    return new Promise((_, reject) => connection.signal.addEventListener("abort", () => reject(connection.signal.reason)));
  };
}

describe("aiio.close()", () => {
  test("cancel interrupts a request but leaves IO reusable", async () => {
    const aiio = makeIO({ Protocol: fakeProvider([], { read: streamThenHang() }) });
    const pending = aiio.write(new Context({ messages: [] }));
    await Bun.sleep(10);
    await aiio.cancel();
    expect((await pending).cancelled).toBe(true);
    expect(aiio.state).toBe("idle");
    await aiio.close();
  });
  test("cancels an active request, preserves its partial response, and closes", async () => {
    const closed = [];
    const aiio = makeIO({ Protocol: fakeProvider(
      [{ events: [{ type: "text_delta", contentIndex: 0, text: "partial answer" }] }],
      { read: streamThenHang(), close: async (connection) => { closed.push(connection); connection.closed = true; } },
    ) });
    const pending = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    await Bun.sleep(10);
    await aiio.close();
    const terminal = await pending;
    expect(terminal).toMatchObject({ type: "error", cancelled: true, kind: "cancelled" });
    expect(terminal.message.content).toEqual([{ type: "text", text: "partial answer" }]);
    expect(closed.length).toBeGreaterThan(0);
    expect(aiio.state).toBe("closed");
  });

  test("kill without data omits a message, is idempotent, and permanently closes", async () => {
    const aiio = makeIO({ Protocol: fakeProvider([], { read: streamThenHang() }) });
    const pending = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    await Bun.sleep(10);
    await aiio.close();
    expect((await pending).message).toBeUndefined();
    await aiio.close();
    expect(aiio.state).toBe("closed");
    await expect(aiio.write(new Context({ messages: [{ type: 2, content: [] }] }))).rejects.toThrow(/permanently disconnected/);
  });

  test("a replacement instance works after a killed instance", async () => {
    const first = makeIO({ Protocol: fakeProvider([], { read: streamThenHang() }) });
    const pending = first.write(new Context({ messages: [{ type: 2, content: [] }] }));
    await Bun.sleep(10);
    await first.close();
    await pending;
    // A new endpoint name permits a fresh class registration in this fixture.
    const Protocol = fakeProvider([{ events: [{ type: "text_delta", contentIndex: 0, text: "ok" }, { type: "done" }] }]);
    providerAdd(env, "replacement", Protocol);
    env.settings.providers.replacement = { provider: "replacement", url: "http://replacement" };
    const second = new IO({ env, model: "replacement/m" });
    expect((await second.write(new Context({ messages: [{ type: 2, content: [] }] }))).type).toBe("done");
    expect(second.state).toBe("idle");
  });

  test("concurrent close waits for delayed connection teardown", async () => {
    let release;
    let closing = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const aiio = makeIO({ Protocol: fakeProvider([{ events: [{ type: "done" }] }], {
      close: async () => { closing = true; await gate; },
    }) });
    const request = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    while (!closing) await Bun.sleep(1);
    let finished = false;
    const first = aiio.close().then(() => { finished = true; });
    const second = aiio.close();
    await Bun.sleep(1);
    expect(finished).toBe(false);
    release();
    await Promise.all([request, first, second]);
    expect(aiio.state).toBe("closed");
  });

  test("connection teardown error rejects close after state is closed", async () => {
    let sent;
    const sending = new Promise((resolve) => { sent = resolve; });
    const aiio = makeIO({ Protocol: fakeProvider([{ events: [{ type: "done" }] }], {
      send: () => { sent(); },
      close: async () => { throw new Error("teardown failed"); },
    }) });
    const request = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    await sending;
    await expect(aiio.close()).rejects.toThrow(/teardown failed/);
    await expect(request).rejects.toThrow(/teardown failed/);
    expect(aiio.state).toBe("closed");
  });

  test("kill during send aborts the transport", async () => {
    const aiio = makeIO({ Protocol: fakeProvider([], { send: (connection) => new Promise((_, reject) => {
      connection.signal.addEventListener("abort", () => reject(connection.signal.reason));
    }) }) });
    const pending = aiio.write(new Context({ messages: [{ type: 2, content: [] }] }));
    await Bun.sleep(10);
    await aiio.close();
    expect((await pending).cancelled).toBe(true);
  });
});
