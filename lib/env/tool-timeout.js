/**
 * lib/env/tool-timeout.js — Env's tool-timeout policy (private):
 * one default per call and one hard ceiling for a tool schema's
 * model-facing `timeout` argument. Durations use the shared parser, so
 * settings accept millisecond numbers or unit strings ("30s", "5m").
 *
 * The Agent owns enforcement. Tools may DECLARE `timeout`, but the
 * Agent extracts it before invocation; tools never race a second timer
 * against the harness. A tool's optional Agent-facing `onTimeout`
 * callback gets one bounded cleanup/final-response grace period.
 */

import { parseDuration } from "./duration.js";

/** Default Agent-enforced cap for one tool call: two minutes. */
export const DEFAULT_TOOL_TIMEOUT = 120_000;
/** Maximum model-requested tool duration: twenty minutes. */
export const DEFAULT_TOOL_TIMEOUT_LIMIT = 20 * 60_000;
/** Maximum Agent-facing onTimeout cleanup/final-response grace. */
export const TOOL_ON_TIMEOUT_LIMIT = 60_000;

/** Resolve one positive duration setting, defaulting only when absent. */
function setting(value, fallback) {
  return value === undefined || value === null ? fallback : parseDuration(value);
}

/** @param {object} settings @returns {number} */
export function configuredToolTimeout(settings = {}) {
  return setting(settings.toolTimeout, DEFAULT_TOOL_TIMEOUT);
}

/** @param {object} settings @returns {number} */
export function configuredToolTimeoutLimit(settings = {}) {
  return setting(settings.toolTimeoutLimit, DEFAULT_TOOL_TIMEOUT_LIMIT);
}
