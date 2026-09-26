/** AI-specific, terminal-neutral presentation contracts. */

export { contextBlocks } from "./context-blocks.js";
export {
  KEYBINDINGS,
  buildEndpointItems,
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

/** @deprecated Transitional summary retained for callers of the first Phase 01 draft. */
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
