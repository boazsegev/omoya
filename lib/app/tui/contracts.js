/** AI-specific, terminal-neutral presentation contracts. */

export { contextBlocks } from "./context-blocks.js";
export {
  KEYBINDINGS,
  buildEndpointItems,
  buildEndpointPoliciesItems,
  buildEndpointPolicyItems,
  buildMaxActiveItems,
  buildHelpItems,
  buildLoginItems,
  buildLogoutItems,
  buildMenuItems,
  buildPromptItems,
  buildProviderItems,
  buildResumeItems,
  buildSessionAddItems,
  buildSessionAddModelItems,
  buildSessionCloseItems,
  buildSessionMenuItems,
  buildSessionNewItems,
  buildSpawnPermissionItems,
  buildToolsItems,
  buildThemeItems,
} from "./menu-data.js";
export {
  abandonQuestions,
  answerWithLabels,
  answerWithText,
  createQuestionnaire,
  currentQuestion,
  moveQuestion,
  selectedLabels,
  toggleLabel,
} from "./questionnaire.js";
export { statusData } from "./status-data.js";

/**
 * Build the deprecated, terminal-neutral summary tree for the original Phase 01 draft.
 *
 * @param {Object} [options={}] - Collections used to populate the menu categories.
 * @param {string[]} [options.commands=[]] - Command labels.
 * @param {string[]} [options.prompts=[]] - Prompt labels.
 * @param {{name: string, description?: string}[]} [options.tools=[]] - Tools, represented by their names and descriptions.
 * @param {string[]} [options.endpoints=[]] - Endpoint labels.
 * @param {string[]} [options.sessions=[]] - Session labels.
 * @returns {{id: string, label: string, children?: {id: string, label: string, hint?: string}[]}[]} Menu nodes for Help, Commands, Prompts, Tools, Endpoints, and Sessions.
 * @throws {TypeError} If options is null, a provided collection is not an array, or a tool entry is nullish.
 * @deprecated Transitional summary retained for callers of the first Phase 01 draft.
 */
export function menuTree(options = {}) {
  return [
    { id: "help", label: "Help" },
    { id: "commands", label: "Commands", children: (options.commands ?? []).map((label) => ({ id: label, label })) },
    { id: "prompts", label: "Prompts", children: (options.prompts ?? []).map((label) => ({ id: label, label })) },
    { id: "tools", label: "Tools", children: (options.tools ?? []).map((tool) => ({ id: tool.name, label: tool.name, hint: tool.description })) },
    { id: "endpoints", label: "Endpoints", children: (options.endpoints ?? []).map((label) => ({ id: label, label })) },
    { id: "sessions", label: "Sessions", children: (options.sessions ?? []).map((label) => ({ id: label, label })) },
  ];
}
