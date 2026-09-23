// test/agent-tool-timeout.test.js — proof that tool timeouts belong to
// Agent: Env supplies default/limit, schema-declared timeout is
// extracted and capped, in-process calls are bounded, and onTimeout is
// private Agent metadata with a one-minute grace contract.
import { describe, expect, test } from "bun:test";
import { Env, TOOL_ON_TIMEOUT_LIMIT } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { runWithToolTimeout } from "../lib/agent/tool-timeout.js";

const call = (name, args = {}) => ({ name, callId: `call-${name}`, arguments: args });
const textOf = (outcome) => outcome.message.content[0].text;

function register(env, name, fn, { onTimeout } = {}) {
  env.registerTool(name, fn, {
    safe: true,
    onTimeout,
    description: "test tool",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        timeout: { type: "integer" },
      },
    },
  });
}

describe("Agent-owned tool timeout policy", () => {
  test("Env exposes duration-parsed defaults and the fixed callback grace", () => {
    const defaults = new Env({ settingsDir: null, settings: {} });
    expect(defaults.toolTimeout).toBe(120_000);
    expect(defaults.toolTimeoutLimit).toBe(1_200_000);
    const env = new Env({ settingsDir: null, settings: { toolTimeout: "3s", toolTimeoutLimit: "7m" } });
    expect(env.toolTimeout).toBe(3000);
    expect(env.toolTimeoutLimit).toBe(420_000);
    expect(TOOL_ON_TIMEOUT_LIMIT).toBe(60_000);
  });

  test("a declared timeout is extracted, capped, and onTimeout may return the final result", async () => {
    const env = new Env({ settingsDir: null, settings: { toolTimeout: 100, toolTimeoutLimit: 35 } });
    let invokedArgs;
    let timeoutContext;
    register(env, "timed-final", async (args) => {
      invokedArgs = args;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "late";
    }, {
      onTimeout: (args, context) => {
        expect(args).toEqual({ value: "kept" }); // timeout was extracted
        timeoutContext = context;
        return "final from timeout";
      },
    });
    const agent = new Agent({ env, context: [] });
    const started = Date.now();
    const outcome = await agent._execute(call("timed-final", { value: "kept", timeout: 5000 }));
    expect(Date.now() - started).toBeLessThan(140);
    expect(invokedArgs).toEqual({ value: "kept" });
    expect(timeoutContext.timeout).toBe(35); // hard-capped by Env
    expect(timeoutContext.requestedTimeout).toBe(5000);
    expect(timeoutContext.tool).toBe("timed-final");
    expect(outcome.message.error).toBeUndefined();
    expect(textOf(outcome)).toBe("final from timeout");
  });

  test("cleanup-only onTimeout keeps the ordinary timeout error", async () => {
    const env = new Env({ settingsDir: null, settings: { toolTimeout: 25, toolTimeoutLimit: 100 } });
    let cleaned = 0;
    register(env, "timed-cleanup", () => new Promise(() => {}), {
      onTimeout: () => { cleaned++; },
    });
    const agent = new Agent({ env, context: [] });
    const outcome = await agent._execute(call("timed-cleanup", {}));
    expect(cleaned).toBe(1);
    expect(outcome.message).toMatchObject({ type: 4, error: true, name: "timed-cleanup" });
  });

  test("clears the ordinary deadline after a fast tool settles", async () => {
    const env = new Env({ settingsDir: null, settings: { toolTimeout: 100_000 } });
    const agent = new Agent({ env, context: [] });
    let cleared = 0;
    const outcome = await runWithToolTimeout({
      agent, entry: null, name: "fast", args: {}, call: call("fast"), timeout: 100_000,
      invoke: () => "ok", setTimer: () => ({ unref() {} }), clearTimer: () => { cleared++; },
    });
    expect(outcome).toBe("ok");
    expect(cleared).toBe(1);
  });

  test("onTimeout is validated and stripped from the provider catalog", () => {
    const env = new Env({ settingsDir: null, settings: {} });
    const hook = () => "done";
    register(env, "private-timeout-hook", () => "ok", { onTimeout: hook });
    expect(env.toolEntry("private-timeout-hook").onTimeout).toBe(hook);
    expect(env.toolSchemas()[0].onTimeout).toBeUndefined();
    expect(() => env.registerTool("bad-hook", () => {}, {
      onTimeout: true,
      description: "bad",
      inputSchema: { type: "object", properties: {} },
    })).toThrow(/onTimeout must be a function/);
  });
});
