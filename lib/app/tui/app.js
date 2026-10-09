/**
 * lib/tui-app/app.js — the ai application on GTUI: a plain
 * {init, update, view, bindings} app (see lib/gtui/gtui.js's `run`
 * contract). Owns the agent-turn/question lifecycle
 * (createAgentAdapter), the transcript (contextBlocks -> GTUI feed
 * items, transcript.js), the draft input + status bar, and overlays
 * as model sub-states: the ^X/^P/^M menus and ^O block viewer
 * (overlay-controller.js), the questionnaire's real menu+input UI
 * (questionnaire-view.js), and session switching (agent-slot.js).
 * Slash commands (typed or menu-triggered) run through the SAME
 * already-tested router (commands.js) legacy used. Dispatched by
 * lib/tui.js through run.js in both inline and alternate-screen modes.
 */

import { effect } from "../gtui/gtui.js";
import { createLiveState } from "./live-state.js";
import { createKeyHandler } from "./app-keys.js";
import { createUpdateCore, initialModel, appendNotice, noticeExpiryEffect } from "./app-events.js";
import { createAppView } from "./app-view.js";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { conversationCreate, conversationActivate } from "../host/conversation.js";
import { runOAuthFlow, tokensToAuth } from "../host/oauth.js";
import { listEndpointModels } from "../shared/catalog.js";
import { endpointPolicySet } from "../shared/endpoint-policy.js";
import { createAgentAdapter, msg } from "./agent-adapter.js";
import { createAgentSlot } from "./agent-slot.js";
import { createCommands } from "./commands.js";
import { NAMES } from "../../namespace.js";
import Env from "../../env.js";
import IO from "../../io.js";
import { historyFromContext, initialInput, clearInput, insertText } from "./input-controller.js";
import { appBindings, resolveKeymap } from "./bindings.js";
import { openMenu, openViewer, pushMenu, popMenu, refreshMenus } from "./overlay-controller.js";
import { resolveMenuAction } from "./menu-actions.js";
import { masterMenuOptions, endpointMenuOptions } from "./menu-sources.js";
import { buildEndpointItems } from "./contracts.js";
import { resolveTheme, themePreviewRows } from "./theme-data.js";
import { createCompletionSources } from "./completion-sources.js";
import { hasAttachment } from "./attachment-draft.js";
import Agent from "../../agent.js";
import { createWorkspace } from "./workspace.js";
import { buildAccessRoot, buildActionSearch } from "./access-menu.js";
import { createAccessController } from "./access-controller.js";
import { unwrapToolResult, formatToolResult } from "../shared/tool-run.js";

/**
 * @param {object} agent - the Agent this app starts on ("main")
 * @param {object} [options]
 * @param {object} [options.env=agent.env] - Env, for status/menu facts
 * @param {string} [options.cwd] - the process working folder
 * @param {object} [options.sources] - lib/tui-app/completion.js sources
 * @param {object} [options.completionIO] - completion filesystem hooks
 *   ({listDir}); defaults to real directory reads resolved under cwd
 * @param {(url: string) => void} [options.open] - browser opener handed to
 *   the OAuth flow; undefined uses the flow's system-browser default
 * @param {(line: string) => void} [options.log] - an external diagnostics
 *   mirror (piped `--input` runs: stdout IS the terminal byte stream,
 *   not human-parseable, so the caller may want every notice ALSO
 *   written somewhere plain — parity with the legacy engines' `log` option)
 * @returns {{init: Function, update: Function, view: Function, bindings: Function, currentAgent: Function, closeWorkspace: Function, dispose: Function, abandonPending: Function, theme: object}} App lifecycle and presentation. Call dispose to detach UI bridges, then await closeWorkspace to release App-created agents and acquired project Envs; borrowed unrelated resources remain open.
 */
