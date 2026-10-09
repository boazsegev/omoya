import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";

const agent = async (env, endpoint, model) => await Agent.create({ env, model: `${endpoint}/${model}` });

describe("Env active-Agent capacity inspection", () => {
  test("Agent permits no endpoint but rejects an unknown named endpoint", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), {  });
    expect(await Agent.create({ env })).toBeInstanceOf(Agent);
    await expect(Agent.create({ env, model: "missing/m" })).rejects.toThrow('unknown endpoint: "missing"');
    expect(env.agents()).toHaveLength(1);
  });

  /** One pair's catalog entry (the Agent plugin adds maxActive/active/available). */
  const pair = (env, selector) => env.models(true).get(selector);

  test("reports global, endpoint, and model capacity without reserving it", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 5 } });
    env.settings.providers.ep = { provider: "test", maxActive: 4, models: { m: { maxActive: 2 }, other: {} } };
    await agent(env, "ep", "m");

    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 2, active: 0, available: 2 });
    expect(pair(env, "ep/other")).toMatchObject({ maxActive: 4, available: 4 }); // the endpoint cap
    expect(pair(env, "ep/m").available).toBe(2); // reading never reserves
  });

  test("subtracts only busy agents from global, endpoint, and model capacity", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 4 } });
    env.settings.providers.ep = { provider: "test", maxActive: 3, models: { m: { maxActive: 2 }, other: {} } };
    await agent(env, "ep", "m");
    env._agentAdd({ model: "ep/m", busy: true });

    expect(pair(env, "ep/m")).toMatchObject({ active: 1, available: 1 });
    expect(pair(env, "ep/other")).toMatchObject({ active: 0, available: 2 }); // the endpoint's busy agent counts
  });

  test("does not consume capacity for registered idle agents", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 4 } });
    env.settings.providers.ep = { provider: "test", maxActive: 3, models: { m: { maxActive: 2 }, other: {} } };
    await agent(env, "ep", "m");

    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 2, available: 2 });
    expect(pair(env, "ep/other").available).toBe(3);
  });

  test("treats false endpoint or model policy as unavailable", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 4 } });
    env.settings.providers.ep = { provider: "test", models: { m: { maxActive: false } } };
    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 0, available: 0 });
  });

  test("a limit changes as a settings write", async () => {
    const dir = mkdtempSync("./ai-tmp/env-agents-");
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir, settingsDir: dir, settings: { maxActive: 4 } });
    env.settings.providers.ep = { provider: "test", models: { m: {} } };
    expect(pair(env, "ep/m").maxActive).toBe(4);
    env.settings.providers.ep.models.m.maxActive = 1;
    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 1, available: 1 });
  });
});
