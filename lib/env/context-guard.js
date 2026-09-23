/**
 * lib/env/context-guard.js — Env's runaway-guard policy (private):
 * the agent tool loop is capped by CONTEXT USAGE (a fraction of the
 * model's context window), not by counting requests/tool calls — a
 * model that quotes one huge file spins the context out just as
 * "runaway" as one that loops forever on trivial calls, and a request
 * count can't tell the two apart.
 *
 * Two independent caps, both settable in settings.json:
 *   - contextGuardCap      the OVERALL ceiling (default 0.9 — always
 *                          leaves room for /compact itself to run);
 *                          crossing it refuses to continue — user
 *                          oversight and /compact are required first.
 *   - contextGuardTurnCap  the growth ceiling for ONE agent turn alone
 *                          (default 0.4): even starting from a
 *                          near-empty context, a single turn cannot
 *                          consume more than this fraction of the
 *                          window before it's stopped.
 *
 * A settings value > 1 is read as a PERCENTAGE (90 == 0.9); either
 * spelling works. The Agent owns enforcement (lib/agent/run.js) —
 * this module only resolves the two numbers.
 */

/** The overall context-usage ceiling: 90% (always leaves /compact room). */
export const DEFAULT_CONTEXT_GUARD_CAP = 0.9;
/** The per-turn context-growth ceiling: 40%. */
export const DEFAULT_CONTEXT_GUARD_TURN_CAP = 0.4;

/** Normalize a settings value into a (0, 1] fraction; absent/invalid -> fallback. */
function fraction(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n > 1 ? n / 100 : n, 1);
}

/** @param {object} settings @returns {number} the overall context-usage cap, a (0,1] fraction */
export function configuredContextGuardCap(settings = {}) {
  return fraction(settings.contextGuardCap, DEFAULT_CONTEXT_GUARD_CAP);
}

/** @param {object} settings @returns {number} the per-turn context-growth cap, a (0,1] fraction */
export function configuredContextGuardTurnCap(settings = {}) {
  return fraction(settings.contextGuardTurnCap, DEFAULT_CONTEXT_GUARD_TURN_CAP);
}
