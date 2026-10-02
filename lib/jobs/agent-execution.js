/** In-process job Agent execution: one fresh, headless Agent per task against
 * a wake-shared Env. An explicit cancel interrupts it; Jobs has no whole-job
 * deadline and a wake never force-kills a running job.
 */
import Env from "../env.js";
import Agent from "../agent.js";
import IO from "../io.js";
import Context from "../context.js";
import CLI from "../cli.js";

/** Determine whether a selected model is outside its endpoint's published catalog.
 * An endpoint without listed models has no catalog yet, so any model passes.
 * @param {Env} env Environment whose model catalog is inspected.
 * @param {string|undefined} model Selected qualified model.
 * @returns {boolean} Whether the pair is unlisted or marked secret.
 * @throws Propagates errors raised while reading the environment model catalog.
 */
function isUnlistedModel(env, model) {
  if (!model) return true;
  const pairs = [...env.models(true).values()].filter(/** Select listed models belonging to the requested endpoint.
   * @param {object} info Model catalog entry.
   * @returns {boolean} Whether this entry belongs in the endpoint's listed-model set.
   */ (info) => model.startsWith(`${info.endpoint}/`) && info.listed);
  const pair = pairs.find(/** Locate the requested model in the endpoint's listed catalog.
   * @param {object} info Listed model catalog entry.
   * @returns {boolean} Whether this entry names the requested model.
   */ (info) => `${info.endpoint}/${info.model}` === model);
  return pairs.length > 0 && (pair === undefined || pair.secret);
}

/** Run one fresh, headless Agent for a job against the wake-shared Env.
 * Cancellation comes only from the caller's AbortSignal; request/tool timeouts,
 * retries, context limits, and transcript writes remain Agent/IO policy. The
 * caller owns the Env and its teardown; injected factories are trusted boundaries.
 * @param {object} task Job task.
 * @param {string} task.prompt Prompt persisted to the Agent context and executed.
 * @param {string} [task.model] Requested model; falls back to options.defaultModel.
 * @param {number} [task.timeout] IO timeout override; nullish values fall back to options.defaultTimeout.
 * @param {Array<string>} [task.tools] Optional tool allowlist; omitted when undefined.
 * @param {object} [options={}] Runtime settings, dependency overrides, and lifecycle callbacks.
 * @param {Env} [options.env] Existing shared Env; if absent, one is created.
 * @param {string} [options.sessionId] Session/context ID; defaults to a generated `job-<UUID>`.
 * @param {AbortSignal} [options.signal] Signal whose abort cancels the Agent; no default signal.
 * @param {object} [options.environment] Options passed to Env.create; defaults to an empty spread.
 * @param {string} [options.projectRoot] Env cwd override; undefined if omitted.
 * @param {string} [options.defaultModel] Fallback model; undefined if omitted.
 * @param {number} [options.defaultTimeout] Fallback IO timeout; undefined if omitted.
 * @param {Function} [options.createEnv] Env factory; defaults to Env.create.
 * @param {Function} [options.selectModel] Model selector; defaults to CLI.selectEndpointModel.
 * @param {Function} [options.createAgent] Agent factory; defaults to env.agentCreate.
 * @param {Function} [options.effectiveTimeout] Timeout resolver; defaults to IO.timeoutsResolve.
 * @param {Function} [options.close] Agent release callback; defaults to CLI.close.
 * @param {Function} [options.onAgent] Optional callback invoked with the created Agent.
 * @param {Function} [options.onReady] Optional callback invoked with session and resolved timeout.
 * @param {Function} [options.onError] Optional callback invoked for caught execution errors.
 * @returns {Promise<object>} Outcome record (`completed`, `failed`, `blocked`, or `cancelled`), session, and applicable code/message/warning.
 * @throws Teardown errors from the close callback or Agent close may reject the promise; execution errors are otherwise reported as failed outcomes.
 * @effects May create an Env and Agent, persist the prompt, run the Agent, invoke hooks, respond to abort, and close the Agent. Does not close the caller-owned Env.
 */
