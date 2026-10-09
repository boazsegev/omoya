// test/base-env-usage.test.js — proof for Env's context-size
// surfaces: contextWindow (settings override vs the cached model
// descriptor) and the sticky tool message/status data the TUI collects. Cumulative
// usage accounting lives on Agent (in memory, never persisted) — see
// test/agent-usage.test.js — Env never tracks or persists it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Env } from "../lib/env.js";
import { contextWindow, toolStatus, toolStatusSet } from "./env-internals.js";
import { updateToolMessage } from "../lib/agent/tool-messages.js";

const tempEnv = async (settings) =>
  await Env.open(mkdtempSync("./ai-tmp/env-case-"), { dir: mkdtempSync("./ai-tmp/env-usage-"), settings });

describe("Env: contextWindow", () => {
  test("the cached model descriptor's contextWindow; null when unknown", async () => {
    const env = await tempEnv({
      providers: { ollama: { provider: "ollama", url: "http://localhost:11434", models: {
        big: { contextWindow: 262144 },
        mystery: null,
      } } },
    });
    expect(contextWindow(env, "ollama", "big")).toBe(262144);
    expect(contextWindow(env, "ollama", "mystery")).toBeNull();
    expect(contextWindow(env, "ollama", "absent")).toBeNull();
    expect(contextWindow(env, "unregistered", "big")).toBeNull();
  });

  test("an explicit provider-settings override wins over the descriptor", async () => {
    const env = await tempEnv({
      providers: { ollama: { provider: "ollama", url: "http://localhost:11434", contextWindow: 32768, models: { big: { contextWindow: 262144 } } } },
    });
    expect(contextWindow(env, "ollama", "big")).toBe(32768);
  });
});

describe("Env: sticky tool status data (TUI collects); the agent owns the messages", () => {
  test("updateToolStatus merges; toolStatus collects live entries", async () => {
    const env = await tempEnv({});
    env.toolAdd("file-read", () => {}, { description: "f", inputSchema: {} });
    expect(toolStatus(env)).toEqual([]);
    toolStatusSet(env, "file-read", { root: "./" });
    expect(toolStatus(env)).toEqual([{ name: "file-read", status: { root: "./" } }]);
    expect(() => toolStatusSet(env, "nope", {})).toThrow(/unknown tool/);
  });

  test("tool dispatch updates/clears agent-local messages; Agent.toolMessages collects", async () => {
    const { Agent } = await import("../lib/agent.js");
    const env = await tempEnv({});
    const agent = await Agent.create({ env });
    expect(agent.toolMessages()).toEqual([]);
    updateToolMessage(agent, "note", "🔵 **write tests**\n✅ **run gates**");
    expect(agent.toolMessages()).toEqual([{ name: "note", text: "🔵 **write tests**\n✅ **run gates**" }]);
    updateToolMessage(agent, "note", null); // cleared
    expect(agent.toolMessages()).toEqual([]);
    expect(() => updateToolMessage(agent, "", "x")).toThrow(/non-empty string/);
  });
});
