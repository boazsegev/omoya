/** Agent status projection. */
import { modelParts } from "../shared/format.js";
const display = (value) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
/** Produce the client-facing recursive snapshot of an agent and its state.
 * @param {object} agent - Agent to describe.
 * @param {object|null} active - Currently active agent for the connection.
 * @param {string} [project] - Path of the project serving the agent; identifies agents across projects.
 * @returns {object} Serializable agent information, including descendants.
 */
export function agentInfo(agent, active, project) {
  // `state` derives `busy`, never the reverse: a snapshot can be taken in
  // the instant after a disconnect clears (state "idle") but before the
  // run's finally flips `_running`, and the wire must never report the
  // mixed {busy:true, state:"idle"}.
  const state = agent.ioState === "disconnected" ? "disconnected" : agent.busy === true || agent.ioState === "working" ? "working" : "idle";
  const { endpoint, model } = modelParts(agent.model);
  return {
    id: display(agent.name),
    name: display(agent.name),
    endpoint: display(endpoint),
    model: display(model),
    busy: state === "working",
    state,
    description: display(agent.description),
    parentId: agent.parent ? display(agent.parent.name) : null,
    session: display(agent.context.id),
    logged: agent.context.save,
    active: agent === active,
    ...(project === undefined ? {} : { project }),
    children: agent.children.map((child) => agentInfo(child, active, project)),
  };
}