export async function runJobAgent(task, options = {}) {
  const session = options.sessionId ?? `job-${crypto.randomUUID()}`;
  let env = options.env, agent, blocked = false, aborted = false;
  /** Mark the run cancelled and request cancellation of its Agent, if created.
   * @returns {void} No value.
   * @effects Sets the local aborted flag and calls Agent.cancel() without awaiting it.
   */
  const onAbort = () => { aborted = true; void agent?.cancel(); };
  /** Mark unattended interaction as blocked and cancel the Agent.
   * @returns {null} Null answer for the question hook.
   * @effects Sets the local blocked flag and calls Agent.cancel() without awaiting it.
   */
  const block = () => { blocked = true; void agent?.cancel(); return null; };
  const close = options.close ?? CLI.close;
  try {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    env ??= await (options.createEnv ?? /** Create the job Env with configured environment and project root.
     * @param {object} config Environment options with cwd overridden by projectRoot.
     * @returns {Promise<Env>} Newly created Env.
     * @effects Allocates an Env; errors propagate to the enclosing run handler.
     */ Env.create)({ ...options.environment, cwd: options.projectRoot });
    const selectModel = options.selectModel ?? CLI.selectEndpointModel;
    let model = await selectModel(env, { model: task.model ?? options.defaultModel }, { lastUsed: true });
    const warning = task.model !== undefined && isUnlistedModel(env, model)
      ? { code: "JOBS_MODEL_UNLISTED", message: `job model ${JSON.stringify(task.model)} is not listed; using the run default or last-model.json` }
      : undefined;
    if (warning) model = await selectModel(env, { model: options.defaultModel }, { lastUsed: true });
    const createAgent = options.createAgent ?? /** Create an Agent from the selected runtime settings.
     * @param {object} settings Agent configuration.
     * @returns {Agent} Created Agent.
     * @effects Delegates construction to the current Env; construction errors propagate to the enclosing run handler.
     */ ((settings) => env.agentCreate(settings));
    if (!model) {
      return { outcome: "blocked", session, code: warning?.code ?? "JOBS_MODEL_BLOCKED", message: warning?.message ?? "no endpoint/model is available: set a default model, pass --model, or add `model:` to the task", ...(warning ? { warning } : {}) };
    }
    const timeout = task.timeout ?? options.defaultTimeout;
    agent = createAgent({
      model, contextId: session, ...(timeout === undefined ? {} : { timeout }),
      ...(task.tools === undefined ? {} : { tools: task.tools }),
      toolCall: { detached: false },
      question: { ask: /** Reject interactive questions by blocking and cancelling the unattended job.
       * @returns {Promise<null>} A promise resolving to the null answer from block().
       * @effects Marks the run blocked and requests Agent cancellation.
       */ async () => block() },
    });
    agent.onEvent(Agent.EVENT.TOOL_EXECUTE, /** Block and reject question tool executions.
     * @param {object} call Tool execution details.
     * @returns {void} No value when the call is not the question tool.
     * @throws {Error} Throws when the tool is `question`.
     * @effects Marks question requests blocked; the Agent is cancelled by the question hook.
     */ (call) => {
      if (call.name === "question") {
        blocked = true;
        throw new Error("jobs cannot ask questions");
      }
    });
    options.onAgent?.(agent);
    // Persist the captured prompt even when model selection/login blocks execution.
    agent.context.append(Context.messageUser(task.prompt));
    agent.context.flush();
    if ([...env.models(true).values()].some(/** Check whether the selected endpoint requires login.
     * @param {object} info Model catalog entry.
     * @returns {boolean} Whether this entry belongs to the selected endpoint and requires login.
     */ (info) => model.startsWith(`${info.endpoint}/`) && info.loginRequired)) {
      return { outcome: "blocked", session, code: warning?.code ?? "JOBS_MODEL_BLOCKED", message: `model ${JSON.stringify(model)} needs a login before jobs can use it`, ...(warning ? { warning } : {}) };
    }
    // Jobs leaves the run to Agent/IO policy; a wake never force-kills it.
    const ioTimeout = (options.effectiveTimeout ?? IO.timeoutsResolve)({ env, model, ...(timeout === undefined ? {} : { timeout }) });
    options.onReady?.({ session, timeout: ioTimeout });
    const terminal = await agent.run();
    const outcome = blocked || terminal?.kind === "auth" ? "blocked"
      : aborted || terminal?.cancelled || terminal?.kind === "cancelled" ? "cancelled"
      : terminal?.type === "done" ? "completed" : "failed";
    const reason = blocked ? "the job asked a question, but jobs run unattended" : terminal?.error?.message ?? (typeof terminal?.error === "string" ? terminal.error : `the agent run ended ${outcome}`);
    return { outcome, session, ...(outcome === "completed" ? {} : { code: `JOBS_${outcome.toUpperCase()}`, message: reason }), ...(warning ? { warning } : {}) };
  } catch (error) {
    options.onError?.(error);
    return { outcome: blocked ? "blocked" : "failed", session, code: blocked ? "JOBS_INTERACTION_BLOCKED" : "JOBS_AGENT_FAILED", message: blocked ? "the job asked a question, but jobs run unattended" : String(error?.message ?? error) };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Release only the agent; the caller owns the shared Env and its teardown.
    close({ agent });
    if (typeof agent?.close === "function") agent.close();
  }
}
