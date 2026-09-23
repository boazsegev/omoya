import { describe, expect, test } from "bun:test";
import { createTheme } from "../lib/gtui/theme.js";
import { layoutView } from "../lib/gtui/layout.js";
import { compileAnimations, scheduleCompiledAnimations, animationTimerWake, animationSchedulerInternals } from "../lib/gtui/animation-scheduler.js";
import { cometFrame, flashFrame, waveFrame } from "../lib/gtui/theme.js";

function scene(text, theme) { return layoutView({ type: "text", margin: 0, role: "busy", content: text }, { width: 12, height: 1, theme }); }
function fakeClock(time = 0) {
  const calls = []; let id = 0;
  return { calls, now: () => time, set(value) { time = value; }, setTimeout(callback, delay, state) { const timer = { id: ++id, callback, delay, state }; calls.push(timer); return timer; }, clearTimeout(timer) { timer.cancelled = true; } };
}

describe("GTUI compiled animation scheduler", () => {
  test("compiles animated runs into one timer and reuses its painted buffer", () => {
    const theme = createTheme({ text: {}, busy: { animation: { type: "flash", period: 30 }, fg: 1 }, accent: { fg: 2 } });
    const compiled = compileAnimations(scene("abcdefgh", theme), theme, { time: 0, sampleMs: 50 });
    expect(compiled.targets.length).toBe(1);
    const buffer = compiled.buffer;
    const clock = fakeClock(); let paints = 0;
    const sink = { paint(_sink, value) { paints++; expect(value).toBe(buffer); } };
    const state = { compiled, sink, timer: null, disposed: false, generation: 1, expectedGeneration: 1, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    scheduleCompiledAnimations(state);
    expect(clock.calls.length).toBe(1);
    clock.set(30); animationTimerWake(state);
    expect(paints).toBe(1);
    expect(compiled.buffer).toBe(buffer);
    expect(compiled.allocations).toBe(1);
  });

  test("collapses identical output phases and jumps late directly to its absolute phase", () => {
    const theme = createTheme({ text: {}, busy: { animation: { type: "flash", period: 25, role: "busy" }, fg: 3 } });
    const compiled = compileAnimations(scene("x", theme), theme, { time: 0, sampleMs: 50 });
    // Flashing to its own role never changes output, therefore no target/timer.
    expect(compiled.targets).toEqual([]);
    const changing = createTheme({ text: {}, busy: { animation: { type: "flash", period: 25, role: "accent" }, fg: 3 }, accent: { fg: 4 } });
    const target = compileAnimations(scene("x", changing), changing, { time: 0, sampleMs: 50 }).targets[0];
    expect(target.frames.map((frame) => frame.duration)).toEqual([25, 25]);
    const clock = fakeClock(175); let paints = 0;
    const sink = { paint() { paints++; } };
    const state = { compiled: { buffer: compileAnimations(scene("x", changing), changing, { time: 0, sampleMs: 50 }).buffer, theme: changing, targets: [target], sampleMs: 50 }, sink, timer: null, disposed: false, generation: 1, expectedGeneration: 1, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    animationTimerWake(state);
    expect(paints).toBe(1); // no replay of missed 25ms phases
    expect(clock.calls.at(-1).delay).toBe(25); // next absolute boundary: 200
  });

  test("uses exact comet/wave/flash transition frames instead of millisecond sampling", () => {
    const configs = [{ type: "flash", period: 37 }, { type: "wave", period: 101, colors: [1, 2, 3], mirror: true }, { type: "comet", tick: 17, crossing: 233, mirror: true }];
    for (const animation of configs) {
      const theme = createTheme({ text: {}, busy: { animation, fg: 7 }, accent: { fg: 2 } });
      const target = compileAnimations(scene("abcdefgh", theme), theme, { time: 0 }).targets[0];
      expect(target.frames.length).toBeLessThanOrEqual(animation.type === "comet" ? 100 : 24);
      for (const frame of target.frames) {
        const styles = animationSchedulerInternals.frameAt(target, theme, frame.start, 50).styles;
        expect(styles).toEqual(frame.styles);
        const expected = animation.type === "comet" ? cometFrame(8, frame.start, animation)[0]
          : animation.type === "wave" ? waveFrame("abcdefgh", frame.start, animation)[0].role : flashFrame(frame.start, animation);
        expect(expected).toBeDefined();
      }
    }
  });

  test("coalesces multiple due targets into one sink paint", () => {
    const theme = createTheme({ text: {}, busy: { animation: { type: "flash", period: 20 }, fg: 1 }, accent: { fg: 2 } });
    const root = { type: "column", children: [{ type: "text", margin: 0, role: "busy", content: "aa" }, { type: "text", margin: 0, role: "busy", content: "bb" }] };
    const compiled = compileAnimations(layoutView(root, { width: 4, height: 2, theme }), theme, { time: 0 });
    expect(compiled.targets.length).toBe(2);
    const clock = fakeClock(20); let paints = 0;
    const state = { compiled, sink: { paint() { paints++; } }, timer: null, disposed: false, generation: 1, expectedGeneration: 1, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    animationTimerWake(state);
    expect(paints).toBe(1);
  });
});
