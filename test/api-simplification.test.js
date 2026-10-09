import { describe, expect, test } from "bun:test";
import Agent from "../lib/agent.js";
const { Env, IO } = Agent;
import { testEnv } from "./fakes.js";

describe("0.3.0 Env and Agent ownership", () => {
  test("replacing IO preserves Context data and validates before mutation", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, model: "p/m" });
    const context = agent.context;
    context.planUsage = { quotas: { requests: { remaining: 3 } } };
    await env._providersLoad({ detect: false });
    const replacement = new IO({ env, model: "p2/m" });
    agent.io = replacement;
    expect(agent.io).toBe(replacement);
    expect(agent.model).toBe("p2/m");
    expect(agent.context).toBe(context);
    expect(context.planUsage.quotas.requests.remaining).toBe(3);
    expect(agent.planUsage).toBeUndefined();
    expect(() => { agent.io = {}; }).toThrow("idle IO");
    expect(agent.io).toBe(replacement);
    await agent.close();
  });
  test("Agent owns membership lifecycle without public Env mutation methods", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env });
    expect(env.agentAdd).toBeUndefined();
    expect(env.agentRemove).toBeUndefined();
    expect(env.agents()).toEqual([agent]);
    await agent.close();
    expect(env.agents()).toEqual([]);
  });

  test("Env owns catalog formatting and Agent retains only skill activation", async () => {
    const env = await testEnv();
    for (const name of ["skillCatalog", "promptCatalog", "skillSection"]) {
      expect(Agent[name]).toBeUndefined();
      expect(typeof env[name]).toBe("function");
    }
    expect(typeof Agent.prototype.skillLoad).toBe("function");
    expect(env.skillCatalog()).toStartWith("# Skill Catalog\n");
    expect(env.promptCatalog()).toStartWith("# Prompt Catalog\n");
    expect(env.skillSection({ name: 'a "quoted" skill', body: "body" })).toBe('<skill name="a &quot;quoted&quot; skill">\nbody\n</skill>');
    expect(Env.prototype.skillSection).toBeDefined();
  });

  test("skillLoad injects once, validates atomically, and resets with a new Context", async () => {
    const env = await testEnv();
    env.skills = () => new Map([["alpha", { name: "alpha", body: "guidance" }]]);
    const agent = await Agent.create({ env });
    expect(() => agent.skillLoad(["alpha", "missing"])).toThrow("Unknown skills");
    expect(agent.context.length).toBe(0);
    expect(agent.skillLoad("alpha")).toBe("Loaded skills: alpha.");
    const length = agent.context.length;
    agent.skillLoad(["alpha", "alpha"]);
    expect(agent.context.length).toBe(length);
    const fresh = await Agent.create({ env });
    fresh.skillLoad("alpha");
    expect(fresh.context.messages().some((message) => message.content?.some((block) => block.text?.includes("guidance")))).toBe(true);
    await fresh.close();
    await agent.close();
    expect(() => agent.skillLoad("alpha")).toThrow("closed");
  });
});
