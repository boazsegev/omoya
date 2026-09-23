import { describe, expect, test } from "bun:test";
import Env from "../lib/env.js";
import { Agent } from "../lib/agent.js";

const agent = (env, endpoint, model) => new Agent({ env, model: `${endpoint}/${model}` });

describe("Env active-Agent capacity inspection", () => {
  test("Agent permits no endpoint but rejects an unknown named endpoint", () => {
    const env = new Env();
    expect(() => new Agent({ env })).not.toThrow();
    expect(() => new Agent({ env, model: "missing/m" })).toThrow('unknown endpoint: "missing"');
    expect(env.agents()).toHaveLength(1);
  });

  test("reports global, endpoint, and model capacity without reserving it", () => {
    const env = new Env({ settings: { maxActive: 5 } });
    env.endpoints.ep = { provider: "test", maxActive: 4, models: { m: { maxActive: 2 } } };
    agent(env, "ep", "m");

    expect(env.agentsAt("ep")).toBe(1);
    expect(env.agentsAt("ep", "m")).toBe(1);
    expect(env.agentsEndpointLimit("ep", "m")).toEqual({ excluded: false, cap: 2 });
    expect(env.agentEndpointAvailable("ep", "m")).toBe(2);
    expect(env.agentEndpointAvailable("ep", "other")).toBe(4);
    expect(env.agentEndpointAvailable("ep", "m")).toBe(2);
  });

  test("subtracts only busy agents from global, endpoint, and model capacity", () => {
    const env = new Env({ settings: { maxActive: 4 } });
    env.endpoints.ep = { provider: "test", maxActive: 3, models: { m: { maxActive: 2 } } };
    agent(env, "ep", "m");
    env.registerAgent({ endpoint: "ep", model: "m", busy: true });

    expect(env.agentEndpointAvailable("ep", "m")).toBe(1);
    expect(env.agentEndpointAvailable("ep")).toBe(2);
  });

  test("does not consume capacity for registered idle agents", () => {
    const env = new Env({ settings: { maxActive: 4 } });
    env.endpoints.ep = { provider: "test", maxActive: 3, models: { m: { maxActive: 2 } } };
    agent(env, "ep", "m");

    expect(env.agentsEndpointLimit("ep", "m")).toEqual({ excluded: false, cap: 2 });
    expect(env.agentEndpointAvailable("ep", "m")).toBe(2);
    expect(env.agentEndpointAvailable("ep")).toBe(3);
  });

  test("treats false endpoint or model policy as unavailable", () => {
    const env = new Env({ settings: { maxActive: 4 } });
    env.endpoints.ep = { provider: "test", models: { m: { maxActive: false } } };
    expect(env.agentsEndpointLimit("ep", "m")).toEqual({ excluded: true, cap: 0 });
    expect(env.agentEndpointAvailable("ep", "m")).toBe(0);
  });
});
