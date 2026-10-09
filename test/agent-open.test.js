import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "../lib/agent.js";
import { Env } from "../lib/env.js";
import { Context } from "../lib/context.js";
import { fakeIO, recordingFactory, testEnv } from "./fakes.js";

test("constructor requires an explicit open Env and never acquires one", async () => {
  const env = await testEnv();
  expect(() => new Agent()).toThrow(/Agent.create/);
  expect(() => new Agent({ env: {} })).toThrow(/Agent.create/);
  expect(() => new Agent({ env }, Symbol("invalid"))).toThrow(/Agent.create/);
  expect(Agent.open).toBeUndefined();
  await expect(Agent.create({ env: {} })).rejects.toThrow(/open Env is required/);
  const agent = await Agent.create({ env });
  expect(agent.env).toBe(env);
  await agent.close();
  expect(env.closed).toBe(false);
  await env.close();
  expect(() => new Agent({ env })).toThrow(/Agent.create/);
  await expect(Agent.create({ env })).rejects.toThrow(/open Env is required/);
});

test("Agent.create acquires Env from cwd, not the independent agent folder", async () => {
  const env = await testEnv();
  const folder = resolve(mkdtempSync("./ai-tmp/agent-open-folder-"));
  const calls = [];
  const original = Env.open;
  Env.open = async (...args) => { calls.push(args); return env; };
  try {
    const agent = await Agent.create({ folder });
    expect(calls).toEqual([[process.cwd(), undefined]]);
    expect(agent.folder).toBe(folder);
    expect(agent.env).toBe(env);
    await agent.close();
    expect(env.closed).toBe(false);
  } finally {
    Env.open = original;
    await env.close();
  }
});

test("Agent.create accepts explicit acquisition path and options, and does not reacquire an Env", async () => {
  const env = await testEnv();
  const original = Env.open;
  const calls = [];
  Env.open = async (...args) => { calls.push(args); return env; };
  try {
    const cwd = env.folder;
    const envOptions = { settingsDir: null };
    const acquired = await Agent.create({ cwd, envOptions });
    expect(calls).toEqual([[cwd, envOptions]]);
    await acquired.close();
    const borrowed = await Agent.create({ env });
    expect(calls).toHaveLength(1);
    await borrowed.close();
    await expect(Agent.create({ env, url: "https://example.test" })).rejects.toThrow(/unknown option url/);
    await expect(Agent.create({ env, timeout: 3000 })).rejects.toThrow(/unknown option timeout/);
    await expect(Agent.create({ env, settings: {} })).rejects.toThrow(/unknown option settings/);
    await expect(Agent.create({ env, cwd })).rejects.toThrow(/omitted env/);
  } finally {
    Env.open = original;
    await env.close();
  }
});

test("IO receives only model, tools, and thinking from Agent, with per-request timeout retained", async () => {
  const env = await testEnv();
  const factory = recordingFactory(() => fakeIO(async () => ({ type: "done" })));
  const agent = await Agent.create({ env, model: "p/m", createIO: factory, tools: [] });
  agent.thinking = "high";
  try {
    void agent.io;
    const opts = factory.made[0].opts;
    expect(opts.model).toBe("p/m");
    expect(opts.tools).toEqual([]);
    expect(opts.settings).toEqual({ think: "high" });
    expect(opts).not.toHaveProperty("url");
    expect(opts).not.toHaveProperty("timeout");
    await agent.run({ timeout: 1234 });
    expect(factory.made[0].io.writes[0].options.timeout).toBe(1234);
  } finally {
    await agent.close();
    await env.close();
  }
});

test("legacy saved provider URL and timeout never restore or enter new session snapshots", async () => {
  const env = await testEnv();
  const context = new Context({ messages: [] });
  context.settings = { model: "p/m", url: "https://obsolete.test", timeout: 1, thinking: "low" };
  const agent = await Agent.create({ env, context });
  try {
    expect(agent.model).toBe("p/m");
    expect(agent.thinking).toBe("low");
    expect(agent.url).toBeUndefined();
    expect(agent.timeout).toBeUndefined();
    agent.thinking = "high";
    expect(context.settings).not.toHaveProperty("url");
    expect(context.settings).not.toHaveProperty("timeout");
  } finally {
    await agent.close();
    await env.close();
  }
});
