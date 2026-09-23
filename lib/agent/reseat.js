/**
 * lib/agent/reseat.js — RESEATING an agent (private to Agent;
 * re-exported for the TUI): /session-new in the TUI builds a FRESH
 * Agent instead of hollowing out the old one. Per-agent state is
 * deliberately NOT carried — tool stores (the note tool's backup),
 * the pending queue: a new session starts with none of the old
 * session's artifacts, because they all derive from the context that
 * was just abandoned.
 *
 * What DOES carry over is the CONNECTION (endpoint/model/thinking,
 * safe mode, the IO factory and tool-sandbox policy — the caller's
 * own class constructs its own kind, like spawn.js) and the SEAT IN
 * THE PEER GROUP: the fresh agent takes over the old one's links and
 * with "main" (env.reseatPeer moves the topology record). The old
 * agent is left a group of one, its session store closed (the old
 * conversation stays on disk, resumable); with no strong references
 * left, it fades out of the environment's WeakRef registry on its
 * own.
 */

import { randomUUID } from "node:crypto";
import { setThinking } from "./thinking.js";

/** The anonymous-session id spellings: "0", "false", "anon" (sessions.js). */
export const isAnonymousId = (id) => id === "0" || id === "false" || id === "anon";

/**
 * Build the FRESH Agent that replaces `agent` for a new session.
 * @param {object} agent - the agent being replaced (the TUI's viewed one)
 * @param {Object} [options]
 * @param {string} [options.id] - the new session's id; "0"/"false"/"anon"
 *   (or no id while the old session is anonymous) starts ANONYMOUS
 * @returns {object} the fresh Agent, seated in the old one's group
 */
export function reseatAgent(agent, { id } = {}) {
  const anonymous = isAnonymousId(id) || (id === undefined && agent.session == null);
  // Closing, rather than merely closing the store, releases the replaced
  // Agent from Env's active-session registry. Otherwise every /new leaves
  // an inert Agent behind and is indistinguishable from adding a session.
  agent.close();
  const fresh = new agent.constructor({
    env: agent.env,
    model: `${agent.endpoint}/${agent.model}`,
    url: agent.url,
    timeout: agent.timeout,
    settings: agent.settings,
    tools: agent._toolSelection,
    safe: agent.safe === true,
    sessionSave: agent.sessionSave === true,
    // a logged session gets its own store in the same folder; an
    // anonymous one stays unpersisted (session: null)
    ...(anonymous ? {} : { session: id ?? randomUUID(), sessionDir: agent._sessionDir }),
    createIO: agent._createIO, // inherit the IO factory (tests: the fakes)
    toolCall: agent._toolCall, // and the tool-sandbox policy
    // NOT inherited, on purpose: event subscriptions (the binding
    // wraps its own), the question bridge (the binding re-attaches it),
    // the context, the pending queue, every tool store, the consent
    // latches — the artifacts a new session must start without
  });
  setThinking(fresh, agent.thinking); // the level is a connection preference, not an artifact
  // the PENDING queue belongs to the user's seat, not to the abandoned
  // context: queued messages ride over (they show in the fresh session's
  // queue area, exactly as an in-place /session-new left them)
  for (const message of agent.drainPending()) fresh.enqueue(message);
  return fresh;
}
