/**
 * lib/tui-helpers/command-handlers.js — the slash-command implementations
 * (private to the TUI): each handler validates its arguments, routes
 * every context mutation through the Agent (Context edit semantics,
 * mirrored into the session log), and reports through log(). The
 * router (handle) lives in commands.js.
 */

import Context from "../../context.js";
const { ContentType, MessageType, messageSystem } = Context;
import CLI from "../../cli.js";
import Agent from "../../agent.js";
const { loginEndpoint, logoutEndpoint, resolveModelCombo, listModelCandidates, listEndpointModels, resolveToolArgs, unwrapToolResult, formatToolResult } = CLI;
import { THINKING_LEVELS, HELP_LINES } from "./command-data.js";
import { modelParts, resetCountdown, sortedQuotaEntries } from "../shared/format.js";

/**
 * Build slash-command handlers bound to an Agent and optional UI callbacks.
 * @param {Object} options - Handler dependencies.
 * @param {Agent} options.agent - Agent whose context and environment handlers operate on.
 * @param {Function} [options.log=()=>{}] - Output logger.
 * @param {Function} [options.onExit] - Exit callback (accepted for command wiring).
 * @param {Function} [options.onMenu] - Menu callback (accepted for command wiring).
 * @param {Function} [options.onEditMode] - Interactive context-edit callback.
 * @param {Function} options.copy - Clipboard copy callback.
 * @param {Function} [options.onChanged] - Context/view change notification.
 * @param {Function} [options.onAppended] - Appended-message notification.
 * @param {Function} [options.onReload] - Reload callback (accepted for command wiring).
 * @param {Function} [options.onFillInput] - Callback to populate input text.
 * @param {Function} [options.onContinue] - Continue callback (accepted for command wiring).
 * @param {Function} [options.onReset] - View reset callback.
 * @param {Function} [options.onCompact] - Context compaction callback.
 * @param {Function} [options.onLogin] - Login wizard callback.
 * @param {Function} [options.onSwitch] - Switch callback (accepted for command wiring).
 * @param {Function} [options.onReseat] - Callback to reseat the Agent/session.
 * @returns {Object} Named command handlers and shared index helper.
 */
