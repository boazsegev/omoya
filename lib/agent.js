/**
 * lib/agent.js — Agent: owns context, provider/model selection, the tool
 * loop, and persistence. Headless: no stdio, no process.exit, no TUI.
 *
 * PUBLIC CORE ENTRY POINT. Agent coordinates the JSONL session store,
 * crash-safe finish hooks, the forked tool sandbox, the tool loop,
 * tool-call execution, status readouts, session lifecycle, and thinking
 * level. It composes Context ← Env ← IO ← Agent and publishes that core
 * tree as Agent.Context, Agent.Env, and Agent.IO. It does not import CLI,
 * Markdown, or application/UI layers.
 *
 * Ownership:
 *   - Agent alone owns the ordered in-memory context, provider/model
 *     selection per request, the tool loop, and persistence.
 *   - IO stays stateless: every request passes the COMPLETE current
 *     context; one IO instance is reused per active provider and
 *     reconstructed after kill() leaves it permanently closed. It
 *     reports usage PER TURN (the terminal event's `usage` envelope,
 *     see lib/context/usage.js) — nothing above it.
 *   - Session wiring (--session/--resume) lives wholly inside Agent;
 *     bindings pass an id, nothing more. Persistence is injectable
 *     (any SessionStore-shaped object); the file store is the default.
 *   - Agent alone owns the CUMULATIVE usage total (the `usage` getter):
 *     it sums every terminal's envelope in memory as run() sees them.
 *     Never persisted (no usage.json) — a fresh Agent starts at zero;
 *     bindings that show it (the TUI footer, a one-shot CLI's final
 *     line) read it fresh rather than tracking their own copy.
 *
 * Agent's implementation is split across helper modules in lib/agent/;
 * this file provides the public façade:
 *   - run.js        the tool loop and its runaway guards;
 *   - tool-exec.js  tool-call dispatch/execution, the result contract;
 *   - readouts.js   usage/context-window/plan/connection readouts;
 *   - sessions.js   fork/new/resume/list, the seeded system prompt;
 *   - thinking.js   the thinking level.
 *
 * Core rules (see run.js/tool-exec.js for the full contracts): every
 * tool call in the LIVE response executes — identical repeats
 * included; calls execute ONLY in real time, never from history.
 * Tool-call ids belong to AGENT, never to the model (generated when
 * missing, regenerated on collision). Tool-execution lifecycle is
 * observable: TOOL_EXECUTE fires just before a call runs and
 * TOOL_RESULT after each result is appended.
 *
 * Tool-call SANDBOX (options.toolCall): file-scanned tools execute in
 * a FORKED child process by default (fork: true); built-ins,
 * programmatic tools, and INTERACTIVE tools stay in-process. Options:
 *   - fork:    false disables the sandbox (in-process execution)
 *   - timeout: explicit HOST override of Env.toolTimeout (duration)
 *   - async:   true executes ONE message's tool calls concurrently
 * Every call is Agent-timed (including in-process). A schema-declared
 * `timeout` argument is extracted and capped at Env.toolTimeoutLimit;
 * schema.onTimeout gets at most 60s for cleanup or a final result.
 *
 * SAFE MODE (options.safe; setSafe() toggles it at runtime — /safe,
 * the ^X Settings row — applying from the next request): publish and
 * execute ONLY read-only tools (schemas with `safe: true`) through
 * the environment's SAFE VIEW (`Env.safe`): the Agent reads tools
 * through `this._safe ? env.safe : env`, so one Env serves any
 * number of Agents in either mode — safety is a view, never global
 * state. Safe mode is FORCED (construction and setSafe both honor
 * `this._forcedSafe`) when no supported OS sandbox is available —
 * there is NO opt-out: mutation tools run only under an active OS
 * sandbox, so on a mechanism-less platform the agent is read-only.
 *
 * SYSTEM PAYLOADS: a tool returning { result, system } answers briefly
 * via its tool result while `system` (string or string[]) appends as
 * System messages right after it — before any queued user messages.
 * DISPLAY PAYLOADS: { result, display } — `display` rides the outcome
 * to TOOL_RESULT subscribers and is
 * shown to the user WITHOUT ever joining the context: a tool can
 * display data without sending it to the model (the edit tool's
 * git-style diff).
 */

