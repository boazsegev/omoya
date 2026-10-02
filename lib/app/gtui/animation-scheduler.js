// The scheduler owns no screen buffer. The host paints a frame, applies the
// current animation styles into it (animationApply), and on each timer wake
// receives only the style updates that are due (sink.paint(sink, updates)).

// 10 seconds covers the built-in cycles (flash and wave are normally <= 2.8s).
// Larger/custom cycles retain one indexed evaluator instead of retaining an
// unbounded table; it still wakes only at its configured sampling boundary.
export const MAX_COMPILED_CYCLE_MS = 10_000;

/** Compare the foreground, background, and attributes of two style records.
 * @param {{fg: unknown, bg: unknown, attrs: unknown}} a First style.
 * @param {{fg: unknown, bg: unknown, attrs: unknown}} b Second style.
 * @returns {boolean} Whether all three style fields are strictly equal.
 */
function sameStyle(a, b) { return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs; }

/** Evaluate one animated style for a cell position.
 * @param {object} theme Theme whose `animated(role, context)` method computes styles.
 * @param {string} role Animation role to evaluate.
 * @param {number} index Zero-based position within the animated run.
 * @param {number} count Number of cells in the run.
 * @param {number} time Animation time in milliseconds.
 * @returns {{fg: unknown, bg: unknown, attrs: unknown}} The computed style fields.
 * @throws Propagates errors thrown by `theme.animated`.
 */
function styleAt(theme, role, index, count, time) {
  const { fg, bg, attrs } = theme.animated(role, { time, index, count });
  return { fg, bg, attrs };
}
/** Build a comparison key from an ordered list of style records.
 * @param {Array<{fg: unknown, bg: unknown, attrs: unknown}>} styles Styles to encode.
 * @returns {string} Joined representation used to detect equal animation phases.
 */
function signature(styles) { return styles.map(({ fg, bg, attrs }) => `${fg ?? ""}/${bg ?? ""}/${attrs}`).join("|"); }

/** Calculate the greatest common divisor of two integers.
 * @param {number} a First integer.
 * @param {number} b Second integer.
 * @returns {number} Greatest common divisor, using the Euclidean algorithm.
 */
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/** Determine the repeating period for a supported animation.
 * @param {object} animation Animation configuration (`type` plus type-specific options).
 * @param {number} count Number of cells in the run.
 * @returns {number} Cycle duration in milliseconds, or zero for an unsupported type.
 */
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

/** Find contiguous animated-role cell runs in a scene canvas.
 * @param {object} scene Scene with `canvas.height`, `canvas.width`, and row `canvas.cells`.
 * @param {object} theme Theme providing `animation(role)` lookup.
 * @returns {Array<{role: string, indexes: number[], count: number}>} Animated runs with flat buffer indexes.
 * @throws Propagates errors thrown by `theme.animation`.
 */
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

/** Enumerate times at which an animation can change its rendered style.
 * @param {object} animation Animation configuration.
 * @param {number} count Number of cells in the run.
 * @param {number} cycle Cycle duration in milliseconds.
 * @returns {number[]} Sorted transition times in one cycle, including the cycle-specific boundaries.
 */
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

/** Compile one animated run into reusable style frames when it has visible transitions.
 * @param {{role: string, indexes: number[], count: number}} run Animated run descriptor.
 * @param {object} theme Theme used to evaluate the run's animation.
 * @param {number} sampleMs Sampling interval in milliseconds for oversized cycles.
 * @returns {object|null} Target descriptor, or `null` when the animation has no cycle or only one style.
 * @throws Propagates errors from theme animation lookup or style evaluation.
 */
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

/** Resolve the style array active for a target at a given time and its next boundary.
 * @param {object} target Compiled animation target.
 * @param {object} theme Theme used for indexed (non-precompiled) evaluation.
 * @param {number} time Current animation time in milliseconds.
 * @param {number} sampleMs Sampling interval in milliseconds for indexed targets.
 * @returns {{styles: object[], end: number}} Active styles and the absolute time of their next boundary.
 * @throws Propagates errors from style evaluation for indexed targets.
 */
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

/** Copy changed style fields into the corresponding cells of a flat frame buffer.
 * @param {object} target Target containing flat cell indexes.
 * @param {object[]} styles Styles corresponding positionally to `target.indexes`.
 * @param {object} buffer Buffer with a flat `cells` array to mutate.
 * @returns {boolean} Whether any cell's foreground, background, or attributes changed.
 * @effects Mutates style fields on buffer cells; cells without change are left untouched.
 */
function apply(target, styles, buffer) {
  let changed = false;
  for (let index = 0; index < target.indexes.length; index++) {
    const cell = buffer.cells[target.indexes[index]];
    const style = styles[index];
    if (!sameStyle(cell, style)) { cell.fg = style.fg; cell.bg = style.bg; cell.attrs = style.attrs; changed = true; }
  }
  return changed;
}

