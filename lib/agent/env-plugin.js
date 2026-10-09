/**
 * lib/agent/env-plugin.js — Agent's Env plugin (private to Agent).
 *
 * Env knows nothing about Agents: this plugin installs every Env member
 * that concerns them (Env.extend) when lib/agent.js loads —
 *   - the ACTIVE-AGENT registry: agents(), _agentAdd(), _agentRemove();
 *   - the private _toolContextCreate(name, context) handshake for manual
 *     Env.toolCall dispatches carrying an Agent;
 *   - the factory agentCreate(options) (an Agent over the env it is
 *     called on — the safe view yields a safe Agent);
 *   - active-Agent capacity: the modelInfo catalog hook adds maxActive /
 *     active / available to every env.models() pair (the `maxActive`
 *     settings; a limit changes as a settings write:
 *     env.settings.providers[endpoint].models[model].maxActive = n);
 *   - the MEMBERSHIP events AGENT_ADDED/AGENT_REMOVED ({agent}) — Env
 *     reports which agents exist; what an agent does is its own
 *     Agent.onEvent vocabulary (subscribe on AGENT_ADDED);
 *   - the schema entries of the settings Agent owns: `context` and
 *     `retry` (the policy each Agent resolves once — lib/agent/policy.js)
 *     and `maxActive`;
 *   - systemPrompt(): the seeded system-prompt texts.
 * Registry state lives under a private Symbol key on the Env (shared by
 * its safe view).
 */

import { resolveSystemPrompt } from "./system-prompt.js";
import { POLICY_SETTINGS } from "./policy.js";
import { refreshHooks, attachHooks, detachHooks } from "./hooks.js";

const AGENTS = Symbol("agents");
const DEFAULT_MAX_ACTIVE = 8;

/** The settings keys Agent owns: key -> {default, description}. */
const SETTINGS = {
  ...POLICY_SETTINGS,
  maxActive: { default: DEFAULT_MAX_ACTIVE, description: "Default cap on concurrently RUNNING Agents (endpoint and model limits override it; false excludes one)." },
};

/** The env's registry Set (created on first use).
 * @param {object} env - Env instance (or its safe view)
 * @returns {Set<object>} the shared active-Agent registry
 */
function registry(env) {
  return env[AGENTS] ??= new Set();
}

/**
 * Normalize a configured concurrency limit, falling back to the default.
 * @param {*} value - candidate capacity
 * @returns {number} a finite nonnegative capacity
 */
function capacity(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_ACTIVE;
}

/**
 * Count running Agents, optionally restricted to an endpoint and model.
 * @param {object[]} agents - registered Agent snapshot
 * @param {string} [endpoint] - endpoint filter
 * @param {string} [model] - model filter
 * @returns {number} matching busy-Agent count
 */
function busyAgents(agents, endpoint, model) {
  return agents.filter((agent) => {
    const selected = agent.model;
    return agent.busy === true
      && (endpoint === undefined || selected?.startsWith(`${endpoint}/`))
      && (model === undefined || selected === `${endpoint}/${model}`);
  }).length;
}

/**
 * Validate that a value can be used as an Agent registry entry.
 * @param {*} agent - candidate registry entry
 * @param {string} owner - Env method name for error context
 * @returns {void}
 * @throws {TypeError} when agent is neither an object nor a function
 */
function requireAgent(agent, owner) {
  if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) {
    throw new TypeError(`Env.${owner}: agent must be an object`);
  }
}

/**
 * Install Agent's members onto Env.
 * @param {Function} Env
 * @param {Function} Agent
 * @returns {{EVENT: Object<string, symbol>, emit: Function}} the AGENT_* events and their emitter
 */
