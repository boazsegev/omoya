// test/env-model-windows.test.js — proof for the context-window
// fallbacks: the models.dev registry (lib/env/model-windows.js — one
// shared background download per process, synchronous reads) and
// the curated current-tier table (Context.fallbackContextWindow) that
// covers the gap until a lookup lands.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { contextWindowsLoad, registryContextWindow, registryCacheReset } from "../lib/env/model-windows.js";
import { Env } from "../lib/env.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import Context from "../lib/context.js";
import { contextWindow } from "./env-internals.js";
const { fallbackContextWindow, FALLBACK_CONTEXT_WINDOWS } = Context;

/** A fresh package + user settings folder (settings writes stay inside it). */
const isolated = (prefix) => {
  const dir = mkdtempSync(`./ai-tmp/${prefix}`);
  return { dir, settingsDir: dir };
};
const realFetch = globalThis.fetch;
mkdirSync("./ai-tmp", { recursive: true });
// The registry load is process-global: every test starts cold so its own
// fetch stub is the one consulted.
beforeEach(() => { registryCacheReset(); });
afterEach(() => { globalThis.fetch = realFetch; registryCacheReset(); });

const registryBody = { openai: { models: {
  "gpt-6-sol": { limit: { context: 1050000, output: 128000 } },
  "gpt-6-luna": { limit: { context: 1050000 } },
} } };

describe("fallbackContextWindow: the curated current-tier table", () => {
  test("exact ids and prefix variants resolve; unknown ids don't", () => {
    expect(fallbackContextWindow("gpt-6-sol")).toBe(FALLBACK_CONTEXT_WINDOWS["gpt-6"]);
    expect(fallbackContextWindow("gpt-6-astra")).toBe(FALLBACK_CONTEXT_WINDOWS["gpt-6"]);
    expect(fallbackContextWindow("o3-2025-04-16")).toBe(200000); // date-stamped variant via prefix
    expect(fallbackContextWindow("o3")).toBe(200000);
    expect(fallbackContextWindow("gpt-5.5")).toBeNull(); // not in the current-tier table
    expect(fallbackContextWindow("mystery")).toBeNull();
    expect(fallbackContextWindow("")).toBeNull();
    expect(fallbackContextWindow(undefined)).toBeNull();
  });
});

describe("contextWindowsLoad: one background models.dev download per process", () => {
  test("concurrent loads share ONE fetch; reads are synchronous and null until it lands", async () => {
    let fetches = 0;
    let release;
    globalThis.fetch = async () => {
      fetches++;
      await new Promise((resolve) => { release = resolve; });
      return Response.json(registryBody);
    };
    const first = contextWindowsLoad();
    // every paint/status read before the download lands: no new fetch, no await
    for (let i = 0; i < 100; i++) {
      expect(contextWindowsLoad()).toBe(first);
      expect(registryContextWindow("gpt-6-sol")).toBeNull();
    }
    release();
    expect(await first).toBe(true);
    expect(registryContextWindow("gpt-6-sol")).toBe(1050000);
    expect(registryContextWindow("not-a-model")).toBeNull();
    expect(await contextWindowsLoad()).toBe(true);
    expect(fetches).toBe(1);
  });

  test("an offline registry settles false, never throws, and is not retried", async () => {
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error("offline"); };
    expect(await contextWindowsLoad()).toBe(false);
    expect(await contextWindowsLoad()).toBe(false);
    expect(registryContextWindow("gpt-6-sol")).toBeNull();
    expect(fetches).toBe(1);
  });

  test("a pair's caps.contextWindow never fetches: settings/cache first, registry fallback once loaded", async () => {
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return Response.json(registryBody); };
    const env = new Env({ ...isolated("model-windows-"), settings: { providers: {
      openai: { provider: "openai", url: "http://127.0.0.1:1/v1", models: { "gpt-6-sol": {}, "local-custom": { contextWindow: 400000 } } },
    } } });
    expect(contextWindow(env, "openai", "gpt-6-sol")).toBeNull();
    expect(fetches).toBe(0);
    expect(await contextWindowsLoad()).toBe(true);
    expect(contextWindow(env, "openai", "gpt-6-sol")).toBe(1050000);
    expect(contextWindow(env, "openai", "local-custom")).toBe(400000); // cache when registry has no match
    expect(fetches).toBe(1);
  });

  test("a loaded registry replaces stale OpenAI API cache for user-named endpoints, not overrides or account catalogs", async () => {
    globalThis.fetch = async () => Response.json(registryBody);
    const env = new Env({ ...isolated("model-windows-"), settings: { providers: {
      jimmy: { provider: "openai", url: "https://api.openai.com/v1", models: { "gpt-6-sol": { contextWindow: 262144 } } },
      subscription: { provider: "openai", url: "https://chatgpt.com/backend-api/codex", models: { "gpt-6-sol": { contextWindow: 262144, maxContextWindow: 1050000 } } },
    } } });
    expect(contextWindow(env, "jimmy", "gpt-6-sol")).toBe(262144); // before download
    expect(contextWindow(env, "subscription", "gpt-6-sol")).toBe(1050000); // existing cached catalog
    expect(await contextWindowsLoad()).toBe(true);
    expect(contextWindow(env, "jimmy", "gpt-6-sol")).toBe(1050000);
    expect(contextWindow(env, "subscription", "gpt-6-sol")).toBe(1050000); // account catalog wins
    env.settings.jimmy = { ...env.settings.jimmy, contextWindow: 32768 };
    expect(contextWindow(env, "jimmy", "gpt-6-sol")).toBe(32768);
  });
});
