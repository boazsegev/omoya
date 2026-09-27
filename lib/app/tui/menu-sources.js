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

function agentSortKey(agent) {
  return `${agent?.parent?.name ?? "__"}:${agent?.name ?? "__"}`;
}

/** Order an Env agent snapshot without treating equal names as equal agents. */
export function orderAgentSnapshot(agents = []) {
  const sorted = [...agents].sort((first, second) => {
    const firstKey = agentSortKey(first);
    const secondKey = agentSortKey(second);
    return firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0;
  });
  const ordered = [];
  const append = (agent) => {
    if (ordered.some((candidate) => candidate === agent)) return;
    ordered.push(agent);
    for (const child of sorted) if (child?.parent === agent) append(child);
  };
  for (const agent of sorted) if (!agent?.parent) append(agent);
  for (const agent of sorted) append(agent);
  return ordered;
}

/** Capture active agents once for a menu opening; its items remain frozen thereafter. */
export function activeAgentMenuOptions(env, current) {
  const snapshot = typeof env?.agents === "function" ? env.agents() : [];
  return orderAgentSnapshot(snapshot).map((agent) => ({
    agent,
    current: agent === current,
    child: agent?.parent !== undefined && agent?.parent !== null,
    busy: agent?.busy === true || agent?.ioState === "working",
    description: typeof agent?.description === "string" && agent.description !== "" ? agent.description : undefined,
  }));
}

/** One catalog pair's capacity readout (env.models(): the Agent plugin's fields). */
function availability(info) {
  return { available: info?.available ?? 0, limit: info?.maxActive ?? 0, excluded: info?.maxActive === 0 };
}

/** Capture endpoint/model capacity details once for the Add submenu: each
 *  pair's own readout; an endpoint row summarizes its best pair. */
export function addAgentMenuOptions(env) {
  const catalog = env?.models?.() ?? new Map();
  return listEndpointModels(env).filter(({ loginRequired }) => loginRequired !== true).map(({ name, models = [] }) => {
    const pairs = models.map((id) => ({ id, ...availability(catalog.get(`${name}/${id}`)) }));
    return {
      name,
      available: Math.max(0, ...pairs.map((pair) => pair.available)),
      limit: Math.max(0, ...pairs.map((pair) => pair.limit)),
      excluded: pairs.length > 0 && pairs.every((pair) => pair.excluded),
      models: pairs,
    };
  });
}

/** @param {object} agent @param {object} env @param {string} combo - "provider/model" @param {object} [options] */
export function masterMenuOptions(agent, env, combo, { catalog } = {}) {
  return {
    commands: COMMANDS,
    prompts: catalog?.prompts ?? [...(env.prompts?.().keys() ?? [])],
    tools: (Array.isArray(catalog?.tools) ? catalog.tools : []).map(({ name, schema }) => ({
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
    themes: ["default", ...Object.keys(env.settings?.tui?.themes ?? {})].sort((a, b) => a.localeCompare(b)),
    theme: env.settings?.tui?.theme ?? "default",
  };
}

/** @param {object} env @param {string} combo */
export function endpointMenuOptions(env, combo) {
  return { providers: listEndpointModels(env), combo };
}

/** @param {object} agent @param {object} env - the ^M model menu of the CURRENTLY CONNECTED endpoint */
export function modelMenuOptions(agent, env) {
  const name = agent.endpoint;
  if (typeof name !== "string" || name === "") return null;
  const models = listEndpointModels(env).find((provider) => provider.name === name)?.models ?? [];
  return { value: name, models };
}

/** @param {object} env */
export function loginMenuOptions(env) {
  return { presets: env.loginPresets?.() ?? [] };
}
