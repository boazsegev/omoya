import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { listEndpointModels } from "../lib/cli.js";
import OpenAIProvider from "../providers/openai.js";
import { detect, providerAdd, refresh, settingsOf } from "./env-internals.js";

const dirs = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function openaiEnv() {
  const dir = mkdtempSync("./ai-tmp/model-discovery-");
  dirs.push(dir);
  const env = new Env({ dir, cwd: dir, settingsDir: dir, settings: {
    providers: { openai: { provider: "openai", url: "https://api.openai.com/v1" } },
  } });
  providerAdd(env, "openai", OpenAIProvider);
  return env;
}

describe("OpenAI model discovery after startup", () => {
  test("a transient startup timeout does not permanently leave the live endpoint model-less", async () => {
    const env = openaiEnv();
    let calls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-discovered" }] }));
    };
    await refresh(env, { timeout: 15 });
    expect(settingsOf(env, "openai").models ?? {}).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(calls).toBeGreaterThan(1);
    expect(Object.keys(settingsOf(env, "openai").models)).toEqual(["gpt-discovered"]);
    expect(listEndpointModels(env).find(({ name }) => name === "openai")?.models).toEqual(["gpt-discovered"]);
  });

  test("a provider ignoring AbortSignal cannot hold the startup refresh hostage", async () => {
    const env = openaiEnv();
    let resolveFirst;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return new Response(JSON.stringify({ data: [{ id: "late" }] }));
    };
    const started = Date.now();
    await Promise.race([
      refresh(env, { timeout: 15 }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("startup model refresh hung")), 200)),
    ]);
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(settingsOf(env, "openai").models).toHaveProperty("late");
    resolveFirst(new Response(JSON.stringify({ data: [{ id: "obsolete" }] })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Object.keys(settingsOf(env, "openai").models)).toEqual(["late"]);
  });

  test("a failed refresh after earlier discovery does not erase live models", async () => {
    const env = openaiEnv();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 2) throw new Error("temporary outage");
      return new Response(JSON.stringify({ data: [{ id: "working" }] }));
    };
    await refresh(env);
    await refresh(env);
    expect(calls).toBe(2);
    expect(settingsOf(env, "openai").models).toHaveProperty("working");
  });

  test("a hung retry is bounded before the next late-discovery attempt", async () => {
    const env = openaiEnv();
    let calls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
      }
      if (calls === 2) return new Promise(() => {}); // provider ignores retry abort
      return new Response(JSON.stringify({ data: [{ id: "second-retry" }] }));
    };
    await refresh(env, { timeout: 15 });
    await new Promise((resolve) => setTimeout(resolve, 9300));
    expect(calls).toBe(3);
    expect(settingsOf(env, "openai").models).toHaveProperty("second-retry");
  }, 11000);

  test("late discovery refreshes an environment-detected endpoint in memory only", async () => {
    const dir = mkdtempSync("./ai-tmp/model-discovery-");
    dirs.push(dir);
    const env = new Env({ dir, cwd: dir, settingsDir: dir });
    let calls = 0;
    class Wire {
      static provider = {};
      static async detect() {
        return { wire: { provider: "wire", url: "http://wire", dynamic: true } };
      }
      static async models() {
        calls++;
        if (calls === 1) throw new Error("temporary failure");
        return { "late-model": null };
      }
    }
    providerAdd(env, "wire", Wire);
    await detect(env);
    await refresh(env);
    expect(env.models().has("wire/late-model")).toBe(false); // no catalog yet
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(env.models().has("wire/late-model")).toBe(true); // the bounded retry published it
    expect(existsSync(join(dir, "auth-wire.json"))).toBe(false);
  });

  test("an endpoint removed and re-added during a hung probe rejects obsolete publication", async () => {
    const env = openaiEnv();
    let finishOld;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { finishOld = resolve; });
      return new Response(JSON.stringify({ data: [{ id: "new-model" }] }));
    };
    await refresh(env, { timeout: 15 });
    env.logout("openai");
    env.settings.providers.openai = { provider: "openai", url: "https://api.openai.com/v1" };
    await refresh(env);
    finishOld(new Response(JSON.stringify({ data: [{ id: "old-model" }] })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Object.keys(settingsOf(env, "openai").models)).toEqual(["new-model"]);
  });

  test("a dropped endpoint cannot be refreshed by its pending discovery", async () => {
    const env = openaiEnv();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("offline"); };
    await refresh(env);
    env.logout("openai");
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(calls).toBe(1);
    expect(settingsOf(env, "openai").models).toBeUndefined();
  });
});
