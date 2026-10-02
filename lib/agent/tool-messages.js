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
 * the tool context's statusSet.)
 */
import { EVENT } from "./events.js";

/** The sticky area is small: one message is a handful of short lines. */
const MAX_NAME = 64;
const MAX_MESSAGE = 1024;

/**
 * Set or clear a tool's sticky display message on an agent. Names are trimmed
 * and limited to 64 characters; messages are stringified and limited to 1024
 * characters. Clearing removes the entry, but retains the agent's map.
 * @param {object} agent - agent whose message map is updated
 * @param {string} name - non-empty tool display name; trimmed before use
 * @param {string|null} [text=undefined] - message to store; null, undefined,
 *   or an empty string clears the entry
 * @returns {string|null} stored message, or null when cleared
 * @throws {TypeError} if name is not a non-empty string after trimming
 */
export function updateToolMessage(agent, name, text) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("Agent.toolMessageSet: a non-empty string tool name is required");
  }
  const key = name.trim().slice(0, MAX_NAME);
  const box = (agent._toolMessages ??= new Map());
  if (text === null || text === undefined || text === "") box.delete(key);
  else box.set(key, String(text).slice(0, MAX_MESSAGE));
  return box.get(key) ?? null;
}

/**
 * Get a snapshot of the agent's live sticky tool messages.
 * @param {object} agent - agent whose messages are read
 * @returns {Array<{name: string, text: string}>} messages in map insertion order;
 *   returns an empty array if no message map exists
 */
export function toolMessages(agent) {
  return [...(agent._toolMessages ?? new Map())].map(([name, text]) => ({ name, text }));
}

/**
 * Run catalog detectors to refresh tool-provided display information, then
 * return the agent's current sticky messages. Detectors are synchronous; each
 * detector failure is logged and isolated. Failure to load the catalog (or a
 * failure while reading messages) rejects the returned promise.
 * @param {object} agent - agent whose environment supplies the tools catalog
 * @returns {Promise<Array<{name: string, text: string}>>} current messages in
 *   insertion order
 */
export async function detectToolMessages(agent) {
  const catalog = await agent.env?.tools?.() ?? new Map();
  for (const [name, info] of catalog) {
    try {
      info.detect?.({ agent, env: agent.env });
    } catch (err) {
      agent._emit(EVENT.LOG, `tool ${name} information detection failed: ${err?.message ?? err}`);
    }
  }
  return toolMessages(agent);
}

/**
 * Clear every sticky tool message on an agent. The map itself is retained if
 * present; tools may repopulate it on their next call.
 * @param {object} agent - agent whose messages are cleared
 * @returns {void}
 */
export function clearToolMessages(agent) {
  agent._toolMessages?.clear();
}