import IO from "./io.js";
const { Env, Context } = IO;
const { ENV_EVENT, NAMES } = Env;
import { join, resolve, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
const { osSandboxAvailable, parseDuration } = Env;
const { ContentType, textContent, systemMessage, normalizeCallbacks, dispatch, editBlock, editMessage, pop, rollbackTo, removeMessages, appendMessage, estimateContextTokens } = Context;
import { SessionStore, sessionDir, loadMessages, sameFolder, findSessionFile } from "./agent/session.js";
import { onFinish, runFinish, armFinishSignals, _resetFinish } from "./agent/finish.js";
import { callToolSandboxed, DEFAULT_TOOL_TIMEOUT } from "./agent/tool-sandbox.js";
import { runLoop, guarded } from "./agent/run.js";
import { dispatchToolCall, resolveCallId, callIdSeen, callToolFor, executeToolCall, resultContent } from "./agent/tool-exec.js";
import { repairToolCalls, sweepEmptyMessages } from "./agent/tool-repair.js";
import { trimUserMessage, trimLatestUserMessage } from "./agent/trim-user.js";
import { accumulateUsage, contextUsageOf, planUsageOf, ioStateOf } from "./agent/readouts.js";
import { forkSession, seedSystemPrompt, newSession as newSessionImpl, resumeSession as resumeSessionImpl, listSessions as listSessionsImpl, listSessionsAsync as listSessionsAsyncImpl, latestSessionId as latestSessionIdImpl, renameSession as renameSessionImpl } from "./agent/sessions.js";
import { thinkValue, setThinking as setThinkingImpl } from "./agent/thinking.js";
import { pathInfo, resolvedFile } from "./agent/path-info.js";
const { fileMessage } = Context;
import { reseatAgent, isAnonymousId } from "./agent/reseat.js";
import { updateToolMessage, toolMessages, detectToolMessages } from "./agent/tool-messages.js";
import { compactContext } from "./agent/compact.js";
import { EVENT, EVENT_COUNT, RESPONSE_CALLBACK_EVENTS } from "./agent/events.js";
const { parseModelSelector } = Env;

export { SessionStore, sessionDir, loadMessages, sameFolder, findSessionFile } from "./agent/session.js";
export { resolveAgentPath, rejectAgentSymlinks, pathInfo } from "./agent/path-info.js";
export { onFinish, runFinish, armFinishSignals, _resetFinish } from "./agent/finish.js";
export { callToolSandboxed, DEFAULT_TOOL_TIMEOUT } from "./agent/tool-sandbox.js";
export { resultContent } from "./agent/tool-exec.js";
export { thinkValue } from "./agent/thinking.js";
export { reseatAgent, isAnonymousId } from "./agent/reseat.js";
export { RESPONSE_CALLBACK_EVENTS } from "./agent/events.js";

/**
 * The agent: the ordered context, the provider/model selection, the
 * tool loop, the pending queue and the session persistence, behind one
 * headless object.
 */
export class Agent {
  static _counter = 1;
  /**
   * The numeric event vocabulary for Agent.onEvent: START, TEXT_START,
   * TEXT_DELTA, TEXT_END, THINKING_START, THINKING_DELTA, THINKING_END,
   * TOOLCALL_START, TOOLCALL_DELTA, TOOLCALL_END, DONE, ERROR,
   * MESSAGE_COMMITTED, LOG, TOOL_EXECUTE, TOOL_DATA, TOOL_RESULT,
   * CLOSE_MARKED, CLOSED, SENT_MESSAGE — see Agent.onEvent's
   * documentation for each value's meaning and payload.
   */
  static EVENT = EVENT;

  /**
   * The [responseCallbackName, Agent.EVENT] pairs: every EVENT value's
   * corresponding option-callback name ("onTextDelta" for
   * Agent.EVENT.TEXT_DELTA, …), for hosts that prefer per-event
   * callbacks over one onEvent listener.
   */
  static RESPONSE_CALLBACK_EVENTS = RESPONSE_CALLBACK_EVENTS;
  /**
   * Build an agent over an environment; wires the session store (a
   * named file session, a resumed one, an injected store, or none) and
   * takes ownership of the seed context — a NEW (non-resumed) context
   * starts with the seeded system prompt as its FIRST message(s).
   * @param {Object} [options]
   * @param {Env} [options.env] - the sole registry surface
   * @param {string} [options.model] - default `<endpoint>/<model>` selector
   *   (per-request override via run options)
   * @param {string} [options.url]
   * @param {number|string} [options.timeout] - overall provider-request timeout
   * @param {object} [options.settings] - per-invocation provider overrides
   * @param {Array} [options.context] - seed context; Agent takes ownership
   *   (the seeded system prompt lands AHEAD of it)
   * @param {string[]} [options.tools] - availability selection (omitted/["*"]=all, []=none)
   * @param {Agent} [options.parent] - creating Agent, or unset for non-Agents
   * @param {string} [options.name] - display name (default: `agent-<counter>`)
   * @param {string} [options.description] - display description (empty allowed)
   * @param {*} [options.spawnPermission] - generic permission for
   *   delegation tools to create another Agent: false denies, true allows,
   *   and any other value asks through the tool's own user-interaction policy
   * @param {boolean} [options.safe] - SAFE MODE: publish and execute ONLY
   *   read-only tools (schemas with `safe: true`) — exploration and
   *   planning without mutation. Unsafe calls are refused with a
   *   tool-result error, never executed (defense in depth: the filtered
   *   catalog alone is not the enforcement). FORCED on when no
   *   supported OS sandbox is available (Env.osSandboxAvailable())
   *   — there is no opt-out: mutation tools run only under an active
   *   OS sandbox
   * @param {string|object} [options.session] - a session id or injectable
   *   SessionStore-shaped store. An existing id is resumed; an absent id creates it.
   * @param {string} [options.sessionDir] - file-store folder
   * @param {boolean} [options.sessionSave=true] - whether a SessionStore
   *   created from `session` persists its context to disk
   * @param {(opts:object)=>object} [options.createIO] - IO factory (tests inject fakes)
   * @param {{ask: (questions: Array) => Promise<Array>}} [options.question]
   *   - the QUESTION BRIDGE for interactive tools (the `question` tool,
   *   write/edit's path-guard permission flow): the binding's rendering
   *   engine (TUI overlay, HTML form, WebSocket prompt) renders the
   *   questions — options, previews — and collects the answers. Never
   *   published: the tool schemas carry only the model-facing
   *   arguments. The bridge belongs to the DISPLAYED session only —
   *   a headless agent has no one to ask: without a
   *   bridge, interactive tools refuse (the question tool and the
   *   writers' permission flow alike)
   * @param {{fork?: boolean, timeout?: number|string, async?: boolean, detached?: boolean}} [options.toolCall]
   *   - tool sandbox: forked execution (default true), optional host
   *   override of Env.toolTimeout, concurrent dispatch (default false). detached:false keeps workers and
   *   cooperating command children in the host process group (host owns teardown).
   *   Every effective duration is capped at Env.toolTimeoutLimit.
   */
  constructor({
    env,
    model,
    url,
    timeout,
    settings,
    context,
    tools,
    parent,
    name,
    description,
    session,
    sessionDir,
    sessionSave = true,
    createIO,
    toolCall,
    safe,
    spawnPermission,
    question,
  } = {}) {
    if (parent === this) throw new TypeError("Agent parent cannot be itself");
    this.env = env ?? new Env();
    // An omitted endpoint is valid for an agent that will be configured
    // later, but a named endpoint must be a live Env registry entry. Do this
    // before registration/parent linkage so a rejected construction leaks no
    // partially-owned agent.
    const selected = model === undefined ? {} : parseModelSelector(this.env, model, "Agent");
    this.env.registerAgent?.(this);
    this._children = new Set();
    this._parent = parent instanceof Agent ? parent : undefined;
    this._parent?.childAdd(this);
    this.endpoint = selected.endpoint;
    this.model = selected.model;
    this.url = url;
    this.timeout = timeout;
    this.settings = settings;
    this._toolSelection = tools;
    this._name = name === undefined ? `agent-${Agent._counter++}` : "";
    this._description = "";
    if (name !== undefined) this.name = name;
    if (description !== undefined) this.description = description;
    // FORCED SAFE: mutation tools (bash/write/edit — the forked tool
    // sandbox's OS write jail is their enforcement layer) run only
    // under an active OS sandbox; there is no opt-out. On a
    // mechanism-less platform the agent is read-only, no matter what
    // the caller asked for.
    this._forcedSafe = !osSandboxAvailable();
    this._safe = safe === true;
    this._spawnPermission = undefined;
    this.setSpawnPermission(spawnPermission);
    this._callbacks = Array.from({ length: EVENT_COUNT }, () => []);
    this._createIO = createIO ?? ((opts) => new IO(opts));
    this._question = question ?? null; // the question bridge (interactive tools)
    // A headless host may narrow this agent's tool root below env.cwd.
    // It is deliberately agent-local: shared environment configuration,
    // catalogs, and other agents retain their original project root.
    this._folder = this.env?.cwd;
    this._toolCall = {
      detached: toolCall?.detached !== false,
      fork: toolCall?.fork !== false, // sandboxed (forked) by default
      // Explicit host override only; absent delegates to the live
      // Env.toolTimeout default. Model-requested schema `timeout`
      // values are extracted/capped per call in tool-timeout.js.
      timeout: toolCall?.timeout === undefined ? undefined : parseDuration(toolCall.timeout),
      async: toolCall?.async === true,
    };
    this._io = new Map(); // provider key -> IO (one per active provider)
    this._activeIO = null;
    this._activeTools = new Set(); // in-flight tool children ({kill}) — the cancel path
    this._cancelRequested = false; // set by cancel(); a SECOND cancel forces the tool children
    this._endRequested = false; // set by requestEnd(); honored when the turn settles
    this._closeMarked = false; // close() refuses new work immediately
    this._closed = false; // performClose() has released registries/links
    // The file store is always the explicit folder or this environment's
    // settings folder plus `sessions`. An Env without a settings layer still
    // uses the standard resolved settings folder for session persistence.
    this._sessionDir = sessionDir ?? join(
      this.env?.settingsDir ?? Env.defaultSettingsDir(),
      NAMES.sessionsDir,
    ); // remembered for listSessions/resumeSession
    this._pending = []; // user messages queued mid-turn (flushed after the request settles)
    // Tool-owned state is allocated lazily by toolStorage(name). It is
    // agent-local and intentionally transient; tools own any persistence.
    this._usage = { inputTokens: 0, outputTokens: 0, cost: 0 }; // cumulative, in-memory only — never persisted

    // Session wiring — wholly inside Agent. With saving disabled, an id never
    // discovers or resumes a disk session.
    if (typeof sessionSave !== "boolean") throw new TypeError("Agent: sessionSave must be a boolean");
    const sessionFile = typeof session === "string" && sessionSave
      ? findSessionFile(this._sessionDir ?? sessionDir(), session)
      : undefined;
    if (typeof session === "string") {
      this.session = sessionFile
        ? SessionStore.resume({ id: session, dir: this._sessionDir, save: sessionSave })
        : new SessionStore({ id: session, dir: this._sessionDir, context: context ?? [], origin: this.env?.cwd, save: sessionSave });
      if (sessionFile && context?.length) {
        for (const message of context) this.session.append(message);
      }
    } else {
      this.session = session ?? null;
    }
    if (this.session && !Array.isArray(this.session.context)) {
      throw new TypeError("Agent: session store must expose a context array");
    }
    this.context = this.session ? this.session.context : (context ?? []);
    // A NEW context starts with the seeded system prompt — always the
    // FIRST message(s), ahead of any constructor-provided context.
    // Only `resume` skips it: a resumed session's stored context
    // replaces the seeded one wholesale (it carries its own).
    if (!sessionFile) this._seedSystemPrompt();
    // Tools can rebuild transient TUI information from a replayed context
    // (for example, the note tool's sticky note list) before the first paint.
    detectToolMessages(this);
  }

  /**
   * Register a synchronous listener for one numeric Agent.EVENT value.
   * Response payloads deliberately omit IO's string `type`. Indexed
   * payloads carry `contentIndex` plus `content`, the assembled block
   * after that IO event was consumed. End-event `text`, when present,
   * is the provider-normalized authoritative full block snapshot.
   * MESSAGE_COMMITTED receives the stored message after persistence.
   * SENT_MESSAGE receives a queued user message as it enters context.
   * The possible `event` values (the Agent.EVENT constants):
   * - `Agent.EVENT.START` — a run began; payload is the request start
   * - `Agent.EVENT.TEXT_START` / `TEXT_DELTA` / `TEXT_END` — one
   *   assistant text block began / grew / completed; indexed payloads
   *   (`contentIndex`, `content`)
   * - `Agent.EVENT.THINKING_START` / `THINKING_DELTA` / `THINKING_END` —
   *   the same lifecycle for a thinking (reasoning) block
   * - `Agent.EVENT.TOOLCALL_START` / `TOOLCALL_DELTA` / `TOOLCALL_END` —
   *   the same lifecycle for one streamed tool call
   * - `Agent.EVENT.DONE` — the turn completed successfully
   * - `Agent.EVENT.ERROR` — the turn failed; payload carries the error
   * - `Agent.EVENT.MESSAGE_COMMITTED` — a message was persisted to the
   *   context (payload is the stored message)
   * - `Agent.EVENT.LOG` — one diagnostic log line (payload is the line)
   * - `Agent.EVENT.TOOL_EXECUTE` — a tool call is about to run
   * - `Agent.EVENT.TOOL_DATA` — one chunk of a tool's live output
   * - `Agent.EVENT.TOOL_RESULT` — a tool call's outcome was appended
   * - `Agent.EVENT.CLOSE_MARKED` — close() was requested (no new work)
   * - `Agent.EVENT.CLOSED` — close cleanup completed; the agent is dead
   * - `Agent.EVENT.SENT_MESSAGE` — a queued user message entered context
   * @param {number} event - one Agent.EVENT constant (see the list above)
   * @param {(payload: object) => void} callback
   * @returns {number} opaque random registration handle (offEvent removes it)
   */
  onEvent(event, callback) {
    if (!Number.isInteger(event) || event < 0 || event >= this._callbacks.length) throw new TypeError("Agent.onEvent: invalid event constant");
    if (typeof callback !== "function") throw new TypeError("Agent.onEvent: callback must be a function");
    let handle;
    do { handle = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); }
    while (this._callbacks.some((callbacks) => callbacks.some((entry) => entry[1] === handle)));
    this._callbacks[event].push([callback, handle]);
    return handle;
  }

  /** Remove one registration; returns false when it is absent. */
  offEvent(handle) {
    if (!Number.isSafeInteger(handle)) return false;
    for (const callbacks of this._callbacks) {
      const index = callbacks.findIndex((entry) => entry[1] === handle);
      if (index !== -1) { callbacks.splice(index, 1); return true; }
    }
    return false;
  }

  /** @private */
  _emit(event, value) {
    for (let i = 0; i < this._callbacks[event].length; i++) this._callbacks[event][i][0](value);
    if (event === EVENT.START) this.env?._emitEvent?.(ENV_EVENT.AGENT_START, { agent: this, event: value });
    if (event === EVENT.DONE || event === EVENT.ERROR) this.env?._emitEvent?.(ENV_EVENT.AGENT_DONE, { agent: this, event: value });
  }

  /**
   * Return this agent's mutable, transient storage object for one tool.
   * @param {string} toolname
   * @returns {object}
   */
  toolStorage(toolname) {
    if (typeof toolname !== "string" || toolname.trim() === "") {
      throw new TypeError("Agent.toolStorage: a non-empty string tool name is required");
    }
    const name = toolname.trim();
    const stores = (this._toolStorage ??= Object.create(null));
    return (stores[name] ??= {});
  }

  /**
   * Clear one tool's transient storage, or every tool store when omitted.
   * @param {string} [toolname]
   * @returns {void}
   */
  toolStorageClear(toolname) {
    if (toolname === undefined) {
      delete this._toolStorage;
      return;
    }
    if (typeof toolname !== "string" || toolname.trim() === "") {
      throw new TypeError("Agent.toolStorageClear: a non-empty string tool name is required");
    }
    if (this._toolStorage) delete this._toolStorage[toolname.trim()];
  }

  /** The creating Agent, or undefined when none was supplied. */
  get parent() {
    return this._parent;
  }

  /** Snapshot of direct child Agents. */
  get children() {
    return [...this._children];
  }

  /**
   * Construct one direct child through the environment factory. The parent
   * relationship is authoritative for ownership and delegation denial.
   * @param {object} [options]
   * @returns {Agent}
   */
  createChild(options = {}) {
    return this.env.createAgent({ ...options, parent: this });
  }

  /** Register one direct child Agent. @param {Agent} child @returns {Agent} */
  childAdd(child) {
    if (!(child instanceof Agent)) throw new TypeError("Agent child must be an Agent");
    if (child === this) throw new TypeError("Agent cannot be its own child");
    this._children.add(child);
    return child;
  }

  /** Remove one direct child Agent. @param {Agent} child @returns {boolean} */
  childRemove(child) {
    return this._children.delete(child);
  }

  /** Parent-owned cleanup: detach this Agent from a closing parent. */
  _parentClosed() {
    this._parent = undefined;
  }

  /** Human-friendly Agent name. */
  get name() {
    return this._name;
  }

  /** Set the human-friendly Agent name. @param {string} value */
  set name(value) {
    if (typeof value !== "string") throw new TypeError("Agent name must be a string");
    this._name = value;
  }

  /** Human-friendly Agent description; an empty string is valid. */
  get description() {
    return this._description;
  }

  /** Set the human-friendly Agent description. @param {string} value */
  set description(value) {
    if (typeof value !== "string") throw new TypeError("Agent description must be a string");
    this._description = value;
  }

  /** @returns {boolean} safe mode: only read-only (`safe`) tools publish and execute */
  get safe() {
    return this._safe || this._forcedSafe || this.env.safe === true || this._parent?.safe === true;
  }

  /**
   * The environment view for TOOL operations: safe mode reads Env's
   * SAFE VIEW (env.safe — a facade whose catalog is read-only tools
   * only and whose callTool refuses unsafe ones), normal mode the
   * environment itself. One Env serves any number of Agents, each
   * picking its own view — safety is never global state.
   * @returns {Env}
   */
  _toolEnv() {
    return this.safe ? this.env.safe : this.env;
  }

  /**
   * Select an exact, configured endpoint/model pair for subsequent turns.
   * Validation happens before either live field changes, so a failed attempt
   * leaves the current selection intact.
   * @param {string} selector - `<endpoint>/<model>`
   * @returns {{endpoint: string, model: string}} the active selection
   */
  setModel(selector) {
    const selected = parseModelSelector(this.env, selector, "Agent.setModel");
    this.endpoint = selected.endpoint;
    this.model = selected.model;
    return selected;
  }

  /**
   * Switch safe mode at runtime (the /safe command, the ^X menu).
   * Applies from the NEXT request: idle cached provider connections
   * are dropped (their tool selection was fixed at construction); an
   * in-flight request finishes with the old catalog.
   * @param {boolean} value
   * @returns {boolean} the new mode
   */
  setSafe(value) {
    const next = value === true;
    if (next === this._safe) return this.safe;
    // Required safety belongs to the environment, parent, or platform and
    // cannot be escaped by a local toggle.
    if (next === false && (this._forcedSafe || this.env.safe === true || this._parent?.safe === true)) return this.safe;
    this._safe = next;
    for (const [key, aiio] of this._io) {
      if (aiio.state === "idle" || aiio.state === "closed") this._io.delete(key);
    }
    return this.safe;
  }

  /** @returns {boolean|undefined} whether the current SessionStore saves to disk */
  get sessionSave() {
    return this.session?.save;
  }

  /**
   * Enable or disable saving for the current SessionStore. Anonymous agents
   * have no store and cannot acquire one implicitly.
   * @param {boolean} value
   * @returns {boolean} whether saving is enabled
   */
  sessionSaveSet(value) {
    if (!this.session?.saveSet) throw new Error("Agent.sessionSaveSet: anonymous sessions have no SessionStore");
    return this.session.saveSet(value);
  }

  /**
   * Generic delegation permission. A child Agent may never delegate further,
   * regardless of its stored host/user policy. Tools decide how to ask when
   * an independent Agent's permission is unset; Agent performs no spawning.
   * @returns {*}
   */
  get spawnPermission() {
    return this._parent instanceof Agent ? false : this._spawnPermission;
  }

  /** Set generic delegation permission; non-booleans restore tool-owned asking. */
  setSpawnPermission(value) {
    this._spawnPermission = value === true ? true : value === false ? false : undefined;
    return this._spawnPermission;
  }

  /**
   * Narrow this agent's tool working folder to an existing folder inside
   * its environment project. `undefined` restores the environment root.
   * @param {string|undefined|null} folder - absolute or env.cwd-relative
   * @returns {string} the resolved tool folder
   */
  setFolder(folder) {
    const root = this.env?.cwd;
    if (typeof root !== "string" || root === "") throw new Error("Agent.setFolder: env.cwd is required");
    const base = resolve(root);
    if (folder === undefined || folder === null) return (this._folder = root);
    if (typeof folder !== "string" || folder.trim() === "") throw new TypeError("Agent.setFolder: folder must be a non-empty path");
    let candidate;
    try { candidate = realpathSync(resolve(base, folder)); } catch { throw new Error("Agent.setFolder: folder does not exist"); }
    const rel = relative(realpathSync(base), candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || (rel !== "" && rel.split(sep).includes(".."))) {
      throw new Error("Agent.setFolder: folder must be inside env.cwd");
    }
    const stat = statSync(candidate);
    if (!stat.isDirectory()) throw new Error("Agent.setFolder: path is not a folder");
    this._folder = candidate;
    return this._folder;
  }

  /** The agent-local root used for file tools and their OS sandbox. */
  get folder() { return this._folder ?? this.env?.cwd; }

  /**
   * Set (or replace) the QUESTION BRIDGE at runtime — the binding's
   * rendering engine wires it once its overlays exist (the TUI hands
   * its questionnaire overlay to the Agent after construction; see
   * the constructor's `question` option for the contract). Applies to
   * the next tool call.
   * @param {{ask: (questions: Array) => Promise<Array>}|null} callbacks
   */
  setQuestion(callbacks) {
    this._question = callbacks ?? null;
  }

  /**
   * The TOOL CONTEXT handed to interactive tools (in-process only):
   * the question bridge, the environment VIEW the call runs under
   * (the safe view in safe mode — an interactive tool reading
   * settings or reporting status sees exactly what the call may),
   * the CALL's own linkage ({callId, name}) so a tool can key
   * per-call state (the edit tool's rollback record), and the
   * calling Agent itself. Plain data +
   * callbacks — never serialized, never published to the provider.
   * @param {object} [call] - the tool call being executed
   * @param {{trusted?: boolean}} [options]
   * @returns {{question: object|null, env: object, call: object|undefined, agent: object|undefined, storage: object|undefined, trusted: boolean}}
   */
  _toolContext(call, { trusted = false } = {}) {
    const storageName = call?.name
      ? (this.env.toolEntry(call.name)?.storage ?? call.name)
      : undefined;
    return Agent.toolContext({
      question: this._question,
      env: this._toolEnv(),
      call,
      agent: this,
      storage: storageName ? this.toolStorage(storageName) : undefined,
      trusted,
      resetTimeout: this._resetToolTimeout,
    });
  }

  /**
   * Construct the public tool-call context. The object is ordinary
   * in-process data: it is never serialized or published to a provider.
   * @param {{question?: object|null, env: object, call?: object, agent?: object, storage?: object, trusted?: boolean, resetTimeout?: Function}} values
   * @returns {{question: object|null, env: object, call: object|undefined, agent: object|undefined, storage: object|undefined, resetTimeout: Function}}
   */
  static toolContext({ question = null, env, call, agent, storage, trusted = false, resetTimeout } = {}) {
    return {
      question,
      env,
      call: call ? { callId: call.callId, name: call.name } : undefined,
      agent,
      storage,
      trusted: trusted === true,
      // Interactive tools call this after a keyboard/mouse event to renew
      // their inactivity deadline. It is harmless for ordinary tools.
      resetTimeout: typeof resetTimeout === "function" ? resetTimeout : () => {},
    };
  }

  /**
   * The tool selection handed to provider connections: safe mode
   * intersects the availability selection with the read-only list (an
   * explicit selection still applies — safe mode only ever NARROWS it).
   * @returns {string[]|undefined}
   */
  _toolSelectionFor() {
    if (!this.safe) return this._toolSelection;
    const safeNames = this.env.safeToolNames();
    const sel = this._toolSelection;
    if (sel === undefined || (sel.length === 1 && sel[0] === "*")) return safeNames;
    return sel.filter((n) => safeNames.includes(n));
  }

  /** Whether this Agent's effective catalog authorizes a named tool. */
  canCallTool(name) {
    if (typeof name !== "string" || !this._toolEnv().hasTool(name)) return false;
    const selection = this._toolSelectionFor();
    return selection === undefined || (selection.length === 1 && selection[0] === "*") || selection.includes(name);
  }

  /** Provider-owned capability hook. Absence is explicitly unsupported. */
  async callProviderCapability(name, args, options) {
    const aiio = this.endpoint && this.model ? this._connection(this.endpoint, this.model) : null;
    const handler = aiio?.Provider?.capabilities?.[name] ?? aiio?.provider?.capabilities?.[name];
    if (typeof handler !== "function") return { status: "unsupported" };
    try {
      const content = await handler.call(aiio.Provider, { aiio, args, ...options });
      return content === undefined ? { status: "unsupported" } : { status: "success", content };
    } catch (error) {
      return { status: "failure", error };
    }
  }

  /**
   * Set (or clear) a tool's sticky MESSAGE on THIS agent — a compact
   * live text the TUI renders above the input area (collected from
   * the VIEWED agent; lib/agent/tool-messages.js).
   * @param {string} name - the tool's display name
   * @param {string|null} [text] - the message; null/undefined/"" clears
   * @returns {string|null} the tool's current message
   */
  updateToolMessage(name, text) {
    return updateToolMessage(this, name, text);
  }

  /** @returns {Array<{name: string, text: string}>} tools with a live sticky message */
  toolMessages() {
    return toolMessages(this);
  }

  /** Re-detect tool-provided display information from the current context. */
  detectToolMessages() {
    return detectToolMessages(this);
  }

  /**
   * Run the tool loop until done/error (lib/agent/run.js).
   * @param {Object} [options]
   * @param {string|object} [options.endpoint] - per-request endpoint selection
   * @param {string} [options.model] - per-request model selection
   * @param {number|string} [options.timeout] - per-request provider-request timeout
   * @param {boolean} [options.contextGuard] - false only for internal
   *   compaction, which must run above the normal 90% ceiling
   * @returns {Promise<object>} the terminal done/error event
   */
  run(options = {}) {
    if (this._runPromise) return this._runPromise;
    const running = runLoop(this, options);
    this._runPromise = running.finally(() => {
      if (this._runPromise === settled) this._runPromise = null;
    });
    const settled = this._runPromise;
    return settled;
  }

  /**
   * /context-compact: ask the model to summarize the conversation
   * (a structured, self-contained prompt), then replace the context
   * with the surviving SYSTEM messages plus one ASSISTANT message
   * holding the marked summary (lib/agent/compact.js). Compact is an
   * ordinary turn observed through Agent events; a no-op (context
   * untouched) when the model's turn returns no usable summary text.
   * @returns {Promise<{ok: boolean, before: number, summaryText?: string}>}
   */
  async compact() {
    return compactContext(this);
  }

  /**
   * Cumulative usage across every request THIS Agent has made — every
   * IO terminal event's usage envelope, summed in memory. Never
   * persisted: a fresh Agent starts at zero.
   * @returns {{inputTokens: number, outputTokens: number, cost: number}}
   */
  get usage() {
    return { ...this._usage };
  }

  /** Accumulate one terminal event's usage envelope (called from run()). */
  _accumulateUsage(usage) {
    accumulateUsage(this, usage);
  }

  /**
   * The context-window readout for the status surface (most exact
   * first: the provider's own report, the last provider-reported
   * envelope, the word-count estimate marked `approximate`).
   * @returns {{used: number, total: number|null, approximate: boolean}}
   */
  get contextUsage() {
    return contextUsageOf(this);
  }

  /**
   * The provider-reported PLAN/QUOTA readout of the current endpoint
   * (`{label?, quotas}`; in-memory, last-known). null until a request
   * reports one.
   * @returns {{label?: string, quotas: Object}|null}
   */
  get planUsage() {
    return planUsageOf(this);
  }

  /** Whether an agent run is currently in progress. @returns {boolean} */
  get busy() {
    return this._running === true;
  }

  /** Whether this agent asked to end after its current turn settles. @returns {boolean} */
  get endRequested() {
    return this._endRequested === true;
  }

  /** Whether close has been requested, including while a turn finishes. */
  get closeMarked() {
    return this._closeMarked === true;
  }

  /** Whether close cleanup has completed. */
  get closed() {
    return this._closed === true;
  }

  /**
   * Refuse new messages now and close after the current turn, or immediately
   * when idle. CLOSE_MARKED precedes CLOSED; repeated calls are no-ops.
   * @returns {boolean} true only when this call marks the agent
   */
  close() {
    if (this._closeMarked) return false;
    this._closeMarked = true;
    this._emit(EVENT.CLOSE_MARKED, {});
    if (!this.busy) this._performClose();
    return true;
  }

  /** Release every Agent-owned external retention point exactly once. */
  _performClose() {
    if (this._closed) return false;
    this._closed = true;
    this._emit(EVENT.CLOSED, {});
    for (const child of this._children) child._parentClosed();
    this._children = new Set();
    this._parent?.childRemove(this);
    this._parent = undefined;
    this.session?.close?.();
    this.env?.removeAgent?.(this);
    return true;
  }

  /**
   * Ask to END this agent (its job is done): the current turn finishes
   * first; the run loop then
   * closes the agent instead of
   * idling forever. Idempotent.
   * @returns {true}
   */
  requestEnd() {
    this._endRequested = true;
    return true;
  }

  /**
   * The connection/work state for the TUI's status indicator:
   * "working" (a run is in flight), "disconnected" (the last turn
   * failed connection-class), "idle" (otherwise).
   * @returns {"idle"|"working"|"disconnected"}
   */
  get ioState() {
    return ioStateOf(this);
  }

  /** Cancel the in-flight request (IO kill → terminal partial).
   *  Tool children in flight are signalled on an ESCALATION LADDER:
   *  the first cancel interrupts (SIGINT — a well-behaved command
   *  exits on its own; note a BUN worker shrugs SIGINT off — the next
   *  press is what lands), the SECOND forces the child out (SIGTERM),
   *  and a still-surviving child gets SIGKILL from the third press
   *  on. The run loop stops after the current tool outcome. */
  async cancel() {
    this._cancelCount = (this._cancelCount ?? 0) + 1;
    this._cancelRequested = true;
    this._signalCancel?.(); // an in-flight awaitTimeout completes NOW
    const signal = this._cancelCount === 1 ? "SIGINT" : this._cancelCount === 2 ? "SIGTERM" : "SIGKILL";
    for (const handle of this._activeTools) {
      // Settle the Agent-owned tool boundary before signaling its process:
      // command shutdown is cooperative, but user interruption is immediate.
      handle.interrupt?.();
      handle.abort?.(new Error("tool call cancelled"));
      handle.kill?.(signal);
    }
    await this._activeIO?.kill();
  }

  /**
   * Fork the current session into a NEW session id: the live context
   * continues under a fresh store (flushed immediately); the old file
   * stays behind as a snapshot. "0"/"false"/"anon" forks into an ANONYMOUS
   * (hidden, unpersisted) session.
   * @param {string} [id]
   * @returns {{id: string|null, file?: string, anonymous?: boolean}}
   */
  fork(id) {
    return forkSession(this, id);
  }

  /** Seed the system prompt into a NEW context (lib/agent/sessions.js). */
  _seedSystemPrompt() {
    seedSystemPrompt(this);
  }

  /**
   * Start a NEW session with an EMPTY context (re-seeded with the
   * system prompt): the old session file is closed (its flushed
   * content stays on disk — fork() first to keep a snapshot). With no
   * id a random UUID is chosen (an anonymous session STAYS anonymous);
   * "0"/"false"/"anon" always switches to an ANONYMOUS
   * (unpersisted) session.
   * @param {string} [id]
   * @returns {{id: string|null, file?: string, anonymous?: boolean}}
   */
  newSession(id) {
    return newSessionImpl(this, id);
  }

  /**
   * Rename the current session: the session file takes the proper
   * name (`session-<name>.jsonl`; the old name's file is gone) —
   * /session-name. An anonymous session has no file to name.
   * @param {string} name
   * @returns {{id: string, file: string}}
   */
  renameSession(name) {
    return renameSessionImpl(this, name);
  }

  /**
   * Deliver a user message: while a request is in flight it is queued for
   * the next request; while idle it is appended and starts a request
   * immediately. Pending messages send only after the in-flight IO turn
   * settles (never mid-response). The flush appends them AFTER any
   * tool results (tool calls answer first), append-merged into one
   * user message (consecutive same-type merging). An identical user
   * submission immediately following another user submission is ignored:
   * it is normally an accidental second submit while a run is starting.
   * A user message is TRIMMED of surrounding whitespace (trailing EOLs,
   * tabs, every white space) before it is queued; a submission that is
   * whitespace only carries no turn at all — it behaves exactly like
   * /continue: no message is appended and the existing context runs.
   * @param {object} message
   * @returns {object|null} the queued message (the prior duplicate when
   *   ignored, null for a whitespace-only /continue submission)
   */
  enqueue(message) {
    if (this._closeMarked) throw new Error("Agent.enqueue: agent is closed");
    if (message?.type === 2) {
      const trimmed = trimUserMessage(message);
      if (trimmed === null) {
        // Whitespace-only input is a continue: start the turn over the
        // existing context with NO appended message — exactly what
        // /continue does. A busy agent needs nothing queued.
        if (!this.busy) this.run().catch(() => {});
        return null;
      }
      message = trimmed.message;
    }
    const previous = this._pending.at(-1) ?? this.context.at(-1);
    if (sameConsecutiveUserMessage(previous, message)) return previous;
    if (!this.busy) {
      const appended = this._append(message);
      // Idle delivery is active delivery: start the turn before returning so
      // an immediate close() observes busy and waits for this message.
      this.run().catch(() => {}); // failures remain observable through events
      return appended;
    }
    this._pending.push(message);
    return message;
  }

  /**
   * Read an existing file as a binary user message and deliver it.
   * The path is resolved inside the Agent folder; missing files, folders,
   * and paths outside that folder fail before any message is queued.
   * @param {string} fileName - Agent-folder-relative file path
   * @returns {Promise<object>} the queued message
   */
  async enqueueFile(fileName) {
    const file = await resolvedFile(fileName, { folder: this.folder });
    const bytes = await readFile(file.resolved);
    const message = fileMessage(file.path, bytes);
    this.enqueue(message);
    return message;
  }

  /**
   * Inspect a path using the Agent's file-security boundary.
   * @param {string} path
   * @param {{requireExists?: boolean}} [options]
   * @returns {Promise<{path:string,isFolder:boolean,mimetype?:string}>}
   */
  pathInfo(path, options = {}) {
    return pathInfo(path, { folder: this.folder, ...options });
  }

  /** @returns {Array} the pending queue (a copy — drainPending to remove) */
  get pending() {
    return [...this._pending];
  }

  /**
   * Remove EVERY pending message, returning them (the TUI's Option+↑
   * recall: the queued messages go back into the input area, merged,
   * for editing).
   * @returns {Array} the drained messages
   */
  drainPending() {
    return this._pending.splice(0, this._pending.length);
  }

  /** Append every pending message now (merging folds them into one). */
  _flushPending() {
    const queued = this._pending.splice(0, this._pending.length);
    for (const message of queued) {
      this._append(message);
      this._emit(EVENT.SENT_MESSAGE, message);
    }
    return queued.length;
  }

  /**
   * Resume an EXISTING session: the live context is replaced with the
   * session's stored context under its store; the old session file is
   * closed (its flushed content stays on disk).
   * @param {string} id - session id (see latestSessionId for "latest")
   * @returns {{id: string, file: string, cwd: string|undefined, originMissing: boolean}}
   * @throws {Error} when no such session exists
   */
  resumeSession(id) {
    return resumeSessionImpl(this, id);
  }

  /**
   * Every session in the store's folder, latest first, each with a
   * first-user-message preview (the ^X menu's Resume sub-menu,
   * /resume's Tab completion).
   * @returns {Array<{id: string, file: string, mtime: number, messages: number, preview: string}>}
   */
  listSessions() {
    return listSessionsImpl(this);
  }

  /**
   * Nonblocking counterpart of listSessions().
   * @returns {Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string}>>}
   */
  listSessionsAsync() {
    return listSessionsAsyncImpl(this);
  }

  /** @returns {string|undefined} the latest session's id (undefined: no sessions) */
  latestSessionId() {
    return latestSessionIdImpl(this);
  }

  /** @returns {string|undefined} the current thinking level (undefined = provider default) */
  get thinking() {
    return this._thinking;
  }

  /**
   * Set the thinking level for subsequent requests (THINKING_LEVELS;
   * each provider translates it to the nearest symbol the model accepts).
   * Applies to already-open provider connections too.
   * @param {string} [level] - off/low/medium/high/xhigh (undefined: the model's default)
   */
  setThinking(level) {
    setThinkingImpl(this, level);
  }

  /**
   * Append a caller-built message (e.g. AI user input), mirrored
   * to the session store when one is wired. Library consumers use this
   * to grow the context between turns; an active run flushes it at its
   * durability points.
   */
  append(message) {
    return this._append(message);
  }

  /* --------------------------------------- context edits (Context) */

  /**
   * Replace context[i] (Context edit semantics: rebuilt from
   * recognized fields, stale provider identifiers dropped), mirrored to
   * the session store when one is wired.
   * @param {number} i
   * @param {object} message
   * @returns {object} the stored (rebuilt) message
   */
  edit(i, message) {
    return this.session ? this.session.edit(i, message) : editMessage(this.context, i, message);
  }

  /**
   * Replace context[i].content[j] (the containing message is rebuilt).
   * @param {number} i
   * @param {number} j
   * @param {object} block
   * @returns {object} the stored (rebuilt) block
   */
  editBlock(i, j, block) {
    return this.session ? this.session.editBlock(i, j, block) : editBlock(this.context, i, j, block);
  }

  /**
   * Remove every message at index >= i (RangeError when i is not an
   * existing index).
   * @param {number} i
   * @returns {Array} the removed messages
   */
  rollback(i) {
    return this.session ? this.session.rollback(i) : rollbackTo(this.context, i);
  }

  /**
   * Remove and return the last message (undefined on an empty context).
   * @returns {object|undefined}
   */
  pop() {
    return this.session ? this.session.pop() : pop(this.context);
  }

  /** Remove selected context messages. */
  removeMessages(indexes) {
    return this.session ? this.session.removeMessages(indexes) : removeMessages(this.context, indexes);
  }

  /* ---------------------------------------------------- internals */

  /** A runaway-guard stop: log, surface an ordinary error event, flush. */
  _guarded(agentSet, error) {
    return guarded(this, agentSet, error);
  }

  /** One IO per active endpoint; a killed instance is reconstructed. */
  _connection(endpoint, model) {
    const key = typeof endpoint === "string" ? endpoint : (endpoint?.name ?? "custom");
    let aiio = this._io.get(key);
    // Parent/environment safety can change without this agent receiving a
    // setter call. A connection's published tool catalog is fixed at creation,
    // so never reuse one built for a different effective safety state.
    if (aiio && (aiio.state === "closed" || aiio._agentSafe !== this.safe)) {
      this._io.delete(key);
      aiio = undefined;
    }
    if (!aiio) {
      aiio = this._createIO({
        env: this._toolEnv(),
        model: `${typeof endpoint === "string" ? endpoint : endpoint.name}/${model}`,
        url: this.url,
        timeout: this.timeout,
        settings: this._connectionSettings(),
        tools: this._toolSelectionFor(),
        onLog: (line) => this._emit(EVENT.LOG, line),
      });
      aiio._agentSafe = this.safe;
      this._io.set(key, aiio);
    }
    return aiio;
  }

  /** Constructor settings plus live per-request options (thinking). */
  _connectionSettings() {
    const think = thinkValue(this._thinking);
    if (think === undefined) return this.settings;
    return { ...this.settings, think };
  }

  _append(message, options) {
    // appendMessage normally MERGES consecutive same-type messages.
    // Callers may preserve an intentional boundary (tool system arrays).
    if (this.session) return this.session.append(message, options);
    return appendMessage(this.context, message, options);
  }

  _flush() {
    this.session?.flush?.();
  }

  /**
   * Yield live-turn session persistence to the event loop. This private path
   * preserves the public synchronous SessionStore.flush() contract used by
   * explicit callers and process-finish hooks.
   */
  async _flushLive() {
    if (typeof this.session?._flushAsync === "function") await this.session._flushAsync();
    else this._flush();
  }

  /**
   * Append one tool-call outcome: the result beside its call, then any
   * SYSTEM PAYLOADS the tool attached ({ result, system } returns) —
   * they land after the tool result and before any queued user
   * messages (pending user messages flush at the top of the loop,
   * after every tool outcome of this iteration).
   */
  _appendOutcome({ message, display, system }) {
    const appended = this._append(message);
    for (const text of system) this._append(systemMessage(text), { merge: false });
    this._emit(EVENT.TOOL_RESULT, { result: appended, display });
  }

  /** Route one tool call: id resolution and execution (lib/agent/tool-exec.js). */
  async _dispatch(call, claimedIds, batch) {
    return dispatchToolCall(this, call, claimedIds, batch);
  }

  /** Agent-owned id resolution (lib/agent/tool-exec.js). */
  _resolveCallId(id, claimedIds, batch) {
    return resolveCallId(this, id, claimedIds, batch);
  }

  /** True when a call OUTSIDE the current batch already uses this id. */
  _callIdSeen(callId, batch) {
    return callIdSeen(this, callId, batch);
  }

  /** Invoke one tool (sandboxed fork for file-scanned tools; lib/agent/tool-exec.js). */
  async _callTool(name, args, call) {
    return callToolFor(this, name, args, call);
  }

  /** Repair unanswered tool calls before a request (lib/agent/tool-repair.js). */
  _repairToolCalls() {
    return repairToolCalls(this);
  }

  /** Sweep empty messages out of the live context before a request
   *  (lib/agent/tool-repair.js) — an interrupted turn can leave one,
   *  and no provider dialect can carry it. */
  _sweepEmptyMessages() {
    return sweepEmptyMessages(this);
  }

  /** Trim whitespace off the latest user message before a request
   *  (lib/agent/trim-user.js) — append()/resume paths can bypass
   *  enqueue()'s trim. */
  _trimLatestUserMessage() {
    return trimLatestUserMessage(this);
  }

  /** Execute one tool call — NEVER throws (lib/agent/tool-exec.js). */
  async _execute(call) {
    return executeToolCall(this, call);
  }
}

/** True only for byte-for-byte equivalent consecutive user submissions. */
function sameConsecutiveUserMessage(previous, next) {
  return previous?.type === 2 && next?.type === 2 &&
    JSON.stringify(previous.content ?? []) === JSON.stringify(next.content ?? []);
}

Object.assign(Agent, {
  Agent, Context, Env, IO, NAMES,
  SessionStore, sessionDir, loadMessages, sameFolder, findSessionFile,
  onFinish, runFinish, armFinishSignals, _resetFinish,
  callToolSandboxed, DEFAULT_TOOL_TIMEOUT, resultContent, thinkValue,
  reseatAgent, isAnonymousId,
});

/**
 * Convenience Agent factory, creating an agent attached to this `Env` instance.
 * @param {object} [options] `Agent` constructor options; `env` is always this Env
 * @returns {Agent} a new Agent registered with this Env
 */
Object.defineProperty(Env.prototype, "createAgent", {
  configurable: true,
  writable: true,
  value(options = {}) {
    return new Agent({ ...options, env: this });
  },
});

export { Context, Env, IO };
export default Agent;
