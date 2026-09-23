// test/base-env-usage.test.js — proof for Env's context-size
// surfaces: contextWindow (settings override vs the cached model
// descriptor), contextConsumption (provider count vs the estimate),
// and the sticky tool message/status data the TUI collects. Cumulative
// usage accounting lives on Agent (in memory, never persisted) — see
// test/agent-usage.test.js — Env never tracks or persists it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";

const tempEnv = (settings) =>
  new Env({ dir: mkdtempSync("./ai-tmp/env-usage-"), settings });

describe("Env: contextWindow", () => {
  test("the cached model descriptor's contextWindow; null when unknown", () => {
    const env = tempEnv({
      ollama: { models: {
        big: { contextWindow: 262144 },
        mystery: null,
      } },
    });
    expect(env.contextWindow("ollama", "big")).toBe(262144);
    expect(env.contextWindow("ollama", "mystery")).toBeNull();
    expect(env.contextWindow("ollama", "absent")).toBeNull();
    expect(env.contextWindow("unregistered", "big")).toBeNull();
  });

  test("an explicit provider-settings override wins over the descriptor", () => {
    const env = tempEnv({
      ollama: { contextWindow: 32768, models: { big: { contextWindow: 262144 } } },
    });
    expect(env.contextWindow("ollama", "big")).toBe(32768);
  });
});

describe("Env: contextConsumption", () => {
  const context = [
    { type: 2, content: [{ type: "text", text: "one two three four five six" }] },
  ];

  test("the provider-reported input count wins when present", () => {
    const env = tempEnv({});
    expect(env.contextConsumption(context, { inputTokens: 1234 })).toBe(1234);
  });

  test("otherwise the word-count estimate of the live context", () => {
    const env = tempEnv({});
    const estimated = env.contextConsumption(context, null);
    expect(estimated).toBeGreaterThan(0);
    expect(estimated).toBeLessThan(100);
  });
});

describe("Env: sticky tool status data (TUI collects); the agent owns the messages", () => {
  test("updateToolStatus merges; toolStatus collects live entries", () => {
    const env = tempEnv({});
    env.registerTool("file-read", () => {}, { description: "f", inputSchema: {} });
    expect(env.toolStatus()).toEqual([]);
    env.updateToolStatus("file-read", { root: "./" });
    expect(env.toolStatus()).toEqual([{ name: "file-read", status: { root: "./" } }]);
    expect(() => env.updateToolStatus("nope", {})).toThrow(/unknown tool/);
  });

  test("Agent.updateToolMessage sets/clears on the AGENT; toolMessages collects", async () => {
    const { Agent } = await import("../lib/agent.js");
    const env = tempEnv({});
    const agent = new Agent({ env });
    expect(agent.toolMessages()).toEqual([]);
    agent.updateToolMessage("note", "🔵 **write tests**\n✅ **run gates**");
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🔵 **write tests**\n✅ **run gates**" }]);
    agent.updateToolMessage("note", null); // cleared
    expect(agent.toolMessages()).toEqual([]);
    expect(() => agent.updateToolMessage("", "x")).toThrow(/non-empty string/);
  });
});
