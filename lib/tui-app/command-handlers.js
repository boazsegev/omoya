/**
 * lib/tui-helpers/command-handlers.js — the slash-command implementations
 * (private to the TUI): each handler validates its arguments, routes
 * every context mutation through the Agent (Context edit semantics,
 * mirrored into the session log), and reports through log(). The
 * router (handle) lives in commands.js.
 */

import Context from "../context.js";
const { ContentType, MessageType, systemMessage } = Context;
import CLI from "../cli.js";
const { loginEndpoint, logoutEndpoint, resolveModelCombo, writeLastCombo, listModelCandidates, resolveToolArgs, unwrapToolResult, formatToolResult } = CLI;
import { THINKING_LEVELS, HELP_LINES } from "./command-data.js";
import { resetCountdown, sortedQuotaEntries } from "./status-data.js";

/**
 * @param {Object} deps - see createCommands in commands.js
 * @returns {Object} the named command handlers + the shared index() helper
 */
export function createHandlers({ agent, log = () => {}, onExit, onMenu, onEditMode, copy, onChanged, onAppended, onReload, onFillInput, onContinue, onReset, onCompact, onLogin, onSwitch, onReseat }) {

  const index = (raw, what = "index") => {
    const i = Number(raw);
    if (!Number.isInteger(i) || i < 0) {
      throw new Error(`${what} must be a non-negative integer, got "${raw}"`);
    }
    return i;
  };

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
    const message = agent.context[i];
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
      agent.editBlock(i, j, { ...block, text });
      log(`edited block ${i}.${j}`);
    } else {
      const text = rest.slice(1).join(" ");
      agent.edit(i, { ...message, content: [{ type: ContentType.Text, text }] });
      log(`edited message ${i}`);
    }
    onChanged?.();
  };

  /** /context-edit with no arguments: MOVE the last message into the input
   * line for editing (popped from the context; resubmit sends it as a
   * new message). */
  const editLast = () => {
    const message = agent.context[agent.context.length - 1];
    if (!message) throw new Error("context is empty — nothing to edit");
    const text = (message.content ?? [])
      .filter((b) => b?.type === ContentType.Text)
      .map((b) => b.text ?? "")
      .join("\n");
    if (text === "") throw new Error("the last message has no text to edit");
    agent.pop();
    onChanged?.();
    onFillInput?.(text);
    log("last message moved into the input for editing");
  };

  const model = async (rest) => {
    if (rest.length === 0) {
      // sensible default: LIST the available models (the same
      // candidates /endpoint-model's autocomplete and the ^X menu offer)
      const current = `${agent.endpoint ? `${agent.endpoint}/` : ""}${agent.model ?? "(none)"}`;
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
    const combo = await resolveModelCombo(rest[0], agent.env, { url: agent.url });
    const endpoint = combo.endpoint ?? agent.endpoint;
    const model = combo.model;
    if (!endpoint || !model) throw new Error("select an endpoint/model pair");
    agent.setModel(`${endpoint}/${model}`);
    // Always read back the live Agent state: selection is an Agent-owned
    // mutation, and the TUI must never claim a requested model succeeded.
    if (agent.endpoint !== endpoint || agent.model !== model) {
      throw new Error(`model selection was not applied: ${endpoint}/${model}`);
    }
    writeLastCombo(agent.env, { endpoint, model });
    log(`endpoint: ${agent.endpoint}, model: ${agent.model}`);
  };

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
    agent.endpoint = result.name;
    const models = agent.env.endpointSettings(result.name).models ?? {};
    agent.model = Object.keys(models).find((id) => models[id]?.secret !== true);
    writeLastCombo(agent.env, { endpoint: agent.endpoint, model: agent.model });
    log(`endpoint saved: ${result.name} (${provider} at ${url}, ${scope})`);
    log(agent.model ? `model: ${agent.endpoint}/${agent.model}` : "endpoint has no known model; use /endpoint-model");
  };

  /** /endpoint-logout <endpoint> — remove an endpoint: its settings.json entry
   * and auth file go, the live Env forgets it (logoutEndpoint), and
   * a combo pointing at it is cleared — the honest end state is "no
   * endpoint/model chosen" (never a dead endpoint that keeps failing).
   * Environment-detected endpoints were never persisted: the removal
   * is in-memory only (they re-detect while the env provides them). */
  const logout = (rest) => {
    if (rest.length !== 1) throw new Error("usage: /endpoint-logout <endpoint>");
    const result = logoutEndpoint(agent.env, rest[0]);
    if (agent.endpoint === result.name) {
      agent.endpoint = undefined;
      agent.model = undefined;
      log(`endpoint removed: ${result.name} — the combo is cleared; pick a model with ^X or /endpoint-model`);
    } else {
      log(`endpoint removed: ${result.name}`);
    }
    if (result.dynamic) log("(environment-defined — nothing was persisted; it re-detects while the environment provides it)");
  };

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
    const removed = agent.rollback(i);
    onChanged?.();
    log(`rolled back ${removed.length} message(s); context now ${agent.context.length}`);
  };

  const pop = (rest) => {
    if (rest.length > 1 || (rest.length === 1 && (!/^\d+$/.test(rest[0]) || Number(rest[0]) < 1))) {
      throw new Error("usage: /context-pop [count]");
    }
    const count = rest.length === 0 ? 1 : Number(rest[0]);
    let removed = 0;
    while (removed < count && agent.pop() !== undefined) removed++;
    if (removed > 0) onChanged?.();
    log(removed === 0
      ? "context already empty"
      : `popped ${removed} message(s); context now ${agent.context.length}`);
  };

  const system = (rawArg) => {
    const text = rawArg.trim();
    if (text === "") throw new Error("usage: /context-system <text...> (a multi-line body is fine)");
    const message = agent.append(systemMessage(text));
    onAppended?.(message);
    log(`system message added; context now ${agent.context.length}`);
  };

  const fork = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-fork [id|false]");
    const result = agent.fork(rest[0]);
    if (result.anonymous) {
      log("forked into an anonymous session (not persisted)");
    } else {
      log(`forked into session: ${result.id} — ${result.file}`);
    }
  };

  const rename = (rest) => {
    if (rest.length !== 1) throw new Error("usage: /session-name <name>");
    const result = agent.renameSession(rest[0]);
    log(`session renamed: ${result.id} — ${result.file}`);
  };

  const newSession = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-new [session-id]");
    if (onReseat) {
      // the TUI's FRESH-AGENT path (lib/agent/reseat.js): the new session
      // starts without the old one's per-agent artifacts (tool stores,
      // consent latches, sticky messages); the view switch does the reset
      const result = onReseat(rest[0]);
      if (result.anonymous) log("new anonymous session (not persisted)");
      else log(`new session: ${result.id} — ${result.file}`);
      return;
    }
    const result = agent.newSession(rest[0]);
    if (onReset) onReset(); else onChanged?.();
    if (result.anonymous) {
      log("new anonymous session (not persisted)");
    } else {
      log(`new session: ${result.id} — ${result.file}`);
    }
  };

  /** /session-resume [id|latest] — switch to an EXISTING session (default: the
   * latest in the folder); the view re-renders from its context. */
  const resume = (rest) => {
    if (rest.length > 1) throw new Error("usage: /session-resume [session-id|latest]");
    let id = rest[0];
    if (id === undefined || id === "latest" || id === "true") {
      id = agent.latestSessionId?.();
      if (!id) throw new Error("no sessions of this folder to resume");
    }
    const result = agent.resumeSession(id);
    // A resumed context replaces the visible session wholesale: reset
    // terminal/scrollback before its redraw, not merely the cached view.
    if (onReset) onReset(); else onChanged?.();
    log(`resumed session: ${result.id} — ${result.file} (${agent.context.length} message${agent.context.length === 1 ? "" : "s"})`);
    if (result.cwd) log(`working folder is now the session's: ${result.cwd}`);
    if (result.originMissing) log(`note: the session's folder (${agent.session.origin}) no longer exists — staying in ${process.cwd()}`);
  };

  const deleteAll = (rest) => {
    if (rest.length !== 0) throw new Error("usage: /session-delete!");
    const n = agent.context.length;
    if (onReseat) {
      // the fresh-agent restart under the SAME id: the old store's close
      // flushed the old content; the fresh (empty) store's flush removes it
      const result = onReseat(agent.session?.id);
      result.flush?.();
      log(`cleared ${n} message(s); session restarted${result.anonymous ? " (anonymous)" : ` (${result.id})`}`);
      return;
    }
    if (n > 0) agent.rollback(0);
    agent.session?.flush?.(); // the file now holds the empty context
    if (onReset) onReset(); else onChanged?.();
    log(`cleared ${n} message(s); session restarted${agent.session ? ` (${agent.session.id})` : " (anonymous)"}`);
  };

  /** /sessions-delete-all! — delete EVERY session file in the sessions
   * namespace sessions folder (outside all projects), after an
   * explicit confirmation through the question bridge (the "!" is the
   * warning, the bridge is the gate). The LIVE session is unaffected
   * (it may re-persist its file on the next flush). */
  const sessionsDeleteAll = async (rest) => {
    if (rest.length !== 0) throw new Error("usage: /session-delete-all!");
    const bridge = typeof agent._question?.ask === "function" ? agent._question.ask : null;
    if (bridge === null) {
      throw new Error("needs the interactive question bridge (the TUI) for the confirmation");
    }
    const { SessionStore } = await import("../agent.js");
    const dir = agent.session?.dir ?? agent._sessionDir; // undefined = the default sessions folder
    const count = SessionStore.list({ dir }).length; // every session, every origin
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
    const { deleted } = SessionStore.deleteAll({ dir });
    log(`deleted ${deleted} session file(s) from the sessions folder`);
  };

  /** /agent-name [name] — show or set the human-friendly Agent name (the ^X menu, web list). */
  const name = (rest) => {
    if (rest.length === 0) {
      log(`agent name: ${agent.name}`);
      return;
    }
    const value = rest.join(" ").trim();
    if (value === "") throw new Error("usage: /agent-name [name]");
    agent.name = value;
    log(`agent name: ${agent.name}`);
  };

  /** /agent-safe [on|off] — runtime safe-mode switch (see Agent.setSafe). */
  const safeMode = (rest) => {
    if (rest.length > 1 || (rest.length === 1 && !["on", "off", "true", "false"].includes(rest[0]))) {
      throw new Error("usage: /agent-safe [on|off]");
    }
    if (rest.length === 0) {
      log(`safe mode: ${agent.safe ? "on (read-only tools only)" : "off"}`);
      return;
    }
    const on = rest[0] === "on" || rest[0] === "true";
    agent.setSafe(on);
    const published = agent.safe ? agent.env.safeToolNames().length : agent.env.toolNames().length;
    log(`safe mode: ${agent.safe ? "on" : "off"} — ${published} tool(s) published from the next request`);
  };

  /** /agent-session-save [true|false] — runtime SessionStore save switch. */
  const sessionSave = (rest) => {
    if (rest.length > 1 || (rest.length === 1 && !["true", "false"].includes(rest[0]))) {
      throw new Error("usage: /agent-session-save [true|false]");
    }
    if (rest.length === 0) {
      log(`session save: ${agent.sessionSave ?? "anonymous (not persisted)"}`);
      return;
    }
    log(`session save: ${agent.sessionSaveSet(rest[0] === "true")}`);
  };

  const thinking = (rest) => {
    if (rest.length === 0) {
      log(`thinking: ${agent.thinking ?? "provider default"} (levels: ${THINKING_LEVELS.join(", ")})`);
      return;
    }
    if (rest.length !== 1 || !THINKING_LEVELS.includes(rest[0])) {
      throw new Error(`usage: /agent-thinking [${THINKING_LEVELS.join("|")}]`);
    }
    agent.setThinking(rest[0] === "default" ? undefined : rest[0]);
    log(`thinking: ${agent.thinking ?? "provider default"}`);
  };

  /** /context-copy — the last assistant response's text to the clipboard. */
  const copyLast = async () => {
    const textOf = (m) =>
      (m?.content ?? []).filter((b) => b?.type === ContentType.Text).map((b) => b.text ?? "").join("\n");
    const last = [...agent.context].reverse()
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
  const clearThoughts = (rest) => {
    if (rest.length !== 0) throw new Error("usage: /context-clear-thoughts");
    let cleared = 0;
    agent.context.forEach((message, i) => {
      if (message?.type !== MessageType.Assistant) return;
      const content = message.content ?? [];
      if (!content.some((b) => b?.type === ContentType.Thinking)) return;
      const kept = content.filter((b) => b?.type !== ContentType.Thinking);
      agent.edit(i, { ...message, content: kept });
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
   * /context-compact — best-practice context compaction: ask the model ITSELF
   * to summarize the conversation so far, then replace the whole
   * context with that summary (system messages survive — they aren't
   * conversation history to compact away). The ALGORITHM is Agent's
   * concern (agent.compact(), lib/agent/compact.js); this just
   * validates and delegates to onCompact (repl.js: the same per-agent
   * turn guard as /continue and a normal submitted turn).
   */
  const compact = async (rest) => {
    if (rest.length !== 0) throw new Error("usage: /context-compact");
    if (agent.context.length === 0) throw new Error("nothing to compact — the context is empty");
    if (!onCompact) {
      log("compact: not available");
      return;
    }
    await onCompact();
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
   * settings.prompts and the namespace prompt path — see Env.defaultPromptRoots),
   * read fresh from disk on every call.
   */
  const promptExpand = (name, data) => {
    if (!name) {
      log(agent.env.promptCatalog().trimEnd());
      return;
    }
    const body = agent.env.promptBody(name);
    if (body === null) {
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
  const runTool = async (name, rawArg) => {
    const entry = agent.env.toolEntry(name);
    let args;
    try {
      args = resolveToolArgs(rawArg, { name, schema: entry.schema });
    } catch (err) {
      log(`tool ${name}: ${err.message}`);
      return;
    }
    let value;
    try {
      value = await agent.env.callTool(name, args, { question: null, env: agent.env, call: undefined, agent });
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
  const status = () => {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const m of agent.context) {
      if (m?.type in counts) counts[m.type]++;
    }
    const combo = `${agent.endpoint ? `${agent.endpoint}/` : ""}${agent.model ?? "(none)"}`;
    log(`status: ${combo} (thinking: ${agent.thinking ?? "provider default"})`);
    log(`session: ${agent.session ? `${agent.session.id} — ${agent.session.file}` : "anonymous (not persisted)"}`);
    log(`context: ${agent.context.length} message(s) — ` +
      `${counts[1]} system, ${counts[2]} user, ${counts[3]} assistant, ${counts[4]} tool result(s)`);
    const names = agent.env.toolNames();
    log(`tools (${names.length}):`);
    for (const name of names) {
      const entry = agent.env.toolEntry(name);
      let desc = (entry?.schema?.description ?? "").replace(/\s+/g, " ").trim();
      if (desc.length > 120) desc = `${desc.slice(0, 119)}…`;
      const live = entry?.status ? ` status: ${JSON.stringify(entry.status)}` : "";
      log(`  ${name}${desc ? ` — ${desc}` : ""}${live}`);
    }
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
      const connected = agent.env.toolEntry("mcp")?.status?.connected ?? [];
      log(`MCP servers (${mcpNames.length}):`);
      for (const name of mcpNames) {
        const command = mcpServers[name]?.command ?? "?";
        log(`  ${name} — ${command}${connected.includes(name) ? " (connected)" : ""}`);
      }
    }
  };

  return {
    index, edit, editLast, model, login, logout, rollback, pop, system, fork, rename,
    newSession, resume, deleteAll, sessionsDeleteAll, name, safeMode, sessionSave, thinking, copyLast, clearThoughts,
    compact, promptExpand, status, runTool,
  };
}