export function createHandlers({ agent, log = () => {}, onExit, onMenu, onEditMode, copy, onChanged, onAppended, onReload, onFillInput, onContinue, onReset, onCompact, onLogin, onSwitch, onReseat }) {

  /**
   * Parse a non-negative integer index.
   * @param {string|number} raw - Value to parse.
   * @param {string} [what="index"] - Label used in validation errors.
   * @returns {number} Parsed integer.
   * @throws {Error} If the value is not a non-negative integer.
   */
  const index = (raw, what = "index") => {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0) {
      throw new Error(`${what} must be a non-negative integer, got "${raw}"`);
    }
    return i;
  };

  /**
   * Edit a context message or content block, or enter interactive/last-message editing.
   * @param {string[]} rest - Command arguments.
   * @returns {void|*>} Interactive edit callback result when invoked.
   * @throws {Error} For invalid indices, arguments, or non-editable content blocks.
   * @effects Mutates context and notifies/logs edits; may fill the input via callbacks.
   */
  const edit = (rest) => {
    // Bare /context-edit or /context-edit <i>: the interactive edit mode when the TUI
    // wired it (any message, ↑/↓ between messages, ^C cancels); the
    // non-TTY fallback moves the last message into the input line.
    if (rest.length === 0 || (rest.length === 1 && /^\d+$/.test(rest[0]))) {
      if (onEditMode) {
        return onEditMode(rest.length === 0 ? agent.context.length - 1 : index(rest[0]));
      }
      if (rest.length === 0) return editLast();
    }
    if (rest.length < 2) throw new Error("usage: /context-edit [<i> [j] <text...>] (no arguments edits the last message)");
    const i = index(rest[0]);
    const message = agent.context.at(i);
    if (!message) throw new Error(`no message at index ${i}`);

    const blockForm = rest.length >= 3 && /^\d+$/.test(rest[1]);
    if (blockForm) {
      const j = index(rest[1], "block index");
      const block = message.content[j];
      if (!block) throw new Error(`no block at index ${j} in message ${i}`);
      if (block.type !== ContentType.Text && block.type !== ContentType.Thinking) {
        throw new Error(`block ${i}.${j} is ${block.type}; only text/thinking blocks edit`);
      }
      const text = rest.slice(2).join(" ");
      agent.context.editBlock(i, j, { ...block, text });
      log(`edited block ${i}.${j}`);
    } else {
      const text = rest.slice(1).join(" ");
      agent.context.edit(i, { ...message, content: [{ type: ContentType.Text, text }] });
      log(`edited message ${i}`);
    }
    onChanged?.();
  };

  /**
   * Move the last message's text into the input for editing. It is popped from
   * context; resubmitting sends it as a new message.
   * @returns {void}
   * @throws {Error} If context is empty or the last message contains no text.
   * @effects Pops the last context message, notifies change, fills input, and logs.
   */
  const editLast = () => {
    const message = agent.context.at(-1);
    if (!message) throw new Error("context is empty — nothing to edit");
    const text = (message.content ?? [])
      .filter((b) => b?.type === ContentType.Text)
      .map((b) => b.text ?? "")
      .join("\n");
    if (text === "") throw new Error("the last message has no text to edit");
    agent.context.pop();
    onChanged?.();
    onFillInput?.(text);
    log("last message moved into the input for editing");
  };

  /**
   * List model candidates or select an endpoint/model combination.
   * @param {string[]} rest - Empty to list; otherwise one model or endpoint argument.
   * @returns {Promise<void>}
   * @throws {Error} For invalid arguments, resolution failures, or unapplied selection.
   * @effects Logs candidates/selection and may change the Agent model.
   */
  const model = async (rest) => {
    if (rest.length === 0) {
      // sensible default: LIST the available models (the same
      // candidates /endpoint-model's autocomplete and the ^X menu offer)
      const current = agent.model ?? "(none)";
      const candidates = listModelCandidates(agent.env).sort();
      log(`model: ${current}`);
      if (candidates.length === 0) {
        log("available: (no known models)");
      } else {
        log(`available (${candidates.length}):`);
        for (const c of candidates) log(`  ${c}${c === current ? "  ← current" : ""}`);
      }
      return;
    }
    if (rest.length !== 1) throw new Error("usage: /endpoint-model [<endpoint>/]<model> | <endpoint>");
    const resolved = await resolveModelCombo(rest[0], agent.env);
    const endpoint = modelParts(agent.model).endpoint;
    const isBareModel = !rest[0].includes("/") && !listEndpointModels(agent.env).some(({ name }) => name === rest[0]);
    const combo = resolved ?? (isBareModel && endpoint ? `${endpoint}/${rest[0]}` : undefined);
    if (!combo || !modelParts(combo).model) throw new Error("select an endpoint/model pair");
    (agent.model = combo);
    // Always read back the live Agent state: selection is an Agent-owned
    // mutation, and the TUI must never claim a requested model succeeded.
    if (agent.model !== combo) throw new Error(`model selection was not applied: ${combo}`);
    const selected = modelParts(agent.model);
    log(`endpoint: ${selected.endpoint}, model: ${selected.model}`);
  };

  /**
   * Run login wizard or register an endpoint from arguments.
   * @param {string[]} rest - Empty for wizard; otherwise scope, name, provider, URL, optional token.
   * @returns {Promise<void>}
   * @throws {Error} If wizard unavailable, arguments invalid, or endpoint login fails.
   * @effects Updates Env endpoint/auth state, may select first model, and logs outcome.
   */
  const mcpLogin = (name) => {
    log(`MCP sign-in starting for ${name}; the browser opens. Paste a full callback with /mcp-oauth-paste if needed.`);
    void agent.env.mcpLogin(name, { onAuthUrl: (url) => log(`authorize: ${url}`), onLog: log })
      .then(() => log(`MCP signed in: ${name}`))
      .catch((error) => log(`MCP sign-in failed: ${error.message}`));
  };
  const mcpPaste = (input) => agent.env.mcpPaste(input);
  const login = async (rest) => {
    if (rest.length === 0) {
      if (!onLogin) throw new Error("login wizard is unavailable");
      await onLogin();
      return;
    }
    if (rest.length < 4 || rest.length > 5) {
      throw new Error("usage: /endpoint-login <package|local> <endpoint> <provider> <url> [token]");
    }
    const [scope, name, provider, url, token] = rest;
    const result = await loginEndpoint(agent.env, { scope, name, provider, url, token });
    const first = listEndpointModels(agent.env).find(({ name: endpoint }) => endpoint === result.name)?.models[0];
    if (first) (agent.model = `${result.name}/${first}`);
    log(`endpoint saved: ${result.name} (${provider} at ${url}, ${scope})`);
    log(first ? `model: ${agent.model}` : "endpoint has no known model; use /endpoint-model");
  };

  /** /endpoint-logout <endpoint> — remove an endpoint: its settings.json entry
   * and auth file go, the live Env forgets it (logoutEndpoint), and
   * a combo pointing at it is cleared — the honest end state is "no
   * endpoint/model chosen" (never a dead endpoint that keeps failing).
   * Environment-detected endpoints were never persisted: the removal
   * is in-memory only (they re-detect while the env provides them).
   * @param {string[]} rest - Exactly one endpoint name.
   * @returns {void}
   * @throws {Error} If argument count is wrong or endpoint removal fails.
   * @effects Removes endpoint from Env/config/auth state, clears matching live selection, and logs.
   */
  const logout = (rest) => {
    if (rest.length !== 1) throw new Error("usage: /endpoint-logout <endpoint>");
    const result = logoutEndpoint(agent.env, rest[0]);
    if (modelParts(agent.model).endpoint === result.name) {
      (agent.model = undefined);
      log(`endpoint removed: ${result.name} — the combo is cleared; pick a model with ^X or /endpoint-model`);
    } else {
      log(`endpoint removed: ${result.name}`);
    }
    if (result.dynamic) log("(environment-defined — nothing was persisted; it re-detects while the environment provides it)");
  };

  /**
   * Roll back context starting at a message index.
   * @param {string[]} rest - Exactly one non-negative message index.
   * @returns {void}
   * @throws {Error} For invalid usage, empty context, or out-of-range index.
   * @effects Removes context messages, notifies change, and logs.
   */
  const rollback = (rest) => {
    if (rest.length !== 1) throw new Error("usage: /context-rollback <i>");
    const i = index(rest[0]);
    const n = agent.context.length;
    if (n === 0) throw new Error("context already empty");
    if (i >= n) {
      throw new Error(
        `no message at index ${i} (indexes 0..${n - 1}; /context-rollback 0 clears all, /session-delete! restarts the session)`,
      );
    }
    const removed = agent.context.rollback(i);
    onChanged?.();
    log(`rolled back ${removed.length} message(s); context now ${agent.context.length}`);
  };

  /**
   * Pop a requested number of trailing context messages.
   * @param {string[]} rest - Empty for one message, or one positive integer count.
   * @returns {void}
   * @throws {Error} For invalid count/arguments.
   * @effects Removes available messages, notifies on mutation, and logs.
   */
  const pop = (rest) => {
    if (rest.length > 1 || (rest.length === 1 && (!/^\d+$/.test(rest[0]) || Number(rest[0]) < 1))) {
      throw new Error("usage: /context-pop [count]");
    }
    const count = rest.length === 0 ? 1 : Number(rest[0]);
    let removed = 0;
    while (removed < count && agent.context.pop() !== undefined) removed++;
    if (removed > 0) onChanged?.();
    log(removed === 0
      ? "context already empty"
      : `popped ${removed} message(s); context now ${agent.context.length}`);
  };

  /**
   * Append a system message to context.
   * @param {string} rawArg - Message text.
   * @returns {void}
   * @throws {Error} If trimmed text is empty.
   * @effects Appends context message, notifies append callback, and logs.
   */
  const system = (rawArg) => {
    const text = rawArg.trim();
    if (text === "") throw new Error("usage: /context-system <text...> (a multi-line body is fine)");
    const message = agent.context.append(messageSystem(text));
    onAppended?.(message);
    log(`system message added; context now ${agent.context.length}`);
  };

  /**
   * Fork the current session, optionally specifying an identifier or false.
   * @param {string[]} rest - Zero or one fork identifier/false value.
   * @returns {void}
   * @throws {Error} If more than one argument is supplied.
   * @effects Changes session context and logs its summary.
   */
  const fork = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-fork [id|false]");
    agent.contextFork(rest[0]);
    log(`forked into session: ${agent.context.summary}`);
  };

  /**
   * Rename the current session.
   * @param {string[]} rest - Exactly one session name.
   * @returns {void}
   * @throws {Error} If argument count is not one.
   * @effects Renames context session and logs summary.
   */
  const rename = (rest) => {
    if (rest.length !== 1) throw new Error("usage: /session-name <name>");
    agent.context.rename(rest[0]);
    log(`session renamed: ${agent.context.summary}`);
  };

  /**
   * Start a new session, using reseat callback when available.
   * @param {string[]} rest - Zero or one session identifier.
   * @returns {void}
   * @throws {Error} If more than one argument is supplied.
   * @effects Replaces/reseats session and resets or notifies the view; logs result.
   */
  const newSession = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-new [session-id]");
    if (onReseat) {
      // the TUI's FRESH-AGENT path (lib/agent/reseat.js): the new session
      // starts without the old one's per-agent artifacts (tool stores,
      // consent latches, sticky messages); the view switch does the reset
      log(`new session: ${onReseat(rest[0]).summary}`);
      return;
    }
    agent.contextNew(rest[0]);
    if (onReset) onReset(); else onChanged?.();
    log(`new session: ${agent.context.summary}`);
  };

  /**
   * /session-resume [id|latest] — switch to an existing session (default: latest
   * in the folder); the view re-renders from its context.
   * @param {string[]} rest - Empty/latest/true to select latest, or one session ID.
   * @returns {void}
   * @throws {Error} For invalid arguments, no matching latest session, or resume failures.
   * @effects Replaces current context, resets/notifies view, and logs session details.
   */
  const resume = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-resume [session-id|latest]");
    let id = rest[0];
    if (id === undefined || id === "latest" || id === "true") {
      id = Context.latest({ dir: agent.env.settings.sessions, cwd: agent.env.cwd });
      if (!id) throw new Error("no sessions of this folder to resume");
    }
    const result = agent.contextResume(id);
    // A resumed context replaces the visible session wholesale: reset
    // terminal/scrollback before its redraw, not merely the cached view.
    if (onReset) onReset(); else onChanged?.();
    log(`resumed session: ${result.id} — ${result.file} (${agent.context.length} message${agent.context.length === 1 ? "" : "s"})`);
  };

  /**
   * Clear and restart the current session under its existing identifier.
   * @param {string[]} rest - Must be empty.
   * @returns {void}
   * @throws {Error} If arguments are supplied.
   * @effects Clears/flushed context or reseats and flushes a fresh store; resets view and logs.
   */
  const deleteAll = (rest) => {
    if (rest.length !== 0) throw new Error("usage: /session-delete!");
    const n = agent.context.length;
    if (onReseat) {
      // the fresh-agent restart under the SAME id: the old store's close
      // flushed the old content; the fresh (empty) store's flush removes it
      // the SAME id; reseat carries the logging setting over
      const store = onReseat(agent.context.id);
      store.flush();
      log(`cleared ${n} message(s); session restarted (${store.summary})`);
      return;
    }
    if (n > 0) agent.context.rollback(0);
    agent.context.flush(); // the file now holds the empty context
    if (onReset) onReset(); else onChanged?.();
    log(`cleared ${n} message(s); session restarted (${agent.context.summary})`);
  };

  /** /sessions-delete-all! — delete EVERY session file in the sessions
   * namespace sessions folder (outside all projects), after an
   * explicit confirmation through the question bridge (the "!" is the
   * warning, the bridge is the gate). The LIVE session is unaffected
   * (it may re-persist its file on the next flush).
   * @param {string[]} rest - Must be empty.
   * @returns {Promise<void>}
   * @throws {Error} If arguments are supplied, confirmation bridge is unavailable, or listing/deletion fails.
   * @effects May delete all stored session files after explicit bridge confirmation; logs outcome.
   */
  const sessionsDeleteAll = async (rest) => {
    if (rest.length !== 0) throw new Error("usage: /session-delete-all!");
    const bridge = typeof agent.question?.ask === "function" ? agent.question.ask : null;
    if (bridge === null) {
      throw new Error("needs the interactive question bridge (the TUI) for the confirmation");
    }
    const { Context } = await import("../../context.js");
    const dir = agent.env.settings.sessions;
    const count = Context.list({ dir }).length; // every session, every origin
    if (count === 0) {
      log("no session files in the sessions folder");
      return;
    }
    const answers = await bridge([{
      question:
        `Delete ALL ${count} session file(s) in the sessions folder — every ` +
        "project's, permanently? The live session is unaffected (it may " +
        "re-persist on its next flush).",
      header: "Sessions",
      options: [
        { label: "Cancel", description: "Keep every session file." },
        { label: "Delete all", description: `Permanently delete the ${count} session file(s).` },
      ],
    }]);
    if (!Array.isArray(answers) || !answers[0]?.labels?.includes("Delete all")) {
      log("cancelled — no session files deleted");
      return;
    }
    const { deleted } = Context.deleteAll({ dir });
    log(`deleted ${deleted} session file(s) from the sessions folder`);
  };

  /**
   * Show or set the Agent's display name in surfaces such as the ^X menu and web list.
   * @param {string[]} rest - Empty to show; otherwise words forming the name.
   * @returns {void}
   * @throws {Error} If a supplied name is empty after trimming.
   * @effects May update Agent name and logs it.
   */
  const name = (rest) => {
    if (rest.length === 0) {
      log(`agent name: ${agent.name}`);
      return;
    }
    const value = rest.join(" ").trim();
    if (value === "") throw new Error("usage: /agent-name [name]");
    (agent.name = value);
    log(`agent name: ${agent.name}`);
  };

  /**
   * Show or change runtime safe mode (see Agent.safe).
   * @param {string[]} rest - Empty to show, or one of on/off/true/false.
   * @returns {Promise<void>}
   * @throws {Error} For invalid arguments; tool catalog lookup failures propagate.
   * @effects May change Agent safe mode and logs published tool count.
   */
  const safeMode = async (rest) => {
    if (rest.length > 1 || (rest.length === 1 && !["on", "off", "true", "false"].includes(rest[0]))) {
      throw new Error("usage: /agent-safe [on|off]");
    }
    if (rest.length === 0) {
      log(`safe mode: ${agent.safe ? "on (read-only tools only)" : "off"}`);
      return;
    }
    const on = rest[0] === "on" || rest[0] === "true";
    (agent.safe = on);
    const published = (await agent.env.tools(agent.safe)).size;
    log(`safe mode: ${agent.safe ? "on" : "off"} — ${published} tool(s) published from the next request`);
  };

  /**
   * Show or set whether the current session is saved.
   * @param {string[]} rest - Empty to show, or one boolean string.
   * @returns {void}
   * @throws {Error} For invalid arguments.
   * @effects May update context save setting and logs state.
   */
  const sessionSave = (rest) => {
    if (rest.length > 1 || (rest.length === 1 && !["true", "false"].includes(rest[0]))) {
      throw new Error("usage: /agent-session-save [true|false]");
    }
    if (rest.length === 0) {
      log(`session save: ${agent.context.save}`);
      return;
    }
    log(`session save: ${(agent.context.save = rest[0] === "true")}`);
  };

  /**
   * Show or set the Agent thinking level.
   * @param {string[]} rest - Empty to show, or one supported level (including default).
   * @returns {void}
   * @throws {Error} If the supplied level is unsupported.
   * @effects May update Agent thinking setting and logs state.
   */
  const thinking = (rest) => {
    if (rest.length === 0) {
      log(`thinking: ${agent.thinking ?? "provider default"} (levels: ${THINKING_LEVELS.join(", ")})`);
      return;
    }
    if (rest.length !== 1 || !THINKING_LEVELS.includes(rest[0])) {
      throw new Error(`usage: /agent-thinking [${THINKING_LEVELS.join("|")}]`);
    }
    (agent.thinking = rest[0] === "default" ? undefined : rest[0]);
    log(`thinking: ${agent.thinking ?? "provider default"}`);
  };

  /**
   * Copy the latest non-empty assistant response text.
   * @returns {Promise<void>}
   * @throws {Error} If no assistant response with text exists; clipboard errors propagate.
   * @effects Calls clipboard callback and logs success/unavailability.
   */
  const copyLast = async () => {
    const textOf = (m) =>
      (m?.content ?? []).filter((b) => b?.type === ContentType.Text).map((b) => b.text ?? "").join("\n");
    const last = agent.context.messages().reverse()
      .find((m) => m?.type === MessageType.Assistant && textOf(m).trim() !== "");
    if (!last) throw new Error("no assistant response to copy");
    const text = textOf(last);
    const ok = await copy(text);
    log(ok
      ? `copied the last response (${text.length} chars) to the clipboard`
      : "clipboard unavailable (no OSC 52 terminal sink / pbcopy / wl-copy / xclip)");
  };

  /**
   * /context-clear-thoughts — strip every THINKING block from every assistant
   * message, in place (rebuilt via agent.edit — stale provider/cache
   * identifiers on the touched messages drop, same as /context-edit). Frees
   * space with no model call, unlike /context-compact: an assistant message
   * that becomes contentless (thinking was its only block) is left as
   * an empty-content message rather than removed outright — never
   * renumbers surrounding messages a session log may reference by index.
   */
  /**
   * Remove thinking blocks from all assistant messages.
   * @param {string[]} rest - Must be empty.
   * @returns {void}
   * @throws {Error} If arguments are supplied.
   * @effects Edits context messages, notifies change when modified, and logs result.
   */
  const clearThoughts = (rest) => {
    if (rest.length !== 0) throw new Error("usage: /context-clear-thoughts");
    let cleared = 0;
    agent.context.messages().forEach((message, i) => {
      if (message?.type !== MessageType.Assistant) return;
      const content = message.content ?? [];
      if (!content.some((b) => b?.type === ContentType.Thinking)) return;
      const kept = content.filter((b) => b?.type !== ContentType.Thinking);
      agent.context.edit(i, { ...message, content: kept });
      cleared++;
    });
    if (cleared === 0) {
      log("no thinking blocks in the context");
      return;
    }
    onChanged?.();
    log(`cleared thinking blocks from ${cleared} message(s)`);
  };

  /**
   * /compact (/context-compact alias) — ask the model ITSELF
   * to summarize the conversation so far, then replace the whole
   * context with that summary (system messages survive — they aren't
   * conversation history to compact away). The ALGORITHM is Agent's
   * concern (agent.compact(), lib/agent/compact.js); this just
   * validates and delegates to onCompact (repl.js: the same per-agent
   * turn guard as /continue and a normal submitted turn).
   */
  /**
   * Delegate conversation compaction to the configured callback.
   * @param {*} focus - Optional focus passed through unchanged to compaction.
   * @returns {Promise<void>}
   * @throws {Error} If context is empty or the callback rejects.
   * @effects Calls onCompact when available; otherwise logs unavailability.
   */
  const compact = async (focus) => {
    if (agent.context.length === 0) throw new Error("nothing to compact — the context is empty");
    if (!onCompact) {
      log("compact: not available");
      return;
    }
    await onCompact(focus);
  };

  /**
   * /<name> [data...] — load a custom prompt into the input area (never
   * auto-submitted — same spirit as /context-edit: land it where it can
   * still be reviewed/edited before Enter). `/` alone lists the
   * catalog; `//<name>` is the explicit form that never resolves as a
   * command. `data` is whatever raw text (single- or multi-line)
   * followed the name on the submitted line/buffer; appended as its
   * own trailing line, not interpolated. Prompts come from Env's
   * own accumulated roots (this package's `prompts/`,
   * settings.prompts and the namespace prompt path — env.prompts()),
   * read fresh from disk on every call.
   */
  /**
   * List prompts or load a named prompt into the input area.
   * @param {string} name - Prompt name; empty/falsy lists the catalog.
   * @param {string} data - Optional trailing text appended on its own line.
   * @returns {void}
   * @effects Reads current Env prompt catalog; fills input or logs output/status.
   */
  const promptExpand = (name, data) => {
    if (!name) {
      log(Agent.promptCatalog(agent.env.prompts()).trimEnd());
      return;
    }
    const body = agent.env.prompts().get(name)?.body;
    if (body === undefined) {
      log(`unknown prompt: ${name}`);
      return;
    }
    const text = data ? `${body}\n${data}` : body;
    if (onFillInput) onFillInput(text);
    else log(text); // no input area to fill (non-TTY): print it instead
  };

  /**
   * /<tool> [json-args] — run any REGISTERED tool directly, close to
   * the "manual door" bin/scripts/tool is (lib/cli/tool-run.js: one JSON
   * object, or a bare value shorthanded into the tool's first schema
   * property) — but WITH the viewed agent as the calling one (unlike
   * bin/scripts/tool, which has none to give): an interactive tool that
   * anchors on its caller works the same way it would mid-turn. Still no
   * question bridge and no `call` linkage (nothing is answering a
   * live tool call here) — the human is operating the tool directly,
   * not the model. A `secret: true` tool (invisible to the model's
   * published catalog) is reachable here exactly like any other —
   * secrecy is from the model, never from the user.
   */
  /**
   * Run a registered tool directly with the viewed Agent as caller.
   * @param {string} name - Registered tool name.
   * @param {string} rawArg - Raw arguments parsed against the tool schema.
   * @returns {Promise<void>}
   * @effects Calls Env tool API and logs result/system/display output; parse and call errors are logged and swallowed.
   */
  const runTool = async (name, rawArg) => {
    const entry = (await agent.env.tools()).get(name);
    let args;
    try {
      args = resolveToolArgs(rawArg, { name, schema: entry.schema });
    } catch (err) {
      log(`tool ${name}: ${err.message}`);
      return;
    }
    let value;
    try {
      value = await agent.env.toolCall(name, args, { question: null, env: agent.env, call: undefined, agent });
    } catch (err) {
      log(`tool ${name} failed: ${err.message}`);
      return;
    }
    const { result, system, display } = unwrapToolResult(value);
    log(formatToolResult(result));
    for (const text of system) log(`[system] ${text}`);
    for (const text of display) log(`[display] ${text}`);
  };

  /** /agent-status — context details, available tools (+ live tool status), MCP. */
  /**
   * Log current Agent/session/context, tools, quota usage, and MCP status.
   * @returns {Promise<void>}
   * @throws {Error} If tool catalog retrieval fails.
   * @effects Reads live Env/Agent state and emits status through log.
   */
  const status = async () => {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const m of agent.context) {
      if (m?.type in counts) counts[m.type]++;
    }
    const combo = agent.model ?? "(none)";
    log(`status: ${combo} (thinking: ${agent.thinking ?? "provider default"})`);
    log(`session: ${agent.context.summary}`);
    log(`context: ${agent.context.length} message(s) — ` +
      `${counts[1]} system, ${counts[2]} user, ${counts[3]} assistant, ${counts[4]} tool result(s)`);
    const catalog = await agent.env.tools();
    log(`tools (${catalog.size}):`);
    for (const [name, entry] of catalog) {
      let desc = (entry?.schema?.description ?? "").replace(/\s+/g, " ").trim();
      if (desc.length > 120) desc = `${desc.slice(0, 119)}…`;
      const live = entry?.status ? ` status: ${JSON.stringify(entry.status)}` : "";
      log(`  ${name}${desc ? ` — ${desc}` : ""}${live}`);
    }
    for (const proc of agent.backgroundList().filter((item) => item.state === "running")) log(`process ${proc.id}: ${proc.command} (${proc.uptime}ms, ${proc.bytes} bytes)`);
    // the provider-reported plan/quota map (in-memory, last known)
    const plan = agent.planUsage;
    if (plan?.quotas && Object.keys(plan.quotas).length > 0) {
      log(`plan usage${plan.label ? ` (${plan.label})` : ""}:`); // most important quota first (soonest reset, else smallest window)
      for (const [name, quota] of sortedQuotaEntries(plan.quotas)) {
        const parts = [];
        if (Number.isFinite(quota.used)) parts.push(`used=${quota.used}`);
        if (Number.isFinite(quota.remaining)) parts.push(`remaining=${quota.remaining}`);
        if (Number.isFinite(quota.total)) parts.push(`total=${quota.total}`);
        if (typeof quota.unit === "string" && quota.unit !== "") parts.push(`unit=${quota.unit}`);
        if (Number.isFinite(quota.windowSeconds)) parts.push(`window=${quota.windowSeconds}s`);
        if (quota.reset !== undefined) parts.push(`reset=${quota.reset}${resetCountdown(quota.reset) ? ` (${resetCountdown(quota.reset)})` : ""}`);
        log(`  ${name}: ${parts.join(" · ")}`);
      }
    }
    // the configured MCP servers + the mcp tool's live pool state
    const mcpServers = agent.env.settings?.mcp;
    const mcpNames = mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)
      ? Object.keys(mcpServers)
      : [];
    if (mcpNames.length === 0) {
      log("MCP servers: none configured (settings.mcp)");
    } else {
      const connected = catalog.get("mcp")?.status?.connected ?? [];
      log(`MCP servers (${mcpNames.length}):`);
      for (const name of mcpNames) {
        const target = mcpServers[name]?.url ?? mcpServers[name]?.command ?? "?";
        log(`  ${name} — ${target}${connected.includes(name) ? " (connected)" : ""}`);
      }
    }
  };

  return {
    index, edit, editLast, model, login, mcpLogin, mcpPaste, logout, rollback, pop, system, fork, rename,
    newSession, resume, deleteAll, sessionsDeleteAll, name, safeMode, sessionSave, thinking, copyLast, clearThoughts,
    compact, promptExpand, status, runTool,
  };
}
