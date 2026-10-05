/**
 * lib/agent/tool-exec.js — tool-call execution (private to Agent):
 * the dispatch of one live call (Agent-owned call-id resolution —
 * generated when missing, regenerated on collision), the invocation
 * itself (sandboxed fork for file-scanned tools, in-process for
 * built-ins and interactive tools — the question bridge cannot cross
 * a fork), and the NEVER-THROWS execute wrapper: every failure becomes
 * a tool-result error message for the model. Plus the tool-answer
 * contract (resultContent).
 */

import Context from "../context.js";
import { EVENT } from "./events.js";
const { ContentType, MessageType, contentText } = Context;
import Sandbox from "../sandbox.js";
import { callToolSandboxed } from "./tool-sandbox.js";
import { prepareToolTimeout, runWithToolTimeout, ToolTimeoutError } from "./tool-timeout.js";

/**
 * One tool's catalog entry for this Agent's pair (Env.tools — the pair's
 * provider tools shadow a global tool), or undefined.
 * @param {object} agent
 * @param {string} name
 * @returns {Promise<object|undefined>}
 */
export async function toolInfoOf(agent, name) {
  const selector = agent.model;
  return (await agent.env.tools(false, selector)).get(name);
}

/**
 * Route one tool call: resolve the call id (pure call→answer
 * linkage — generated when missing, regenerated on collision) and
 * execute. Every live call runs — an identical repeat (same name +
 * arguments) executes again; the data may have changed.
 * @param {object} agent - the owning Agent (provides context, env, call sequence)
 * @param {object} call - the tool call ({name, arguments, callId?}); callId is resolved in place
 * @param {Set<string>} claimedIds - ids already claimed in this batch; call.callId is added
 * @param {Array<object>} batch - the content blocks of this message batch (collision-scope)
 * @returns {Promise<{message: object, system: Array<string>, display: Array<object>}>} the executeToolCall outcome
 */
export async function dispatchToolCall(agent, call, claimedIds, batch) {
  call.callId = resolveCallId(agent, call.callId, claimedIds, batch);
  claimedIds.add(call.callId);
  return await executeToolCall(agent, call, { notify: true });
}

/**
 * Agent-owned id resolution: keep a provider id when it wasn't
 * claimed earlier in this message batch AND no call in the REST of
 * the context uses it (same-batch siblings are exempt — batch order
 * decides: first keeps, later ones regenerate). Never throws.
 * @param {object} agent - the owning Agent (holds the _callSeq generator counter)
 * @param {string|undefined} id - the provider-supplied call id, if any
 * @param {Set<string>} claimedIds - ids already claimed earlier in this batch
 * @param {Array<object>} batch - the content blocks of this message batch
 * @returns {string} the id to use: the provider id when free, else a fresh `agent-N`
 */
export function resolveCallId(agent, id, claimedIds, batch) {
  if (id !== undefined && !claimedIds.has(id) && !callIdSeen(agent, id, batch)) return id;
  let fresh;
  do {
    fresh = `agent-${(agent._callSeq = (agent._callSeq ?? 0) + 1)}`;
  } while (claimedIds.has(fresh) || callIdSeen(agent, fresh, batch));
  return fresh;
}

/**
 * True when a call OUTSIDE the current batch already uses this id.
 * @param {object} agent - the owning Agent (its context message history is scanned)
 * @param {string} callId - the call id to look for
 * @param {Array<object>} batch - the content blocks of this message batch (exempt from the check)
 * @returns {boolean} true when a ToolCall block outside the batch carries callId
 */
export function callIdSeen(agent, callId, batch) {
  return agent.context.messages().some((m) =>
    (m?.content ?? []).some(
      (b) => b?.type === ContentType.ToolCall && b.callId === callId && !batch.includes(b),
    ));
}

