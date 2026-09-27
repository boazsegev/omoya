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
 *     reconstructed after close() leaves it permanently closed. It
 *     reports usage PER TURN (the terminal event's `usage` envelope,
 *     see lib/context/usage.js) — nothing above it.
 *   - The CONTEXT is a Context object (lib/context.js): Agent names it
 *     from a session id (--session/--resume), or takes a ready one; it
 *     is logged to env.settings.sessions when saving is on.
 *   - Agent alone owns the CUMULATIVE usage total (the `usage` getter):
 *     it sums every terminal's envelope in memory as run() sees them.
 *     Never persisted (no usage.json) — a fresh Agent starts at zero;
 *     bindings that show it (the TUI footer, a one-shot CLI's final
 *     line) read it fresh rather than tracking their own copy.
 *
 * Agent's implementation is split across helper modules in lib/agent/;
 * this file provides the public façade:
 *   - run.js        the tool loop and its runaway guards;
 *   - tool-exec.js  tool-call eventDispatch/execution, the result contract;
 *   - readouts.js   usage/context-window/plan/connection readouts;
 *   - context-lifecycle.js  contextNew/contextFork/contextResume, the seeded system prompt;
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
 *   - timeout: explicit HOST override of settings.tools.timeout (duration)
 *   - async:   legacy option; read-only (safe:true) calls overlap by default
 *              in contiguous groups; other calls always run in step
 * Every call is Agent-timed (including in-process). A schema-declared
 * `timeout` argument is extracted and capped at settings.tools.timeoutLimit;
 * schema.onTimeout gets at most 60s for cleanup or a final result.
 *
 * SAFE MODE (options.safe; setSafe() toggles it at runtime — /safe,
 * the ^X Settings row — applying from the next request): publish and
 * execute ONLY read-only tools (schemas with `safe: true`): safe mode is
 * the Agent's own argument to Env (env.tools(safe), the tool context's
 * `safe` that env.toolCall honors), so one Env serves any number of
 * Agents in either mode. A child inherits its parent's safe mode and
 * cannot turn it off. Safe mode is FORCED (construction and setSafe both honor
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

import { NAMES } from "./namespace.js";
import IO from "./io.js";
const { Env, Context } = IO;
import { join, resolve, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import Sandbox from "./sandbox.js";
import { durationParse } from "./util.js";
const { messageSystem, eventDispatch } = Context;
import { onFinish, runFinish, armFinishSignals } from "./agent/finish.js";
import { DEFAULT_TOOL_TIMEOUT } from "./agent/tool-timeout-settings.js";
import { runLoop, guarded } from "./agent/run.js";
import { dispatchToolCall, resolveCallId, callIdSeen, callToolFor, executeToolCall } from "./agent/tool-exec.js";
import { repairToolCalls, sweepEmptyMessages } from "./agent/tool-repair.js";
import { trimUserMessage, trimLatestUserMessage, prepareUserMessages, compactFocus } from "./agent/trim-user.js";
import { accumulateUsage, contextUsageOf, planUsageOf, ioStateOf } from "./agent/readouts.js";
import { contextFork, contextNew, contextResume, seedSystemPrompt, applyContextSettings, agentSettingsSnapshot } from "./agent/context-lifecycle.js";
import { thinkValue, setThinking as setThinkingImpl } from "./agent/thinking.js";
import { pathInfo, resolvedFile } from "./agent/path-info.js";
const { messageFile, MessageType, ContentType } = Context;
import { reseatAgent } from "./agent/reseat.js";
import { updateToolMessage, toolMessages, detectToolMessages } from "./agent/tool-messages.js";
import { compactContext } from "./agent/compact.js";
import { EVENT, EVENT_COUNT, RESPONSE_CALLBACK_EVENTS } from "./agent/events.js";
import { installEnvPlugin } from "./agent/env-plugin.js";
import { modelSelectorParse } from "./agent/model-select.js";
import { skillCatalog, promptCatalog, skillSection } from "./agent/catalogs.js";
import { agentPolicy } from "./agent/policy.js";

export { onFinish as finishAdd, runFinish as finishRun, armFinishSignals as finishSignalsArm } from "./agent/finish.js";
export { DEFAULT_TOOL_TIMEOUT as TOOL_TIMEOUT_DEFAULT } from "./agent/tool-timeout-settings.js";
export { reseatAgent as reseat } from "./agent/reseat.js";
export { RESPONSE_CALLBACK_EVENTS as EVENT_CALLBACKS } from "./agent/events.js";

/**
 * The agent: the ordered context, the provider/model selection, the
 * tool loop, the pending queue and the session persistence, behind one
 * headless object.
 */
export class Agent {
  static _counter = 1;
  /**
   * The numeric event vocabulary for Agent.onEvent — events about THIS
   * agent only (Env reports membership: AGENT_ADDED/AGENT_REMOVED):
   * REQUEST_START, TEXT_START, TEXT_DELTA, TEXT_END, THINKING_START,
   * THINKING_DELTA, THINKING_END, TOOL_CALL_START, TOOL_CALL_DELTA,
   * TOOL_CALL_END, REQUEST_DONE, REQUEST_ERROR,
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
  static EVENT_CALLBACKS = RESPONSE_CALLBACK_EVENTS;
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
   * @param {Array|Context} [options.context] - seed messages (Agent takes
   *   ownership), or a ready Context used as is (then no `session`)
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
   *   supported OS sandbox is available (Sandbox.osAvailable())
   *   — there is no opt-out: mutation tools run only under an active
   *   OS sandbox
   * @param {string|false} [options.contextId] - names the context: an existing
   *   id (in env.settings.sessions) is resumed; an absent id creates it. `false` (or
   *   omitted, or an anonymous spelling "0"/"false"/"anon") gives a memory-only
   *   context that is not logged — agent.context.saveSet(true) starts logging it at any time.
   * @param {boolean} [options.contextSave=true] - whether a context named by
   *   `contextId` is logged to disk
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
   *   override of settings.tools.timeout, concurrent eventDispatch (default false).
   *   Worker processes always use an owned group for dispatch teardown;
   *   detached remains a context hint for in-process tools.
   *   Every effective duration is capped at settings.tools.timeoutLimit.
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
    contextId,
    contextSave = true,
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
    const selected = model === undefined ? {} : modelSelectorParse(this.env, model, "Agent", { remember: !(parent instanceof Agent) });
    this._children = new Set();
    this._parent = parent instanceof Agent ? parent : undefined;
    this._parent?._childAdd(this);
    this.endpoint = selected.endpoint;
    this.model = selected.model;
    this.url = url;
    this.timeout = timeout;
    this.settings = settings;
    this._toolSelection = tools;
    this._name = name === undefined ? `agent-${Agent._counter++}` : "";
    this._description = "";
    if (name !== undefined) this.nameSet(name);
    if (description !== undefined) this.descriptionSet(description);
    // FORCED SAFE: mutation tools (bash/write/edit — the forked tool
    // sandbox's OS write jail is their enforcement layer) run only
    // under an active OS sandbox; there is no opt-out. On a
    // mechanism-less platform the agent is read-only, no matter what
    // the caller asked for.
    this._forcedSafe = !Sandbox.osAvailable();
    this._safe = safe === true;
    this._spawnPermission = undefined;
    this.spawnPermissionSet(spawnPermission);
    this._callbacks = Array.from({ length: EVENT_COUNT }, () => []);
    this._createIO = createIO ?? ((opts) => new IO(opts));
    this._question = question ?? null; // the question bridge (interactive tools)
    // A headless host may narrow this agent's tool root below env.cwd.
    // It is deliberately agent-local: shared environment configuration,
    // catalogs, and other agents retain their original project root.
    this._folder = this.env?.cwd;
    // the settings this Agent runs by: resolved now, and again only when
    // another model is selected
    this._policyResolve();
    this._toolCall = {
      detached: toolCall?.detached !== false,
      fork: toolCall?.fork !== false, // sandboxed (forked) by default
      // Explicit host override only; absent delegates to the policy's
      // tools.timeout. Model-requested schema `timeout`
      // values are extracted/capped per call in tool-timeout.js.
      timeout: toolCall?.timeout === undefined ? undefined : durationParse(toolCall.timeout),
      async: toolCall?.async === true,
    };
    this._io = new Map(); // provider key -> IO (one per active provider)
    this._activeIO = null;
    this._activeTools = new Set(); // dispatch controllers + teardown completion
    this._cancelRequested = false;
    this._delayedRun = null; // scheduled continuation, distinct from an active run
    this._closeMarked = false; // close() refuses new work immediately
    this._closed = false; // performClose() has released registries/links
    this._pending = []; // user messages queued mid-turn (flushed after the request settles)
    this._expandedUserMessages = new WeakSet(); // avoid re-expanding processed prompts
    // Tool-owned state is allocated lazily by toolStorage(name). It is
    // agent-local and intentionally transient; tools own any persistence.
    this._usage = { inputTokens: 0, outputTokens: 0, cost: 0 }; // cumulative, in-memory only — never persisted

    // Context wiring — wholly inside Agent. With saving disabled, an id never
    // discovers or resumes a logged context.
    if (typeof contextSave !== "boolean") throw new TypeError("Agent: contextSave must be a boolean");
    if (contextId === null) throw new TypeError("Agent: contextId must be an id or false (not logged)");
    const injected = context instanceof Context;
    if (injected && contextId !== undefined) throw new TypeError("Agent: pass a ready Context or a contextId, not both");
    if (contextId !== undefined && typeof contextId !== "string" && contextId !== false) {
      throw new TypeError("Agent: contextId must be an id or false (not logged); pass a ready Context as `context`");
    }
    const memoryOnly = contextId === undefined || Context.idAnonymous(contextId);
    const dir = this._sessionsDir;
    const contextFile = !injected && !memoryOnly && contextSave && dir !== undefined
      ? Context.fileOf({ id: contextId, dir })
      : undefined;
    const seed = injected ? [] : (context ?? []);
    if (injected) {
      this.context = context;
    } else if (memoryOnly) {
      this.context = new Context({ dir, messages: seed, origin: this.env?.cwd, save: false });
    } else if (contextFile) {
      this.context = Context.resume({ id: contextId, dir, save: contextSave });
      for (const message of seed) this.context.append(message);
    } else {
      this.context = new Context({ id: contextId, dir, messages: seed, origin: this.env?.cwd, save: contextSave });
    }
    // Crash safety is the owner's: flush whatever context this Agent
    // holds when the process finishes (lib/agent/finish.js).
    this._finishUnregister = onFinish(() => this.context.flush());
    // A resumed session restores its stored AGENT SETTINGS (safe,
    // thinking, endpoint/model, name, …) with its context: caller-given
    // options win where they were set (applyContextSettings honors the
    // constructor fields already in place).
    if (contextFile) applyContextSettings(this, this.context.settings);
    // From here on, a wired file store records this agent's settings as
    // they change (setSafe/setModel/name/… — _recordContextSettings),
    // starting with the effective (launch + resumed) configuration.
    this._recordContextSettings();
    // A NEW context starts with the seeded system prompt — always the
    // FIRST message(s), ahead of any constructor-provided context.
    // Only `resume` skips it: a resumed session's stored context
    // replaces the seeded one wholesale (it carries its own).
    if (!contextFile) this._seedSystemPrompt();
    // Tools can rebuild transient TUI information from a replayed context
    // (for example, the note tool's sticky note list), as soon as the tool
    // catalog answers (toolMessagesDetect() awaits the same pass).
    this._toolMessagesDetected = detectToolMessages(this).catch(() => []);
    // Join the Env LAST: AGENT_ADDED listeners receive a complete agent
    // (they may subscribe to it, read its context and name), and a
    // construction that throws never leaves a registered agent behind.
    this.env.agentAdd?.(this);
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
   * - `Agent.EVENT.REQUEST_START` — a provider request began (once per request; a tool-loop run makes several); payload is the request start
   * - `Agent.EVENT.TEXT_START` / `TEXT_DELTA` / `TEXT_END` — one
   *   assistant text block began / grew / completed; indexed payloads
   *   (`contentIndex`, `content`)
   * - `Agent.EVENT.THINKING_START` / `THINKING_DELTA` / `THINKING_END` —
   *   the same lifecycle for a thinking (reasoning) block
   * - `Agent.EVENT.TOOL_CALL_START` / `TOOL_CALL_DELTA` / `TOOL_CALL_END` —
   *   the same lifecycle for one streamed tool call
   * - `Agent.EVENT.REQUEST_DONE` — the provider request completed (after its bookkeeping)
   * - `Agent.EVENT.REQUEST_ERROR` — the provider request failed; payload carries the error
   * - `Agent.EVENT.MESSAGE_COMMITTED` — a message was persisted to the
   *   context (payload is the stored message)
   * - `Agent.EVENT.LOG` — one diagnostic log line (payload is the line)
   * - `Agent.EVENT.TOOL_EXECUTE` — a tool call is about to run
   * - `Agent.EVENT.TOOL_DATA` — one chunk of a tool's live output
   * - `Agent.EVENT.TOOL_RESULT` — a tool call's outcome was appended
   * - `Agent.EVENT.CLOSE_MARKED` — close() was requested (no new work)
   * - `Agent.EVENT.CLOSED` — close cleanup completed; the agent is dead
   * - `Agent.EVENT.SENT_MESSAGE` — a queued user message entered context
   * - `Agent.EVENT.THROTTLED` — a delayed continuation was scheduled; {until} is epoch ms
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

  /** @private The sessions folder: the Env's setting (env.settings.sessions), never the Agent's own choice. */
  get _sessionsDir() {
    return this.env?.settings.sessions;
  }

  /** @private */
  _emit(event, value) {
    for (let i = 0; i < this._callbacks[event].length; i++) this._callbacks[event][i][0](value);
    if (event === EVENT.MESSAGE_COMMITTED && this._parent) this._forwardToParent(value);
  }

  /** Forward a completed, non-tool assistant response to its direct parent. */
  _forwardToParent(message) {
    if (message?.type !== MessageType.Assistant || message.incomplete === true) return;
    const content = message.content ?? [];
    if (!content.some((part) => part?.type !== ContentType.Thinking) || content.some((part) => part?.type === ContentType.ToolCall)) return;
    this._parent.send({
      type: MessageType.User,
      content: [{ type: ContentType.Text, text: `[Message from worker: ${JSON.stringify(this.name)}]\n` }, ...content],
      worker: this.name,
    });
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

  /** Snapshot of directly owned workers. */
  get children() {
    return [...this._children];
  }

  /**
   * Construct one direct child through the environment factory. The parent
   * relationship is authoritative for ownership and delegation denial.
   * @param {object} [options]
   * @returns {Agent}
   */
  childCreate(options = {}) {
    const name = options.name;
    if (typeof name !== "string" || !name.trim() || name === "*") throw new TypeError("Choose a non-empty worker name other than *.");
    if (this.children.some((worker) => worker.name === name)) throw new Error(`Choose another worker name; ${JSON.stringify(name)} is already in use.`);
    const model = options.model ?? (this.endpoint && this.model ? `${this.endpoint}/${this.model}` : undefined);
    return this.env.agentCreate({ ...options, name, model, parent: this });
  }

  /** Register one direct child Agent. @param {Agent} child @returns {Agent} */
  _childAdd(child) {
    if (!(child instanceof Agent)) throw new TypeError("Agent child must be an Agent");
    if (child === this) throw new TypeError("Agent cannot be its own child");
    this._children.add(child);
    return child;
  }

  /** Remove one direct child Agent. @param {Agent} child @returns {boolean} */
  _childRemove(child) {
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
  /**
   * Rename the agent (recorded into a logged context's settings).
   * @param {string} value
   * @returns {string} the name
   */
  nameSet(value) {
    if (typeof value !== "string") throw new TypeError("Agent name must be a string");
    this._name = value;
    this._recordContextSettings?.();
    return value;
  }

  /** Human-friendly Agent description; an empty string is valid. */
  get description() {
    return this._description;
  }

  /** Set the human-friendly Agent description. @param {string} value */
  /**
   * Describe the agent (recorded into a logged context's settings).
   * @param {string} value
   * @returns {string} the description
   */
  descriptionSet(value) {
    if (typeof value !== "string") throw new TypeError("Agent description must be a string");
    this._description = value;
    this._recordContextSettings?.();
    return value;
  }

  /**
   * The settings this Agent runs by, resolved from env.settings when it
   * was created, re-resolved only when it selects another model
   * (lib/agent/policy.js): context {cap, turn, autocompact} (the runaway
   * guard and the auto-compaction threshold; global, then endpoint, then
   * model overrides), retry {attempts, base, max},
   * tools {timeout, timeoutLimit, concurrency}.
   * @returns {Readonly<object>}
   */
  get policy() {
    if (this._policyKey !== `${this.endpoint}/${this.model}`) this._policyResolve();
    return this._policy;
  }

  /** Resolve the policy for the current pair (its endpoint section supplies the context overrides). */
  _policyResolve() {
    let section = {};
    if (this.endpoint && this.model) {
      try {
        section = this.env.connection(`${this.endpoint}/${this.model}`, { remember: false }).settings;
      } catch { /* an unregistered pair: the global settings alone */ }
    }
    this._policy = agentPolicy(this.env?.settings, section, this.model);
    this._policyKey = `${this.endpoint}/${this.model}`;
  }

  /** @returns {boolean} safe mode: only read-only (`safe`) tools publish and execute */
  get safe() {
    return this._safe || this._forcedSafe || this._parent?.safe === true;
  }

  /**
   * Select an exact, configured endpoint/model pair for subsequent turns.
   * Validation happens before either live field changes, so a failed attempt
   * leaves the current selection intact.
   * @param {string} selector - `<endpoint>/<model>`
   * @returns {{endpoint: string, model: string}} the active selection
   */
  modelSet(selector) {
    const selected = modelSelectorParse(this.env, selector, "Agent.modelSet", { remember: !this.parent });
    this.endpoint = selected.endpoint;
    this.model = selected.model;
    this._recordContextSettings?.();
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
  safeSet(value) {
    const next = value === true;
    if (next === this._safe) return this.safe;
    // Required safety belongs to the environment, parent, or platform and
    // cannot be escaped by a local toggle.
    if (next === false && (this._forcedSafe || this._parent?.safe === true)) return this.safe;
    this._safe = next;
    this._recordContextSettings?.();
    for (const [key, aiio] of this._io) {
      if (aiio.state === "idle" || aiio.state === "closed") this._io.delete(key);
    }
    return this.safe;
  }

  /**
   * Record the live agent settings into the context (the snapshot resume
   *   restores with it — see agentSettingsSnapshot in lib/agent/context-lifecycle.js).
   *   A context that is not logged keeps it in memory (written once logging
   *   starts). No-op until the constructor has wired the context.
   * @private
   */
  _recordContextSettings() {
    if (!(this.context instanceof Context)) return;
    try { this.context.settingsSet(agentSettingsSnapshot(this)); } catch { /* a closed context refuses */ }
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
  spawnPermissionSet(value) {
    this._spawnPermission = value === true ? true : value === false ? false : undefined;
    this._recordContextSettings?.();
    return this._spawnPermission;
  }

  /**
   * Narrow this agent's tool working folder to an existing folder inside
   * its environment project. `undefined` restores the environment root.
   * @param {string|undefined|null} folder - absolute or env.cwd-relative
   * @returns {string} the resolved tool folder
   */
  folderSet(folder) {
    const root = this.env?.cwd;
    if (typeof root !== "string" || root === "") throw new Error("Agent.folderSet: env.cwd is required");
    const base = resolve(root);
    if (folder === undefined || folder === null) return (this._folder = root);
    if (typeof folder !== "string" || folder.trim() === "") throw new TypeError("Agent.folderSet: folder must be a non-empty path");
    let candidate;
    try { candidate = realpathSync(resolve(base, folder)); } catch { throw new Error("Agent.folderSet: folder does not exist"); }
    const rel = relative(realpathSync(base), candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || (rel !== "" && rel.split(sep).includes(".."))) {
      throw new Error("Agent.folderSet: folder must be inside env.cwd");
    }
    const stat = statSync(candidate);
    if (!stat.isDirectory()) throw new Error("Agent.folderSet: path is not a folder");
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
  questionSet(callbacks) {
    this._question = callbacks ?? null;
  }

  /**
   * The TOOL CONTEXT handed to in-process tools: the question bridge,
   * the Env, the call's safe mode (Env refuses a tool that is not
   * read-only), the pair the call serves (`selector` + its IO
   * connection — the pair's provider tools serve first), the CALL's own
   * linkage ({callId, name}) so a tool can key per-call state (the edit
   * tool's rollback record), and the calling Agent itself. Plain data +
   * callbacks — never serialized, never published to the provider.
   * @param {object} [call] - the tool call being executed
   * @param {{trusted?: boolean, info?: object}} [options] - info: the tool's catalog entry
   * @returns {object}
   */
  _toolContext(call, { trusted = false, info } = {}) {
    const storageName = call?.name ? (info?.storage ?? call.name) : undefined;
    const selector = this.endpoint && this.model ? `${this.endpoint}/${this.model}` : undefined;
    const context = Agent.toolContext({
      question: this._question,
      env: this.env,
      safe: this.safe,
      selector,
      call,
      agent: this,
      storage: storageName ? this.toolStorage(storageName) : undefined,
      trusted,
      resetTimeout: this._resetToolTimeout,
    });
    // the connection opens only when a provider tool asks for it
    if (selector) Object.defineProperty(context, "io", { get: () => this._connection(this.endpoint, this.model), enumerable: true });
    return context;
  }

  /**
   * The `# Skill Catalog` text of env.skills() (the skill tool's answer,
   * the skills CLI).
   * @param {Map<string, object>} skills
   * @param {{debug?: boolean}} [options] - debug appends each source root
   * @returns {string}
   */
  static skillCatalog(skills, options) {
    return skillCatalog(skills, options);
  }

  /**
   * The `# Prompt Catalog` text of env.prompts().
   * @param {Map<string, object>} prompts
   * @param {{debug?: boolean}} [options]
   * @returns {string}
   */
  static promptCatalog(prompts, options) {
    return promptCatalog(prompts, options);
  }

  /**
   * One skill's full content as the model reads it:
   * `<skill name="...">\n<body>\n</skill>`.
   * @param {{name: string, body: string}} skill - an env.skills() entry
   * @returns {string}
   */
  static skillSection(skill) {
    return skillSection(skill);
  }

  /**
   * Construct the public tool-call context. The object is ordinary
   * in-process data: it is never serialized or published to a provider.
   * @param {{question?: object|null, env: object, safe?: boolean, selector?: string, io?: object, call?: object, agent?: object, storage?: object, trusted?: boolean, resetTimeout?: Function}} values
   * @returns {{question: object|null, env: object, safe: boolean, selector: string|undefined, io: object|undefined, call: object|undefined, agent: object|undefined, storage: object|undefined, resetTimeout: Function}}
   */
  static toolContext({ question = null, env, safe = false, selector, io, call, agent, storage, trusted = false, resetTimeout } = {}) {
    return {
      question,
      env,
      safe: safe === true,
      selector,
      io,
      call: call ? { callId: call.callId, name: call.name } : undefined,
      agent,
      storage,
      trusted: trusted === true,
      // Interactive tools call this after a keyboard/mouse event to renew
      // their inactivity deadline. It is harmless for ordinary tools.
      resetTimeout: typeof resetTimeout === "function" ? resetTimeout : () => {},
    };
  }

  /** Whether this Agent's effective catalog authorizes a named tool: the
   *  availability selection, narrowed to read-only tools while safe.
   *  @param {string} name
   *  @returns {Promise<boolean>} */
  async toolCallable(name) {
    if (typeof name !== "string" || !(await this.env.tools(this.safe)).has(name)) return false;
    const selection = this._toolSelection;
    return selection === undefined || (selection.length === 1 && selection[0] === "*") || selection.includes(name);
  }

  /**
   * Set (or clear) a tool's sticky MESSAGE on THIS agent — a compact
   * live text the TUI renders above the input area (collected from
   * the VIEWED agent; lib/agent/tool-messages.js).
   * @param {string} name - the tool's display name
   * @param {string|null} [text] - the message; null/undefined/"" clears
   * @returns {string|null} the tool's current message
   */
  toolMessageSet(name, text) {
    return updateToolMessage(this, name, text);
  }

  /** @returns {Array<{name: string, text: string}>} tools with a live sticky message */
  toolMessages() {
    return toolMessages(this);
  }

  /** Re-detect tool-provided display information from the current context.
   *  @returns {Promise<Array<{name: string, text: string}>>} the messages after detection */
  toolMessagesDetect() {
    return (this._toolMessagesDetected = detectToolMessages(this));
  }

  /**
   * Run the tool loop until done/error (lib/agent/run.js).
   * @param {Object} [options]
   * @param {string|object} [options.endpoint] - per-request endpoint selection
   * @param {string} [options.model] - per-request model selection
   * @param {number|string} [options.timeout] - per-request provider-request timeout
   * @param {number} [options.after] - non-negative delay in ms before running;
   *   an immediate run cancels a pending delayed continuation
   * @param {boolean} [options.contextGuard] - false only for internal
   *   compaction, which must run above the normal 90% ceiling
   * @returns {Promise<object|null>} terminal done/error, or null if a delayed run is superseded
   */
  run(options = {}) {
    const { after, ...runOptions } = options;
    if (after !== undefined && (!Number.isFinite(after) || after < 0 || after > 2_147_483_647)) {
      throw new RangeError("Agent.run: after must be a non-negative timer delay in ms");
    }
    if (this._closeMarked) throw new Error("Agent.run: agent is closed");
    if (after > 0) {
      this._cancelDelayedRun();
      return new Promise((resolve, reject) => {
        const until = Date.now() + after;
        const timer = setTimeout(async () => {
          const scheduled = this._delayedRun;
          if (this._runPromise) {
            try { await this._runPromise; } catch { /* the next turn may still proceed */ }
          }
          if (this._delayedRun !== scheduled) return;
          this._delayedRun = null;
          try { resolve(await this.run(runOptions)); } catch (error) { reject(error); }
        }, after);
        this._delayedRun = { timer, resolve, until };
        this._emit(EVENT.THROTTLED, { until });
      });
    }
    this._cancelDelayedRun();
    if (this._runPromise) return this._runPromise;
    const running = runLoop(this, runOptions);
    this._runPromise = running.finally(() => {
      if (this._runPromise === settled) this._runPromise = null;
    });
    const settled = this._runPromise;
    return settled;
  }

  /** Epoch-ms deadline of a pending continuation, or null. */
  get throttledUntil() { return this._delayedRun?.until ?? null; }

  /** @private Cancel a scheduled continuation without starting a second turn. */
  _cancelDelayedRun() {
    if (!this._delayedRun) return;
    const { timer, resolve } = this._delayedRun;
    this._delayedRun = null;
    clearTimeout(timer);
    resolve(null);
  }

  /**
   * Compact: ask the model to summarize the conversation
   * (a structured, self-contained prompt), then replace the context
   * with the surviving SYSTEM messages plus one ASSISTANT message
   * holding the marked summary (lib/agent/compact.js). Compact is an
   * ordinary turn observed through Agent events; a no-op (context
   * untouched) when the model's turn returns no usable summary text.
   * @param {string} [focus] - optional user guidance appended to the summary prompt
   * @returns {Promise<{ok: boolean, before: number, summaryText?: string}>}
   */
  async compact(focus = "") {
    return compactContext(this, focus);
  }

  /** Compact from inside an active run, reusing its tool loop. */
  _compactTurn(focus) {
    return compactContext(this, focus, (options) => runLoop(this, options));
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

  /** Whether close has been requested, including while a turn finishes. */
  get closeMarked() {
    return this._closeMarked === true;
  }

  /** Whether close cleanup has completed. */
  get closed() {
    return this._closed === true;
  }

  /**
   * Refuse new messages immediately; finish the current turn before releasing
   * resources, or release them now when idle. This does not interrupt IO or
   * tools; call cancel() first to interrupt. CLOSE_MARKED precedes CLOSED;
   * repeated calls are no-ops.
   * @returns {boolean} true only when this call marks the agent
   */
  close() {
    if (this._closeMarked) return false;
    this._closeMarked = true;
    this._cancelDelayedRun();
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
    this._parent?._childRemove(this);
    this._parent = undefined;
    this.context.close();
    this._finishUnregister?.();
    this.env?.agentRemove?.(this);
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

  /** Cancel active IO and every pending tool dispatch; queued calls never start.
   * Dispatch owns sandbox teardown. Resolves after active dispatch resources
   * are released; repeated cancellation is safe and needs no escalation. */
  async cancel() {
    this._cancelDelayedRun();
    this._cancelRequested = true;
    this._signalCancel?.();
    const dispatches = [...this._activeTools];
    for (const { controller } of dispatches) controller.abort(new Error("tool call cancelled"));
    await Promise.all([this._activeIO?.close(), ...dispatches.map(({ done }) => done)]);
  }

  /**
   * Fork the context into a NEW context id: the conversation continues
   * in a fresh Context (flushed immediately when logged); the old file
   * stays behind as a snapshot. The fork keeps the logging setting; an
   * anonymous spelling (false/"0"/"false"/"anon") forks into one that is
   * not logged.
   * @param {string|false} [id]
   * @returns {{id: string, file: string, save: boolean}}
   */
  contextFork(id) {
    return contextFork(this, id);
  }

  /** Seed the system prompt into a NEW context (lib/agent/context-lifecycle.js). */
  _seedSystemPrompt() {
    seedSystemPrompt(this);
  }

  /**
   * Start a NEW, EMPTY context (re-seeded with the system prompt): the
   * old one is closed (its flushed content stays on disk — contextFork()
   * first to keep a snapshot). With no id a random UUID is chosen. The
   * new context keeps the logging setting (one not logged stays not
   * logged); an anonymous spelling (false/"0"/"false"/"anon") always
   * starts one that is not logged.
   * @param {string|false} [id]
   * @returns {{id: string, file: string, save: boolean}}
   */
  contextNew(id) {
    return contextNew(this, id);
  }

  /**
   * Submit a user message: while a request is in flight it is queued for
   * the next request; while idle it is appended and starts a request
   * immediately. Pending messages send only after the in-flight IO turn
   * settles (never mid-response). The flush appends them AFTER any
   * tool results (tool calls answer first), append-merged into one
   * user message (consecutive same-type merging). An identical user
   * submission immediately following another user submission is ignored:
   * it is normally an accidental second submit while a run is starting.
   * User slash messages are interpreted just before IO, after all
   * pending and direct context writes: /compact triggers compaction,
   * and registered /prompt (or //prompt) expands with trailing text.
   * Unknown slash commands remain text; other UI commands are not executed.
   * A user message is TRIMMED of surrounding whitespace (trailing EOLs,
   * tabs, every white space) before it is queued; a submission that is
   * whitespace only carries no turn at all — it behaves exactly like
   * /continue: no message is appended and the existing context runs.
   * @param {object} message
   * @returns {Promise<object>} the active run's terminal done/error event.
   *   Awaiting a busy send waits for that run, not a distinct reply to this
   *   message; on failure the queued message remains pending for a later run.
   */
  send(message) {
    if (this._closeMarked) throw new Error("Agent.send: agent is closed");
    if (message?.type === 2) {
      const trimmed = trimUserMessage(message);
      if (trimmed === null) {
        // Whitespace-only input is a continue: start the turn over the
        // existing context with NO appended message — exactly what
        // /continue does. A busy agent needs nothing queued.
        return this.busy ? this._runPromise : this.run();
      }
      message = trimmed.message;
    }
    const previous = this._pending.at(-1) ?? this.context.at(-1);
    if (sameConsecutiveUserMessage(previous, message)) return this.busy ? this._runPromise : this.run();
    if (!this.busy) {
      this._append(message, { merge: !isCompactCommand(message) });
      // Claim the run synchronously so close() waits for this message.
      const turn = this.run();
      // Unobserved fire-and-forget submissions still report errors via events.
      turn.catch(() => {});
      return turn;
    }
    this._pending.push(message);
    if (this._delayedRun) this._cancelDelayedRun();
    return this._runPromise;
  }

  /**
   * Read an existing file as a binary user message and deliver it.
   * The path is resolved inside the Agent folder; missing files, folders,
   * and paths outside that folder fail before any message is queued.
   * @param {string} fileName - Agent-folder-relative file path
   * @returns {Promise<object>} the run's terminal done/error event
   */
  async sendFile(fileName) {
    if (this._closeMarked) throw new Error("Agent.sendFile: agent is closed");
    const file = await resolvedFile(fileName, { folder: this.folder });
    const bytes = await readFile(file.resolved);
    return this.send(messageFile(file.path, bytes));
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

  /** Unsent messages queued while busy (array copy; message objects are shared).
   *  An error leaves them pending until a later run or pendingPop(). */
  get pending() {
    return [...this._pending];
  }

  /**
   * Remove ALL unsent pending messages, returning them (the TUI's Option+↑
   * recall: the queued messages go back into the input area, merged,
   * for editing).
   * @returns {Array} the drained messages
   */
  pendingPop() {
    return this._pending.splice(0, this._pending.length);
  }

  /** Append every pending message now (merging folds them into one). */
  _flushPending() {
    const queued = this._pending.splice(0, this._pending.length);
    for (const message of queued) {
      this._append(message, { merge: !isCompactCommand(message) });
      this._emit(EVENT.SENT_MESSAGE, message);
    }
    return queued.length;
  }

  /**
   * Resume a LOGGED context by id (from env.settings.sessions): it replaces the
   * current one, which is closed (its flushed content stays on disk); its
   * recorded settings and origin folder apply (lib/agent/context-lifecycle.js).
   * @param {string} id - context id (Context.latest finds the newest)
   * @returns {{id: string, file: string, cwd: string|undefined, originMissing: boolean}}
   * @throws {Error} when no such context exists
   */
  contextResume(id) {
    return contextResume(this, id);
  }

  /** @returns {string|undefined} the current thinking level (undefined = provider default) */
  get thinking() {
    return this._thinking;
  }

  /**
   * Set the thinking level for subsequent requests (THINKING_LEVELS;
   * each provider translates it to the nearest symbol the model accepts).
   * Applies to already-open provider connections too.
   * @param {string} [level] - none/low/medium/high/xhigh/max (undefined: the model's default)
   */
  thinkingSet(level) {
    setThinkingImpl(this, level);
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
        env: this.env,
        safe: this.safe,
        model: `${typeof endpoint === "string" ? endpoint : endpoint.name}/${model}`,
        url: this.url,
        timeout: this.timeout,
        settings: this._connectionSettings(),
        // The availability selection as given: the connection narrows it to
        // read-only tools in safe mode on EVERY request (Env.tools) — a
        // snapshot here would hide safe tools registered later.
        tools: this._toolSelection,
        onLog: (line) => this._emit(EVENT.LOG, line),
        remember: false, // adopting the selection remembered it (modelSet)
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
    // append normally MERGES consecutive same-type messages. Callers may
    // preserve an intentional boundary (tool system arrays).
    return this.context.append(message, options);
  }

  _flush() {
    this.context.flush();
  }

  /** Yield live-turn logging to the event loop (Context.flushAsync). */
  async _flushLive() {
    await this.context.flushAsync();
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
    for (const text of system) this._append(messageSystem(text), { merge: false });
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
  async _callTool(name, args, call, dispatch) {
    return callToolFor(this, name, args, call, dispatch);
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
   *  send()'s trim. */
  _trimLatestUserMessage() {
    return trimLatestUserMessage(this);
  }

  /** Interpret trailing user messages at the single pre-IO boundary. */
  _prepareUserMessages() {
    return prepareUserMessages(this);
  }

  /** Execute one tool call — NEVER throws (lib/agent/tool-exec.js). */
  async _execute(call) {
    return executeToolCall(this, call);
  }
}

/** True only for byte-for-byte equivalent consecutive user submissions. */
function isCompactCommand(message) {
  return compactFocus(message) !== null;
}

function sameConsecutiveUserMessage(previous, next) {
  return previous?.type === 2 && next?.type === 2 &&
    JSON.stringify(previous.content ?? []) === JSON.stringify(next.content ?? []);
}

Object.assign(Agent, {
  Context, Env, IO, NAMES,
  finishAdd: onFinish, finishRun: runFinish, finishSignalsArm: armFinishSignals,
  TOOL_TIMEOUT_DEFAULT: DEFAULT_TOOL_TIMEOUT,
  reseat: reseatAgent,
});

// Env knows nothing about Agents: everything it does regarding them —
// the active-Agent registry, agentCreate, capacity, the AGENT_ADDED/
// AGENT_REMOVED membership events — is this plugin, installed after the
// fact (lib/agent/env-plugin.js).
installEnvPlugin(Env, Agent);

export { Context, Env, IO };
export default Agent;
