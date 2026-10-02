/**
 * lib/tui-app/menu-sources.js — gathers the live Agent/Env facts
 * buildMenuItems/buildEndpointItems/buildProviderItems/buildLoginItems
 * need, exactly as lib/tui-helpers/repl-overlays.js's openMenu() did
 * (same fields, same secret-inclusive tool listing — this is a
 * human-facing surface, `secret` only ever hides a tool from the
 * model's own published catalog).
 */

import CLI from "../../cli.js";
import Context from "../../context.js";
const { listEndpointModels, listEndpoints } = CLI;
import { COMMANDS, THINKING_LEVELS, TOOL_PREFIX } from "./commands.js";
import { modelParts } from "../shared/format.js";

/**
 * Build the stable parent/name key used to sort an agent snapshot.
 * @param {object|null|undefined} agent Agent-like value; missing fields use "__".
 * @returns {string} Parent name and agent name joined with a colon.
 */
function agentSortKey(agent) {
  return `${agent?.parent?.name ?? "__"}:${agent?.name ?? "__"}`;
}

/**
 * Order an Env agent snapshot in parent-before-child order, without treating
 * distinct agents with equal names as the same agent.
 * @param {Array<object>} [agents=[]] Agent snapshot to order.
 * @returns {Array<object>} A new array containing the snapshot agents, sorted by
 *   parent/name key and traversed depth-first beneath each root. Identity is used
 *   to avoid adding an agent more than once.
 * @throws Propagates errors raised while reading agent properties or sorting.
 */
export function orderAgentSnapshot(agents = []) {
  const sorted = [...agents].sort(/** Compare agents by their parent/name sort keys.
   * @param {object} first First agent to compare.
   * @param {object} second Second agent to compare.
   * @returns {number} Negative, zero, or positive according to key ordering.
   */ (first, second) => {
    const firstKey = agentSortKey(first);
    const secondKey = agentSortKey(second);
    return firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0;
  });
  const ordered = [];
  /**
   * Append an agent once, followed recursively by its children in sorted order.
   * @param {object} agent Agent to append and use as the parent for child lookup.
   * @returns {undefined} Always returns undefined; mutates the enclosing ordered array.
   */
  const append = (agent) => {
    if (ordered.some(/** Check whether the ordered list already contains this exact agent.
     * @param {object} candidate Previously appended agent.
     * @returns {boolean} True when the candidate is the same object as `agent`.
     */ (candidate) => candidate === agent)) return;
    ordered.push(agent);
    for (const child of sorted) if (child?.parent === agent) append(child);
  };
  for (const agent of sorted) if (!agent?.parent) append(agent);
  for (const agent of sorted) append(agent);
  return ordered;
}

/**
 * Capture active agents once and shape them as menu options; the result is a
 * snapshot and does not update when the environment changes.
 * @param {object|null|undefined} env Environment; if `agents` is callable it is invoked.
 * @param {object|null|undefined} current Agent to mark as current by identity.
 * @returns {Array<{agent: object, current: boolean, child: boolean, busy: boolean, description: string|undefined}>} Menu options in snapshot order.
 * @throws Propagates errors from `env.agents()` or agent snapshot processing.
 */
export function activeAgentMenuOptions(env, current) {
  const snapshot = typeof env?.agents === "function" ? env.agents() : [];
  return orderAgentSnapshot(snapshot).map(/** Shape one agent as a frozen menu option.
   * @param {object} agent Agent from the captured snapshot.
   * @returns {{agent: object, current: boolean, child: boolean, busy: boolean, description: string|undefined}} Menu-option fields for the agent.
   */ (agent) => ({
    agent,
    current: agent === current,
    child: agent?.parent !== undefined && agent?.parent !== null,
    busy: agent?.busy === true || agent?.ioState === "working",
    description: typeof agent?.description === "string" && agent.description !== "" ? agent.description : undefined,
  }));
}

/**
 * Convert one catalog entry into the capacity fields used by the Add submenu.
 * @param {object|null|undefined} info Agent-plugin model information; missing fields default to zero.
 * @returns {{available: number, limit: number, excluded: boolean}} Capacity and exclusion status.
 */
function availability(info) {
  return { available: info?.available ?? 0, limit: info?.maxActive ?? 0, excluded: info?.maxActive === 0 };
}

/**
 * Capture endpoint/model capacity details once for the Add submenu. Each model
 * pair retains its own readout; each endpoint row summarizes its best pair.
 * @param {object|null|undefined} env Environment passed to the CLI catalog lookup;
 *   its optional `models()` method supplies capacity data.
 * @returns {Array<{name: string, available: number, limit: number, excluded: boolean, models: Array<{id: string, available: number, limit: number, excluded: boolean}>}>} Endpoint options excluding login-required endpoints.
 * @throws Propagates errors from environment methods and CLI endpoint/model lookup.
 */
