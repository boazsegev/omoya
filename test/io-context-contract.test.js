import { test, expect } from "bun:test";
import Context from "../lib/context.js";
import IO from "../lib/io.js";
import Env from "../lib/env.js";
import { providerAdd } from "./env-internals.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("quota belongs to Context and survives replacing its IO", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const dir = mkdtempSync(join("./ai-tmp", "io-quota-"));
  const env = await Env.open(dir, { dir });
  class Protocol {
    static provider = {};
    constructor(url, io) { this.io = io; }
    context2msg() { return [{}, {}]; }
    async send() { this.response = { headers: new Headers() }; }
    reportPlanUsage() { this.io.context.planUsage = { quotas: { requests: { remaining: 9 } } }; }
    async read() { return this.done ? null : (this.done = true, { events: [{ type: "done" }] }); }
    msg2events(frame) { return frame.events; }
    async close() {}
  }
  try {
    providerAdd(env, "quota", Protocol);
    env.settings.providers.quota = { provider: "quota", url: "http://quota" };
    const context = new Context({ messages: [] });
    const first = new IO({ env, model: "quota/m" });
    await first.write(context);
    await first.close();
    const second = new IO({ env, model: "quota/m" });
    expect(context.planUsage).toEqual({ quotas: { requests: { remaining: 9 } } });
    expect(second.planUsage).toBeUndefined();
    expect(second.contextUsage).toBeUndefined();
    await second.close();
  } finally { env.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("changing model invalidates old window but same-model IO replacement retains usage and quota", () => {
  const context = new Context({ messages: [] });
  context.contextUsage = { used: 400, total: 8000 };
  context.planUsage = { quotas: { requests: { remaining: 8 } } };
  // A new IO for the same model shares the Context; neither report is reset.
  expect(context.contextUsage).toEqual({ used: 400, total: 8000 });
  context.contextUsageInvalidate(); // compaction changes contents, not model identity
  expect(context.contextUsage).toEqual({ used: undefined, total: 8000 });
  context.contextUsage = { used: 350 };
  context.contextUsageInvalidate({ window: true }); // actual model identity change
  expect(context.contextUsage).toEqual({ used: undefined, total: undefined });
  expect(context.planUsage).toEqual({ quotas: { requests: { remaining: 8 } } });
});

test("write rejects even valid same-endpoint model overrides without reserving IO", async () => {
  mkdirSync("./ai-tmp", { recursive: true });
  const dir = mkdtempSync(join("./ai-tmp", "io-override-"));
  const env = await Env.open(dir, { dir });
  try {
    class Protocol { static provider = {}; }
    providerAdd(env, "quota", Protocol);
    env.settings.providers.quota = { provider: "quota", url: "http://quota" };
    const io = new IO({ env, model: "quota/m" });
    await expect(io.write(new Context({ messages: [] }), {}, { model: "quota/other" })).rejects.toThrow(/model/);
    expect(io.state).toBe("idle");
    await io.close();
  } finally { env.close(); rmSync(dir, { recursive: true, force: true }); }
});
