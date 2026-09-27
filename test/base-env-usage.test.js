// test/base-env-usage.test.js — proof for Env's context-size
// surfaces: contextWindow (settings override vs the cached model
// descriptor) and the sticky tool message/status data the TUI collects. Cumulative
// usage accounting lives on Agent (in memory, never persisted) — see
// test/agent-usage.test.js — Env never tracks or persists it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { contextWindow, toolStatus, toolStatusSet } from "./env-internals.js";

const tempEnv = (settings) =>
  new Env({ dir: mkdtempSync("./ai-tmp/env-usage-"), settings });

describe("Env: contextWindow", () => {
  test("the cached model descriptor's contextWindow; null when unknown", () => {
    const env = tempEnv({
      providers: { ollama: { provider: "ollama", url: "http://localhost:11434" } },
      ollama: { models: {
        big: { contextWindow: 262144 },
        mystery: null,
      } },
    });
    expect(contextWindow(env, "ollama", "big")).toBe(262144);
    expect(contextWindow(env, "ollama", "mystery")).toBeNull();
    expect(contextWindow(env, "ollama", "absent")).toBeNull();
    expect(contextWindow(env, "unregistered", "big")).toBeNull();
  });

  test("an explicit provider-settings override wins over the descriptor", () => {
    const env = tempEnv({
      providers: { ollama: { provider: "ollama", url: "http://localhost:11434" } },
      ollama: { contextWindow: 32768, models: { big: { contextWindow: 262144 } } },
    });
    expect(contextWindow(env, "ollama", "big")).toBe(32768);
  });
});

describe("Env: sticky tool status data (TUI collects); the agent owns the messages", () => {
  test("updateToolStatus merges; toolStatus collects live entries", () => {
    const env = tempEnv({});
    env.toolAdd("file-read", () => {}, { description: "f", inputSchema: {} });
    expect(toolStatus(env)).toEqual([]);
    toolStatusSet(env, "file-read", { root: "./" });
    expect(toolStatus(env)).toEqual([{ name: "file-read", status: { root: "./" } }]);
    expect(() => toolStatusSet(env, "nope", {})).toThrow(/unknown tool/);
  });

  test("Agent.toolMessageSet sets/clears on the AGENT; toolMessages collects", async () => {
    const { Agent } = await import("../lib/agent.js");
    const env = tempEnv({});
    const agent = new Agent({ env });
    expect(agent.toolMessages()).toEqual([]);
    agent.toolMessageSet("note", "🔵 **write tests**\n✅ **run gates**");
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🔵 **write tests**\n✅ **run gates**" }]);
    agent.toolMessageSet("note", null); // cleared
    expect(agent.toolMessages()).toEqual([]);
    expect(() => agent.toolMessageSet("", "x")).toThrow(/non-empty string/);
  });
});
