import { beforeEach, describe, expect, test } from "bun:test";
import { __resetWebRateForTests, rateEnter, throttlePause, webBudgetMs, sleepAbortable, webRateSettings } from "../tools/web/shared.js";

beforeEach(__resetWebRateForTests);

describe("shared web burst policy", () => {
  test("defaults expose only burst and success throttle settings", () => {
    expect(webRateSettings()).toEqual({ calls: 8, windowMs: 40_000, startAt: 0.20, step: 0.05, stepMs: 1_000 });
    expect(webRateSettings({ limit: { calls: 12 }, throttle: { stepMs: 0 } }).calls).toBe(12);
    for (const web of [{ limit: { calls: 0 } }, { limit: { windowMs: -1 } }, { throttle: { startAt: 2 } }, { throttle: { stepMs: -1 } }, { throttle: { step: 0 } }, { limit: null }, { throttle: "off" }]) {
      expect(() => webRateSettings(web)).toThrow();
    }
  });

  test("budget uses actual deadlines and configurable shared tool defaults", () => {
    expect(webBudgetMs()).toBe(120_000);
    expect(webBudgetMs({ env: { settings: { tools: { timeout: "30s" } } } })).toBe(30_000);
    expect(webBudgetMs({ env: { settings: { tools: { timeout: "3m", timeoutLimit: "1m" } } } })).toBe(60_000);
    const deadline = Date.now() + 5000;
    expect(webBudgetMs({ deadline, env: { settings: { tools: { timeout: "30s" } } } })).toBeLessThanOrEqual(5000);
    expect(webBudgetMs({ deadline: Date.now() - 1 })).toBe(0);
  });

  test("30-second actual window caps a full-pressure success pause to 15 seconds", async () => {
    const pauses = [];
    const leave = await rateEnter(webRateSettings({ limit: { calls: 1 } }), () => 0, undefined, async (ms) => pauses.push(ms), 30_000);
    await leave(true);
    expect(pauses[0]).toBeLessThanOrEqual(15_000);
    expect(pauses[0]).toBeGreaterThan(14_900);
  });

  test("starts at 20% and adds one second per 5% without floating point boundary drift", () => {
    const limits = webRateSettings();
    expect([0.19, 0.20, 0.249, 0.25, 0.30, 0.375, 0.75, 1].map((fill) => throttlePause(fill, limits))).toEqual([0, 1000, 1000, 2000, 3000, 4000, 12000, 17000]);
  });

  test("parallel success pauses overlap: batch delay is maximum, not sum", async () => {
    let now = 0;
    const ends = [];
    const limits = webRateSettings();
    const sleep = async (ms) => { ends.push(now + ms); };
    const first = await rateEnter(limits, () => now, undefined, sleep);
    const second = await rateEnter(limits, () => now, undefined, sleep);
    const third = await rateEnter(limits, () => now, undefined, sleep);
    // Finish the first two at 37.5% fill, then a fourth starts while the third runs.
    await Promise.all([first(true), second(true)]);
    const fourth = await rateEnter(limits, () => now, undefined, sleep);
    await Promise.all([third(true), fourth(false)]);
    now = Math.max(...ends);
    expect(ends).toEqual([4000, 4000, 7000]);
    expect(now).toBe(7000);
  });

  test("fast parallel groups may fill the default burst gate; deadline prevents a long wait", async () => {
    const limits = webRateSettings();
    let now = 0;
    for (const size of [3, 3, 2]) {
      const pauses = [];
      const leaves = [];
      for (let i = 0; i < size; i++) leaves.push(await rateEnter(limits, () => now, undefined, async (ms) => pauses.push(ms)));
      await Promise.all(leaves.map((leave) => leave(true)));
      now += Math.max(...pauses);
    }
    expect(now).toBeLessThan(40_000);
    const wait = [];
    const leave = await rateEnter(limits, () => now, undefined, async (ms) => { wait.push(ms); now += ms; });
    expect(wait).toHaveLength(1);
    expect(now).toBe(40_000);
    await leave(false);
  });

  test("ninth attempt waits for exact expiry; no rolling ceiling remains", async () => {
    const limits = webRateSettings({ throttle: { stepMs: 0 } });
    let now = 0;
    const waits = [];
    for (let i = 0; i < 80; i++) {
      const leave = await rateEnter(limits, () => now, undefined, async (ms) => { waits.push(ms); now += ms; });
      await leave(false);
    }
    expect(waits).toEqual(Array(9).fill(40_000));
  });

  test("full window refuses at the half-budget boundary without sleeping", async () => {
    const limits = webRateSettings({ limit: { calls: 1 }, throttle: { stepMs: 0 } });
    await rateEnter(limits, () => 0);
    await expect(rateEnter(limits, () => 0, undefined, async () => { throw new Error("must not sleep"); }, 80_000, "web-fetch")).rejects.toThrow("web-fetch busy for 40000 ms, please wait");
  });

  test("post-success delay uses deadline remaining after network work", async () => {
    let now = 0;
    const pauses = [];
    const limits = webRateSettings({ limit: { calls: 1 }, throttle: { stepMs: 100 } });
    const leave = await rateEnter(limits, () => now, undefined, async (ms) => pauses.push(ms), 300);
    now = 150;
    await leave(true);
    expect(pauses).toEqual([75]);
  });

  test("multiple capacity waits recheck the actual remaining budget", async () => {
    const limits = webRateSettings({ limit: { calls: 1 }, throttle: { stepMs: 0 } });
    let now = 0;
    await rateEnter(limits, () => now);
    const waits = [];
    await expect(rateEnter(limits, () => now, undefined, async (ms) => {
      waits.push(ms);
      now += ms;
      // Another caller takes the newly expired slot first.
      await rateEnter(limits, () => now);
    }, 100_000, "web-search")).rejects.toThrow("web-search busy for 40000 ms, please wait");
    expect(waits).toEqual([40_000]);
  });

  test("failures skip success delays and leave is idempotent", async () => {
    const pauses = [];
    const leave = await rateEnter(webRateSettings({ limit: { calls: 1 } }), () => 0, undefined, async (ms) => pauses.push(ms));
    await leave(false);
    await leave(true);
    expect(pauses).toEqual([]);
  });

  test("cancellation interrupts a full-window wait", async () => {
    const limits = webRateSettings({ limit: { calls: 1 } });
    await rateEnter(limits, Date);
    const controller = new AbortController();
    const waiting = rateEnter(limits, Date, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    await expect(sleepAbortable(100, controller.signal)).rejects.toThrow("cancelled");
  });
});