export function installEnvPlugin(Env, Agent) {
  let emit;
  const plugin = Env.extend({
    events: ["AGENT_ADDED", "AGENT_REMOVED"],
    settings: SETTINGS,
    methods: {
      /** Load/reload trusted hook observers for this environment. @returns {Promise<void>} */
      _hooksRefresh() { return refreshHooks(this); },
      /** Attach the loaded hooks to an Agent. @param {object} agent @returns {void} */
      _attachHooks(agent) { attachHooks(this, agent); },
      /** Remove hook registrations on Agent close. @param {object} agent @returns {void} */
      _detachHooks(agent) { detachHooks(this, agent); },
      /**
       * The system-prompt text(s) seeded into a FRESH context, read from
       * disk on every call (package, user settings, then project
       * AGENTS.md — or `settings.system`), with `{{skill}}` prefill.
       * @returns {string[]} zero to three texts, in layering order
       */
      systemPrompt() {
        return resolveSystemPrompt(this);
      },

      /**
       * Snapshot registered Agents in registration order. Awaiting Agent.close()
       * ensures its owned teardown and removal; close-marked Agents remain
       * registered until releases settle. Inactivity and garbage collection
       * never change this lifecycle registry.
       * @returns {object[]}
       */
      agents() {
        return [...registry(this)];
      },

      /**
       * Register an active Agent (Agent construction owns this call); it
       * stays until `Agent.close()` removes it.
       * @param {object} agent
       * @returns {object} the registered agent
       */
      _agentAdd(agent) {
        requireAgent(agent, "_agentAdd");
        const agents = registry(this);
        if (agents.has(agent)) return agent;
        agents.add(agent);
        this._attachHooks?.(agent);
        emit(this, plugin.EVENT.AGENT_ADDED, { agent });
        return agent;
      },

      /**
       * Remove an active Agent (`Agent.close()` owns normal use).
       * @param {object} agent
       * @returns {boolean} whether the agent was registered
       */
      _agentRemove(agent) {
        requireAgent(agent, "_agentRemove");
        if (!registry(this).delete(agent)) return false;
        this._detachHooks?.(agent);
        emit(this, plugin.EVENT.AGENT_REMOVED, { agent });
        return true;
      },

      /**
       * Fill a manual Env.toolCall's host context with Agent-owned tool
       * capabilities. The supplied context wins for explicitly provided
       * capabilities; absent safe mode inherits the Agent's effective mode.
       * Env invokes this private hook only when context.agent is present.
       * @param {string} name Flattened tool name.
       * @param {object} context Caller-supplied host context (not mutated).
       * @returns {Promise<object>} Context suitable for tool dispatch.
       */
      async _toolContextCreate(name, context) {
        const agent = context.agent;
        const info = (await this.tools(false, context.selector ?? agent.model)).get(name);
        const generated = agent._toolContext({ name }, { info, trusted: info?.trusted });
        // Copy descriptors so the optional IO getter remains lazy: spreading
        // generated would open a provider connection before dispatch needs it.
        const descriptors = Object.getOwnPropertyDescriptors(generated);
        for (const descriptor of Object.values(descriptors)) descriptor.configurable = true;
        const filled = Object.defineProperties({}, descriptors);
        Object.defineProperties(filled, Object.getOwnPropertyDescriptors(context));
        filled.safe = context.safe ?? agent.can.write !== true;
        return filled;
      },

      /**
       * Create an Agent over this env (`env` is always this env).
       * @param {object} [options] Agent constructor options
       * @returns {Promise<Agent>} the new, registered Agent
       * @throws {Error} when this env is closed (env.closed)
       */
      async agentCreate(options = {}) {
        if (this.closed) throw new Error("Env is closed; it creates no new agents.");
        return Agent.create({ ...options, env: this });
      },

    },

    /**
     * Each catalog pair's active-Agent capacity (env.models()): maxActive
     * inherits the first specified limit from model, endpoint, then global;
     * `false` excludes that scope (0). active = RUNNING Agents on the pair
     * (idle registered Agents are sessions, not work); available subtracts
     * running Agents in the selected limit's scope — an observation, never
     * a reservation.
     * @param {object} env
     * @param {{endpoint: string, model: string}} info
     * @param {object} settings - the endpoint's settings
     * @returns {{maxActive: number, active: number, available: number}}
     */
    modelInfo(env, { endpoint, model }, settings) {
      const agents = env.agents();
      /** Treat an explicit false scope limit as zero; normalize other values. */
      const cap = (value) => (value === false ? 0 : capacity(value));
      const modelLimit = settings.models?.[model]?.maxActive;
      const endpointLimit = settings.maxActive;
      const maxActive = cap(modelLimit ?? endpointLimit ?? env.settings.maxActive);
      const active = busyAgents(agents, endpoint, model);
      const occupied = modelLimit != null ? active
        : endpointLimit != null ? busyAgents(agents, endpoint) : busyAgents(agents);
      return { maxActive, active, available: Math.max(0, maxActive - occupied) };
    },
  });
  emit = plugin.emit;
  return plugin;
}
