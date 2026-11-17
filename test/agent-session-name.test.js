import { expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { testEnv } from "./fakes.js";

for (const direction of ["agent", "session"]) {
  for (const state of ["unnamed", "matching", "different"]) {
    test(`${direction} rename couples ${state} names only when linked`, async () => {
      const env = await testEnv();
      const agent = await Agent.create({ env, contextId: state === "different" ? "before" : false, ...(state === "different" ? { name: "independent" } : {}) });
      try {
        if (state === "matching") {
          agent.context.rename("before");
          agent.name = state === "matching" ? "before" : "independent";
        }
        const oldAgent = agent.name;
        const oldSession = agent.context.name;
        if (direction === "agent") agent.name = "after";
        else agent.context.rename("after");
        expect(agent.name).toBe(direction === "agent" || state !== "different" ? "after" : oldAgent);
        expect(agent.context.name).toBe(direction === "session" || state !== "different" ? "after" : oldSession);
      } finally {
        await agent.close();
        await env.close();
      }
    });
  }
}
