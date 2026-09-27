import { describe, it, expect } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, testEnv, USER } from "./fakes.js";
import { retryAfterMs } from "../lib/io/retry-after.js";
import { HttpStatusError } from "../lib/io/http.js";

describe("delayed continuation", () => {
  it("retries a 429 after the provider's reported wait, and reports the deadline", async () => {
    const env = await testEnv();
    env.settings.retry = { attempts: 1 };
    const io = scriptedIO([
      [{ type: "error", kind: "provider", status: 429, retryAfterMs: 30, error: "Rate limit reached" }],
      [{ type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    const events = [];
    agent.onEvent(Agent.EVENT.THROTTLED, (value) => events.push(value));
    try {
      const first = await agent.run();
      expect(first.type).toBe("error");
      expect(events[0].until).toBeGreaterThan(Date.now());
      await Bun.sleep(70);
      expect(io.writes).toHaveLength(2);
      expect(agent.throttledUntil).toBeNull();
    } finally { agent.close(); }
  });

  it("accepts the actual OpenAI rate-limit JSON and resumes once", async () => {
    const env = await testEnv();
    env.settings.retry = { attempts: 1 };
    const error = new HttpStatusError(429, "Too Many Requests", JSON.stringify({ error: { message: "Rate limit reached. Please try again in 0.025s." } }));
    const io = scriptedIO([[{ type: "error", kind: "provider", status: error.status, retryAfterMs: retryAfterMs(error), error: error.message }], [{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    try {
      await agent.run();
      await Bun.sleep(75);
      expect(io.writes).toHaveLength(2);
    } finally { agent.close(); }
  });

  it("send overrides the pending timer with an immediate turn", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    try {
      const scheduled = agent.run({ after: 90 });
      await agent.send(USER("new input"));
      expect(await scheduled).toBeNull();
      await Bun.sleep(110);
      expect(io.writes).toHaveLength(1);
      expect(agent.throttledUntil).toBeNull();
    } finally { agent.close(); }
  });

  for (const action of ["close", "cancel"]) {
    it(`${action} cancels a scheduled continuation without a provider request`, async () => {
      const env = await testEnv();
      const io = scriptedIO([[{ type: "done" }]]);
      const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
      try {
        const scheduled = agent.run({ after: 40 });
        expect(agent.throttledUntil).toBeGreaterThan(Date.now());
        await agent[action]();
        expect(await scheduled).toBeNull();
        expect(agent.throttledUntil).toBeNull();
        await Bun.sleep(75);
        expect(io.writes).toHaveLength(0);
      } finally { agent.close(); }
    });
  }

  it("an immediate run cancels a delayed run without a duplicate timer", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    try {
      agent.run({ after: 80 });
      await agent.run();
      await Bun.sleep(110);
      expect(io.writes).toHaveLength(1);
    } finally { agent.close(); }
  });
});
