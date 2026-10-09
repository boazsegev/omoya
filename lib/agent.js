/**
 * lib/agent.js — Agent: owns context, provider/model selection, the tool
 * loop, and persistence. Headless: no stdio, no process.exit, no TUI.
 *
 * PUBLIC CORE ENTRY POINT. Agent coordinates the JSONL session store,
 * crash-safe finish hooks, the forked tool sandbox, the tool loop,
 * tool-call execution, status readouts, and thinking level. One Agent owns
 * one conversation for its lifetime; create another Agent to start or
 * resume a conversation, or use Agent.fork to branch one. App owns view replacement. It composes Context ← Env ← IO ← Agent and publishes that core
 * tree as Agent.Context, Agent.Env, and Agent.IO. It does not import CLI,
 * Markdown, or application/UI layers.
 *
 * Ownership:
 *   - Agent alone owns the ordered in-memory context, provider/model
 *     selection per request, the tool loop, and persistence.
 *   - IO receives the COMPLETE current context on every request; one
 *     IO instance is reused per qualified model and
 *     reconstructed after close() leaves it permanently closed. It
 *     reports usage PER TURN (the terminal event's `usage` envelope,
 *     see lib/context/usage.js) — nothing above it.
 *   - The CONTEXT is a Context object (lib/context.js): Agent names it
 *     from a session id (--session/--resume), or adopts a ready one unchanged;
 *     its identity never changes. Context owns edits and persistence to
 *     env.settings.sessions when saving is on.
 *   - Agent alone owns the CUMULATIVE usage total (the `usage` getter):
 *     it sums every terminal's canonical counters in memory as run() sees them.
 *     Never persisted (no usage.json) — a fresh Agent starts at zero;
 *     bindings that show it (the TUI footer, a one-shot CLI's final
 *     line) read it fresh rather than tracking their own copy.
 *
 * Agent's implementation is split across helper modules in lib/agent/;
 * this file provides the public façade:
 *   - run.js        the tool loop and its runaway guards;
 *   - tool-exec.js  tool-call eventDispatch/execution, the result contract;
 *   - readouts.js   cumulative usage/context-window/connection readouts;
 *   - context-lifecycle.js  constructor session settings and seeded system prompt;
 *   - thinking.js   the thinking level.
 *
 * Model identity is one qualified `<endpoint>/<model>` string throughout
 * construction, property assignment, child creation and context persistence.
 * Assigning `model` validates and records a whole state change. run() has no
 * model override. Split endpoint options are rejected; presentation layers derive display fields.
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
 * Read-only (tool schema safe:true) calls overlap in contiguous groups; mutations run in order.
 * Every call is Agent-timed (including in-process). A schema-declared
 * `timeout` argument is extracted and capped at settings.tools.timeoutLimit;
 * schema.onTimeout gets at most 60s for cleanup or a final result.
 *
 * WRITE CAPABILITY (options.can.write; assign agent.can.write at runtime):
 * always publish the full available catalog, but execute ONLY read-only
 * tools (schemas with `safe: true`) while write is denied. Agent passes
 * the effective tool-context `safe` to Env.toolCall. A child inherits its
 * parent's write restriction. Write denial is FORCED when no supported OS sandbox is available —
 * there is NO opt-out: mutation tools run only under an active OS
 * sandbox, so on a mechanism-less platform the agent is read-only.
 *
 * SYSTEM PAYLOADS: a tool returning { result, system } answers briefly
 * via its tool result while `system` (string or string[]) appends as
 * System messages after the complete tool-call batch and any queued user input.
 * DISPLAY PAYLOADS: { result, display } — `display` rides the outcome
 * to TOOL_RESULT subscribers and is
 * shown to the user WITHOUT ever joining the context: a tool can
 * display data without sending it to the model (the edit tool's
 * git-style diff).
 */

