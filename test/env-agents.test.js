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
    expect(pair(env, "ep/other")).toMatchObject({ maxActive: 4, available: 4 }); // the endpoint default
    expect(pair(env, "ep/m").available).toBe(2); // reading never reserves
  });

  test("uses the first explicit limit from model to endpoint to global without parent caps", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 8 } });
    env.settings.providers.ep = { provider: "test", maxActive: 0, models: { m: { maxActive: 3 }, inherited: {} } };
    env.settings.providers.wide = { provider: "test", maxActive: 16, models: { m: {} } };
    env.settings.providers.default = { provider: "test", models: { m: {}, other: {} } };

    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 3, available: 3 });
    expect(pair(env, "ep/inherited")).toMatchObject({ maxActive: 0, available: 0 });
    expect(pair(env, "wide/m")).toMatchObject({ maxActive: 16, available: 16 });
    expect(pair(env, "default/m")).toMatchObject({ maxActive: 8, available: 8 });
    expect(pair(env, "default/other")).toMatchObject({ maxActive: 8, available: 8 });

    for (let index = 0; index < 9; index++) env._agentAdd({ model: "default/m", busy: true });
    expect(pair(env, "default/other")).toMatchObject({ active: 0, available: 8 }); // the global default is per model
    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 3, available: 3 });
    expect(pair(env, "wide/m")).toMatchObject({ maxActive: 16, available: 16 });
    env._agentAdd({ model: "ep/inherited", busy: true });
    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 3, available: 3 });
    env._agentAdd({ model: "ep/m", busy: true });
    expect(pair(env, "ep/m")).toMatchObject({ maxActive: 3, active: 1, available: 2 });
  });

  test("subtracts only busy agents on each exact model pair", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 4 } });
    env.settings.providers.ep = { provider: "test", maxActive: 3, models: { m: { maxActive: 2 }, other: {} } };
    await agent(env, "ep", "m");
    env._agentAdd({ model: "ep/m", busy: true });

    expect(pair(env, "ep/m")).toMatchObject({ active: 1, available: 1 });
    expect(pair(env, "ep/other")).toMatchObject({ active: 0, available: 3 }); // endpoint defaults do not aggregate models
  });

  test("active counts the exact endpoint/model and inherited limits stay per model", async () => {
    const env = await Env.open(mkdtempSync("./ai-tmp/env-case-"), { settings: { maxActive: 1 } });
    env.settings.providers.foo = { provider: "test", maxActive: 1, models: { bar: { maxActive: 1 }, baz: { maxActive: 1 }, shared: {} } };
    env.settings.providers.other = { provider: "test", models: { bar: { maxActive: 1 } } };
    env._agentAdd({ model: "foo/bar", busy: true });

    expect(pair(env, "foo/bar")).toMatchObject({ active: 1, available: 0 });
    expect(pair(env, "foo/baz")).toMatchObject({ active: 0, available: 1 }); // model caps isolate siblings
    expect(pair(env, "other/bar")).toMatchObject({ active: 0, available: 1 }); // model names do not cross endpoints
    expect(pair(env, "foo/shared")).toMatchObject({ active: 0, available: 1 }); // an endpoint default is per model
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
