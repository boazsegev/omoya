import { expect, test } from "bun:test";
import { IO } from "../lib/io.js";
import { Agent } from "../lib/agent.js";
import { testEnv } from "./fakes.js";
import { providerAdd } from "./env-internals.js";

class LocalProvider {
  static provider = { capabilities: { thinking: ["none", "low", "high"] } }; 
  constructor(url, io) { this.url = url; this.io = io; }
  async close() {}
}

async function fixture() {
  const env = await testEnv();
  providerAdd(env, "local-config", LocalProvider);
  env.settings.providers.p = {
    provider: "local-config", url: "http://first", timeout: "2s",
    connectTimeout: "3s", stuckTimeout: "4s",
  };
  env.connection("p/m", { remember: false }).authSet({ auth: { token: "first" } });
  return env;
}

test("cached Agent IO reads fresh Env URL, auth, and timeout defaults", async () => {
  const env = await fixture();
  const agent = await Agent.create({ env, model: "p/m" });
  try {
    const io = agent.io;
    expect(io.url).toBe("http://first");
    expect(io.settings.auth.token).toBe("first");
    expect(io.timeout).toBe(2000);
    const first = io.connectionCreate();
    expect(first.url).toBe("http://first");
    await first.close();
    env.settings.providers.p.url = "http://second";
    env.connection("p/m", { remember: false }).authSet({ auth: { token: "second" } });
    env.settings.providers.p.timeout = "5s";
    env.settings.providers.p.connectTimeout = "6s";
    env.settings.providers.p.stuckTimeout = "7s";
    expect(agent.io).toBe(io);
    expect(io.url).toBe("http://second");
    expect(io.settings.auth.token).toBe("second");
    expect(io.timeout).toBe(5000);
    expect(io.connectTimeout).toBe(6000);
    expect(io.stuckTimeout).toBe(7000);
    const second = io.connectionCreate();
    expect(second.url).toBe("http://second");
    await second.close();
  } finally {
    await agent.close();
    await env.close();
  }
});

test("IO rejects provider constructor overrides but retains local thinking and request timeout", async () => {
  const env = await fixture();
  try {
    for (const value of [{ url: "http://other" }, { timeout: 10 }, { connectTimeout: 10 }, { stuckTimeout: 10 }, { settings: { auth: { token: "other" } } }]) {
      expect(() => new IO({ env, model: "p/m", ...value })).toThrow(/IO:/);
    }
    expect(() => IO.timeoutsResolve({ env, model: "p/m", settings: { timeout: 1 } })).toThrow(/configure provider settings on Env/);
    const io = new IO({ env, model: "p/m", settings: { think: "high" } });
    expect(io.settings.think).toBeDefined();
    io.settingsSet("think", "low");
    expect(io.settings.think).toBeDefined();
    expect(() => io.settingsSet("auth", {})).toThrow(/only think/);
    await io.close();
  } finally {
    await env.close();
  }
});

test("auth reload does not pin credentials over subsequent Env changes", async () => {
  const env = await fixture();
  const io = new IO({ env, model: "p/m" });
  try {
    const link = io._link;
    io._link = {
      get settings() { return link.settings; },
      get url() { return link.url; },
      authReload: async () => ({ auth: { token: "retry" }, url: "http://retry" }),
    };
    expect(await io._refreshEndpointAuth()).toBe(true);
    expect(io.settings.auth.token).toBe("retry");
    env.connection("p/m", { remember: false }).authSet({ auth: { token: "fresh" } });
    io._authRetry = undefined; // the write completion clears the transient retry credential
    expect(io.settings.auth.token).toBe("fresh");
    expect(io.url).toBe("http://first");
  } finally {
    await io.close();
    await env.close();
  }
});