/**
 * Invoke one tool: SANDBOXED (forked child, lib/agent/tool-sandbox.js)
 * when the tool is file-scanned (a child can rebuild it from the tool
 * roots). Execution policy is declarative and independent of harness
 * interaction: every unsafe, untrusted tool forks under the OS write jail;
 * safe/read-only and trusted tools execute in-process unless they explicitly
 * request `sandbox: true`. `sandbox: false` is ignored. `agent.folder` only
 * supplies an OS sandbox root — it never forces a worker.
 * @param {object} agent - the owning Agent (env, safe mode, question bridge, tool-data events)
 * @param {string} name - the tool name to invoke
 * @param {*} args - parsed tool arguments (timeout directives are applied via prepareToolTimeout)
 * @param {object} call - the tool-call record (passed to the tool context and event payloads)
 * @param {object} [dispatch] - the active dispatch scope ({controller, sandbox, done, finished}); when omitted one is created via withToolDispatch
 * @returns {Promise<*>} the tool's raw return value (not normalized to content blocks)
 * @throws {Error} on abort, timeout (ToolTimeoutError), or any tool failure; a forked failure's `system` payload rides back on error.system
 */
export async function callToolFor(agent, name, args, call, dispatch) {
  if (!dispatch) return withToolDispatch(agent, call, (scope) => callToolFor(agent, name, args, call, scope));
  dispatch.controller.signal.throwIfAborted();
  const entry = await toolInfoOf(agent, name);
  const prepared = prepareToolTimeout(agent, entry, args);
  dispatch.controller.signal.throwIfAborted();
  const sandboxed = entry?.sandbox === true || (entry?.trusted !== true && entry?.safe !== true);
  // Only package-authorized classifiers may skip a fork for specific calls.
  // Provider tools run in-process because they need the IO connection.
  let inProcess = false;
  try { inProcess = entry?.inProcess?.(prepared.args) === true; } catch { /* fail closed: fork */ }
  const forked = entry?.file !== undefined && entry?.provider !== true && sandboxed && !inProcess;
  const { controller, sandbox } = dispatch;
  const deadline = Date.now() + prepared.timeout;
  const invoke = async () => {
    controller.signal.throwIfAborted();
    // Live output streaming: a tool emits incremental progress through
    // context.onData; the Agent relays it to its onToolData binding
    // (the TUI's tool-preview stream). Forked calls relay it through
    // the worker's stderr records instead (lib/agent/tool-sandbox.js).
    // Tool output can arrive after a TUI turn restores its temporary
    // lifecycle hook (notably just after ^C has settled the tool boundary).
    // Retain streaming while the hook is live, but resolve it again for every
    // chunk so a late child-data event cannot call an obsolete/undefined hook.
    const onData = (chunk) => {
      if (!controller.signal.aborted && !dispatch.finished) agent._emit(EVENT.TOOL_DATA, { call, chunk });
    };
    if (!forked) {
      const context = agent._toolContext(call, { trusted: entry?.trusted === true, info: entry });
      context.detached = agent._toolCall.detached;
      context.signal = controller.signal;
      context.sandbox = sandbox;
      context.osSandbox = sandboxed;
      context.deadline = deadline;
      if (onData !== undefined && context.onData === undefined) context.onData = onData;
      // In-process tools retain the host process cwd. Safe/trusted tools
      // own their own path policy; only OS-sandboxed calls get a worker root.
      return agent.env.toolCall(name, prepared.args, context); // context.safe: Env refuses unsafe tools
    }
    // Dispatch owns the deadline, callback grace and sandbox teardown.
    const result = await callToolSandboxed({
      env: agent.env,
      name,
      file: entry.file,
      args: prepared.args,
      timeout: 0,
      deadline,
      scope: sandbox,
      sandbox: sandboxed,
      // The narrowed agent folder defines the kernel jail's root only.
      cwd: sandboxed ? agent.folder : undefined,
      onData,
      questionBridge: typeof agent._question?.ask === "function",
      onQuestion: (questions) => agent._question?.ask?.(questions) ?? null,
    });
    if (!result.ok) {
      const err = new Error(result.error);
      if (result.system !== undefined) err.system = result.system; // a `system` payload rides back
      throw err;
    }
    return result.value;
  };
  try {
    return await runWithToolTimeout({
      agent, entry, name, args: prepared.args, call,
      timeout: prepared.timeout, requested: prepared.requested,
      invoke, controller, sandbox,
      onResetTimeout: (resetTimeout) => { agent._question?.setResetTimeout?.(resetTimeout); },
    });
  } catch (error) {
    // Only cancellation and timeouts tear down retained pooled resources;
    // ordinary tool failures leave healthy shared servers available.
    if (error instanceof ToolTimeoutError && !controller.signal.aborted) {
      controller.abort(error);
    }
    throw error;
  }
}

