import { sceneBaseBuffer } from "./scene-buffer.js";

// 10 seconds covers the built-in cycles (flash and wave are normally <= 2.8s).
// Larger/custom cycles retain one indexed evaluator instead of retaining an
// unbounded table; it still wakes only at its configured sampling boundary.
export const MAX_COMPILED_CYCLE_MS = 10_000;

function sameStyle(a, b) { return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs; }
function styleAt(theme, role, index, count, time) {
  const { fg, bg, attrs } = theme.animated(role, { time, index, count });
  return { fg, bg, attrs };
}
function signature(styles) { return styles.map(({ fg, bg, attrs }) => `${fg ?? ""}/${bg ?? ""}/${attrs}`).join("|"); }
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function cycleFor(animation, count) {
  if (animation.type === "flash") return Math.max(1, Number(animation.period) || 600) * 2;
  if (animation.type === "wave") return Math.max(1, Number(animation.period) || 1400) * 2;
  if (animation.type === "comet") {
    const tick = Math.max(1, Number(animation.tick) || 50);
    const head = animation.head?.length ?? 4;
    const tail = animation.tail?.length ?? 8;
    const nose = animation.nose?.length ?? 2;
    const span = Math.max(head + tail + nose, Math.round(count / ((1 + Math.sqrt(5)) / 2)));
    const travel = count + span;
    const speed = Math.max(2, Math.round(travel / ((Number(animation.crossing) || 1400) / tick)));
    return (2 * travel / gcd(speed, 2 * travel)) * tick;
  }
  return 0;
}

function runs(scene, theme) {
  const out = [];
  for (let y = 0; y < scene.canvas.height; y++) {
    const row = scene.canvas.cells[y];
    for (let x = 0; x < row.length;) {
      const cell = row[x];
      if (!cell || cell.text === null || !theme.animation(cell.role)) { x++; continue; }
      const role = cell.role ?? "text";
      let end = x + 1;
      while (end < row.length && row[end]?.text !== null && (row[end]?.role ?? "text") === role) end++;
      out.push({ role, indexes: Array.from({ length: end - x }, (_, i) => y * scene.canvas.width + x + i), count: end - x });
      x = end;
    }
  }
  return out;
}

function transitionTimes(animation, count, cycle) {
  if (animation.type === "flash") return [0, Math.max(1, Number(animation.period) || 600)];
  if (animation.type === "comet") {
    const tick = Math.max(1, Number(animation.tick) || 50);
    return Array.from({ length: Math.ceil(cycle / tick) }, (_, index) => index * tick);
  }
  if (animation.type === "wave") {
    const period = Math.max(1, Number(animation.period) || 1400);
    const colors = Array.isArray(animation.colors) && animation.colors.length ? animation.colors.length : 1;
    const steps = count + colors + 1;
    const times = new Set([0, period]);
    for (let step = 1; step < steps; step++) {
      const at = Math.ceil(step * period / steps);
      times.add(at); times.add(cycle - at);
    }
    return [...times].sort((a, b) => a - b);
  }
  return [0];
}

function compileTarget(run, theme, sampleMs) {
  const animation = theme.animation(run.role);
  const cycle = cycleFor(animation, run.count);
  if (!cycle) return null;
  // The fallback retains no table. It preserves the historical configurable
  // sampling model for pathological custom cycles without periodic empty work.
  if (cycle > MAX_COMPILED_CYCLE_MS) return { ...run, cycle: sampleMs, indexed: true, frames: null };
  const times = transitionTimes(animation, run.count, cycle);
  const frames = [];
  let previous = null;
  for (let index = 0; index < times.length; index++) {
    const at = times[index];
    const duration = (times[index + 1] ?? cycle) - at;
    const styles = run.indexes.map((_, cellIndex) => styleAt(theme, run.role, cellIndex, run.count, at));
    const key = signature(styles);
    if (previous?.key === key) previous.duration += duration;
    else {
      previous = { key, start: at, duration, styles };
      frames.push(previous);
    }
  }
  // Cycle endpoints can have the same output; merge them so no meaningless
  // wake occurs at time zero. Frame lookup handles the wrapped first frame.
  if (frames.length > 1 && frames[0].key === frames.at(-1).key) {
    frames[0].start = frames.at(-1).start;
    frames[0].duration += frames.at(-1).duration;
    frames.pop();
  }
  return frames.length > 1 ? { ...run, cycle, frames } : null;
}

function frameAt(target, theme, time, sampleMs) {
  if (target.indexed) return { styles: target.indexes.map((_, index) => styleAt(theme, target.role, index, target.count, time)), end: time - (time % sampleMs) + sampleMs };
  const offset = ((time % target.cycle) + target.cycle) % target.cycle;
  const frame = target.frames.find((candidate) => {
    const end = candidate.start + candidate.duration;
    return end <= target.cycle ? offset >= candidate.start && offset < end : offset >= candidate.start || offset < end - target.cycle;
  });
  const endOffset = frame.start + frame.duration;
  const end = endOffset <= target.cycle
    ? time - offset + endOffset
    : offset >= frame.start ? time - offset + target.cycle : time - offset + endOffset - target.cycle;
  return { styles: frame.styles, end };
}

function apply(target, styles, buffer) {
  let changed = false;
  for (let index = 0; index < target.indexes.length; index++) {
    const cell = buffer.cells[target.indexes[index]];
    const style = styles[index];
    if (!sameStyle(cell, style)) { cell.fg = style.fg; cell.bg = style.bg; cell.attrs = style.attrs; changed = true; }
  }
  return changed;
}

/** Compile narrow per-run styles and one reusable painted buffer at mount. */
export function compileAnimations(scene, theme, { time = Date.now(), sampleMs = 50 } = {}) {
  const buffer = sceneBaseBuffer(scene, theme);
  const targets = runs(scene, theme).map((run) => compileTarget(run, theme, sampleMs)).filter(Boolean);
  const compiled = { buffer, theme, targets, sampleMs: Math.max(1, sampleMs), allocations: 1 };
  for (const target of targets) apply(target, frameAt(target, theme, time, compiled.sampleMs).styles, buffer);
  return compiled;
}

function next(compiled, time) {
  let deadline = Infinity;
  for (const target of compiled.targets) deadline = Math.min(deadline, frameAt(target, compiled.theme, time, compiled.sampleMs).end);
  return deadline;
}

// Named static callback: native timer retains only this deliberately narrow
// scheduler state, never a terminal host or a bound method.
export function animationTimerWake(state) {
  state.timer = null;
  if (state.disposed || state.generation !== state.expectedGeneration) return;
  const time = state.now();
  let changed = false;
  for (const target of state.compiled.targets) changed = apply(target, frameAt(target, state.compiled.theme, time, state.compiled.sampleMs).styles, state.compiled.buffer) || changed;
  if (changed) state.sink.paint(state.sink, state.compiled.buffer);
  scheduleCompiledAnimations(state);
}

export function scheduleCompiledAnimations(state) {
  if (state.timer) state.clearTimeout(state.timer);
  state.timer = null;
  if (state.disposed || !state.compiled?.targets.length) return;
  const deadline = next(state.compiled, state.now());
  state.timer = state.setTimeout(animationTimerWake, Math.max(1, deadline - state.now()), state);
  state.timer?.unref?.();
}

export function disposeCompiledAnimations(state) {
  state.disposed = true;
  if (state.timer) state.clearTimeout(state.timer);
  state.timer = null;
  if (state.compiled) { state.compiled.targets = []; state.compiled = null; }
}

export const animationSchedulerInternals = Object.freeze({ compileTarget, frameAt, apply, next });
