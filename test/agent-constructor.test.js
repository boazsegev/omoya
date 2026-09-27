import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { Agent } from "../lib/agent.js";
import IO, { Context, Env } from "../lib/io.js";
import { NAMES } from "../lib/namespace.js";
import { USER, testEnv } from "./fakes.js";

function model(env, name = "p", value = "m") {
  return `${name}/${value}`;
}

describe("Agent construction", () => {
  test("composes Env and Context through the IO façade", () => {
    expect(Agent.Env).toBe(Env);
    expect(Agent.Context).toBe(Context);
    expect(Agent.IO).toBe(IO);
    expect(Env.NAMES).toBeUndefined(); // the namespace foundation owns it
    expect(Agent.NAMES).toBe(NAMES);
  });

  test("Env.agentCreate constructs an Agent over its receiver Env", async () => {
    const env = await testEnv();
    const other = await testEnv();
    const agent = env.agentCreate({ env: other, model: model(env), context: [] });
    expect(agent).toBeInstanceOf(Agent);
    expect(agent.env).toBe(env);
    expect(env.agents()).toEqual([agent]);
    expect(other.agents()).toEqual([]);
  });

  test("normalizes one endpoint/model selector", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: model(env, "p", "org/model") });
    expect(agent.endpoint).toBe("p");
    expect(agent.model).toBe("org/model");
  });

  test("rejects malformed, unknown-endpoint, and unknown-model selectors before registration", async () => {
    const env = await testEnv();
    env._endpoints.p.models = { known: {} };
    for (const value of ["p", "/m", "p/"]) {
      expect(() => new Agent({ env, model: value })).toThrow(/model selector/);
    }
    expect(() => new Agent({ env, model: "missing/m" })).toThrow(/unknown endpoint/);
    expect(() => new Agent({ env, model: "p/missing" })).toThrow(/unknown model/);
    expect(env.agents()).toHaveLength(0);
  });

  test("refuses an invalid later selection without changing the active model", async () => {
    const env = await testEnv();
    env._endpoints.p.models = { known: {} };
    const agent = new Agent({ env, model: "p/known" });
    expect(() => agent.modelSet("p/missing")).toThrow(/unknown model/);
    expect(`${agent.endpoint}/${agent.model}`).toBe("p/known");
  });

  test("a string session resumes an existing id and otherwise creates it", async () => {
    const dir = mkdtempSync("./ai-tmp/agent-constructor-");
    const env = await testEnv({ sessions: resolve(dir) });
    const first = new Agent({ env, model: model(env), contextId: "same", context: [USER("first")] });
    first.context.flush();
    const resumed = new Agent({ env, model: model(env), contextId: "same", context: [USER("second")] });
    expect(resumed.context.messages()).toEqual([USER("first\n\nsecond")]);
    expect(resumed.context.id).toBe("same");
    expect(existsSync(resumed.context.file)).toBe(true);
  });

  test("a ready Context is used as the agent's context", async () => {
    const env = await testEnv();
    const store = new Context({ id: "injected", dir: mkdtempSync("./ai-tmp/agent-store-") });
    const agent = new Agent({ env, model: model(env), context: store });
    expect(agent.context).toBe(store);
  });
});
