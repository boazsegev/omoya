/** Live AI-specific completion sources; generic matching stays in completion.js. */

import CLI from "../cli.js";
const { listModelCandidates } = CLI;
import { COMMANDS, COMMAND_ARG_HINTS, THINKING_LEVELS } from "./command-data.js";

const TOOL_PREFIX = "tool-";

/** Synchronous snapshots serve keys; refresh() exclusively uses public async APIs. */
export function createCompletionSources(agent, env, { now = Date.now } = {}) {
  const runtime = env ?? agent?.env;
  let cache = { prompts: [], sessions: [], shims: [] };
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
        "/context-edit": () => (agent?.context ?? []).map((_, index) => String(index)),
        "/context-rollback": () => (agent?.context ?? []).map((_, index) => String(index)),
        "/session-resume": cache.sessions.map((session) => session.id),
        "/endpoint-logout": runtime?.endpointNames?.({ includeSecret: true }) ?? [],
      },
    };
  };
  sources.catalog = () => cache;
  sources.refresh = async () => {
    const [prompts, sessions] = await Promise.all([
      runtime?.promptNamesAsync?.() ?? [],
      agent?.listSessionsAsync?.() ?? [],
    ]);
    cache = {
      prompts: [...new Set(prompts)],
      sessions,
      shims: [...new Set((runtime?.toolNames?.() ?? []).map((name) => `/${TOOL_PREFIX}${name}`))],
      at: now(),
    };
    return cache;
  };
  return sources;
}
