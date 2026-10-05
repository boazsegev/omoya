// test/agent-policy.test.js — proof for lib/agent/policy.js: the settings
// an Agent runs by are resolved ONCE, when it is created, from nested
// settings (context, retry, tools), and kept for its lifetime.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { agentPolicy, retryDelay } from "../lib/agent/policy.js";

describe("agentPolicy(settings)", () => {
  test("defaults", () => {
    expect(agentPolicy({})).toEqual({
      context: { cap: 0.9, turn: 0.4, autocompact: false }, // the schema default 0 resolves to false
      retry: { attempts: 3, base: 2_000, max: 30_000 },
      tools: { timeout: 120_000, timeoutLimit: 1_200_000, concurrency: 3 },
    });
  });

  test("fractions accept percentages; durations accept unit strings; invalid numbers fall back", () => {
    const policy = agentPolicy({ context: { cap: 80, turn: 0.25 }, retry: { attempts: 0, base: "1s", max: "5s" }, tools: { timeout: "30s" } });
    expect(policy.context).toEqual({ cap: 0.8, turn: 0.25, autocompact: false });
    expect(policy.retry).toEqual({ attempts: 3, base: 1_000, max: 5_000 });
    expect(policy.tools.timeout).toBe(30_000);
    expect(Object.isFrozen(policy) && Object.isFrozen(policy.context)).toBe(true);
  });

  test("context.autocompact: missing/false never, true = 0.65, a fraction, or a percentage", () => {
    const autocompact = (value) => agentPolicy({ context: { autocompact: value } }).context.autocompact;
    expect(agentPolicy({ context: {} }).context.autocompact).toBe(false);
    expect(autocompact(false)).toBe(false);
    expect(autocompact(true)).toBe(0.65);
    expect(autocompact(0.5)).toBe(0.5);
    expect(autocompact(80)).toBe(0.8);
    expect(autocompact(0)).toBe(false);
    // the whole window is never: 1 = 100% (never 1%), as are 100 and beyond
    for (const never of [1, 1.0, 100, 150]) expect(autocompact(never), String(never)).toBe(false);
    expect(autocompact(99)).toBe(0.99);
    expect(autocompact(0.99)).toBe(0.99);
    expect(autocompact("soon")).toBe(false);
  });

  test("retryDelay doubles from base, capped at max", () => {
    const retry = { base: 100, max: 300 };
    expect(retryDelay(retry, 0)).toBeGreaterThanOrEqual(100);
    expect(retryDelay(retry, 0)).toBeLessThan(125);
    expect(retryDelay(retry, 5)).toBe(300);
  });
});

describe("agent.policy", () => {
  test("is read from env.settings when the Agent is created and kept for its lifetime", () => {
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), settingsDir: null, settings: { context: { cap: 0.7 }, retry: { attempts: 1 } } });
    const agent = new Agent({ env });
    expect(agent.policy.context.cap).toBe(0.7);
    expect(agent.policy.retry.attempts).toBe(1);
    env.settings.context.cap = 0.5;
    expect(agent.policy.context.cap).toBe(0.7); // unchanged mid-life
    const next = new Agent({ env });
    expect(next.policy.context.cap).toBe(0.5);
    agent.close();
    next.close();
  });

  test("the policy keys are Agent's settings schema entries; Env publishes no policy getters", () => {
    const env = new Env({ cwd: mkdtempSync("./ai-tmp/env-case-"), settingsDir: null, settings: {} });
    expect(env.settingsSchema().context.default).toEqual({ cap: 0.9, turn: 0.4, autocompact: 0 }); // a number: 0 = never
    expect(env.settingsSchema().retry.default).toEqual({ attempts: 3, base: 2_000, max: 30_000 });
    for (const gone of ["contextGuardCap", "contextGuardTurnCap", "maxAttempts", "retryDelay", "toolTimeout", "toolTimeoutLimit"]) {
      expect(gone in env, gone).toBe(false);
    }
  });
});

describe("context settings resolve down a tree: global, then endpoint, then model", () => {
  test("per key, the endpoint overrides the global and the model overrides both", () => {
    const settings = { context: { cap: 0.9, turn: 0.4, autocompact: 0.6 } };
    const endpoint = { context: { autocompact: 0.5, turn: 0.3 }, models: { big: { context: { autocompact: 0.8 } } } };
    expect(agentPolicy(settings, endpoint, endpoint.models.small).context).toEqual({ cap: 0.9, turn: 0.3, autocompact: 0.5 });
    expect(agentPolicy(settings, endpoint, endpoint.models.big).context).toEqual({ cap: 0.9, turn: 0.3, autocompact: 0.8 });
    expect(agentPolicy(settings, {}, { context: { autocompact: false } }).context.autocompact).toBe(false);
  });

  test("an Agent applies its pair's overrides and re-resolves when it selects another model", async () => {
    const dir = mkdtempSync("./ai-tmp/policy-"); // the last-used memory lands here, never the package
    const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {
      context: { autocompact: true },
      providers: { p: { provider: "test", url: "test://script" } },
      p: { context: { cap: 0.8 }, models: { m: {}, big: { context: { autocompact: 0.9 } } } },
    } });
    const agent = new Agent({ env, model: "p/m" });
    expect(agent.policy.context).toEqual({ cap: 0.8, turn: 0.4, autocompact: 0.65 });
    (agent.model = "p/big");
    expect(agent.policy.context).toEqual({ cap: 0.8, turn: 0.4, autocompact: 0.9 });
    agent.close();
  });
});