/**
 * Own one dispatch scope (AbortController + pooled Sandbox) around an
 * invocation. Dispatch is the sole teardown owner, including refusal and
 * startup races: on completion it marks the dispatch finished, closes the
 * sandbox scope (cancelling children when aborted), drops it from the
 * agent's active set, and resolves `done`.
 * @param {object} agent - the owning Agent (tracks the dispatch in _activeTools, honors _cancelRequested)
 * @param {object} call - the tool-call record (used for the cancellation message and the TOOL_EXECUTE event)
 * @param {(dispatch: object) => Promise<*>} invoke - runs the call with the dispatch scope
 * @param {boolean} [notify=false] - emit EVENT.TOOL_EXECUTE before invoking
 * @returns {Promise<*>} invoke's result; propagates invoke's errors after teardown
 * @private
 */
async function withToolDispatch(agent, call, invoke, notify = false) {
  const controller = new AbortController();
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  const dispatch = { controller, sandbox: Sandbox.scope(), done, finished: false };
  agent._activeTools.add(dispatch);
  try {
    if (agent._cancelRequested) controller.abort(new Error(`tool "${call?.name}" cancelled`));
    if (notify && !controller.signal.aborted) agent._emit(EVENT.TOOL_EXECUTE, call);
    return await invoke(dispatch);
  } finally {
    dispatch.finished = true;
    try { await dispatch.sandbox.close({ cancel: controller.signal.aborted }); }
    finally { agent._activeTools.delete(dispatch); complete(); }
  }
}

/**
 * Normalize a tool's `display` payload into content blocks: a string
 * becomes one text block (dropped when empty), a block-shaped object
 * (a string `type`) passes through as-is, and anything else is dropped.
 * @param {*} value - a single entry, or an array of entries
 * @returns {Array<object>} display content blocks
 */
export function normalizeDisplay(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return entry === "" ? [] : [{ type: "text", text: entry }];
    if (entry && typeof entry === "object" && typeof entry.type === "string") return [entry];
    return [];
  });
}

/**
 * Execute one tool call. NEVER throws — failures become tool-result
 * error messages for the model.
 *
 * Returns { message, system, display }: the tool result, plus any
 * SYSTEM PAYLOAD and any DISPLAY PAYLOAD the tool attached. A tool
 * returning a plain object with a `system` and/or `display` key
 * answers briefly via `result` (any normal return shape) while
 * `system` (a string or string[]) appends as System messages right
 * after the tool result, and `display` (a string or string[]) is
 * retained on that ToolResult for context viewers and also rides to
 * the binding. It is not exposed as normal tool-result content to
 * the model; a tool can show data without sending it to the model. A THROWN error may carry the same `system` payload
 * as `error.system`: the error becomes the tool-result error AND the
 * payload appends as System messages.
 * @param {object} agent - the owning Agent
 * @param {object} call - the tool call ({name, arguments, callId})
 * @param {object} [options]
 * @param {boolean} [options.notify=false] - emit EVENT.TOOL_EXECUTE before execution
 * @returns {Promise<{message: object, system: Array<string>, display: Array<object>}>} the outcome (see executeOutcome); never rejects
 */
export async function executeToolCall(agent, call, { notify = false } = {}) {
  return withToolDispatch(agent, call, (dispatch) => executeOutcome(agent, call, dispatch), notify);
}

/**
 * Produce one tool-call outcome inside an existing dispatch scope.
 * Enforces the execution-time refusals (human-only `secret` tools, safe
 * mode), parses string arguments as JSON (unparseable input becomes a
 * recoverable tool-result error for the model), invokes the tool through
 * agent._callTool, and unpacks `{result, system?, display?}` envelopes.
 * NEVER throws — a thrown error becomes a tool-result error message, with
 * any `error.system` payload carried alongside.
 * @param {object} agent - the owning Agent (_callTool, safe flag, _emit)
 * @param {object} call - the tool call ({name, arguments, callId}); string arguments are JSON.parsed
 * @param {object} dispatch - the active dispatch scope (its signal is checked before/after the call)
 * @returns {Promise<{message: object, system: Array<string>, display: Array<object>}>} message is the ToolResult ({type, callId, name, content, error?, display?}); system is the lines to append as System messages; display mirrors message.display
 * @private
 */
