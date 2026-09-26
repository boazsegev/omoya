/**
 * lib/agent/thinking.js — the thinking level (private to Agent): one
 * harness vocabulary (none/low/medium/high/xhigh/max, lib/env/thinking.js)
 * that each provider translates to the model's native symbols,
 * settable at runtime, applied to already-open provider connections too.
 */

/**
 * Map a thinking-level word to the request option value:
 * none/false/0 → false, on/true/1 → true, positive level words
 * pass through, undefined/"default" → undefined (the model's default).
 */
export function thinkValue(level) {
  if (level === undefined || level === null || level === "default") return undefined;
  const word = String(level).toLowerCase();
  if (word === "none" || word === "off" || word === "false" || word === "0") return false;
  if (word === "on" || word === "true" || word === "1") return true;
  return word;
}

/**
 * Set the thinking level for subsequent requests. Applies to
 * already-open provider connections too.
 * @param {object} agent
 * @param {string} [level] - none/low/medium/high/xhigh/max (undefined: provider default)
 */
export function setThinking(agent, level) {
  agent._thinking = level;
  agent._recordSessionSettings?.(); // the level rides the session record (no-op mid-construction)
  const value = thinkValue(level);
  for (const aiio of agent._io.values()) aiio.setOption?.("think", value);
}
