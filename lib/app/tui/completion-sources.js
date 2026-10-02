/** Live AI-specific completion sources; generic matching stays in completion.js. */

import CLI from "../../cli.js";
import Context from "../../context.js";
const { listModelCandidates, listEndpoints } = CLI;
import { COMMANDS, COMMAND_ARG_HINTS, THINKING_LEVELS } from "./command-data.js";

const TOOL_PREFIX = "tool-";

/**
 * Create completion sources backed by synchronous runtime data and a refreshable cache.
 * @param {object} agent Agent whose environment, context, and safety setting are used; may be absent.
 * @param {object} env Environment override; when nullish, `agent?.env` is used.
 * @param {object} [options={}] Options object.
 * @param {Function} [options.now=Date.now] Clock called when a refresh succeeds; its result is stored as the cache timestamp.
 * @returns {Function} A source-provider function with `catalog()` and async `refresh()` methods.
 * @throws {Error} Synchronous errors from model-candidate or endpoint lookups propagate to the caller.
 */
export function createCompletionSources(agent, env, { now = Date.now } = {}) {
  const runtime = env ?? agent?.env;
  let cache = { prompts: [], sessions: [], shims: [], tools: [] };
  /**
   * Build the current synchronous completion-source object from constants, runtime data, and cached values.
   * @returns {object} Completion source mappings for commands, prompts, shims, models, argument hints, and candidates.
   * @throws {Error} Errors from synchronous model-candidate and endpoint lookups propagate.
   */
  const sources = () => {
    const models = listModelCandidates(runtime);
    return {
      commands: COMMANDS,
      prompts: cache.prompts.map(/** Convert a cached prompt name to its slash-prefixed completion. @param {string} name Prompt name. @returns {string} Slash-prefixed prompt path. */ (name) => `/${name}`),
      shims: cache.shims,
      modelCandidates: models,
      argHints: COMMAND_ARG_HINTS,
      argCandidates: {
        "/endpoint-model": models,
        "/agent-thinking": THINKING_LEVELS,
        // agent.context is a Context instance (length/at/messages()), not an
        // array — address it through the same contract the handlers use.
        "/context-edit": /** Return string indices for the agent's current context entries. @returns {string[]} Context entry indices from zero through length minus one. */ () => Array.from({ length: agent?.context?.length ?? 0 }, /** Convert an entry position to its string index. @param {number} _ Array position (unused). @param {number} index Context entry index. @returns {string} String representation of the index. */ (_, index) => String(index)),
        "/context-rollback": /** Return string indices for the agent's current context entries. @returns {string[]} Context entry indices from zero through length minus one. */ () => Array.from({ length: agent?.context?.length ?? 0 }, /** Convert an entry position to its string index. @param {number} _ Array position (unused). @param {number} index Context entry index. @returns {string} String representation of the index. */ (_, index) => String(index)),
        "/session-resume": cache.sessions.map(/** Extract the identifier used by session-resume completions. @param {object} session Cached session record. @returns {*} Session identifier. */ (session) => session.id),
        "/endpoint-logout": runtime ? listEndpoints(runtime) : [],
      },
    };
  };
  /** Return the most recently refreshed cache without performing I/O. @returns {object} Current completion catalog; initially contains empty prompts, sessions, shims, and tools. */
  sources.catalog = () => cache;
  /**
   * Refresh prompts, sessions, and tools through public APIs, then replace and return the cache.
   * @returns {Promise<object>} Promise for the refreshed catalog, including its `at` timestamp.
   * @throws {Error} The returned promise rejects if any asynchronous or synchronous source lookup fails; in that case the previous cache remains in place.
   */
  sources.refresh = async () => {
    const [prompts, sessions, tools] = await Promise.all([
      [...(runtime?.prompts?.().keys() ?? [])],
      agent?.env ? Context.listAsync({ dir: agent.env.settings.sessions, cwd: agent.env.cwd }) : [],
      // the tool catalog snapshot (ToolInfo values: menus, shims, status rows)
      runtime?.tools?.(agent?.safe === true) ?? new Map(),
    ]);
    cache = {
      prompts: [...new Set(prompts)],
      sessions,
      tools: [...tools.values()],
      shims: [...tools.keys()].map(/** Convert a tool name to its slash-prefixed shim command. @param {string} name Tool name. @returns {string} Slash-prefixed tool command. */ (name) => `/${TOOL_PREFIX}${name}`),
      at: now(),
    };
    return cache;
  };
  return sources;
}