async function executeOutcome(agent, call, dispatch) {
  const base = { type: MessageType.ToolResult, callId: call.callId, name: call.name };
  const outcome = (message, system = [], display = []) => ({ message, system, display });
  // Human-only tools never cross the Agent boundary. Catalog filtering is
  // merely discoverability; this execution check is the authority when a
  // provider invents a name or an explicit selection names it.
  const info = await toolInfoOf(agent, call.name);
  if (info?.secret === true) {
    agent._emit(EVENT.LOG, `tool ${call.name}: refused (human-only)`);
    return outcome({ ...base, error: true, content: [contentText(`tool error: "${call.name}" is not available to agents (human-only tool)`)] });
  }
  // SAFE MODE enforcement: only read-only tools execute — a refusal
  // surfaces to the model as an ordinary tool-result error. EFFECTIVE
  // safety (own, parent, forced by a missing OS sandbox): the forked
  // worker path below runs against the full env, so this is its guard.
  if (agent.safe && info?.safe !== true) {
    agent._emit(EVENT.LOG, `tool ${call.name}: refused (safe mode)`);
    return outcome({ ...base, error: true, content: [contentText(`tool error: "${call.name}" is not available in safe mode (read-only tools only)`)] });
  }
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (err) {
      // Model-generated call JSON is a recoverable tool failure, never a
      // provider/binding error. Return the raw call and parser diagnostic
      // through the normal tool-result channel so the next model turn can
      // correct and retry its own invocation.
      const detail = err?.message ? ` (${err.message})` : "";
      agent._emit(EVENT.LOG, `tool ${call.name}: unparseable arguments${detail}`);
      return outcome({
        ...base,
        error: true,
        content: [contentText("tool error: Fix the arguments: provide one valid JSON object and try again.")],
      });
    }
  }
  try {
    dispatch.controller.signal.throwIfAborted();
    const value = await agent._callTool(call.name, args ?? {}, call, dispatch);
    dispatch.controller.signal.throwIfAborted();
    agent._emit(EVENT.LOG, `tool ${call.name}: ok`);
    // a { result, system?, display? } return: the system payload
    // appends as System messages; display is retained on the result
    // for context viewers and also rides to the binding; every other
    // shape is an ordinary result
    if (isPlainObject(value) && ("system" in value || "display" in value)) {
      const system = [].concat(value.system ?? []).map(String).filter((s) => s !== "");
      const display = normalizeDisplay(value.display);
      return outcome({ ...base, content: resultContent(value.result), ...(display.length > 0 ? { display } : {}) }, system, display);
    }
    return outcome({ ...base, content: resultContent(value) });
  } catch (err) {
    agent._emit(EVENT.LOG, `tool ${call.name} failed: ${err?.message ?? err}`);
    const detail = String(err?.message ?? err ?? "unknown error").trim() || "unknown error";
    const system = err?.system !== undefined
      ? [].concat(err.system ?? []).map(String).filter((s) => s !== "")
      : [];
    return outcome({ ...base, error: true, content: [contentText(`tool error: ${detail}`)] }, system);
  }
}

/**
 * Normalize a tool return value into result content blocks — the full
 * tool-answer contract. A tool may return:
 *   - a string → one text block;
 *   - an array of content blocks → used as-is;
 *   - `{content: [...]}` → the content array;
 *   - any other JSON value → JSON.stringify'd into one text block;
 *   - `{result, system?, display?}` → `result` is normalized by the rules above,
 *     while `system` (string or string[]) appends as System messages
 *     right after the tool result and `display` is retained on it for
 *     context viewers (handled by the caller, not here).
 * Throwing fails the call: the error message becomes the tool-result
 * error content (error: true on the result message).
 * @param {*} value - the tool's return value
 * @returns {Array<object>} content blocks for the tool-result message
 */
export function resultContent(value) {
  if (typeof value === "string") return [contentText(value)];
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.content)) return value.content;
  return [contentText(JSON.stringify(value ?? null))];
}

/**
 * Plain-object check: excludes null and arrays (a `{result, system?,
 * display?}` envelope detector).
 * @param {*} v - the value to test
 * @returns {boolean} true when v is a non-null, non-array object
 */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