export function addAgentMenuOptions(env) {
  const catalog = env?.models?.() ?? new Map();
  return listEndpointModels(env).filter(/** Keep endpoints that do not require login.
   * @param {object} endpoint Endpoint/model catalog entry.
   * @returns {boolean} True unless login is explicitly required.
   */ ({ loginRequired }) => loginRequired !== true).map(/** Summarize one endpoint and its model capacities.
   * @param {object} endpoint Endpoint entry; `models` defaults to an empty array.
   * @returns {object} Endpoint name, best capacity summary, exclusion flag, and per-model details.
   */ ({ name, models = [] }) => {
    const pairs = models.map(/** Build capacity details for one endpoint/model pair.
     * @param {string} id Model identifier.
     * @returns {{id: string, available: number, limit: number, excluded: boolean}} Pair identifier and capacity fields.
     */ (id) => ({ id, ...availability(catalog.get(`${name}/${id}`)) }));
    return {
      name,
      available: Math.max(0, ...pairs.map(/** Read one model pair's available capacity.
       * @param {object} pair Pair capacity record.
       * @returns {number} Available count.
       */ (pair) => pair.available)),
      limit: Math.max(0, ...pairs.map(/** Read one model pair's capacity limit.
       * @param {object} pair Pair capacity record.
       * @returns {number} Maximum active count.
       */ (pair) => pair.limit)),
      excluded: pairs.length > 0 && pairs.every(/** Check whether a model pair is excluded.
       * @param {object} pair Pair capacity record.
       * @returns {boolean} True when that pair is excluded.
       */ (pair) => pair.excluded),
      models: pairs,
    };
  });
}

/**
 * Build the complete master-menu data snapshot from the agent and environment.
 * @param {object} agent Current agent; supplies thinking, safety, context, and permissions.
 * @param {object} env Environment used to obtain prompts, endpoint/provider data, agents,
 *   settings, and optional sessions.
 * @param {string} combo Current model in `provider/model` form.
 * @param {{catalog?: object}} [options={}] Optional preloaded menu data.
 * @returns {object} Master-menu options, including commands, tools, providers, agents,
 *   settings, and session/model selections.
 * @throws Propagates errors from environment/CLI lookups and session listing.
 */
export function masterMenuOptions(agent, env, combo, { catalog } = {}) {
  return {
    commands: COMMANDS,
    prompts: catalog?.prompts ?? [...(env.prompts?.().keys() ?? [])],
    tools: (Array.isArray(catalog?.tools) ? catalog.tools : []).map(/** Convert a catalog tool to its displayed menu entry.
     * @param {object} tool Tool name and schema.
     * @returns {{name: string, description: string}} Prefixed tool name and first description line.
     */ ({ name, schema }) => ({
      name: `${TOOL_PREFIX}${name}`,
      description: String(schema?.description ?? "").split("\n")[0],
    })),
    endpoints: listEndpoints(env),
    providers: listEndpointModels(env),
    currentModel: combo,
    thinkingLevels: THINKING_LEVELS,
    thinkingLevel: agent.thinking,
    sessions: catalog?.sessions ?? (agent.env ? Context.list({ dir: agent.env.settings.sessions, cwd: agent.env.cwd }) : []),
    agents: activeAgentMenuOptions(env, agent),
    addProviders: addAgentMenuOptions(env),
    safeMode: agent.safe,
    sessionSave: agent.context?.save,
    spawnPermission: agent.spawnPermission,
    themes: ["default", ...Object.keys(env.settings?.tui?.themes ?? {})].sort(/** Sort theme names using locale collation.
     * @param {string} a First theme name.
     * @param {string} b Second theme name.
     * @returns {number} Locale comparison result.
     */ (a, b) => a.localeCompare(b)),
    theme: env.settings?.tui?.theme ?? "default",
  };
}

/**
 * Build endpoint-selection menu data.
 * @param {object} env Environment used to list endpoint model providers.
 * @param {string} combo Current model selection in `provider/model` form.
 * @returns {{providers: Array<object>, combo: string}} Provider catalog and current selection.
 * @throws Propagates errors from endpoint/model lookup.
 */
export function endpointMenuOptions(env, combo) {
  return { providers: listEndpointModels(env), combo };
}

/**
 * Build model-selection menu data for the currently connected endpoint.
 * @param {object} agent Current agent; its qualified `model` identifies the connected endpoint.
 * @param {object} env Environment used to list endpoint models.
 * @returns {{value: string, models: Array<object>}|null} Endpoint name and its models,
 *   or null when the agent has no non-empty string endpoint name.
 * @throws Propagates errors from endpoint/model lookup.
 */
export function modelMenuOptions(agent, env) {
  const name = modelParts(agent?.model).endpoint;
  if (typeof name !== "string" || name === "") return null;
  const models = listEndpointModels(env).find(/** Locate the provider matching the connected endpoint.
   * @param {object} provider Endpoint/provider catalog entry.
   * @returns {boolean} True when this entry has the agent's endpoint name.
   */ (provider) => provider.name === name)?.models ?? [];
  return { value: name, models };
}

/**
 * Build login menu data from the environment's available presets.
 * @param {object} env Environment; its `loginPresets()` method is optional.
 * @returns {{presets: Array<object>}} Login presets, defaulting to an empty array.
 * @throws Propagates errors raised by `env.loginPresets()`.
 */
export function loginMenuOptions(env) {
  return { presets: env.loginPresets?.() ?? [] };
}
