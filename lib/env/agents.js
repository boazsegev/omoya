/** Generic active-Agent registry capacity inspection. */

const DEFAULT_MAX_ACTIVE = 4;

function capacity(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_ACTIVE;
}

function configuredMaxActive(env) {
  return capacity(env.settings?.maxActive);
}

/**
 * Return the effective active-Agent cap for an endpoint/model scope.
 * `false` excludes the scope. More-specific model policy overrides endpoint
 * policy, which overrides the environment default.
 */
export function agentsEndpointLimit(env, endpoint, model) {
  const endpointSettings = env.endpointSettings(endpoint) ?? {};
  const endpointValue = endpointSettings.maxActive;
  const modelValue = model === undefined ? undefined : endpointSettings.models?.[model]?.maxActive;
  const value = modelValue ?? endpointValue ?? env.settings?.maxActive;
  return value === false ? { excluded: true, cap: 0 } : { excluded: false, cap: capacity(value) };
}

/** Count currently registered active Agents in an endpoint or endpoint/model scope. */
export function agentsAt(env, endpoint, model) {
  return env.agents().filter((agent) =>
    agent.endpoint === endpoint && (model === undefined || agent.model === model),
  ).length;
}

function busyAgentsAt(agents, endpoint, model) {
  return agents.filter((agent) => agent.busy === true
    && agent.endpoint === endpoint
    && (model === undefined || agent.model === model)).length;
}

/**
 * Recommend current capacity not occupied by running Agents. Registered idle
 * Agents are sessions, not work, and therefore do not consume a slot. This is
 * an observation, not an admission guarantee or reservation; IO remains the
 * authoritative concurrency boundary.
 */
export function agentEndpointAvailable(env, endpoint, model) {
  const agents = env.agents();
  const global = configuredMaxActive(env) - agents.filter((agent) => agent.busy === true).length;
  const endpointLimit = agentsEndpointLimit(env, endpoint);
  const modelLimit = agentsEndpointLimit(env, endpoint, model);
  if (endpointLimit.excluded || modelLimit.excluded) return 0;
  const endpointRemaining = endpointLimit.cap - busyAgentsAt(agents, endpoint);
  const modelRemaining = modelLimit.cap - busyAgentsAt(agents, endpoint, model);
  return Math.max(0, Math.min(global, endpointRemaining, modelRemaining));
}

/** Persist a generic endpoint/model active-Agent cap. */
export function agentsEndpointLimitSet(env, { endpoint, model, value }) {
  if (value !== undefined && value !== false && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError("active-Agent limit must be a non-negative number, false, or undefined");
  }
  const current = env.endpointSettings(endpoint) ?? {};
  const models = { ...(current.models ?? {}) };
  if (model === undefined) {
    if (value === undefined) delete current.maxActive;
    else current.maxActive = value;
  } else {
    const next = { ...(models[model] ?? {}) };
    if (value === undefined) delete next.maxActive;
    else next.maxActive = value;
    models[model] = next;
    current.models = models;
  }
  env.saveEndpoint(endpoint, current);
  return agentsEndpointLimit(env, endpoint, model);
}
