/**
 * Primary headless library namespace. Exports are explicit so private Agent
 * statics and future implementation details cannot leak through the barrel.
 */
import Agent from "./agent.js";
import Jobs from "./jobs.js";

export default {
  Context: Agent.Context,
  Env: Agent.Env,
  IO: Agent.IO,
  Agent,
  Jobs,
  NAMES: Agent.NAMES,
  EVENT: Agent.EVENT,
  EVENT_CALLBACKS: Agent.EVENT_CALLBACKS,
  finishAdd: Agent.finishAdd,
  finishRun: Agent.finishRun,
  finishSignalsArm: Agent.finishSignalsArm,
  TOOL_TIMEOUT_DEFAULT: Agent.TOOL_TIMEOUT_DEFAULT,
  reseat: Agent.reseat,
};
