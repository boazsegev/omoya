/**
 * lib/tui-app/menu-sources.js — gathers the live Agent/Env facts
 * buildMenuItems/buildEndpointItems/buildProviderItems/buildLoginItems
 * need, exactly as lib/tui-helpers/repl-overlays.js's openMenu() did
 * (same fields, same secret-inclusive tool listing — this is a
 * human-facing surface, `secret` only ever hides a tool from the
 * model's own published catalog).
 */

import CLI from "../cli.js";
const { listEndpointModels } = CLI;
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

function availability(env, endpoint, model) {
  const limit = env?.agentsEndpointLimit?.(endpoint, model) ?? { excluded: false, cap: 0 };
  return { available: env?.agentEndpointAvailable?.(endpoint, model) ?? 0, limit: limit.cap, excluded: limit.excluded === true };
}

/** Capture endpoint/model capacity details once for the Add submenu. */
export function addAgentMenuOptions(env) {
  return listEndpointModels(env).filter(({ loginRequired }) => loginRequired !== true).map(({ name, models = [] }) => ({
    name,
    ...availability(env, name),
    models: models.map((id) => ({ id, ...availability(env, name, id) })),
  }));
}

/** @param {object} agent @param {object} env @param {string} combo - "provider/model" @param {object} [options] */
export function masterMenuOptions(agent, env, combo, { catalog } = {}) {
  return {
    commands: COMMANDS,
    prompts: catalog?.prompts ?? env.promptNames?.() ?? [],
    tools: (env.toolNames?.() ?? []).map((name) => {
      const description = String(env.toolEntry?.(name)?.schema?.description ?? "").split("\n")[0];
      return { name: `${TOOL_PREFIX}${name}`, description };
    }),
    endpoints: env.endpointNames?.({ includeSecret: true }) ?? [],
    providers: listEndpointModels(env),
    currentModel: combo,
    thinkingLevels: THINKING_LEVELS,
    thinkingLevel: agent.thinking,
    sessions: catalog?.sessions ?? agent.listSessions?.() ?? [],
    agents: activeAgentMenuOptions(env, agent),
    addProviders: addAgentMenuOptions(env),
    safeMode: agent.safe,
    sessionSave: agent.sessionSave,
    spawnPermission: agent.spawnPermission,
    themes: ["default", ...Object.keys(env.settings?.tui?.themes ?? {}).sort()],
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
  return { presets: env.knownEndpoints?.() ?? [] };
}
