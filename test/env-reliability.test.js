// test/env-reliability.test.js — Env retry timing primitives
import { afterEach, describe, expect, test } from "bun:test";
import { awaitTimeout } from "../lib/env/reliability.js";

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const activeIntervals = new Set();

afterEach(() => {
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  activeIntervals.clear();
});

const never = () => new Promise(() => {});

describe("awaitTimeout", () => {
  test("deadline settlement leaves no polling interval alive", async () => {
    // Regression: the former predicate contract created a 10ms interval,
    // but never cleared it when the deadline won.
    globalThis.setInterval = (callback, ms, ...args) => {
      const handle = nativeSetInterval(callback, ms, ...args);
      activeIntervals.add(handle);
      return handle;
    };
    globalThis.clearInterval = (handle) => {
      activeIntervals.delete(handle);
      return nativeClearInterval(handle);
    };

    await expect(awaitTimeout(1, never)).resolves.toBe(false);
    expect(activeIntervals.size).toBe(0);
  });

  test("deadline aborts the losing event listener", async () => {
    const event = new EventTarget();
    let calls = 0;
    const result = await awaitTimeout(1, (signal) => new Promise((resolve) => {
      event.addEventListener("complete", () => { calls++; resolve(); }, { signal });
    }));
    event.dispatchEvent(new Event("complete"));
    expect(result).toBe(false);
    expect(calls).toBe(0);
  });

  test("completion or rejection clears the losing deadline", async () => {
    const timers = new Set();
    globalThis.setTimeout = (callback, ms, ...args) => {
      const handle = nativeSetTimeout(callback, ms, ...args);
      timers.add(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      timers.delete(handle);
      return nativeClearTimeout(handle);
    };
    let complete;
    const waiting = awaitTimeout(50, () => new Promise((resolve) => { complete = resolve; }));
    complete();
    await expect(waiting).resolves.toBe(true);
    expect(timers.size).toBe(0);

    const rejected = awaitTimeout(50, () => Promise.reject(new Error("completion failed")));
    await expect(rejected).rejects.toThrow("completion failed");
    expect(timers.size).toBe(0);
  });
});
