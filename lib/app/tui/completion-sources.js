/** Live AI-specific completion sources; generic matching stays in completion.js. */

import CLI from "../../cli.js";
import Context from "../../context.js";
const { listModelCandidates, listEndpoints } = CLI;
import { COMMANDS, COMMAND_ARG_HINTS, THINKING_LEVELS } from "./command-data.js";

const TOOL_PREFIX = "tool-";

/** Synchronous snapshots serve keys; refresh() exclusively uses public async APIs. */
export function createCompletionSources(agent, env, { now = Date.now } = {}) {
  const runtime = env ?? agent?.env;
  let cache = { prompts: [], sessions: [], shims: [], tools: [] };
  const sources = () => {
    const models = listModelCandidates(runtime);
    return {
      commands: COMMANDS,
      prompts: cache.prompts.map((name) => `/${name}`),
      shims: cache.shims,
      modelCandidates: models,
      argHints: COMMAND_ARG_HINTS,
      argCandidates: {
        "/endpoint-model": models,
        "/agent-thinking": THINKING_LEVELS,
        // agent.context is a Context instance (length/at/messages()), not an
        // array — address it through the same contract the handlers use.
        "/context-edit": () => Array.from({ length: agent?.context?.length ?? 0 }, (_, index) => String(index)),
        "/context-rollback": () => Array.from({ length: agent?.context?.length ?? 0 }, (_, index) => String(index)),
        "/session-resume": cache.sessions.map((session) => session.id),
        "/endpoint-logout": runtime ? listEndpoints(runtime) : [],
      },
    };
  };
  sources.catalog = () => cache;
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
      shims: [...tools.keys()].map((name) => `/${TOOL_PREFIX}${name}`),
      at: now(),
    };
    return cache;
  };
  return sources;
}
