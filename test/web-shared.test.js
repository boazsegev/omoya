import { describe, expect, test } from "bun:test";
import { fetchWithConnectTimeout } from "../tools/web/shared.js";

describe("fetchWithConnectTimeout", () => {
  test("rejects a stalled connection with the configured timeout and aborts its request", async () => {
    const controller = new AbortController();
    const fetchImpl = (_, init) => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("late response")), 100);
      init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    await expect(fetchWithConnectTimeout(fetchImpl, "https://example.test", { signal: controller.signal }, { connectTimeoutMs: 10 })).rejects.toThrow("connection timed out");
    expect(controller.signal.aborted).toBe(false);
  });

  test("preserves caller cancellation after response headers arrive", async () => {
    const controller = new AbortController();
    const response = await fetchWithConnectTimeout((_, init) => ({ signal: init.signal }), "https://example.test", { signal: controller.signal }, { connectTimeoutMs: 10 });
    expect(response.signal.aborted).toBe(false);
    controller.abort(new Error("cancelled"));
    expect(response.signal.aborted).toBe(true);
    expect(response.signal.reason.message).toBe("cancelled");
  });

  test("propagates caller cancellation while connecting", async () => {
    const controller = new AbortController();
    const fetchImpl = (_, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    const pending = fetchWithConnectTimeout(fetchImpl, "https://example.test", { signal: controller.signal }, { connectTimeoutMs: 100 });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
