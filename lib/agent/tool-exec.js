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
const { ContentType, MessageType, textContent } = Context;
import { callToolSandboxed } from "./tool-sandbox.js";
import { prepareToolTimeout, runWithToolTimeout } from "./tool-timeout.js";

/**
 * Route one tool call: resolve the call id (pure call→answer
 * linkage — generated when missing, regenerated on collision) and
 * execute. Every live call runs — an identical repeat (same name +
 * arguments) executes again; the data may have changed.
 */
export async function dispatchToolCall(agent, call, claimedIds, batch) {
  call.callId = resolveCallId(agent, call.callId, claimedIds, batch);
  claimedIds.add(call.callId);
  agent._emit(EVENT.TOOL_EXECUTE, call);
  return await executeToolCall(agent, call);
}

/**
 * Agent-owned id resolution: keep a provider id when it wasn't
 * claimed earlier in this message batch AND no call in the REST of
 * the context uses it (same-batch siblings are exempt — batch order
 * decides: first keeps, later ones regenerate). Never throws.
 */
export function resolveCallId(agent, id, claimedIds, batch) {
  if (id !== undefined && !claimedIds.has(id) && !callIdSeen(agent, id, batch)) return id;
  let fresh;
  do {
    fresh = `agent-${(agent._callSeq = (agent._callSeq ?? 0) + 1)}`;
  } while (claimedIds.has(fresh) || callIdSeen(agent, fresh, batch));
  return fresh;
}

/** True when a call OUTSIDE the current batch already uses this id. */
export function callIdSeen(agent, callId, batch) {
  return agent.context.some((m) =>
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
 */
export async function callToolFor(agent, name, args, call) {
  const entry = agent.env.toolEntry(name);
  const prepared = prepareToolTimeout(agent, entry, args);
  const sandboxed = entry?.sandbox === true || (entry?.trusted !== true && entry?.safe !== true);
  const forked = entry?.file !== undefined && sandboxed;
  // The forked worker installs a process-group terminator at spawn. It is
  // the sole owner of sandboxed tool teardown, including any descendants.
  const controller = new AbortController();
  const handle = {
    kill: null,
    abort: (reason) => controller.abort(reason),
  };
  agent._activeTools?.add(handle);
  const invoke = async () => {
    // Live output streaming: a tool emits incremental progress through
    // context.onData; the Agent relays it to its onToolData binding
    // (the TUI's tool-preview stream). Forked calls relay it through
    // the worker's stderr records instead (lib/agent/tool-sandbox.js).
    // Tool output can arrive after a TUI turn restores its temporary
    // lifecycle hook (notably just after ^C has settled the tool boundary).
    // Retain streaming while the hook is live, but resolve it again for every
    // chunk so a late child-data event cannot call an obsolete/undefined hook.
    const onData = (chunk) => agent._emit(EVENT.TOOL_DATA, { call, chunk });
    if (!forked) {
      const context = agent._toolContext(call, { trusted: entry?.trusted === true });
      context.detached = agent._toolCall.detached;
      context.signal = controller.signal;
      if (onData !== undefined && context.onData === undefined) context.onData = onData;
      // In-process tools retain the host process cwd. Safe/trusted tools
      // own their own path policy; only OS-sandboxed calls get a worker root.
      return agent._toolEnv().callTool(name, prepared.args, context); // safe view refuses unsafe tools
    }
    // Disable the sandbox helper's independent timer: this outer Agent
    // boundary owns timeout + onTimeout grace + unconditional SIGKILL.
    const result = await callToolSandboxed({
      env: agent.env,
      name,
      args: prepared.args,
      timeout: 0,
      detached: agent._toolCall.detached,
      sandbox: sandboxed,
      // The narrowed agent folder defines the kernel jail's root only.
      cwd: sandboxed ? agent.folder : undefined,
      onChild: (control) => { handle.kill = control.kill; },
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
      invoke,
      // A bridge receives this only while the call is pending. Its input
      // handlers invoke it for every keyboard/mouse event, turning the
      // interactive timeout into inactivity detection.
      onResetTimeout: (resetTimeout) => { agent._question?.setResetTimeout?.(resetTimeout); },
      // Agent.cancel() invokes this resolver before it signals the child,
      // so ^C returns control immediately even if the tool ignores SIGINT.
      onInterrupt: (interrupt) => { handle.interrupt = interrupt; },
      terminate: () => handle.kill?.("SIGKILL"),
    });
  } finally {
    agent._activeTools?.delete(handle);
  }
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
 */
export function normalizeDisplay(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return entry === "" ? [] : [{ type: "text", text: entry }];
    if (entry && typeof entry === "object" && typeof entry.type === "string") return [entry];
    return [];
  });
}

export async function executeToolCall(agent, call) {
  const base = { type: MessageType.ToolResult, callId: call.callId, name: call.name };
  const outcome = (message, system = [], display = []) => ({ message, system, display });
  // Human-only tools never cross the Agent boundary. Catalog filtering is
  // merely discoverability; this execution check is the authority when a
  // provider invents a name or an explicit selection names it.
  if (agent.env.toolEntry(call.name)?.secret === true) {
    agent._emit(EVENT.LOG, `tool ${call.name}: refused (human-only)`);
    return outcome({ ...base, error: true, content: [textContent(`tool error: "${call.name}" is not available to agents (human-only tool)`)] });
  }
  // SAFE MODE enforcement: only read-only tools execute — a refusal
  // surfaces to the model as an ordinary tool-result error.
  if (agent._safe && agent.env.toolEntry(call.name)?.safe !== true) {
    agent._emit(EVENT.LOG, `tool ${call.name}: refused (safe mode)`);
    return outcome({ ...base, error: true, content: [textContent(`tool error: "${call.name}" is not available in safe mode (read-only tools only)`)] });
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
        content: [textContent("tool error: Fix the arguments: provide one valid JSON object and try again.")],
      });
    }
  }
  try {
    const value = await agent._callTool(call.name, args ?? {}, call);
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
    return outcome({ ...base, error: true, content: [textContent(`tool error: ${detail}`)] }, system);
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
  if (typeof value === "string") return [textContent(value)];
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.content)) return value.content;
  return [textContent(JSON.stringify(value ?? null))];
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
