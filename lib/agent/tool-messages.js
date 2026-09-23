/**
 * lib/agent/tool-messages.js — AGENT-OWNED sticky tool messages
 * (private to the Agent): a tool's compact live display text (a TODO
 * tool posts its current list, the note tool its non-secret titles).
 * Tool execution belongs to the AGENT that executed the call — so
 * does its display state: the messages live on the agent, and the
 * TUI collects them from the VIEWED agent (ctx.agent, the slot
 * proxy) on every redraw. Plain data only: the agent owns the data,
 * the TUI owns the rendering.
 *
 * (Infrastructure state is different: a tool's STATUS — the MCP
 * tool's connected servers — is global and stays on the env, see
 * Env.updateToolStatus.)
 */

/** The sticky area is small: one message is a handful of short lines. */
const MAX_NAME = 64;
const MAX_MESSAGE = 1024;

/**
 * Set (or clear) a tool's sticky MESSAGE on this agent.
 * @param {object} agent
 * @param {string} name - the tool's display name (its module name)
 * @param {string|null} [text] - the message; null/undefined/"" clears
 * @returns {string|null} the tool's current message
 */
export function updateToolMessage(agent, name, text) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("Agent.updateToolMessage: a non-empty string tool name is required");
  }
  const key = name.trim().slice(0, MAX_NAME);
  const box = (agent._toolMessages ??= new Map());
  if (text === null || text === undefined || text === "") box.delete(key);
  else box.set(key, String(text).slice(0, MAX_MESSAGE));
  return box.get(key) ?? null;
}

/** @returns {Array<{name: string, text: string}>} tools with a live sticky message (insertion order) */
export function toolMessages(agent) {
  return [...(agent._toolMessages ?? new Map())].map(([name, text]) => ({ name, text }));
}

/** Rebuild tool-provided display information from the current context.
 * Tools opt in with a synchronous schema `detect({agent, env})` hook.
 * A broken detector is isolated so opening or reloading a session never
 * breaks the TUI. */
export function detectToolMessages(agent) {
  for (const name of agent.env?.toolNames?.() ?? []) {
    try {
      agent.env.toolEntry(name)?.detect?.({ agent, env: agent.env });
    } catch (err) {
      agent._emit(EVENT.LOG, `tool ${name} information detection failed: ${err?.message ?? err}`);
    }
  }
  return toolMessages(agent);
}

/**
 * Clear EVERY sticky tool message: the messages are context-derived
 * displays, so a context replacement (a new or resumed session)
 * invalidates them all — the tools refresh them on their next call.
 * @param {object} agent
 */
export function clearToolMessages(agent) {
  agent._toolMessages?.clear();
}
