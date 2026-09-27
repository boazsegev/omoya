import { describe, it, expect } from "bun:test";
import { Agent } from "../lib/agent.js";
import { msg2events } from "../lib/io/openai.js";
import { testEnv, USER } from "./fakes.js";
import { IO } from "../lib/io.js";
import { AgentSession } from "../lib/app/web/session.js";
import { contextBlocks } from "../lib/app/tui/context-blocks.js";
import { providerAdd } from "./env-internals.js";

describe("OpenAI stream rate limit", () => {
  it("schedules the retry reported by an SSE response.failed event", async () => {
    const env = await testEnv();
    env.settings.retry = { attempts: 1 };
    const native = { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt-6-luna. Please try again in 0.045s." } } };
    let writes = 0;
    providerAdd(env, "stream", class {
      context2msg() { return [{}, {}]; }
      msg2events(message) { return msg2events(message, {}, this.aiio); }
      async send() { writes++; this.items = writes === 1 ? [native] : [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]; }
      async read() { return this.items.shift() ?? null; }
      async close() {}
    });
    env._endpoints.stream = { provider: "stream", url: "http://fake" };
    const agent = new Agent({ env, model: "stream/m", context: [USER("go")], createIO: (options) => new IO(options) });
    try {
      const terminal = await agent.run();
      expect(terminal.message.error).toMatchObject({ message: expect.stringContaining("Rate limit reached"), retry: 45 });
      expect(agent.throttledUntil).toBeGreaterThan(Date.now());
      await Bun.sleep(90);
      expect(writes).toBe(2);
      expect(agent.context.messages().at(-1).error).toBeUndefined();
    } finally { agent.close(); }
  });

  it("retains a structured failed message for display and retracts it on continuation", async () => {
    const env = await testEnv();
    env.settings.retry = { attempts: 1 };
    let writes = 0;
    providerAdd(env, "stream", class {
      context2msg() { return [{}, {}]; }
      msg2events(message) { return msg2events(message, {}, this.aiio); }
      async send() { writes++; this.items = writes === 1 ? [{ type: "error", error: { code: "rate_limit_exceeded", message: "Please try again in 0.2s." } }] : [{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]; }
      async read() { return this.items.shift() ?? null; }
      async close() {}
    });
    env._endpoints.stream = { provider: "stream", url: "http://fake" };
    const agent = new Agent({ env, model: "stream/m", context: [USER("go")], createIO: (options) => new IO(options) });
    try {
      await agent.run();
      expect(agent.context.messages().at(-1).error).toEqual({ message: "Please try again in 0.2s.", retry: 200 });
      const session = new AgentSession(agent);
      expect(session.historySnapshot().at(-1)).toMatchObject({ kind: "error", text: "Please try again in 0.2s." });
      session.dispose();
      expect(contextBlocks(agent.context.messages()).some((block) => block.type === "error" && block.text === "Please try again in 0.2s.")).toBe(true);
      await agent.run();
      expect(agent.throttledUntil).toBeNull();
      expect(writes).toBe(2);
    } finally { agent.close(); }
  });
});