import { NAMES } from "./namespace.js";
import IO from "./io.js";
const { Env, Context } = IO;
import { join, resolve, relative, sep, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import Sandbox from "./sandbox.js";
import { durationParse } from "./util.js";
import { publishedTools } from "./tool-runtime.js";
import { toolContextFor } from "./agent/tool-context.js";
const { messageSystem, messageUser, messageValidate, eventDispatch } = Context;
import { onFinish, runFinish } from "./agent/finish.js";
import { runLoop, guarded } from "./agent/run.js";
import { dispatchToolCall, resolveCallId, callIdSeen, callToolFor, executeToolCall } from "./agent/tool-exec.js";
import { repairToolCalls, sweepEmptyMessages } from "./agent/tool-repair.js";
import { trimUserMessage, trimLatestUserMessage, prepareUserMessages, compactFocus } from "./agent/trim-user.js";
import { accumulateUsage, contextUsageOf, ioStateOf } from "./agent/readouts.js";
import { resumeOriginCheck, seedSystemPrompt, applyContextSettings, agentSettingsSnapshot } from "./agent/context-lifecycle.js";
import { nameReserved, RESERVED_NAMES } from "./agent/names.js";
import { thinkValue, setThinking as setThinkingImpl } from "./agent/thinking.js";
import { resolvedFile } from "./agent/path-info.js";
const { messageFile, MessageType, ContentType } = Context;
import { toolMessages, detectToolMessages } from "./agent/tool-messages.js";
import { compactContext } from "./agent/compact.js";
import { EVENT, RESPONSE_CALLBACK_EVENTS } from "./agent/events.js";
import { installEnvPlugin } from "./agent/env-plugin.js";
import { modelSelectorValidate } from "./agent/model-select.js";
import { appendSkillSystem, loadedSkills } from "./agent/skill-state.js";
import Jobs from "./jobs.js";
import { agentPolicy } from "./agent/policy.js";
import { agentRequest } from "./agent/request.js";

const AGENT_CONSTRUCTION = Symbol("Agent factory construction");

/**
 * Resolve an existing working folder; embedded Agents may use a separate root.
 * Side-effect-free; callers should validate again at construction/use if the
 * filesystem can change after this check.
 * @param {Env} env - environment owning the project root
 * @param {string|undefined|null} folder - absolute or env.folder-relative
 * @returns {string} Validated working folder
 * @throws {Error} When the folder is missing or not a directory.
 */
function folderResolve(env, folder) {
  const root = env?.folder;
  if (typeof root !== "string" || root === "") throw new Error("Agent.folder: env.folder is required");
  const base = resolve(root);
  if (folder === undefined || folder === null) return root;
  if (typeof folder !== "string" || folder.trim() === "") throw new TypeError("Agent.folder: folder must be a non-empty path");
  let candidate;
  try { candidate = realpathSync(resolve(base, folder)); } catch { throw new Error("Agent.folder: folder does not exist"); }
  const stat = statSync(candidate);
  if (!stat.isDirectory()) throw new Error("Agent.folder: path is not a folder");
  return candidate;
}

/**
 * The agent: the ordered context, the provider/model selection, the
 * tool loop, the pending queue and the session persistence, behind one
 * headless object.
 */
export class Agent {
  #env;
  #context;
  /** @returns {Env} Borrowed, read-only environment identity; Agent never closes it. */
  get env() { return this.#env; }
  /** @returns {Context} The live conversation owned and closed by this Agent. Mutate its messages/settings through Context; construct another Agent for another conversation. Identity is read-only for the Agent's lifetime. */
  get context() { return this.#context; }
  /** @returns {{read: boolean, write: boolean, delegate: *, interact: boolean, [capability: string]: *}} Live agent-owned capability map. `read` is always true; `write` is subject to sandbox and parent restrictions; a child's `delegate` and `interact` are always false. Tools may define their own keys; only boolean values allow or deny, others require asking. Assignments persist with session settings. */
  can;
  static _counter = 1;
  /**
   * The Symbol event vocabulary for Agent.onEvent — events about THIS
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
   * Open an Agent with a ready Env. When env is omitted, acquire the Env for
   * cwd (the process cwd by default) through Env.open. The returned Env is
   * borrowed: the caller, not Agent.close(), decides when to close it.
   * `folder` independently selects the Agent's tool root, never the Env path.
   * @param {object} [options={}] Agent creation options plus cwd and envOptions.
   * @param {string} [options.cwd=process.cwd()] Env project path, only when env is omitted.
   * @param {object} [options.envOptions] Options forwarded to Env.open, only when env is omitted.
   * @returns {Promise<Agent>} A fully constructed Agent; options are not mutated or retained.
   * @throws {TypeError|Error} Invalid options or Env startup/Agent construction failure; fix inputs before retrying. Env acquisition is not undone if Agent construction fails.
   */
  static async create(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Agent.create: options must be an object");
    const { cwd, envOptions, ...agentOptions } = options;
    if (agentOptions.env !== undefined && (cwd !== undefined || envOptions !== undefined)) {
      throw new TypeError("Agent.create: cwd and envOptions require an omitted env");
    }
    const env = agentOptions.env ?? await Env.open(cwd ?? process.cwd(), envOptions);
    return new Agent({ ...agentOptions, env }, AGENT_CONSTRUCTION);
  }

  /**
   * Build an agent over an environment; wires the session store (a
   * named file session, a resumed one, an injected store, or none) and
   * takes ownership of the seed context — a NEW (non-resumed) context
   * starts with the seeded system prompt as its FIRST message(s).
   * @param {Object} [options]
   * @param {Env} options.env - required borrowed environment; use Agent.create() for asynchronous acquisition
   * @param {string} [options.model] - default `<endpoint>/<model>` selector
   * @param {Array|Context} [options.context] - seed messages (deep-copied into the owned Context), or a ready Context used as is (then no `session`)
   *   (seed arrays receive the system prompt ahead of them; a ready Context is adopted without changing its messages or stored settings)
   * @param {string[]} [options.tools] - availability selection (omitted/["*"]=all, []=none)
   * @param {Agent} [options.parent] - creating Agent, or unset for non-Agents
   * @param {string} [options.name] - display name (default: `agent-<counter>`); names that read as an address or a privileged identity are reserved (see `name`)
   * @param {string} [options.description] - display description (empty allowed)
   * @param {string} [options.folder] - existing env.folder-relative or absolute working folder;
   *   validated before the agent is registered (omitted uses env.folder)
   * @param {object} [options.can] - agent capabilities: read is always true; write false denies mutations while preserving the full catalog, and is forced false without OS sandbox or when the parent denies writes; delegate allows child creation (false denies; other values ask); interact defaults true but is false for children. Additional tool-owned keys are allowed.
   * @param {string|false} [options.contextId] - names the context: an existing
   *   id (in env.settings.sessions) is resumed — only a session recorded in env.folder; an absent id creates it. `false` (or
   *   omitted, or an anonymous spelling "0"/"false"/"anon") gives a memory-only
   *   context that is not logged — (agent.context.save = true) starts logging it at any time.
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
   * @param {(payload: object) => void} [options.onStart] - response callback; onStart, onTextStart, onTextDelta, onTextEnd, onThinkingStart, onThinkingDelta, onThinkingEnd, onToolCallStart, onToolCallDelta, onToolCallEnd, onDone, and onError map to Agent.EVENT_CALLBACKS. Supplied callbacks register through onEvent before Env membership events; done/error fire after request bookkeeping.
   * @param {{fork?: boolean, timeout?: number|string, detached?: boolean}} [options.toolCall]
   *   - tool sandbox: forked execution (default true), optional host
   *   override of settings.tools.timeout.
   *   Worker processes always use an owned group for dispatch teardown;
   *   detached remains a context hint for in-process tools.
   *   Every effective duration is capped at settings.tools.timeoutLimit.
   * @throws {TypeError} Direct construction, missing or invalid Env, non-object options, unknown own keys (including symbols), non-function response callbacks, and unknown toolCall keys are rejected before Context adoption. Use can.write instead of the removed safe key; count limits and toolCall.async are unsupported.
   */
  constructor(options = {}, construction) {
    if (construction !== AGENT_CONSTRUCTION) throw new TypeError("Agent: use await Agent.create(options)");
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Agent: options must be an object");
    const supported = new Set([
      "env", "model", "context", "tools", "parent", "name",
      "description", "folder", "contextId", "contextSave", "createIO", "toolCall", "can", "question",
      ...RESPONSE_CALLBACK_EVENTS.map(([callback]) => callback),
    ]);
    for (const key of Reflect.ownKeys(options)) {
      if (key === "endpoint") throw new TypeError("Agent: use model: <endpoint>/<model>, not endpoint");
      if (key === "safe") throw new TypeError("Agent: use can: { write: false }, not safe");
      if (!supported.has(key)) throw new TypeError(`Agent: unknown option ${String(key)}`);
    }
    for (const [callback] of RESPONSE_CALLBACK_EVENTS) {
      if (options[callback] !== undefined && typeof options[callback] !== "function") throw new TypeError(`Agent: ${callback} must be a function`);
    }
    if (options.toolCall !== undefined) {
      if (options.toolCall === null || typeof options.toolCall !== "object" || Array.isArray(options.toolCall)) throw new TypeError("Agent: toolCall must be an object");
      for (const key of Reflect.ownKeys(options.toolCall)) {
        if (!["fork", "timeout", "detached"].includes(key)) throw new TypeError(`Agent: unknown toolCall option ${String(key)}`);
      }
    }
    const {
      env, model, context, tools, parent, name, description, folder,
      contextId, contextSave = true, createIO, toolCall, can, question,
    } = options;
    if (parent === this) throw new TypeError("Agent parent cannot be itself");
    if (!(env instanceof Env) || env.closed) throw new TypeError("Agent: an open Env is required; use await Agent.create() to acquire one");
    this.#env = env;
    try {
      // A child inherits its parent's write root unless given a narrower one.
      // Validate before constructing or registering it.
      this._parent = parent instanceof Agent ? parent : undefined;
      this.folder = folder;
      // An omitted model is valid for an agent configured later, but a
      // qualified selector must resolve through the live Env registry. Do this
      // before registration/parent linkage so a rejected construction leaks no
      // partially-owned agent.
      const selected = model === undefined ? undefined : modelSelectorValidate(this.env, model, "Agent", { remember: !(parent instanceof Agent) });
      this._children = new Set();
      this._contacts = new Map(); // request contacts: alias@project -> {folder, id} (lib/agent/request.js)
      this._model = selected;
      this._toolSelection = tools;
      this._name = name === undefined ? `agent-${Agent._counter++}` : "";
      this._description = "";
      if (name !== undefined) (this.name = name);
      if (description !== undefined) (this.description = description);
      // FORCED SAFE: mutation tools (bash/write/edit — the forked tool
      // sandbox's OS write jail is their enforcement layer) run only
      // under an active OS sandbox; there is no opt-out. On a
      // mechanism-less platform the agent is read-only, no matter what
      // the caller asked for.
      this._forcedSafe = !Sandbox.osAvailable();
      this._constructorWriteSpecified = typeof can?.write === "boolean";
      this._can = { read: true, write: can?.write !== false, delegate: this._parent ? undefined : can?.delegate, interact: can?.interact !== false };
      for (const [key, value] of Object.entries(can ?? {})) {
        if (key !== "read" && key !== "write" && key !== "delegate" && key !== "interact" && key !== "__proto__" && key !== "constructor" && key !== "prototype" && !(key === "request" && this._parent)) this._can[key] = value;
      }
      const agent = this;
      this.can = new Proxy(this._can, {
        get(target, key, receiver) {
          if (key === "read") return true;
          if (key === "write") return target.write && !agent._forcedSafe && agent.parent?.can.write !== false;
          if ((key === "delegate" || key === "request") && agent.parent) return false;
          if (key === "interact") return target.interact !== false && !agent.parent;
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value) {
          // Workers never hold peer capabilities; a detached worker starts from the default (ask).
          if (key === "read" || ((key === "delegate" || key === "request") && agent.parent)) return true;
          if (key === "write" || key === "interact") {
            if (typeof value === "boolean") {
              target[key] = value;
              agent._recordContextSettings?.();
            }
            return true;
          }
          if (key === "__proto__" || key === "constructor" || key === "prototype") return false;
          const result = Reflect.set(target, key, value);
          agent._recordContextSettings?.();
          return result;
        },
        defineProperty(target, key, descriptor) {
          if (key === "read" || key === "write" || key === "interact" || key === "__proto__" || key === "constructor" || key === "prototype") return false;
          if ((key === "delegate" || key === "request") && agent.parent) return true;
          const result = Reflect.defineProperty(target, key, descriptor);
          agent._recordContextSettings?.();
          return result;
        },
        deleteProperty(target, key) {
          if (key === "read" || key === "write" || key === "interact") return false;
          const result = Reflect.deleteProperty(target, key);
          agent._recordContextSettings?.();
          return result;
        },
      });
      this._callbacks = new Map();
      this._eventHandle = 0;
      for (const [callback, event] of RESPONSE_CALLBACK_EVENTS) {
        if (options[callback] !== undefined) this.onEvent(event, options[callback]);
      }
      this._createIO = createIO ?? ((opts) => new IO(opts));
      this.question = question; // validate the host's interactive bridge
      // The validated agent-local folder does not alter the shared Env or siblings.
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
      };
      this._io = new Map(); // qualified model -> IO (one per selected model)
      this._activeIO = null;
      this._activeTools = new Set(); // dispatch controllers + teardown completion
      this._cancelRequested = false;
      this._delayedRun = null; // scheduled continuation, distinct from an active run
      this._closeMarked = false; // close() refuses new work immediately
      this._closed = false; // performClose() has released registries/links
      this._closePromise = null; // shared teardown completion
      this._performClosePromise = null; // private idempotent cleanup
      this._pending = []; // user messages queued mid-turn (flushed after the request settles)
      this._expandedUserMessages = new WeakSet(); // avoid re-expanding processed prompts
      // Tool-owned state is allocated lazily during dispatch. It is
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
      const dir = this._sessionsDir;
      const seed = injected ? [] : (context ?? []);
      // Context owns legacy anonymous spellings; only its canonical id is inspected.
      const candidate = injected ? undefined : new Context({ id: contextId === undefined ? false : contextId, dir,
        messages: seed, origin: this.env?.folder, save: false });
      const memoryOnly = !candidate?.id;
      const contextFile = !memoryOnly && contextSave && dir !== undefined
        ? Context.fileOf({ id: candidate.id, dir })
        : undefined;
      if (injected) {
        this.#context = context;
      } else if (memoryOnly) {
        this.#context = candidate;
      } else if (contextFile) {
        resumeOriginCheck(this.env, contextId, dir);
        this.#context = Context.resume({ id: contextId, dir, save: contextSave });
        for (const message of seed) this.context.append(message);
      } else {
        this.#context = new Context({ id: candidate.id, dir, messages: seed, origin: this.env?.folder, save: contextSave });
      }
      // Crash safety is the owner's: flush whatever context this Agent
      // holds when the process finishes (lib/agent/finish.js).
      // Retention hooks are installed only after initialization succeeds.
      // A resumed session restores its stored AGENT SETTINGS (can.write,
      // thinking, endpoint/model, name, …) with its context: caller-given
      // options win where they were set (applyContextSettings honors the
      // constructor fields already in place).
      if (contextFile || injected) {
        this._restoringContextSettings = true;
        try { applyContextSettings(this, this.context.settings); }
        finally { this._restoringContextSettings = false; }
      } else {
        // New sessions record their initial configuration. Resumed sessions
        // retain their on-disk snapshot until a user update or completed round.
        this._recordContextSettings();
      }
      // A NEW context starts with the seeded system prompt — always the
      // FIRST message(s), ahead of any constructor-provided context.
      // Adopted and resumed Contexts retain their own messages wholesale;
      // neither receives another seed.
      if (!contextFile && !injected) this._seedSystemPrompt();
      // Tools can rebuild transient TUI information from a replayed context
      // (for example, the note tool's sticky note list), as soon as the tool
      // catalog answers.
      this._toolMessagesDetected = detectToolMessages(this).catch(() => []);
      // Join the Env LAST: AGENT_ADDED listeners receive a complete agent
      // (they may subscribe to it, read its context and name), and a
      // construction that throws never leaves a registered agent behind.
      try {
        this._parent?._childAdd(this);
        this.env._agentAdd?.(this);
        if (!this.closeMarked) this._finishUnregister = onFinish(() => this.context.flush());
      } catch (error) {
        this._parent?._childRemove(this);
        try { this.env._agentRemove?.(this); } catch { /* membership already removed */ }
        throw error;
      }
    } catch (error) {
      // Ownership transfers only on successful construction. A caller-supplied
      // ready Context remains the caller's on failure; release only a Context
      // allocated by this constructor, observing its async close rejection.
      let releaseContext = Promise.resolve();
      if (this.#context && this.#context !== context) {
        try { releaseContext = Promise.resolve(this.#context.close()); }
        catch { /* preserve the original constructor failure */ }
      }
      // Construction cannot await Context release; the Env remains caller-owned.
      void releaseContext.catch(() => {});
      throw error;
    }
  }

  /**
   * Register a synchronous listener for one Symbol Agent.EVENT value.
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
   * @param {symbol} event - one Agent.EVENT constant (see the list above)
   * @param {(payload: object) => void} callback - synchronous listener; returned promises are not awaited. Async listeners must observe their own rejections and cannot delay teardown.
   * @returns {number} deterministic opaque registration handle (offEvent removes it)
   */
  onEvent(event, callback) {
    if (!Object.values(EVENT).includes(event)) throw new TypeError("Agent.onEvent: invalid event constant");
    if (typeof callback !== "function") throw new TypeError("Agent.onEvent: callback must be a function");
    const handle = ++this._eventHandle;
    const listeners = this._callbacks.get(event) ?? [];
    listeners.push([handle, callback]);
    this._callbacks.set(event, listeners);
    return handle;
  }

  /** Remove one registration; returns false when it is absent. */
  offEvent(handle) {
    if (!Number.isSafeInteger(handle)) return false;
    for (const [event, listeners] of this._callbacks) {
      const index = listeners.findIndex(([id]) => id === handle);
      if (index !== -1) {
        listeners.splice(index, 1);
        if (listeners.length === 0) this._callbacks.delete(event);
        return true;
      }
    }
    return false;
  }

  /** @private The sessions folder: the Env's setting (env.settings.sessions), never the Agent's own choice. */
  get _sessionsDir() {
    return this.env?.settings.sessions;
  }

  /**
   * Notify registered listeners with an event payload; forwards committed
   * messages to the parent when applicable.
   * @private
   * @param {symbol} event Agent event constant
   * @param {*} value Payload
   * @returns {void}
   */
  _emit(event, value) {
    const listeners = this._callbacks.get(event) ?? [];
    for (let i = 0; i < listeners.length; i++) listeners[i][1](value);
    if (event === EVENT.MESSAGE_COMMITTED && this._parent) this._forwardToParent(value);
  }

  /**
   * Forward an eligible completed assistant response to this worker's direct
   * parent.
   * @param {object} message Committed context message
   * @returns {void}
   */
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
   * @returns {Promise<Agent>}
   * @throws {Error} when this agent's env is closed (env.agentCreate)
   */
  async childCreate(options = {}) {
    if (this._closeMarked) throw new Error("Agent.childCreate: parent is closing");
    const name = options.name;
    if (typeof name !== "string" || !name.trim() || name === "*") throw new TypeError("Choose a non-empty worker name other than *.");
    if (this.children.some((worker) => worker.name === name)) throw new Error(`Choose another worker name; ${JSON.stringify(name)} is already in use.`);
    const model = options.model ?? this.model;
    return this.env.agentCreate({ ...options, name, model, parent: this });
  }

  /**
   * Create an independent Agent from a deep copy of this conversation at a message boundary.
   * The source is neither closed nor changed; the returned Agent owns its new Context
   * and has no parent. Its runtime work, event listeners and usage are not copied.
   * @param {{id?: string|false, through?: number}} [options={}] id names a new session;
   *   false makes it memory-only. through is the exclusive message boundary (default: all).
   * @returns {Promise<Agent>} A new Agent owned by the caller; close it independently.
   * @throws {TypeError|RangeError|Error} Invalid options, boundary, existing session id,
   *   or a closing/running source; correct the input or wait for the source to become idle.
   *   Factory failures leave the source intact; retry after resolving the failure.
   */
  async fork({ id, through } = {}) {
    if (this.busy || this.closeMarked || this.closed) throw new Error("cannot fork a closed or running agent");
    const old = this.context;
    if (through !== undefined && (!Number.isInteger(through) || through < 0 || through > old.length)) throw new RangeError("fork through must be a context boundary");
    const candidate = new Context({ id: id ?? false, save: false });
    if (candidate.id) {
      if (typeof id !== "string" || id.trim() !== id || !/^[^\s/\\]{1,64}$/.test(id) || id === "." || id === "..") throw new Error(`invalid session name "${id}"`);
      if (id === old.id || Context.fileOf({ dir: this.env.settings.sessions, id })) throw new Error(`session "${id}" already exists`);
    }
    const settings = old.settings === undefined ? undefined : structuredClone(old.settings);
    // A fork is a separate Agent; display names identify live Agents in hosts.
    if (settings) delete settings.name;
    const context = new Context({ id: id === undefined ? undefined : candidate.id || false, dir: this.env.settings.sessions,
      origin: old.origin, save: (id === undefined || !!candidate.id) && old.save !== false,
      settings, messages: old.messages().slice(0, through ?? old.length) });
    let fresh;
    try {
      fresh = await this.env.agentCreate({ model: this.model, folder: this.folder,
        can: { ...this.can }, tools: this._toolSelection, createIO: this._createIO,
        toolCall: { ...this._toolCall }, context });
      fresh.thinking = this.thinking;
      // Context owns durable state, not the host that happens to view it.
      fresh.context.flush();
      return fresh;
    } catch (error) {
      // A constructor failure leaves ownership with the caller; a successful
      // constructor transfers it to the Agent instead.
      if (fresh) await fresh.close();
      else await context.close();
      throw error;
    }
  }

  /**
   * Send a request (handoff, question or reply) to another root agent and return
   * at once; replies arrive later as user-role messages labelled with the
   * sender's contact address. Requires `can.request === true`; workers never may.
   * `to: "<name>@<project>"` (see `contacts`) messages a known agent again: queued
   * while busy, resumed from its saved session when closed, never duplicated.
   * `to: "new:<name>@<project>"` starts a fresh root agent with that role name
   * (a taken name gets `-2`, `-3`…) in `this` (this project) or a pinned project
   * sharing a settings group. It inherits this Agent's capabilities, model,
   * thinking, tools, IO factory and session logging; `safe: true` makes it read-only
   * and `model` picks a known model with free capacity. On a known contact,
   * `safe: false` and a `model` equal to that contact's current model are
   * harmless; changing either setting requires a new agent. An empty string,
   * false or null model means no override for both kinds of request. The
   * receiver gains this Agent as a known agent, so it can reply.
   * @param {{to: string, prompt: string, safe?: boolean, model?: string|false|null}} request
   * @returns {Promise<string>} The target's contact address (`<alias>@<project>`).
   * @throws {TypeError|Error} Invalid input, worker caller, missing permission,
   *   unknown project/contact/model, unsaved closed contact, or creation failure.
   */
  async request(request) {
    return agentRequest(this, request);
  }

  /** @returns {string[]} Sorted contact addresses (`alias@project`); aliases never change. */
  get contacts() {
    return [...this._contacts.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** Register one direct child Agent. @param {Agent} child @returns {Agent} */
  _childAdd(child) {
    if (this._closeMarked) throw new Error("Agent child: parent is closing");
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

  /**
   * Rename the agent (recorded into a logged context's settings).
   * Reserved (any case, look-alike letters and separators ignored): `new`,
   * `all`, `everyone`, chat role names, the product name, and names containing
   * `user`, `admin`, `group`, or another authority word (root, sudo, system,
   * developer, owner, operator, supervisor, moderator, privilege, authority).
   * @param {string} value
   * @throws {TypeError} For a non-string or reserved name.
   * @returns {void} Assignment records the new name; read name for the current value.
   */
  set name(value) {
    if (typeof value !== "string") throw new TypeError("Agent name must be a string");
    if (nameReserved(value)) throw new TypeError(`Agent name ${JSON.stringify(value)} is reserved (${RESERVED_NAMES})`);
    this._name = value;
    this._recordContextSettings?.();
  }

  /** Human-friendly Agent description; an empty string is valid. */
  get description() {
    return this._description;
  }

  /** Set the human-friendly Agent description. @param {string} value */
  /**
   * Describe the agent (recorded into a logged context's settings).
   * @param {string} value
   * @returns {void} Assignment records the new description.
   */
  set description(value) {
    if (typeof value !== "string") throw new TypeError("Agent description must be a string");
    this._description = value;
    this._recordContextSettings?.();
  }

  /**
   * The settings this Agent runs by, resolved from env.settings when it
   * was created, re-resolved only when it selects another model
   * (lib/agent/policy.js): context {cap, turn, autocompact} (the runaway
   * guard and the auto-compaction threshold; global, then endpoint, then
   * model overrides), retry {attempts, base, max},
   * tools {timeout, timeoutLimit, concurrency}.
   * @private
   * @returns {Readonly<object>}
   */
  get _policyCurrent() {
    if (this._policyKey !== this.model) this._policyResolve();
    return this._policy;
  }

  /**
   * Resolve and cache effective settings for the current endpoint/model pair;
   * the endpoint section supplies context overrides.
   * @returns {void}
   */
  _policyResolve() {
    let section = {}, metadata;
    if (this.model) {
      try {
        const link = this.env.connection(this.model, { remember: false });
        section = link.settings;
        metadata = section.models?.[link.model];
      } catch { /* an unregistered pair: the global settings alone */ }
    }
    this._policy = agentPolicy(this.env?.settings, section, metadata);
    this._policyKey = this.model;
  }

  /**
   * Select an exact, configured endpoint/model pair for subsequent turns.
   * Validation happens before the live model changes, so a failed attempt
   * leaves the current selection intact.
   * @param {string|undefined} selector - `<endpoint>/<model>`; undefined clears the selection
   * @returns {void} Assign the selector; read model for the current value.
   * @throws {TypeError} Invalid selector or unavailable endpoint/model; keep the old selection and choose a valid model.
   * @effects Records the default model and session settings; undefined clears it. Repeating a valid selection is safe and updates its last-used timestamp.
   */
  set model(selector) {
    const selected = selector === undefined ? undefined : modelSelectorValidate(this.env, selector, "Agent.model", { remember: !this.parent });
    const changed = this._model !== selected;
    this._model = selected;
    this._policyResolve();
    if (changed) {
      this.context?.contextUsageInvalidate({ window: true });
      this._disconnected = false;
    }
    this._recordContextSettings();
  }

  /**
   * The selected IO session, lazily created for this Agent's model; undefined when no model is selected.
   * @returns {IO|undefined} Agent-owned active provider IO; the Context is never stored in IO between requests.
   * @effects Creates a provider IO on first read without sending a request.
   */
  get io() {
    return this._closeMarked || this.model === undefined ? undefined : this._connection(this.model);
  }

  /**
   * Adopt another idle IO session for subsequent requests using the same Context.
   * @param {IO} value IO using this Env, configured with this Agent's safety/tool policy.
   * @returns {void} The adopted IO is closed with this Agent. The caller owns and closes any displaced IO obtained from the getter.
   * @throws {TypeError} Invalid IO, another Env, busy/closed Agent or IO; correct configuration or await idle before retrying. Validation failures leave selection unchanged.
   * @effects Selects and records value.model, then replaces the cached IO. Reassigning the same IO is idempotent.
   */
  set io(value) {
    if (this.busy || this._closeMarked) throw new TypeError("Agent.io: replace IO only while the Agent is idle and open");
    if (!value || value.env !== this.env || value.state !== "idle" ||
        ["write", "cancel", "close"].some((name) => typeof value[name] !== "function")) {
      throw new TypeError("Agent.io: use an idle IO from this Agent's Env");
    }
    const selected = modelSelectorValidate(this.env, value.model, "Agent.io", { remember: false });
    this.model = selected;
    this._io.set(selected, value);
  }

  /** @returns {string|undefined} The current qualified model selector. Assign to validate and record a whole model-state change; an active request finishes on its already-open IO. */
  get model() {
    return this._model;
  }

  /**
   * Record the live agent settings into the context (the snapshot resume
   *   restores with it — see agentSettingsSnapshot in lib/agent/context-lifecycle.js).
   *   A context that is not logged keeps it in memory (written once logging
   *   starts). No-op until the constructor has wired the context.
   * @private
   * @returns {void}
   */
  _recordContextSettings() {
    if (!(this.context instanceof Context) || this._restoringContextSettings) return;
    try { (this.context.settings = agentSettingsSnapshot(this)); } catch { /* a closed context refuses */ }
  }

  /**
   * Set this agent's tool working folder to an existing directory.
   * `undefined` restores the parent folder for children, or Env.folder for independent Agents.
   * Embedded independent Agents may use another tree.
   * @param {string|undefined|null} folder - absolute or env.folder-relative
   * @returns {void} Read folder afterwards for the resolved root.
   */
  set folder(folder) {
    const candidate = folder == null && this._parent
      ? resolve(this._parent.folder)
      : folderResolve(this.env, folder);
    if (this._parent) {
      const base = realpathSync(this._parent.folder);
      const rel = relative(base, candidate);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("Agent.folder: child folder must stay inside parent folder");
      }
    }
    this._folder = candidate;
  }

  /** The agent-local root used for file tools and their OS sandbox. */
  get folder() { return this._folder ?? this.env?.folder; }

  /**
   * Set (or replace) the QUESTION BRIDGE at runtime — the binding's
   * rendering engine wires it once its overlays exist (the TUI hands
   * its questionnaire overlay to the Agent after construction; see
   * the constructor's `question` option for the contract). Applies to
   * the next tool call.
   * @param {{ask: (questions: Array) => Promise<Array>}|null|undefined} callbacks Bridge or null to clear it
   * @returns {void}
   */
  set question(callbacks) {
    if (callbacks != null && typeof callbacks.ask !== "function") throw new TypeError("Agent.question: bridge must provide ask()");
    this._question = callbacks ?? null;
  }

  /** @returns {object|null} The live question bridge; a trusted host capability, never provider data. */
  get question() { return this._question; }

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
    return toolContextFor(this, call, { trusted, info });
  }

  /**
   * Activate named skills in this Agent's Context, or list the Env catalog.
   * Validate all requested names before injection; already active skills are no-ops.
   * @param {string|string[]} [names] Names to activate; omitted lists available skills.
   * @returns {string} Catalog text or activation summary; inputs are not retained or mutated.
   * @throws {TypeError|Error} Invalid names, unknown skills, or closed Agent; correct names before retrying. Lookup failures inject nothing.
   * @effects Appends durable system guidance; repeated activation in the same Context is idempotent.
   */
  skillLoad(names) {
    if (this._closeMarked) throw new Error("Agent.skillLoad: agent is closed");
    const activation = this.env.skillLoad(names, { active: loadedSkills(this.context) });
    if (typeof activation === "string") return activation;
    this._appendToolSystems(activation.system);
    return activation.result;
  }

  /**
   * Current model-facing tools: `const tools = await agent.tools`;
   * `tools.get(name)` returns a provider-neutral descriptor with its schema.
   * Uses IO's publication filter: dynamic availability,
   * configured selection, hidden-tool exclusion and the model's provider tools.
   * Provider dialect conversion remains IO/provider-owned; this is the current
   * catalog, not a capture of an earlier request's wire payload.
   * @returns {Promise<Map<string, object>>} Fresh map/descriptors, no callables or execution metadata. Nested schemas are shared registry data.
   * @throws {Error} Availability-check failures propagate; retry by reading again after correcting the tool/environment.
   * @effects Rechecks dynamic availability; does not open a provider connection or mutate context. O(n) in catalog size.
   */
  get tools() {
    const selection = this._toolSelection;
    return this.env.tools(false, this.model).then((catalog) => publishedTools(catalog, selection));
  }

  /** @returns {Array<{name: string, text: string}>} tools with a live sticky message */
  toolMessages() {
    return toolMessages(this);
  }

  /**
   * Run the tool loop until done/error (lib/agent/run.js).
   * @param {Object} [options]
   * @param {number|string} [options.timeout] - per-request provider-request timeout
   * @param {number} [options.after] - non-negative delay in ms before running;
   *   an immediate run cancels a pending delayed continuation
   * @returns {Promise<object|null>} terminal done/error, or null if a delayed run is superseded
   * @throws {TypeError} Unsupported options, including model/endpoint and internal loop controls; assign agent.model before running.
   * @effects Executes provider requests and tools, updates this Context and usage, and persists completed turns. Concurrent calls share the active run.
   */
  run(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Agent.run: options must be an object");
    if (Object.hasOwn(options, "endpoint") || Object.hasOwn(options, "model")) throw new TypeError("Agent.run: assign agent.model before running; run has no model or endpoint option");
    for (const name of Object.keys(options)) {
      if (name !== "timeout" && name !== "after") throw new TypeError(`Agent.run: unsupported internal option ${name}`);
    }
    return this._run(options);
  }

  /** @private Schedule one owned loop; compaction alone supplies guard/queue internals. */
  _run(options = {}) {
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
          try { resolve(await this._run(runOptions)); } catch (error) { reject(error); }
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

  /** @private Cancel a scheduled continuation without starting a second turn. @returns {void} */
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

  /** Compact during an active run using the existing agent tool loop. @param {string} focus Summary guidance. @returns {Promise<object>} Compaction result. */
  _compactTurn(focus) {
    return compactContext(this, focus, (options) => runLoop(this, options));
  }

  /**
   * Cumulative usage across every request THIS Agent has made — every
   * IO terminal event's usage envelope, summed in memory. Never
   * persisted: a fresh Agent starts at zero. Only canonical token/cache/reasoning
   * counters and reported cost are summed; totalTokens is inputTokens + outputTokens.
   * Cache counters are input subsets; reasoningTokens is an output subset. Optional
   * serviceTier, inferenceGeo and bounded provider details describe only the latest
   * request (missing metadata clears previous values). Unknown numeric details are
   * snapshots, not additive counters. Quotas remain separate Context.planUsage snapshots.
   * The returned deep snapshot shares no mutable data with this Agent; reading has no effects.
   * @returns {{inputTokens: number, outputTokens: number, cost: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cacheWrite5mTokens?: number, cacheWrite1hTokens?: number, uncachedInputTokens?: number, reasoningTokens?: number, serviceTier?: string, inferenceGeo?: string, details?: object}}
   */
  get usage() {
    return structuredClone(this._usage);
  }

  /** Add one terminal event's usage envelope to this agent's in-memory total. @param {object} usage Terminal usage data. @returns {void} */
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
   * Mark closure synchronously, refusing admission immediately. Finish an active
   * turn without cancelling it; callers who need interruption call cancel().
   * Await completion for all owned IO, context persistence, background processes,
   * registry and hook removal, never the borrowed Env. Concurrent and repeated
   * calls await the same outcome. CLOSE_MARKED
   * precedes cleanup; CLOSED follows every attempted release. All cleanup and
   * listener failures are reported together after the remaining releases run.
   * @returns {Promise<void>} Completion of owned teardown; rejects with AggregateError on failures.
   */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._closeMarked = true;
    this._cancelDelayedRun();
    const errors = [];
    let resolveClose, rejectClose;
    this._closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    try { this._emit(EVENT.CLOSE_MARKED, {}); } catch (error) { errors.push(error); }
    // Do not await cleanup in runLoop.finally: the running promise must settle
    // before teardown starts, or it would wait for itself indefinitely.
    const running = this._runPromise;
    void (async () => {
      try {
        if (running) await Promise.allSettled([running]);
        await this._performClose(errors);
        resolveClose();
      } catch (error) { rejectClose(error); }
    })();
    return this._closePromise;
  }

  /** Release every Agent-owned external retention point exactly once. @param {Error[]} errors Errors from the marking listener. @returns {Promise<void>} */
  async _performClose(errors = []) {
    if (this._performClosePromise) return this._performClosePromise;
    this._performClosePromise = (async () => {
      const releases = [];
      const cleanup = (fn) => {
        try { releases.push(Promise.resolve(fn())); }
        catch (error) { errors.push(error); }
      };
      cleanup(() => Sandbox.backgroundStopAll(this));
      for (const io of new Set([...this._io.values(), this._activeIO].filter(Boolean))) cleanup(() => io.close?.());
      this._io.clear();
      cleanup(() => this.context.close());
      const results = await Promise.allSettled(releases);
      errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
      // Keep registry membership and the finish hook while persistence and
      // provider teardown are pending; only detach after both have settled.
      for (const child of this._children) {
        try { child._parentClosed(); } catch (error) { errors.push(error); }
      }
      this._children.clear();
      try { this._parent?._childRemove(this); } catch (error) { errors.push(error); }
      this._parent = undefined;
      try { this._finishUnregister?.(); } catch (error) { errors.push(error); }
      try { this.env?._agentRemove?.(this); } catch (error) { errors.push(error); }
      this._closed = true;
      try { this._emit(EVENT.CLOSED, {}); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Agent.close: cleanup or listener failed");
    })();
    return this._performClosePromise;
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
    await Promise.all([this._activeIO?.cancel(), ...dispatches.map(({ done }) => done)]);
  }

  /** Add the configured seed system prompt to a newly created context. @returns {void} */
  _seedSystemPrompt() {
    seedSystemPrompt(this);
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
   * @param {object|string} message - a context message, or plain text converted to a user message
   * @returns {Promise<object>} the active run's terminal done/error event.
   *   Invalid input and closed-agent submissions return a rejected Promise
   *   without changing the queue or context. Awaiting a busy send waits for
   *   that run, not a distinct reply; on failure queued messages remain pending.
   */
  send(message) {
    try {
      if (this._closeMarked) throw new Error("Agent.send: agent is closed");
      if (typeof message === "string") message = messageUser(message);
      messageValidate(message);
    } catch (error) { return Promise.reject(error); }
    if (message.type === 2) {
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

  /** Append pending messages present at this request boundary, preserving later submissions. */
  _flushPending(count = this._pending.length) {
    const queued = this._pending.splice(0, count);
    for (const message of queued) {
      this._append(message, { merge: !isCompactCommand(message) });
      this._emit(EVENT.SENT_MESSAGE, message);
    }
    return queued.length;
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
  set thinking(level) {
    setThinkingImpl(this, level);
  }

  /* ---------------------------------------------------- internals */

  /** Handle a runaway-guard stop by logging, emitting an error, and flushing. @param {Set} agentSet Guard tracking set. @param {Error} error Stop error. @returns {*} Guard handler result. */
  _guarded(agentSet, error) {
    return guarded(this, agentSet, error);
  }

  /** Return or create IO for one qualified model, rebuilding closed or safety-mismatched instances. @param {string} model Qualified model selector. @returns {object} Provider IO instance. */
  _connection(model) {
    const key = model;
    let aiio = this._io.get(key);
    // Safety changes do not alter the published catalog or invalidate a provider connection.
    if (aiio && aiio.state === "closed") {
      this._io.delete(key);
      aiio = undefined;
    }
    if (!aiio) {
      aiio = this._createIO({
        env: this.env,
        safe: false,
        model,
        settings: this._connectionSettings(),
        // Publish all available tools regardless of permission; execution checks
        // the live capability so toggling read-only never changes the wire catalog.
        tools: this._toolSelection,
        onLog: (line) => this._emit(EVENT.LOG, line),
        remember: false, // adopting the selection remembered it (model)
      });
      this._io.set(key, aiio);
    }
    return aiio;
  }

  /** Pass only agent-local thinking to IO; provider configuration belongs to Env. @returns {object|undefined} */
  _connectionSettings() {
    const think = thinkValue(this._thinking);
    return think === undefined ? undefined : { think };
  }

  /** Append a message to the context with the supplied merge options. @param {object} message Context message. @param {object} options Append options. @returns {*} Context append result. */
  _append(message, options) {
    // append normally MERGES consecutive same-type messages. Callers may
    // preserve an intentional boundary (tool system arrays).
    return this.context.append(message, options);
  }

  /** Flush the context's pending persistence. @returns {void} */
  _flush() {
    this.context.flush();
  }

  /** Await asynchronous persistence of the live context. @returns {Promise<void>} */
  async _flushLive() {
    await this.context.flushAsync();
  }

  /**
   * Append a tool result and notify listeners immediately; collect its guidance
   * in call order for the end of the entire assistant tool-call batch.
   * @param {{message: object, display: *, system: string[]}} outcome Tool outcome fields.
   * @param {string[]} systems Batch-owned guidance collector, mutated in place.
   * @returns {void}
   */
  _appendOutcome({ message, display, system }, systems) {
    const appended = this._append(message);
    systems.push(...system);
    this._emit(EVENT.TOOL_RESULT, { result: appended, display });
  }

  /** Append durable guidance once, preserving separate skill boundaries. @param {string[]} systems Ordered system payloads. @returns {void} */
  _appendToolSystems(systems) {
    for (const text of systems) {
      appendSkillSystem(this, text, (value) => this._append(messageSystem(value), { merge: false }));
    }
  }

  /** Resolve and execute one tool call through the tool-execution module. @param {object} call Tool call. @param {Set} claimedIds IDs claimed in this run. @param {*} batch Current dispatch batch. @returns {Promise<*>} Dispatch result. */
  async _dispatch(call, claimedIds, batch) {
    return dispatchToolCall(this, call, claimedIds, batch);
  }

  /** Resolve a tool-call ID while accounting for IDs claimed in the batch. @param {string} id Proposed ID. @param {Set} claimedIds Claimed IDs. @param {*} batch Current batch. @returns {string} Resolved ID. */
  _resolveCallId(id, claimedIds, batch) {
    return resolveCallId(this, id, claimedIds, batch);
  }

  /** Check whether a tool-call ID is already used outside the supplied batch. @param {string} callId ID to check. @param {*} batch Current batch. @returns {boolean} Whether the ID is already in use. */
  _callIdSeen(callId, batch) {
    return callIdSeen(this, callId, batch);
  }

  /** Invoke a tool using the configured in-process or forked execution path. @param {string} name Tool name. @param {object} args Tool arguments. @param {object} call Call metadata. @param {*} dispatch Dispatch state. @returns {Promise<*>} Tool result. */
  async _callTool(name, args, call, dispatch) {
    return callToolFor(this, name, args, call, dispatch);
  }

  /** Repair unanswered tool calls in the context before a request. @returns {*} Repair result. */
  _repairToolCalls() {
    return repairToolCalls(this);
  }

  /** Sweep empty messages out of the live context before a request
   *  (lib/agent/tool-repair.js) — an interrupted turn can leave one,
   *  and no provider dialect can carry it. */
  /** Remove empty messages that cannot be represented by provider dialects. @returns {*} Sweep result. */
  _sweepEmptyMessages() {
    return sweepEmptyMessages(this);
  }

  /** Trim whitespace off the latest user message before a request
   *  (lib/agent/trim-user.js) — append()/resume paths can bypass
   *  send()'s trim. */
  /** Trim the latest user message before sending context to a provider. @returns {*} Trim result. */
  _trimLatestUserMessage() {
    return trimLatestUserMessage(this);
  }

  /** Interpret trailing user messages at the pre-IO boundary. @returns {*} Preparation result. */
  _prepareUserMessages() {
    return prepareUserMessages(this);
  }

  /** Execute one tool call; execution failures are represented as outcomes rather than thrown. @param {object} call Tool call. @returns {Promise<*>} Execution outcome. */
  async _execute(call) {
    return executeToolCall(this, call);
  }
}

/** Determine whether a user message is a compact command. @param {object} message Candidate message. @returns {boolean} Whether it is a compact command. */
function isCompactCommand(message) {
  return compactFocus(message) !== null;
}

/** Compare consecutive user messages by serialized content. @param {object} previous Earlier message. @param {object} next Later message. @returns {boolean} Whether both are user messages with equal content. */
function sameConsecutiveUserMessage(previous, next) {
  return previous?.type === 2 && next?.type === 2 &&
    JSON.stringify(previous.content ?? []) === JSON.stringify(next.content ?? []);
}

Object.assign(Agent, {
  Context, Env, IO, Jobs, NAMES,
  finishAdd: onFinish, finishRun: runFinish,
});

// Env knows nothing about Agents: everything it does regarding them —
// the active-Agent registry, agentCreate, capacity, the AGENT_ADDED/
// AGENT_REMOVED membership events — is this plugin, installed after the
// fact (lib/agent/env-plugin.js).
installEnvPlugin(Env, Agent);

export default Agent;
