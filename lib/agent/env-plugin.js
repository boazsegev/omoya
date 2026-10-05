/**
 * lib/agent/env-plugin.js — Agent's Env plugin (private to Agent).
 *
 * Env knows nothing about Agents: this plugin installs every Env member
 * that concerns them (Env.extend) when lib/agent.js loads —
 *   - the ACTIVE-AGENT registry: agents(), agentAdd(), agentRemove();
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
  maxActive: { default: DEFAULT_MAX_ACTIVE, description: "Global cap on concurrently RUNNING Agents (endpoints and models may set their own; false excludes one)." },
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
       * Snapshot the active Agents in registration order. Closing an Agent
       * removes it synchronously; inactivity and garbage collection never
       * change this lifecycle registry.
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
      agentAdd(agent) {
        requireAgent(agent, "agentAdd");
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
      agentRemove(agent) {
        requireAgent(agent, "agentRemove");
        if (!registry(this).delete(agent)) return false;
        this._detachHooks?.(agent);
        emit(this, plugin.EVENT.AGENT_REMOVED, { agent });
        return true;
      },

      /**
       * Create an Agent over this env (`env` is always this env).
       * @param {object} [options] Agent constructor options
       * @returns {object} the new, registered Agent
       * @throws {Error} when this env is closed (env.closed)
       */
      agentCreate(options = {}) {
        if (this.closed) throw new Error("Env is closed; it creates no new agents.");
        return new Agent({ ...options, env: this });
      },

    },

    /**
     * Each catalog pair's active-Agent capacity (env.models()): maxActive =
     * the tightest of the global, endpoint, and model `maxActive` (model
     * policy overrides endpoint policy, which overrides the global;
     * `false` excludes the scope: 0); active = RUNNING Agents on the pair
     * (idle registered Agents are sessions, not work); available = the
     * capacity no running Agent occupies — an observation, never a
     * reservation.
     * @param {object} env
     * @param {{endpoint: string, model: string}} info
     * @param {object} settings - the endpoint's settings
     * @returns {{maxActive: number, active: number, available: number}}
     */
    modelInfo(env, { endpoint, model }, settings) {
      const agents = env.agents();
      /** Treat an explicit false scope limit as zero; normalize other values. */
      const cap = (value) => (value === false ? 0 : capacity(value));
      const global = capacity(env.settings.maxActive);
      const endpointCap = cap(settings.maxActive ?? env.settings.maxActive);
      const modelCap = cap(settings.models?.[model]?.maxActive ?? settings.maxActive ?? env.settings.maxActive);
      const active = busyAgents(agents, endpoint, model);
      const available = endpointCap === 0 || modelCap === 0 ? 0 : Math.max(0, Math.min(
        global - busyAgents(agents), endpointCap - busyAgents(agents, endpoint), modelCap - active,
      ));
      return { maxActive: Math.min(global, endpointCap, modelCap), active, available };
    },
  });
  emit = plugin.emit;
  return plugin;
}
