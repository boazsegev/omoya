import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { Agent, SessionStore } from "../lib/agent.js";
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
    expect(Env.NAMES).toBe(NAMES);
    expect(Agent.NAMES).toBe(Env.NAMES);
  });

  test("Env.createAgent constructs an Agent over its receiver Env", async () => {
    const env = await testEnv();
    const other = await testEnv();
    const agent = env.createAgent({ env: other, model: model(env), context: [] });
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
    env.endpoints.p.models = { known: {} };
    for (const value of ["p", "/m", "p/"]) {
      expect(() => new Agent({ env, model: value })).toThrow(/model selector/);
    }
    expect(() => new Agent({ env, model: "missing/m" })).toThrow(/unknown endpoint/);
    expect(() => new Agent({ env, model: "p/missing" })).toThrow(/unknown model/);
    expect(env.agents()).toHaveLength(0);
  });

  test("refuses an invalid later selection without changing the active model", async () => {
    const env = await testEnv();
    env.endpoints.p.models = { known: {} };
    const agent = new Agent({ env, model: "p/known" });
    expect(() => agent.setModel("p/missing")).toThrow(/unknown model/);
    expect(`${agent.endpoint}/${agent.model}`).toBe("p/known");
  });

  test("a string session resumes an existing id and otherwise creates it", async () => {
    const env = await testEnv();
    const dir = mkdtempSync("./ai-tmp/agent-constructor-");
    const first = new Agent({ env, model: model(env), session: "same", sessionDir: dir, context: [USER("first")] });
    first.session.flush();
    const resumed = new Agent({ env, model: model(env), session: "same", sessionDir: dir, context: [USER("second")] });
    expect(resumed.context).toEqual([USER("first\nsecond")]);
    expect(resumed.session.id).toBe("same");
    expect(existsSync(resumed.session.file)).toBe(true);
  });

  test("an injected session store remains supported", async () => {
    const env = await testEnv();
    const store = new SessionStore({ id: "injected", dir: mkdtempSync("./ai-tmp/agent-store-") });
    const agent = new Agent({ env, model: model(env), session: store });
    expect(agent.session).toBe(store);
  });
});
