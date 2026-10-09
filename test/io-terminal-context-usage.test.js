import { test, expect } from "bun:test";
import { Context } from "../lib/context.js";
import { IO } from "../lib/io.js";
import { Env } from "../lib/env.js";
import { providerAdd } from "./env-internals.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

async function fixture(Protocol) {
  mkdirSync("./ai-tmp", { recursive: true });
  const dir = mkdtempSync(join("./ai-tmp", "io-terminal-usage-"));
  const env = await Env.open(dir, { dir, init: { providers: false, tools: false, detect: false, models: false } });
  providerAdd(env, "terminal-usage", Protocol);
  env.settings.providers["terminal-usage"] = { provider: "terminal-usage", url: "http://terminal-usage" };
  return { dir, env, io: () => new IO({ env, model: "terminal-usage/m" }), cleanup: async () => { await env.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("each terminal updates last-known input count; current explicit report beats its envelope", async () => {
  let turn = 0;
  const inputs = [11, 22, 33, 55];
  const quotaRelease = deferred();
  const quotaReported = deferred();
  class Protocol {
    static provider = {};
    constructor(url, aiio) { this.aiio = aiio; }
    context2msg() { return [{}, {}]; }
    async send() { this.response = { headers: new Headers() }; }
    async reportPlanUsage() {
      const context = this.aiio.context;
      await quotaRelease.promise;
      context.planUsage = { quotas: { requests: { remaining: 7 } } };
      quotaReported.resolve();
    }
    async read() { return this.sent ? null : (this.sent = true, { turn: turn++ }); }
    msg2events({ turn: index }) {
      if (index === 2) this.aiio.context.contextUsage = { used: 22, total: 8000 };
      if (index === 3) this.aiio.context.contextUsage = { used: 44 };
      return [{ type: "text_delta", contentIndex: 0, text: "answer" },
        { type: "done", usage: { inputTokens: inputs[index], outputTokens: 1 } }];
    }
    async close() {}
  }
  const harness = await fixture(Protocol);
  try {
    const context = new Context({ messages: [] });
    const initial = context.contextUsage;
    expect(Object.isFrozen(initial)).toBe(true);
    expect(context.contextUsage).toBe(initial);
    context.contextUsage = { used: 0 };
    expect(context.contextUsage).not.toBe(initial);
    const same = context.contextUsage;
    context.contextUsage = { used: 0 };
    expect(context.contextUsage).not.toBe(same);
    const beforeInvalidation = context.contextUsage;
    context.contextUsageInvalidate();
    expect(context.contextUsage).not.toBe(beforeInvalidation);
    expect(context.contextUsage).toEqual({ used: undefined, total: undefined });
    context.planUsage = { quotas: { requests: { remaining: 8 } } };
    const io = harness.io();
    const observed = [];
    for (const expected of [11, 22, 22, 44]) {
      const event = await io.write(context, { onDone: () => observed.push(context.contextUsage.used) });
      expect(event.usage.source).toBe("provider");
      expect(context.contextUsage.used).toBe(expected);
    }
    expect(observed).toEqual([11, 22, 22, 44]);
    expect(context.planUsage).toEqual({ quotas: { requests: { remaining: 8 } } });
    quotaRelease.resolve();
    await quotaReported.promise;
    expect(context.planUsage).toEqual({ quotas: { requests: { remaining: 7 } } });
    expect(context.contextUsage.used).toBe(44);
    await io.close();
    const replacement = harness.io();
    expect(context.contextUsage).toEqual({ used: 44, total: 8000 });
    expect(context.planUsage).toEqual({ quotas: { requests: { remaining: 7 } } });
    await replacement.close();
  } finally { quotaRelease.resolve(); await harness.cleanup(); }
});

test("cancel racing final connection teardown remains reusable, and blocks writes until teardown", async () => {
  const closing = deferred();
  const release = deferred();
  let closes = 0;
  class Protocol {
    static provider = {};
    context2msg() { return [{}, {}]; }
    async send() {}
    async read() { return this.sent ? null : (this.sent = true, { events: [
      { type: "text_delta", contentIndex: 0, text: "answer" }, { type: "done" },
    ] }); }
    msg2events(frame) { return frame.events; }
    async close() { if (++closes === 1) { closing.resolve(); await release.promise; } }
  }
  const harness = await fixture(Protocol);
  try {
    const io = harness.io();
    const context = new Context({ messages: [] });
    const first = io.write(context);
    await closing.promise;
    const cancel = io.cancel();
    expect(io.state).toBe("cancelling");
    await expect(io.write(context)).rejects.toThrow(/no concurrent in-flight requests/);
    release.resolve();
    await cancel;
    expect((await first).type).toBe("done");
    expect(io.state).toBe("idle");
    expect((await io.write(context)).type).toBe("done");
    await io.close();
  } finally { release.resolve(); await harness.cleanup(); }
});

test("close racing final connection teardown cannot expose idle or permit another write", async () => {
  const closing = deferred();
  const release = deferred();
  class Protocol {
    static provider = {};
    context2msg() { return [{}, {}]; }
    async send() {}
    async read() { return { events: [{ type: "text_delta", contentIndex: 0, text: "answer" }, { type: "done" }] }; }
    msg2events(frame) { return frame.events; }
    async close() { closing.resolve(); await release.promise; }
  }
  const harness = await fixture(Protocol);
  try {
    const io = harness.io();
    const context = new Context({ messages: [] });
    const first = io.write(context);
    await closing.promise;
    const close = io.close();
    expect(io.state).toBe("closing");
    await expect(io.write(context)).rejects.toThrow(/no concurrent in-flight requests/);
    release.resolve();
    await close;
    expect((await first).type).toBe("done");
    expect(io.state).toBe("closed");
    await expect(io.write(context)).rejects.toThrow(/permanently disconnected/);
  } finally { release.resolve(); await harness.cleanup(); }
});
