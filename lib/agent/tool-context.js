/**
 * Private Agent tool-call context. Tools receive these capabilities only during
 * dispatch; consumers inspect Agent.tools instead of constructing this context.
 */

import { loadedSkills } from "./skill-state.js";

/**
 * Build the context for an in-process tool or its timeout callback.
 * @param {object} agent Owning Agent.
 * @param {object} [call] Active call linkage.
 * @param {{trusted?: boolean, info?: object}} [options] Resolved tool metadata.
 * @returns {object} Live execution capabilities; never sent to a provider.
 */
export function toolContextFor(agent, call, { trusted = false, info } = {}) {
  const storageName = call?.name ? (info?.storage ?? call.name) : undefined;
  const selector = agent.model;
  const context = {
    question: agent.question,
    env: agent.env,
    safe: agent.safe,
    loadedSkills: () => loadedSkills(agent.context),
    selector,
    io: undefined,
    call: call ? { callId: call.callId, name: call.name } : undefined,
    agent,
    storage: storageName ? agent.toolStorage(storageName) : undefined,
    trusted: trusted === true,
    resetTimeout: typeof agent._resetToolTimeout === "function" ? agent._resetToolTimeout : () => {},
  };
  // Open the connection only when a provider tool asks for it.
  if (selector) Object.defineProperty(context, "io", { get: () => agent._connection(selector), enumerable: true });
  return context;
}
