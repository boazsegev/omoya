/**
 * lib/duration.js — duration values: a millisecond numeral OR a string
 * with a time unit identifier ("500ms", "20s", "5m", "1.5h"). Used for
 * every timeout setting (CLI --timeout, provider metadata, settings).
 */

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Parse a duration: a positive millisecond numeral or a unit string
 * ("500ms", "20s", "5m", "1.5h").
 * @param {number|string|undefined|null} value
 * @returns {number|undefined} milliseconds (undefined passes through)
 * @throws {Error} on a non-positive or unparseable value
 */
export function parseDuration(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`duration must be a positive number of milliseconds, got ${value}`);
    }
    return value;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(value));
  if (!m) {
    throw new Error(`invalid duration "${value}" (milliseconds, or a unit: 500ms, 20s, 5m, 1h)`);
  }
  const ms = Number(m[1]) * UNITS[(m[2] ?? "ms").toLowerCase()];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`duration must be positive, got "${value}"`);
  }
  return ms;
}

/** parseDuration that never throws — invalid/empty input is undefined. */
export function tryDuration(value) {
  try {
    return parseDuration(value);
  } catch {
    return undefined;
  }
}