/** Compile animated runs into targets for subsequent frame application and scheduling.
 * @param {object} scene Scene containing the canvas to scan.
 * @param {object} theme Theme providing animation lookup and animated-style evaluation.
 * @param {{sampleMs?: number}} [options={}] Compilation options.
 * @param {number} [options.sampleMs=50] Sampling interval in milliseconds for cycles over `MAX_COMPILED_CYCLE_MS`.
 * @returns {{theme: object, targets: object[], sampleMs: number}} Compiled scheduler data; returned sample interval is clamped to at least 1 ms.
 * @throws Propagates errors from theme animation lookup or style evaluation.
 */
export function compileAnimations(scene, theme, { sampleMs = 50 } = {}) {
  const targets = runs(scene, theme).map((run) => compileTarget(run, theme, sampleMs)).filter(Boolean);
  return { theme, targets, sampleMs: Math.max(1, sampleMs) };
}

/** Apply every compiled target's styles at `time` to a freshly painted frame buffer.
 * @param {{theme: object, targets: object[], sampleMs: number}} compiled Result from `compileAnimations`.
 * @param {object} buffer Frame buffer with a flat mutable `cells` array.
 * @param {number} time Animation time in milliseconds.
 * @returns {void}
 * @effects Mutates buffer cell style fields and records the active styles on each target as `applied`.
 * @throws Propagates errors from indexed style evaluation or malformed input data.
 */
export function animationApply(compiled, buffer, time) {
  for (const target of compiled.targets) {
    const { styles } = frameAt(target, compiled.theme, time, compiled.sampleMs);
    apply(target, styles, buffer);
    target.applied = styles;
  }
}

/** Find the earliest next frame boundary among all compiled targets.
 * @param {{theme: object, targets: object[], sampleMs: number}} compiled Compiled animation state.
 * @param {number} time Current animation time in milliseconds.
 * @returns {number} Absolute next transition time, or `Infinity` when there are no targets.
 * @throws Propagates errors from indexed style evaluation.
 */
function next(compiled, time) {
  let deadline = Infinity;
  for (const target of compiled.targets) deadline = Math.min(deadline, frameAt(target, compiled.theme, time, compiled.sampleMs).end);
  return deadline;
}

// Named static callback: native timer retains only this deliberately narrow
// scheduler state, never a terminal host or a bound method.
/** Handle one scheduler timer wake, repaint changed targets, and schedule the next wake.
 * @param {object} state Scheduler state containing timer, generation, clock, sink, and compiled targets.
 * @returns {void}
 * @effects Clears `state.timer`; unless disposed or stale, obtains current time, calls `state.sink.paint(state.sink, updates)` when styles changed, records applied styles, then reschedules.
 * @throws Propagates errors from the clock, sink paint callback, frame evaluation, or scheduling operations.
 */
export function animationTimerWake(state) {
  state.timer = null;
  if (state.disposed || state.generation !== state.expectedGeneration) return;
  const time = state.now();
  // Compiled frames share one styles array per phase, so identity tells
  // whether a target's phase moved since it was last applied.
  const updates = [];
  for (const target of state.compiled.targets) {
    const { styles } = frameAt(target, state.compiled.theme, time, state.compiled.sampleMs);
    if (styles !== target.applied) updates.push([target, styles]);
  }
  if (updates.length) {
    state.sink.paint(state.sink, updates);
    for (const [target, styles] of updates) target.applied = styles;
  }
  scheduleCompiledAnimations(state);
}

/** Cancel any pending wake and schedule the next compiled animation boundary.
 * @param {object} state Scheduler state containing `timer`, `disposed`, `compiled`, `now`, `setTimeout`, and `clearTimeout`.
 * @returns {void}
 * @effects Clears the previous timer, then stores and optionally unreferences the newly scheduled timer; does nothing further when disposed or no targets exist.
 * @throws Propagates errors from timer functions, the clock, or target evaluation.
 */
export function scheduleCompiledAnimations(state) {
  if (state.timer) state.clearTimeout(state.timer);
  state.timer = null;
  if (state.disposed || !state.compiled?.targets.length) return;
  const deadline = next(state.compiled, state.now());
  state.timer = state.setTimeout(animationTimerWake, Math.max(1, deadline - state.now()), state);
  state.timer?.unref?.();
}

/** Stop a compiled animation scheduler and release its target state.
 * @param {object} state Scheduler state containing `timer`, `clearTimeout`, and optionally `compiled`.
 * @returns {void}
 * @effects Marks the state disposed, cancels its pending timer, and empties then clears the compiled target collection when present.
 * @throws Propagates errors thrown by `state.clearTimeout`.
 */
export function disposeCompiledAnimations(state) {
  state.disposed = true;
  if (state.timer) state.clearTimeout(state.timer);
  state.timer = null;
  if (state.compiled) { state.compiled.targets = []; state.compiled = null; }
}

export const animationSchedulerInternals = Object.freeze({ compileTarget, frameAt, apply, next });
