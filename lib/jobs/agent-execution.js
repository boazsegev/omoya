/** In-process job Agent execution: one fresh, headless Agent per task against
 * a wake-shared Env. An explicit cancel interrupts it; Jobs has no whole-job
 * deadline and a wake never force-kills a running job.
 */
import Env from "../env.js";
import Agent from "../agent.js";
import IO from "../io.js";
import Context from "../context.js";
import CLI from "../cli.js";

function isUnlistedModel(env, combo) {
  if (!combo?.endpoint || !combo?.model) return true;
  const models = env.endpointSettings(combo.endpoint)?.models;
  return models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0
    && (models[combo.model]?.secret === true || !Object.hasOwn(models, combo.model));
}

/** One fresh, headless Agent run against a SHARED per-wake Env. Cancellation
 * is deliberate (the caller's AbortSignal); any request/tool timeout remains
 * Agent/IO policy, never a Jobs schedule watchdog. The caller owns the Env
 * and its teardown; factories are trusted embedding/test boundaries.
 * Retries, context limits, tool timeouts and transcript writes remain Agent/IO-owned.
 */
export async function runJobAgent(task, options = {}) {
  const session = options.sessionId ?? `job-${crypto.randomUUID()}`;
  let env = options.env, agent, blocked = false, aborted = false;
  const onAbort = () => { aborted = true; void agent?.cancel(); };
  const block = () => { blocked = true; void agent?.cancel(); return null; };
  const close = options.close ?? CLI.close;
  try {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    env ??= await (options.createEnv ?? Env.create)({ ...options.environment, cwd: options.projectRoot });
    const selectModel = options.selectModel ?? CLI.selectEndpointModel;
    let combo = await selectModel(env, { model: task.model ?? options.defaultModel }, { lastUsed: true });
    const warning = task.model !== undefined && isUnlistedModel(env, combo)
      ? { code: "JOBS_MODEL_UNLISTED", message: `job model ${JSON.stringify(task.model)} is not listed; using the run default or last-model.json` }
      : undefined;
    if (warning) combo = await selectModel(env, { model: options.defaultModel }, { lastUsed: true });
    const createAgent = options.createAgent ?? ((settings) => env.createAgent(settings));
    if (!combo.endpoint || !combo.model) {
      return { outcome: "blocked", session, code: warning?.code ?? "JOBS_MODEL_BLOCKED", ...(warning ? { warning } : {}) };
    }
    const timeout = task.timeout ?? options.defaultTimeout;
    agent = createAgent({
      model: `${combo.endpoint}/${combo.model}`, session, ...(timeout === undefined ? {} : { timeout }),
      ...(task.tools === undefined ? {} : { tools: task.tools }),
      toolCall: { detached: false },
      question: { ask: async () => block() },
    });
    agent.onEvent(Agent.EVENT.TOOL_EXECUTE, (call) => {
      if (call.name === "question") {
        blocked = true;
        throw new Error("jobs cannot ask questions");
      }
    });
    options.onAgent?.(agent);
    // Persist the captured prompt even when model selection/login blocks execution.
    agent.append(Context.userMessage(task.prompt));
    agent.session?.flush?.();
    if (env.endpointSettings(combo.endpoint)?.loginRequired === true) {
      return { outcome: "blocked", session, code: warning?.code ?? "JOBS_MODEL_BLOCKED", ...(warning ? { warning } : {}) };
    }
    // Jobs leaves the run to Agent/IO policy; a wake never force-kills it.
    const ioTimeout = (options.effectiveTimeout ?? IO.resolveTimeout)({ env, model: `${combo.endpoint}/${combo.model}`, ...(timeout === undefined ? {} : { timeout }) });
    options.onReady?.({ session, timeout: ioTimeout });
    const terminal = await agent.run();
    const outcome = blocked || terminal?.kind === "auth" ? "blocked"
      : aborted || terminal?.cancelled || terminal?.kind === "cancelled" ? "cancelled"
      : terminal?.type === "done" ? "completed" : "failed";
    return { outcome, session, ...(outcome === "completed" ? {} : { code: `JOBS_${outcome.toUpperCase()}` }), ...(warning ? { warning } : {}) };
  } catch (error) {
    options.onError?.(error);
    return { outcome: blocked ? "blocked" : "failed", session, code: blocked ? "JOBS_INTERACTION_BLOCKED" : "JOBS_AGENT_FAILED" };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Release only the agent; the caller owns the shared Env and its teardown.
    close({ agent });
    if (typeof agent?.close === "function") agent.close();
  }
}
