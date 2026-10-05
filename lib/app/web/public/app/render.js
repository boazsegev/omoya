/** Coalesce region invalidations into one paint; key handling never waits on paint. */
const regions = new Map();
const pending = new Set();
let frame = 0;
let timer = 0;
/** Register a region renderer at startup (duplicate registrations are errors). */
export function register(region, renderer) {
  if (regions.has(region)) throw new Error(`duplicate render region: ${region}`);
  regions.set(region, renderer);
}
/** Queue one region for the next paint, with a timer for occluded tabs. */
export function invalidate(region) {
  pending.add(region);
  if (frame) return;
  frame = requestAnimationFrame(flush);
  timer = setTimeout(flush, 100);
}
/** Execute only dirty regions once per paint. */
export function flush() {
  cancelAnimationFrame(frame);
  clearTimeout(timer);
  frame = 0;
  for (const region of pending) regions.get(region)?.();
  pending.clear();
}