export function createApp(agent, { env = agent?.env, cwd = "", sources, completionIO, log, open, columns, rows } = {}) {
  const launchEnv = env;
  env = agent?.env ?? launchEnv;
  const getEnv = () => env;
  const drafts = new WeakMap();
  const questions = new WeakMap();
  let modelAgent = agent;
  const observedAgents = new WeakSet([agent]);
  const terminalWidth = () => typeof columns === "function" ? columns() : (columns ?? 80);
  const terminalHeight = () => typeof rows === "function" ? rows() : (rows ?? 24);
  const slot = createAgentSlot(agent);
  const viewed = slot.agent; // every read/call forwards to the CURRENT agent — a switch needs no other change
  const completionSources = sources ?? createCompletionSources(viewed, env, { getEnv });
  const listDir = completionIO?.listDir ?? (async (dir, options) => readdir(resolve(options.cwd || ".", dir), { withFileTypes: true }));
  const workspace = agent instanceof Agent ? createWorkspace(agent, { env }) : null;
  let savedSessions = [];
  let sessionsLoading = false;
  let menuSnapshot = null;
  const invalidateMenus = () => { menuSnapshot = null; };
  const offSwitch = slot.onSwitch((next) => { env = next.env ?? launchEnv; workspace?.remember(next); invalidateMenus(); });
  /** Every notice that reaches the transcript ALSO reaches the external
   *  diagnostics mirror, when the caller gave one — the one place both
   *  command output (createCommands' own log hook, below) and turn
   *  errors (noticeFor()) funnel through.
   * @param {object} model - the app model; its notice stack is appended to
   * @param {?object} notice - the notice to mirror and stack; null skips both
   * @param {object} [options]
   * @param {boolean} [options.replace=false] - true clears the existing stack first
   * @returns {{notices: Array<object>, effects: Array<object>}} the next stack
   *   plus the expiry effect for its latest entry ([] when notice is null)
   */
  const notify = (model, notice, { replace = false } = {}) => {
    if (notice) log?.(typeof notice.text === "string" ? notice.text : JSON.stringify(notice.text));
    const base = replace ? { ...model, notices: [] } : model;
    const notices = appendNotice(base, notice);
    // Callers receive the expiry effect alongside the stack: notices
    // disappear on their own instead of accumulating forever (previously
    // only the app.log command-output path scheduled one).
    return { notices, effects: notice ? noticeExpiryEffect(notices) : [] };
  };
  // The opening is display-only; it is not a Context message.
  log?.(`${NAMES.Namespace} · ${viewed.model ?? "(none)"}`);
  const adapter = createAgentAdapter(viewed);
  /** A 1 Hz clock: sends agent.throttle.tick once a second until aborted, so
   *  a provider throttle countdown in the status bar keeps repainting.
   * @returns {object} a GTUI task effect keyed "agent.throttle-clock" */
  const throttleEffect = () => effect.task("agent.throttle-clock", async ({ send, signal }) => {
    while (!signal.aborted) {
      await new Promise((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 1000);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!signal.aborted) send({ type: "agent.throttle.tick" });
    }
  });
  let theme = resolveTheme(env?.settings ?? {});
  let keymap = resolveKeymap(env?.settings ?? {});
  const mapped = (action, key) => [].concat(keymap[action] ?? []).includes(key);
  const previewRows = themePreviewRows(theme);
  /** "provider/model" identity text, always read from the viewed agent. */
  const combo = () => viewed.model ?? "(none)/(none)";
  const live = createLiveState(slot, viewed, previewRows);
  const { activeTurns, closedAgents, reseatingAgents, liveByOrigin, toolStreams, TOOL_STREAM_LIMIT, toolSanitizerFor, dropToolSanitizer, thinkingKey, noteTime, claimTurn, toolStreamFor, attachViewedLive, refreshProjection, allBlocksFor, blocksFor, catalogMatches, refreshToolCatalog, projection } = live;
  // The bridge a synchronous hook (commands.js's onMenu/onLogin, called
  // from deep inside an awaited command) uses to reach the CURRENT
  // task's `send` — the same pattern agent-adapter.js's question bridge
  // uses, for the same reason: dispatch always flows through the task
  // that's actively running, never a channel that outlives it.
  const sendRef = { current: null };
  /** Dispatch a message through the currently running task, if any.
   * @param {object} message - the app message to dispatch */
  const dispatchNow = (message) => sendRef.current?.(message);
  const copyWaiters = new Map();
  let copySequence = 0;
  /** Ask the app to copy text and await the clipboard outcome (commands.js
   *  /copy uses this).
   * @param {string} text - the text to copy
   * @returns {Promise<boolean>} resolves true on success; false immediately
   *   when no task can dispatch */
  const requestCopy = (text) => new Promise((resolve) => {
    const id = `command-copy:${++copySequence}`;
    if (!sendRef.current) return resolve(false);
    copyWaiters.set(id, resolve);
    dispatchNow({ type: "app.copy.request", id, text });
  });

  /** The ONE place "the app ends" means anything — /bye|/exit|/quit
   *  (onExit), a second idle-empty ^C, and ^D-on-empty all funnel here
   *  rather than each calling effect.quit() independently.
   * @param {object} model - the app model, returned unchanged
   * @returns {{model: object, effects: Array<object>}} the model plus effect.quit(0) */
  const requestQuit = (model) => ({ model, effects: [effect.quit(0)] });

  /** Create an independent, user-owned Agent and view it.
   * @param {object} options
   * @param {string} options.endpoint - endpoint name for the new session
   * @param {string} options.model - model name within the endpoint
   * Side effect: creates the Agent and switches the slot to it. */
  function addAgent({ endpoint, model }) {
    const current = slot.current();
    return effect.task("agent.add", async ({ send, signal }) => {
      try {
        const fresh = await current.env.agentCreate({
          model: `${endpoint}/${model}`,
          can: { ...current.can },
          contextId: randomUUID(),
          folder: current.folder,
        });
        if (signal.aborted) { await fresh.close(); return; }
        fresh.thinking = current.thinking;
        workspace?.own(fresh);
        send({ type: "agent.add.ready", agent: fresh, origin: current });
      } catch (error) {
        send({ type: "agent.add.error", error });
      }
    });
  }

  /** Close an Agent and move the view before its asynchronous cleanup can strand it.
   * @param {object} agent - the Agent to close
   * @returns {boolean|string} false when the agent is missing/already closed;
   *   "quit" when the viewed agent closed with no replacement; true otherwise
   * Side effects: closes the agent and may switch the slot to another agent. */
  function closeAgent(agent) {
    if (!agent || agent.closed === true) return false;
    const current = slot.current();
    const agents = workspace?.agents() ?? current.env?.agents?.() ?? env?.agents?.() ?? [];
    const index = agents.indexOf(agent);
    const replacement = agent === current && index >= 0
      ? agents.slice(index + 1).concat(agents.slice(0, index)).find((candidate) => candidate !== agent)
      : null;
    void agent.close().catch((error) => log?.(`agent close: ${error?.message ?? error}`));
    if (replacement) slot.switchTo(replacement);
    return agent === current && !replacement ? "quit" : true;
  }

  /** Change the viewed session; a fork keeps its source Agent alive.
   * @param {string} kind - New, fork or resume operation.
   * @param {string} id - The new session id.
   * @param {number} through - Fork boundary, when specified.
   * @returns {Promise<object>} The fresh session's Context, activated before it becomes visible.
   * @throws {Error} When the old Agent is running or either close or activation fails. */
  async function replaceSession(kind, id, through, current = slot.current()) {
    if (kind === "resume") {
      const existing = current.env.agents().find((member) => !member.closed && !member.closeMarked && member.context.id === id && member.context.dir === current.env.settings.sessions);
      if (existing) {
        if (current.busy || current.closeMarked || current.closed) throw new Error("cannot replace a closed or running session");
        if (slot.current() === current) slot.switchTo(existing);
        return existing.context;
      }
    }
    const fresh = kind === "fork" ? await current.fork({ id, through }) : await conversationCreate(current, { kind, id, through });
    workspace?.own(fresh);
    if (kind !== "fork") reseatingAgents.add(current);
    try {
      if (kind !== "fork") await current.close();
      if (kind !== "fork") conversationActivate(fresh);
      if (slot.current() === current) slot.switchTo(fresh);
      return fresh.context;
    } catch (error) {
      await fresh.close().catch(() => {});
      throw error;
    }
  }

  function commandsFor(target, onReplaced = () => {}) {
    const replace = async (kind, id, through) => {
      const context = await replaceSession(kind, id, through, target);
      const fresh = target.env.agents().find((member) => member.context === context);
      if (fresh) onReplaced(fresh);
      dispatchNow({ type: "app.session.replaced" });
      return context;
    };
    return createCommands({
    agent: target,
    copy: requestCopy,
    log: (text) => dispatchNow({ type: "app.log", text }),
    onMenu: () => dispatchNow({ type: "app.overlay.openMaster" }),
    onLogin: () => dispatchNow({ type: "app.overlay.openLogin" }),
    onEditMode: (index) => dispatchNow({ type: "access.context.edit", agent: target, index }),
    onExit: () => dispatchNow({ type: "app.quit" }),
    onFillInput: (text) => dispatchNow({ type: "app.fillInput", text, origin: target }),
    onContinue: () => dispatchNow({ type: "app.continue", origin: target }),
    onCompact: (focus) => dispatchNow({ type: "app.compact", focus, origin: target }),
    onReseat: (id) => replace("new", id),
    onFork: (id, through) => replace("fork", id, through),
    onResume: (id) => replace("resume", id),
    onRestart: (id) => replace("new", id),
  }); }

  /** Runs one or more command lines IN ORDER, on the SAME task (a
   *  fresh task per line would collide on the "agent.command" key and
   *  cancel its predecessor mid-command — see GTUI's per-key task
   *  dedup).
   * @param {string[]} lines - the command lines, run sequentially
   * @returns {object} a task effect keyed "agent.command"; installs the
   *   question bridge and sendRef for the task's lifetime
   */
  function runCommandEffect(lines) {
    const origin = slot.current();
    return effect.task("agent.command", async ({ send }) => {
      let target = origin;
      const restoreQuestion = adapter.installQuestionBridge(send, origin);
      sendRef.current = send;
      try {
        for (const line of lines) await commandsFor(target, (fresh) => { target = fresh; }).handle(line);
      } finally {
        sendRef.current = null;
        restoreQuestion();
      }
    });
  }

  /** Browser sign-in for a chosen OAuth preset (the login picker's
   *  "(browser sign-in)" rows). Previously resolveMenuAction re-opened
   *  the preset picker — the same overlay Enter had just fired on — so
   *  the wizard flickered and reappeared without ever running a login.
   *  Here the real OAuth flow runs on its own task (kept OUT of the
   *  "agent.command" key so a late paste can't cancel it): the host
   *  opens the browser, progress lands as notices, /endpoint-oauth-paste
   *  stays available as the headless channel, and the resulting tokens
   *  log the endpoint in exactly like /endpoint-login does.
   * @param {object} preset - an OAuth preset ({name, label?, provider, url, oauth})
   * @returns {object} a task effect keyed "agent.oauth"; progress and
   *   failures surface as notices, never throw
   */
  function runOAuthLoginEffect(preset) {
    const target = slot.current();
    return effect.task("agent.oauth", async ({ send }) => {
      const logLine = (text, kind = "notice") => send({ type: "app.oauth.log", text, kind });
      try {
        logLine(`starting ${preset.label ?? preset.name} sign-in — the browser opens (headless? use /endpoint-oauth-paste)`);
        const tokens = await runOAuthFlow(preset.oauth, {
          onAuthUrl: (url) => send({ type: "app.oauth.authUrl", url }),
          onLog: (line) => logLine(line),
          open, // undefined: the flow's default system-browser opener
        });
        const result = await target.env.login(preset.name, {
          provider: preset.provider, url: preset.url, auth: tokensToAuth(tokens),
          ...(preset.oauth?.projectId ? { oauth: preset.oauth } : {}),
        }, { scope: "package" });
        finishEndpointLogin(result, target);
        logLine(`endpoint saved: ${result.name} (${preset.provider} at ${preset.url}, package)`);
      } catch (error) {
        logLine(`sign-in failed: ${error?.message ?? error}`, "error");
      }
    });
  }

  /** Submit the draft: commands route to the router, whitespace-only text
   *  continues the turn silently, plain text enqueues and starts a turn.
   * @param {object} model - the app model
   * @param {string} text - the submitted text
   * @param {object} [input=clearInput(model.input)] - the input state to store (defaults cleared)
   * @returns {{model: object, effects: Array<object>}} the next state; a
   *   no-op when the input is closed or the session is close-marked
   */
  function submit(model, text, input = clearInput(model.input)) {
    if (model.closedInput || slot.current().closeMarked) return { model, effects: [] };
    // Whitespace-only input is a continue: the agent starts its turn
    // with the existing context and NO appended message — exactly what
    // /continue does (command-handlers.js's onContinue -> the
    // app.continue case below). The TUI stays silent: no message is
    // printed, no empty user turn lands in the transcript.
    if (text.trim() === "") {
      if (text === "") return { model: { ...model, input }, effects: [] };
      const origin = slot.current();
      if (activeTurns.has(origin)) return { model: { ...model, input }, effects: [] };
      claimTurn(origin);
      return { model: { ...model, turnRunning: true, input }, effects: [adapter.turnEffect()] };
    }
    if (text.startsWith("/")) return { model: { ...model, input, transcriptOffset: 0 }, effects: [runCommandEffect([text])] };
    const origin = slot.current();
    // Attachments must be assembled before a run is claimed. Agent.send()
    // starts idle delivery synchronously, so the ordinary queue+turn pair
    // races and can produce two turns.
    if (hasAttachment(text) && !activeTurns.has(origin)) {
      claimTurn(origin);
      return { model: { ...model, turnRunning: true, pendingCount: model.pendingCount + 1, input, transcriptOffset: 0 }, effects: [adapter.submitEffect(text)] };
    }
    const effects = [adapter.enqueueEffect(text)];
    // Claim before the task begins: a second submit in the same dispatch turn
    // is queue-only, while a switched session receives its own independent task.
    if (!activeTurns.has(origin)) { claimTurn(origin); effects.push(adapter.turnEffect()); }
    return { model: { ...model, turnRunning: true, pendingCount: model.pendingCount + 1, input, transcriptOffset: 0 }, effects };
  }

  /** Apply a questionnaire outcome: an incomplete one keeps the UI open
   *  (and resets the agent's answer timeout); a complete one resolves the
   *  pending question with its answers.
   * @param {object} model - the app model (model.question must be set)
   * @param {object} outcome - a questionnaire outcome ({complete, state?, answers?})
   * @returns {{model: object, effects: Array<object>}} the next state and
   *   either a timeout-reset or question-resolution effect
   */
  function updateQuestion(model, outcome) {
    const { requestId, focus, highlight } = model.question;
    if (!outcome.complete) {
      const draft = outcome.state.drafts[outcome.state.index] ?? "";
      return { model: { ...model, question: { requestId, state: outcome.state, focus, draft, highlight } }, effects: [adapter.resetTimeoutEffect()] };
    }
    return { model: { ...model, question: null }, effects: [adapter.resolveQuestionEffect(requestId, outcome.answers)] };
  }

  /** A finished endpoint login (direct form or OAuth) updates the viewed
   *  agent and the remembered combo — the same end state
   *  /endpoint-login's direct form lands in.
   * @param {object} result - the login result ({name, provider, url})
   * Side effect: selects the first known model, if available. */
  function finishEndpointLogin(result, current = slot.current()) {
    const model = listEndpointModels(current.env).find(({ name }) => name === result.name)?.models[0];
    if (model) (current.model = `${result.name}/${model}`);
  }

  /** A status-toolbar chip (status-view.js's CHIP_ACTIONS). Toggles run
   *  the same slash commands the ^X menu's items do, so they log the same
   *  notices; focus stays on the toolbar for the next toggle.
   * @param {object} model - the app model
   * @param {string} name - the chip name ("thinking" | "safe" | "logging")
   * @returns {{model: object, effects: Array<object>}} the next state
   */
  function statusAction(model, name) {
    switch (name) {
      case "usage": return { model: { ...model, usageExpanded: !model.usageExpanded }, effects: [] };
      case "thinking": {
        const current = viewed.thinking ?? "default";
        const items = ["default", ...IO.THINKING_LEVELS].map((value) => ({
          kind: "action", label: `${value}${current === value ? " (current)" : ""}`, value: { type: "thinking", value },
        }));
        return { model: { ...model, overlay: openMenu("Thinking", items) }, effects: [] };
      }
      case "safe": return applyMenuResolution(model, resolveMenuAction({ type: "safe", value: viewed.can.write === false ? "off" : "on" }, env));
      // Logging is the store's one switch: turning it on writes the whole
      // conversation so far, whether or not it was ever logged before.
      case "logging": return applyMenuResolution(model, resolveMenuAction({ type: "session-save", value: !viewed.context.save }, env));
      default: return { model, effects: [] };
    }
  }

  function persistSettingsEffect(target) {
    return effect.task(`settings.flush:${target?.folder ?? "current"}`, async ({ send }) => {
      try { await target?.settingsFlush?.(); }
      catch (error) { send({ type: "app.oauth.log", kind: "error", text: `Settings were changed in memory but could not be saved: ${error.message}` }); }
    });
  }

  /** Apply the outcome of a selected menu item (pop/push/run/switch/…).
   * @param {object} model - the app model
   * @param {object} resolved - resolveMenuAction's result ({kind, ...})
   * @returns {{model: object, effects: Array<object>}} the next state and
   *   any command/OAuth/quit/theme effects
   */
  function applyMenuResolution(model, resolved) {
    switch (resolved.kind) {
      case "pop": return { model: { ...model, overlay: model.overlay && popMenu(model.overlay) }, effects: [effect.theme(theme)] };
      case "push": return { model: { ...model, overlay: pushMenu(model.overlay, resolved.title, resolved.items, resolved.source) }, effects: [] };
      case "oauth-login": return { model: { ...model, overlay: null }, effects: [runOAuthLoginEffect(resolved.preset)] };
      case "switch-agent":
        if (resolved.agent && slot.switchTo(resolved.agent)) return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
        return { model: { ...model, overlay: null }, effects: [] };
      case "add-agent":
        return { model: { ...model, overlay: null }, effects: [addAgent(resolved)] };
      case "close-agent": {
        const result = closeAgent(resolved.agent);
        if (result === "quit") return requestQuit({ ...model, overlay: null });
        return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
      }
      case "insert": return { model: { ...model, overlay: null, input: insertText(model.input, resolved.text) }, effects: [] };
      case "command": return { model: { ...model, overlay: null }, effects: [runCommandEffect(resolved.lines)] };
      case "autocompact": {
        let failure = null;
        try {
          const change = resolved.change;
          if (!change || Object.keys(change).some((key) => !["autocompact", "autocompactMax"].includes(key))) throw new TypeError("Invalid auto-compaction setting");
          if (change.autocompact !== undefined && (!Number.isFinite(change.autocompact) || change.autocompact < 0 || change.autocompact >= 1)) throw new TypeError("Window threshold must be between 0 and 1");
          if (change.autocompactMax !== undefined && (!Number.isSafeInteger(change.autocompactMax) || change.autocompactMax < 0)) throw new TypeError("Token limit must be a nonnegative integer");
          for (const [key, value] of Object.entries(change)) env.settings.context[key] = value;
        } catch (error) { failure = error; }
        const overlay = access.refresh(refreshMenus(model.overlay, (source) => {
          const fresh = resolveMenuAction(source, env);
          return fresh.kind === "push" ? fresh.items : undefined;
        }));
        if (!failure) return { model: { ...model, overlay }, effects: [persistSettingsEffect(env)] };
        const notified = notify(model, { text: `auto-compaction settings: ${failure.message}`, kind: "error" });
        return { model: { ...model, overlay, notices: notified.notices }, effects: notified.effects };
      }
      case "endpoint-policy": {
        // The settings view persists the change; open policy levels re-read it.
        let failure = null;
        try { endpointPolicySet(env, resolved.selector, resolved.change); } catch (error) { failure = error; }
        const base = resolved.pop && model.overlay?.type === "menu" ? popMenu(model.overlay) : model.overlay;
        const overlay = access.refresh(refreshMenus(base, (source) => {
          const fresh = resolveMenuAction(source, env);
          return fresh.kind === "push" ? fresh.items : undefined;
        }));
        if (!failure) return { model: { ...model, overlay }, effects: [persistSettingsEffect(env)] };
        const notified = notify(model, { text: `endpoint settings: ${failure.message}`, kind: "error" });
        return { model: { ...model, overlay, notices: notified.notices }, effects: notified.effects };
      }
      case "agent.can.delegate":
        (viewed.can.delegate = resolved.value);
        return { model: { ...model, overlay: null }, effects: [] };
      case "agent.can.request":
        (viewed.can.request = resolved.value);
        return { model: { ...model, overlay: null }, effects: [] };
      case "theme": {
        // the menu lists only known themes; the settings view persists the choice
        if (env && (resolved.value === "default" || env.settings.themes?.[resolved.value])) {
          // A UI selection replaces legacy per-interface overrides with one shared choice.
          delete env.settings.tui.theme;
          delete env.settings.web.theme;
          env.settings.theme = resolved.value;
        }
        theme = resolveTheme(env?.settings ?? {});
        return { model: { ...model, overlay: null }, effects: [effect.theme(theme), persistSettingsEffect(env)] };
      }
      default: return { model: { ...model, overlay: null }, effects: [] };
    }
  }

  function accessOptions() {
    const options = masterMenuOptions(viewed, env, combo(), { catalog: completionSources.catalog?.() });
    return { ...options, agent: slot.current(), currentEnv: env, personalSettings: Env.settings,
      agents: workspace ? workspace.agents().map((member) => ({ agent: member,
        name: `${member.env.name}/${member.name}`, current: member === slot.current(), child: Boolean(member.parent),
        busy: member.busy, description: member.description })) : options.agents,
      projects: (workspace?.projects() ?? []).map((project) => ({ ...project, current: project.env === env || project.path === env?.folder })),
      savedSessions, sessionsLoading,
      tools: (completionSources.catalog?.()?.tools ?? []).map(({ name, schema }) => ({ name: `tool-${name}`, schema, description: schema?.description })),
    };
  }

  function openMaster(model) {
    invalidateMenus();
    const options = accessOptions();
    const overlay = openMenu("Menu", buildAccessRoot(options), { type: "master" });
    if (!menuSnapshot) menuSnapshot = buildActionSearch(options);
    overlay.stack[0].searchItems = menuSnapshot;
    return { model: { ...model, overlay, completionGeneration: model.completionGeneration + 1 },
      effects: [refreshCompletionCatalogEffect(), refreshSessionsEffect()] };
  }

  function refreshSessionsEffect() {
    sessionsLoading = Boolean(workspace);
    return effect.task("access.sessions", async ({ send }) => {
      try { send({ type: "access.sessions.ready", sessions: await workspace?.sessions() ?? [] }); }
      catch (error) { send({ type: "access.sessions.ready", sessions: [], error }); }
    });
  }

  function openContext(model, index, blockIndex) {
    const blocks = blocksFor(model);
    const overlay = openViewer(blocks);
    if (Number.isInteger(index)) {
      const found = blocks.findIndex((block) => (block.sourceMessage ?? block.message) === index && (blockIndex === undefined || block.contentIndex === blockIndex));
      if (found >= 0) { overlay.index = found; overlay.sourceIndex = blocks[found].sourceIndex; }
    }
    return { model: { ...model, overlay }, effects: [] };
  }

  const access = createAccessController({ workspace, getAgent: slot.current, getEnv, getOptions: accessOptions,
    runCommandEffect, copyEffect: (text) => effect.copy(text, `viewer-copy:${++copySequence}`), openContext,
    runTool: async (name, args, target) => {
      const value = await target.env.toolCall(name.replace(/^tool-/, ""), args, { question: null, env: target.env, agent: target });
      const { result, system, display } = unwrapToolResult(value);
      return [formatToolResult(result), ...system.map((text) => `[system] ${text}`), ...display.map((text) => `[display] ${text}`)].join("\n");
    },
  });

  function resolveAccess(model, value) {
    return access.resolve(model, value) ?? applyMenuResolution(model, resolveMenuAction(value, env));
  }

  /** Build a path-completion request for the word under the caret.
   * @param {object} input - the draft input state ({value, caret})
   * @returns {?object} {dir, value, caret, agent} for the completion task,
   *   or null when the word starts with "/" (a command, not a path)
   */
  function pathRequest(input) {
    const before = input.value.slice(0, input.caret);
    const wordStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
    const word = before.slice(wordStart);
    if (word.startsWith("/")) return null;
    const slash = word.lastIndexOf("/");
    const dir = slash < 0 ? "." : (word.slice(0, slash + 1).replace(/\/$/, "") || ".");
    return { dir, cwd: viewed.folder ?? env?.folder ?? cwd, value: input.value, caret: input.caret, agent: slot.current() };
  }

  /** Run one asynchronous filesystem listing for path completion.
   * @param {object} request - pathRequest's result
   * @returns {object} a task effect keyed "completion.path"; read errors
   *   resolve to an empty entry list, never throw
   */
  function pathCompletionEffect(request) {
    return effect.task("completion.path", async ({ send }) => {
      try {
        const entries = await listDir(request.dir, { cwd: request.cwd });
        send({ type: "completion.path.ready", request, entries: entries.map((entry) => typeof entry === "string" ? entry : entry.name + (entry.isDirectory() ? "/" : "")) });
      } catch { send({ type: "completion.path.ready", request, entries: [] }); }
    });
  }

  /** Ask the completion sources to refresh their catalog; failures still
   *  send completion.catalog.ready so nothing waits forever.
   * @returns {object} a task effect keyed "completion.catalog" */
  function refreshCompletionCatalogEffect() {
    return effect.task("completion.catalog", async ({ send }) => {
      try { await completionSources.refresh?.(); send({ type: "completion.catalog.ready" }); }
      catch { send({ type: "completion.catalog.ready" }); }
    });
  }

  /** Env collects the model catalog in the background (context windows,
   *  live model lists); the status readout and menus read it
   *  synchronously, so each Env.EVENT.MODELS_CHANGED repaints once.
   * @returns {object} a task effect keyed "context.windows"; a no-op task
   *   when Env events are unavailable
   */
  function contextWindowsEffect() {
    const target = env;
    return effect.task("context.windows", async ({ send, signal }) => {
      if (signal.aborted || !target?.onEvent || !Env.EVENT.MODELS_CHANGED) return;
      const handle = target.onEvent(Env.EVENT.MODELS_CHANGED, () => send({ type: "context.windows.ready", env: target }));
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      target.offEvent(handle);
    });
  }

  /** Observe settings completion without delaying startup; release every listener on abort.
   * @returns {object} A settings subscription task, including a ready-barrier refresh.
   */
  function settingsEffect() {
    const target = env;
    return effect.task("settings", async ({ send, signal }) => {
      if (signal.aborted || !target) return;
      const refresh = () => { if (!signal.aborted) send({ type: "settings.ready", env: target }); };
      const handles = target.onEvent ? [Env.EVENT.SETTINGS_CHANGED, Env.EVENT.SETTINGS_LOADED]
        .map((event) => target.onEvent(event, refresh)) : [];
      let onAbort;
      const aborted = new Promise((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([target.ready?.(), aborted]);
        refresh();
        await aborted;
      } finally {
        signal.removeEventListener("abort", onAbort);
        for (const handle of handles) target.offEvent(handle);
      }
    });
  }

  /** Rebuild live menu data from refreshed parents, retaining stack and preview state.
   * @param {object|null} overlay Current overlay.
   * @returns {object|null} Refreshed menu, or the original non-menu overlay.
   */
  function refreshMenuData(overlay) {
    if (overlay?.type !== "menu") return overlay;
    const options = masterMenuOptions(viewed, env, combo(), { catalog: completionSources.catalog?.() });
    const master = buildAccessRoot(accessOptions());
    const catalogs = {
      prompts: { prompts: options.prompts }, tools: { tools: options.tools }, sessions: { sessions: options.sessions },
      themes: { themes: options.themes, value: options.theme }, "logout-menu": { endpoints: options.endpoints },
    };
    const refreshed = refreshMenus(overlay, (source, parentItems) => {
      if (source.type === "master") return master;
      if (source.type === "endpoints") return buildEndpointItems(endpointMenuOptions(env, combo()));
      const identityKeys = source.type === "provider" ? ["value"] : ["endpoint", "selector"];
      const matching = (item) => item.value?.type === source.type
        && identityKeys.every((key) => source[key] === undefined || item.value[key] === source[key]);
      let value = (parentItems ?? master).find(matching)?.value ?? source;
      if (Object.hasOwn(catalogs, source.type)) value = { ...source, ...catalogs[source.type] };
      if (source.type === "provider") value = { ...source,
        models: endpointMenuOptions(env, combo()).providers.find((entry) => entry.name === source.value)?.models ?? [] };
      const resolved = resolveMenuAction(value, env);
      return resolved.kind === "push" ? resolved.items : undefined;
    });
    if (refreshed.stack[0]?.source?.type === "master") {
      if (!menuSnapshot) menuSnapshot = buildActionSearch(accessOptions());
      refreshed.stack[0] = { ...refreshed.stack[0], searchItems: menuSnapshot };
    }
    return access.refresh(refreshed);
  }

  /** Move the viewed slot through Env's current registry, wrapping at each end.
   * @param {number} direction - +1 for the next session, -1 for the previous
   * @returns {boolean} true when the slot switched; false with <2 agents or
   *   the current agent missing from the registry
   */
  function pageAgent(direction) {
    const agents = workspace?.agents() ?? slot.current().env?.agents?.() ?? env?.agents?.() ?? [];
    const current = slot.current();
    const index = agents.indexOf(current);
    if (agents.length < 2 || index < 0) return false;
    return slot.switchTo(agents[(index + direction + agents.length) % agents.length]);
  }

  /** View the current session's parent agent, if it has one.
   * @returns {boolean} true when the slot switched to the parent */
  function switchParentAgent() {
    const parent = slot.current().parent;
    return parent ? slot.switchTo(parent) : false;
  }

  const nextCopySequence = () => ++copySequence;
  const key = createKeyHandler({ mapped, pageAgent, attachViewedLive, switchParentAgent, blocksFor, viewed, adapter, completionSources, sources, pathRequest, pathCompletionEffect, nextCopySequence, requestQuit, statusAction, combo, getEnv, notify, slot, updateQuestion, openMaster, resolveAccess, forkSession: (through) => replaceSession("fork", undefined, through) });
  const updateCore = createUpdateCore({ key, slot, activeTurns, claimTurn, adapter, submit, closedAgents, reseatingAgents, catalogMatches, completionSources, viewed, cwd, getEnv, attachViewedLive, resolveAccess, openMaster, getTheme: () => theme, blocksFor, updateQuestion, notify, liveByOrigin, noteTime, thinkingKey, dropToolSanitizer, toolStreamFor, toolStreams, toolSanitizerFor, TOOL_STREAM_LIMIT, refreshCompletionCatalogEffect, copyWaiters, nextCopySequence, requestQuit });
  const view = createAppView({ refreshProjection, blocksFor, allBlocksFor, projection, viewed, completionSources, terminalHeight, terminalWidth, getEnv, getAgents: () => workspace?.agents(), cwd });

  function updateInner(model, message) {
    if (message.env && message.env !== env) return { model, effects: [] };
    if (message.type === "agent.question.opened" && message.origin && message.origin !== slot.current()) {
      const state = updateCore(model, { ...message, origin: slot.current() }).model.question;
      questions.set(message.origin, state);
      return { model, effects: [] };
    }
    if (message.type === "agent.question.timed-out" && message.origin) questions.delete(message.origin);
    if (message.type === "access.sessions.ready") {
      savedSessions = message.sessions ?? savedSessions;
      sessionsLoading = false;
      invalidateMenus();
      const notified = message.error ? notify(model, { text: `sessions: ${message.error?.message ?? message.error}`, kind: "error" }) : { notices: model.notices, effects: [] };
      return { model: { ...model, notices: notified.notices, overlay: refreshMenuData(model.overlay) }, effects: notified.effects };
    }
    if (["settings.ready", "context.windows.ready", "completion.catalog.ready", "access.operation.done", "access.sessions.ready"].includes(message.type)) invalidateMenus();
    const accessed = access.update(model, message);
    if (accessed) {
      if (accessed.model.accessSelectedAgent) {
        slot.switchTo(accessed.model.accessSelectedAgent);
        accessed.model = { ...accessed.model, accessSelectedAgent: undefined };
      }
      if (message.type === "access.operation.done" && message.text && model.overlay === message.operation) {
        const notified = notify(accessed.model, { text: String(message.text), kind: "notice" });
        accessed.model = { ...accessed.model, notices: notified.notices };
        accessed.effects = accessed.effects.filter((entry) => entry.type !== "notify").concat(notified.effects);
      }
      return accessed;
    }
    if (message.type === "agent.add.ready") {
      if (message.origin && message.origin !== slot.current()) return { model, effects: [] };
      if (slot.current().closed) {
        void message.agent.close().catch((error) => log?.(`agent close: ${error?.message ?? error}`));
        return { model, effects: [] };
      }
      slot.switchTo(message.agent);
      return { model: attachViewedLive(model), effects: [] };
    }
    if (message.type === "agent.add.error") {
      const notified = notify(model, { text: `agent create: ${message.error?.message ?? message.error}`, kind: "error" });
      return { model: { ...model, notices: notified.notices }, effects: notified.effects };
    }
    const isUsageClick = message.type === "action.select" && message.action === "status.usage";
    const isUserAction = ["key", "paste", "input.change", "input.submit", "pointer", "action.select", "menu.select", "menu.cancel", "agent.submit"].includes(message.type);
    if (model.usageExpanded && isUserAction && !isUsageClick) model = { ...model, usageExpanded: false };
    let result = updateCore(model, message);
    if (message.type === "settings.ready") {
      const nextTheme = resolveTheme(env?.settings ?? {});
      keymap = resolveKeymap(env?.settings ?? {});
      live.setPreviewRows(themePreviewRows(nextTheme));
      if (JSON.stringify(nextTheme) !== JSON.stringify(theme)) {
        theme = nextTheme;
        const preview = model.overlay?.type === "menu" ? model.overlay.stack.at(-1)?.preview : null;
        const tokens = preview?.type === "theme"
          ? resolveTheme({ tui: { theme: preview.name }, themes: env?.settings?.themes ?? {} }) : theme;
        result = { ...result, effects: [...result.effects, effect.theme(tokens)] };
      }
      result = { ...result, effects: [...result.effects, effect.refresh(), refreshCompletionCatalogEffect()] };
    }
    if (result.model.overlay?.type === "menu" && ["settings.ready", "context.windows.ready", "completion.catalog.ready"].includes(message.type)) {
      result = { ...result, model: { ...result.model, overlay: refreshMenuData(result.model.overlay) } };
    }
    const viewing = ["viewer", "viewer-filter"].includes(result.model.overlay?.type);
    const opened = viewing && !["viewer", "viewer-filter"].includes(model.overlay?.type);
    const changed = ["settings.ready", "context.windows.ready", "agent.turn.settled"].includes(message.type)
      || (message.type === "agent.tool.event" && message.event?.type === "tool.result" && (!message.origin || message.origin === slot.current()));
    const refresh = opened || !catalogMatches(result.model.toolCatalog) || changed;
    if (!viewing) return result.model.toolCatalog
      ? { ...result, model: { ...result.model, toolCatalog: undefined } } : result;
    if (!refresh) return result;
    const next = refreshToolCatalog(result.model);
    return { model: next.model, effects: [...result.effects, ...next.effects] };
  }

  /** Rebind presentation state after every route that can change the viewed Agent. */
  function update(model, message) {
    const previous = modelAgent;
    const previousEnv = previous?.env ?? launchEnv;
    const result = updateInner(model, message);
    const current = slot.current();
    if (current === previous) return result;
    drafts.set(previous, { input: model.input, transcriptOffset: model.transcriptOffset });
    if (model.question) questions.set(previous, model.question); else questions.delete(previous);
    const saved = drafts.get(current);
    const input = saved?.input ?? initialInput(historyFromContext(current.context.messages()));
    modelAgent = current;
    const nextTheme = resolveTheme(env?.settings ?? {});
    theme = nextTheme;
    keymap = resolveKeymap(env?.settings ?? {});
    live.setPreviewRows(themePreviewRows(nextTheme));
    const effects = [...result.effects, effect.theme(theme), refreshCompletionCatalogEffect()];
    if (!observedAgents.has(current)) { observedAgents.add(current); effects.push(adapter.closeEffect()); }
    if (env !== previousEnv) effects.push(contextWindowsEffect(), settingsEffect());
    return { model: { ...attachViewedLive(result.model), input: { ...input, completions: [] },
      transcriptOffset: saved?.transcriptOffset ?? 0, focus: "input", closedInput: current.closeMarked === true,
      toolStream: [...(toolStreams.get(current) ?? [])], question: questions.get(current) ?? null, toolCatalog: undefined,
      completionGeneration: result.model.completionGeneration + 1 }, effects };
  }

  return {
    /** The real Agent currently shown by the TUI. Process front ends use this
     * at shutdown because the user may have switched sessions since startup. */
    currentAgent: slot.current,
    closeWorkspace: () => workspace?.close() ?? Promise.resolve(),
    /** @returns {{model: object, effects: Array<object>}} the initial model
     *  (draft history seeded from the viewed context) plus startup effects:
     *  catalog refresh, settings/model events, agent close hook, 1 Hz clock */
    init: () => ({ model: initialModel(historyFromContext(viewed.context.messages())), effects: [refreshCompletionCatalogEffect(), contextWindowsEffect(), settingsEffect(), adapter.closeEffect(), throttleEffect()] }),
    update,
    view,
    /** Keys that must bypass GTUI's input/menu controls entirely — see
     *  each guard above for why (a conflicting native meaning, or the
     *  "swallow anything unrecognized while an overlay is open" rule). */
    bindings: (model) => appBindings(model, Object.values(keymap).flatMap((value) => value == null ? [] : [].concat(value))),
    /** Exposed for the app's owner (a future run.js wiring): drain every
     *  open question before tearing down, so a clean exit never hangs a
     *  tool call waiting on an answer that will never come. */
    abandonPending: adapter.abandonPending,
    /** Tear down: abandon open questions and fail every pending copy waiter
     *  so no Promise outlives the app. */
    dispose: () => {
      offSwitch();
      access.close?.();
      adapter.abandonPending();
      for (const resolve of copyWaiters.values()) resolve(false);
      copyWaiters.clear();
    },
    /** Resolved from tui.theme/themes (theme-data.js) — the app's
     *  owner passes this straight through as `new GTUI({host, theme})`'s
     *  theme option; GTUI applies it at render time, so nothing above
     *  needs to read it. */
    get theme() { return theme; },
  };
}

export { msg };
