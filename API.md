# API (2026-10-02)

## Agent

### `Agent.get busy()`

Whether an agent run is currently in progress.

### `Agent.cancel()`

Cancel active IO and every pending tool dispatch; queued calls never start.

### `Agent.childCreate(options = {…})`

Construct one direct child through the environment factory.

### `Agent.get children()`

Snapshot of directly owned workers.

### `Agent.close()`

Refuse new messages immediately; finish the current turn before releasing resources, or release them now when idle.

### `Agent.get closed()`

Whether close cleanup has completed.

### `Agent.get closeMarked()`

Whether close has been requested, including while a turn finishes.

### `Agent.compact(focus = "")`

Compact: ask the model to summarize the conversation (a structured, self-contained prompt), then replace the context with the surviving SYSTEM messages plus one ASSISTANT message holding the marked summary (lib/agent/compact.js).

### `Agent.constructor({ env, model, url, timeout, settings, context, tools, parent, name, description, contextId, contextSave = true, createIO, toolCall, safe, spawnPermission, question, } = {…})`

Build an agent over an environment; wires the session store (a named file session, a resumed one, an injected store, or none) and takes ownership of the seed context — a NEW (non-resumed) context starts with the seeded system prompt as its FIRST message(s).

### `Agent.contextFork(id)`

Fork the context into a NEW context id: the conversation continues in a fresh Context (flushed immediately when logged); the old file stays behind as a snapshot.

### `Agent.contextNew(id)`

Start a NEW, EMPTY context (re-seeded with the system prompt): the old one is closed (its flushed content stays on disk — contextFork() first to keep a snapshot).

### `Agent.contextResume(id)`

Resume a LOGGED context by id (from env.settings.sessions): it replaces the current one, which is closed (its flushed content stays on disk); its recorded settings and origin folder apply (lib/agent/context-lifecycle.js).

### `Agent.get contextUsage()`

The context-window readout for the status surface (most exact first: the provider's own report, the last provider-reported envelope, the word-count estimate marked `approximate`).

### `Agent.get description()`

Human-friendly Agent description; an empty string is valid.

### `Agent.descriptionSet(value)`

Describe the agent (recorded into a logged context's settings).

### `Agent.EVENT`

The numeric event vocabulary for Agent.onEvent — events about THIS agent only (Env reports membership: AGENT_ADDED/AGENT_REMOVED): REQUEST_START, TEXT_START, TEXT_DELTA, TEXT_END, THINKING_START, THINKING_DELTA, THINKING_END, TOOL_CALL_START, TOOL_CALL_DELTA, TOOL_CALL_END, REQUEST_DONE, REQUEST_ERROR, MESSAGE_COMMITTED, LOG, TOOL_EXECUTE, TOOL_DATA, TOOL_RESULT, CLOSE_MARKED, CLOSED, SENT_MESSAGE — see Agent.onEvent's documentation for each value's meaning and payload.

### `Agent.EVENT_CALLBACKS`

The [responseCallbackName, Agent.EVENT] pairs: every EVENT value's corresponding option-callback name ("onTextDelta" for Agent.EVENT.TEXT_DELTA, …), for hosts that prefer per-event callbacks over one onEvent listener.

### `Agent.get folder()`

The agent-local root used for file tools and their OS sandbox.

### `Agent.folderSet(folder)`

Narrow this agent's tool working folder to an existing folder inside its environment project.

### `Agent.get ioState()`

The connection/work state for the TUI's status indicator: "working" (a run is in flight), "disconnected" (the last turn failed connection-class), "idle" (otherwise).

### `Agent.modelSet(selector)`

Select an exact, configured endpoint/model pair for subsequent turns.

### `Agent.get name()`

Human-friendly Agent name.

### `Agent.nameSet(value)`

Rename the agent (recorded into a logged context's settings).

### `Agent.offEvent(handle)`

Remove one registration; returns false when it is absent.

### `Agent.onEvent(event, callback)`

Register a synchronous listener for one numeric Agent.EVENT value.

### `Agent.get parent()`

The creating Agent, or undefined when none was supplied.

### `Agent.pathInfo(path, options = {…})`

Inspect a path using the Agent's file-security boundary.

### `Agent.get pending()`

Unsent messages queued while busy (array copy; message objects are shared).

### `Agent.pendingPop()`

Remove ALL unsent pending messages, returning them (the TUI's Option+↑ recall: the queued messages go back into the input area, merged, for editing).

### `Agent.get planUsage()`

The provider-reported PLAN/QUOTA readout of the current endpoint (`{label?, quotas}`; in-memory, last-known).

### `Agent.get policy()`

The settings this Agent runs by, resolved from env.settings when it was created, re-resolved only when it selects another model (lib/agent/policy.js): context {cap, turn, autocompact} (the runaway guard and the auto-compaction threshold; global, then endpoint, then model overrides), retry {attempts, base, max}, tools {timeout, timeoutLimit, concurrency}.

### `Agent.promptCatalog(prompts, options)`

The `# Prompt Catalog` text of env.prompts().

### `Agent.questionSet(callbacks)`

Set (or replace) the QUESTION BRIDGE at runtime — the binding's rendering engine wires it once its overlays exist (the TUI hands its questionnaire overlay to the Agent after construction; see the constructor's `question` option for the contract).

### `Agent.run(options = {…})`

Run the tool loop until done/error (lib/agent/run.js).

### `Agent.get safe()`

safe mode: only read-only (`safe`) tools publish and execute

### `Agent.safeSet(value)`

Switch safe mode at runtime (the /safe command, the ^X menu).

### `Agent.send(message)`

Submit a user message: while a request is in flight it is queued for the next request; while idle it is appended and starts a request immediately.

### `Agent.sendFile(fileName)`

Read an existing file as a binary user message and deliver it.

### `Agent.skillCatalog(skills, options)`

The `# Skill Catalog` text of env.skills() (the skill tool's answer, the skills CLI).

### `Agent.skillSection(skill)`

One skill's full content as the model reads it: `<skill name="...">\n<body>\n</skill>`.

### `Agent.get spawnPermission()`

Generic delegation permission.

### `Agent.spawnPermissionSet(value)`

Set generic delegation permission; non-booleans restore tool-owned asking.

### `Agent.get thinking()`

the current thinking level (undefined = provider default)

### `Agent.thinkingSet(level)`

Set the thinking level for subsequent requests (THINKING_LEVELS; each provider translates it to the nearest symbol the model accepts).

### `Agent.get throttledUntil()`

Epoch-ms deadline of a pending continuation, or null.

### `Agent.toolCallable(name)`

Whether this Agent's effective catalog authorizes a named tool: the availability selection, narrowed to read-only tools while safe.

### `Agent.toolContext({ question = null, env, safe = false, selector, io, call, agent, storage, trusted = false, resetTimeout } = {…})`

Construct the public tool-call context.

### `Agent.toolMessages()`

tools with a live sticky message

### `Agent.toolMessagesDetect()`

Re-detect tool-provided display information from the current context.

### `Agent.toolMessageSet(name, text)`

Set (or clear) a tool's sticky MESSAGE on THIS agent — a compact live text the TUI renders above the input area (collected from the VIEWED agent; lib/agent/tool-messages.js).

### `Agent.toolStorage(toolname)`

Return this agent's mutable, transient storage object for one tool.

### `Agent.toolStorageClear(toolname)`

Clear one tool's transient storage, or every tool store when omitted.

### `Agent.get usage()`

Cumulative usage across every request THIS Agent has made — every IO terminal event's usage envelope, summed in memory.

### `Agent.EVENT_CALLBACKS = Object.freeze([…]`

IO callback property paired directly with its numeric Agent event.

### `Agent.finishAdd(fn, { process: proc = process } = {…})`

Register a synchronous cleanup to run at process finish.

### `Agent.finishRun()`

Run every registered cleanup.

### `Agent.finishSignalsArm({ process: proc = process, signals = ["SIGINT", "SIGTERM", "SIGHUP"], } = {…})`

Trap termination signals: run cleanups synchronously, then re-raise the signal with our handlers removed so the process dies by the signal itself.

### `Agent.reseat(agent, { id } = {…})`

Build the FRESH Agent that replaces `agent` for a new session.

### `Agent.TOOL_TIMEOUT_DEFAULT = 120_000`

Default Agent-enforced cap for one tool call: two minutes.

## App

## CLI

### `CLI.adoptResumeOrigin({ resume, anonymous = false, dir } = {…})`

Adopt an explicitly resumed session's origin folder as the cwd.

### `CLI.armCancelSignals({ onCancel, process: proc = process })`

Arm SIGINT/SIGTERM cancellation for a CLI binding.

### `CLI.close({ env, agent } = {…})`

Close a command-line library runtime.

### `CLI.completeOAuthPaste(input)`

Feed a pasted redirect URL / code#state to the in-flight flow.

### `CLI.defaultUrl(provider)`

Known setup defaults only; runtime endpoint discovery remains class-owned.

### `async CLI.execute(command)`

Execute one normalized administrative command.

### `CLI.EXIT = Object.freeze({…})`

Exit codes shared by the command-line tools.

### `CLI.exitCodeFor(terminal)`

Map a terminal done/error event (or an error-shaped `{kind}`) to the process exit code.

### `CLI.formatToolResult(result)`

A result value as printable text: a string as-is, else pretty JSON — ALWAYS a string (JSON.stringify(undefined) is the JS value undefined, not text, so that case is coerced explicitly).

### `CLI.listEndpointModels(env)`

Published endpoints with their published model ids for the menu; loginRequired flags endpoints whose credentials failed (see Agent).

### `CLI.listEndpoints(env)`

Every endpoint the catalog knows (secret ones included) — logout choices.

### `CLI.listModelCandidates(env)`

Published endpoint/model completion candidates.

### `async CLI.listModels(env)`

Every published endpoint's model ids once the background collection has answered (a provider failure shows its cached/static catalogue).

### `async CLI.loginEndpoint(env, { name, provider, url, token, auth, scope = "package", } = {…})`

Configure one endpoint and log it in (Env.login: the provider shapes the credentials — or a pre-seeded `auth`, e.g.

### `CLI.logoutEndpoint(env, name)`

Remove an endpoint (the /logout and --logout contract — Env.logout): its configuration and auth files go; an environment-detected endpoint clears in memory only and re-detects while the environment provides it.

### `CLI.oauthPasteOnly(descriptor)`

Is this flow paste-only (grant shape A with a NON-loopback redirect URI — the provider hosts the callback page and shows the code)?

### `CLI.parseAuthorizationInput(input)`

Parse pasted authorization input: a full redirect URL (`...?code=…&state=…`), `code#state`, or a bare code.

### `CLI.parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] })`

Parse argv into a flat options object.

### `async CLI.readContextFromStdin()`

Read stdin to EOF and parse it into a context array.

### `CLI.readLastCombo(env)`

the newest last-used published pair, or null

### `async CLI.readStdin()`

Read all of stdin, resolving only at EOF.

### `async CLI.refreshOAuthTokens(descriptor, refresh, { signal } = {…})`

Refresh stored OAuth credentials without repeating browser/device authorization.

### `CLI.renderSettingsTemplate(env)`

Render the template text: one commented-out line per known key, sorted, its default (or `null` when there isn't one) as the placeholder value and its description as a trailing comment.

### `CLI.resolveCliToolArgs(argv, entry)`

Resolve the tool CLI's shell-friendly non-JSON arguments.

### `async CLI.resolveModelCombo(value, env)`

Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model.

### `CLI.resolveToolArgs(raw, entry)`

Resolve a raw JSON-args string into a tool's actual args object.

### `async CLI.runLoginWizard(env, { input = process.stdin, output = process.stderr, } = {…})`

Cooked terminal wizard used by `--login`.

### `async CLI.runOAuthFlow(descriptor, options = {…})`

Run one OAuth sign-in.

### `async CLI.selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {…})`

No implicit endpoint/model exists: with neither `--model` nor a valid last-model.json, interactive callers start model-less.

### `CLI.tokensToAuth(tokens, previous = {…})`

Map a token response to the stored auth payload.

### `CLI.unwrapToolResult(value)`

Split a tool's return value into its {result, system?, display?} envelope (see the Tool contract's RETURNS section) — a plain return value is `result` with no side channels.

### `CLI.usageSummary(usage)`

One-line human-readable usage summary (e.g.

### `CLI.writeSettingsTemplate(env, { force = false } = {…})`

Write a fresh namespaced settings template into the project folder (env.cwd).

## Context

### `Context.assemblerCallbacks(assembler)`

The callback set (camelCase, matching lib/context/events.js) that assembles a response — Context "supplies the callback set".

### `Context.assemblerCreate()`

Create an assembler that consumes normalized IO response events into one assistant message.

### `Context.callbacksNormalize(callbacks = {…}, binding = {…})`

Build the full callback set for a binding.

### `Context.contentBinary(path, buffer)`

Build a canonical base64 binary Context block without leaking its source path.

### `Context.contentIndexer()`

Content-block numbering for a provider translator (msg2events) — the producer side of the `contentIndex` the assembler consumes.

### `Context.contentText(text)`

Wrap plain text in a text content block.

### `Context.ContentType = Object.freeze({…})`

Content block discriminators.

### `Context.append(message, options)`

Append a message, MERGING with the last one when possible (consecutive same-type messages / same-sub-type blocks fold — Context.appendMessage); `{merge: false}` keeps a boundary.

### `Context.at(i)`

The message at index `i` (negative counts from the end).

### `Context.blockAt(i, j)`

Block `j` of message `i` (RangeError when either index is out of range).

### `Context.close()`

Flush and close: a closed context refuses changes.

### `Context.constructor({ id, dir, messages = [], origin, uuid, name, settings, save = dir !== undefined } = {…})`

Create a context, optionally named and logged (the file is created on the first flush of a started conversation).

### `Context.deleteAll({ dir } = {…})`

Delete EVERY session file in the folder (the /sessions-delete-all!

### `Context.deleteById({ id, dir } = {…})`

Permanently delete a STORED session by id: every session file whose metadata carries that id (a leftover duplicate goes with it).

### `Context.edit(i, message)`

Replace message `i` (rebuilt from recognized fields; stale provider identifiers dropped).

### `Context.editBlock(i, j, block)`

Replace block `j` of message `i` (the message is rebuilt).

### `Context.errorPop()`

Retract a trailing FAILED RESPONSE before the context is submitted again: an assistant message carrying `error` that is still the last message was not responded to — the user continued as it stands — so it goes and the request is re-attempted.

### `Context.fileOf({ id, dir } = {…})`

The session file holding `id` in `dir` (a metadata-line scan), or undefined.

### `Context.flush()`

Synchronously make the CURRENT context durable (see _planFlush for the remove/none/append/full decision).

### `Context.flushAsync()`

Async counterpart for a live loop (Agent's request/tool turns); the synchronous flush() remains the crash/exit contract.

### `Context.idAnonymous(id)`

Does `id` spell an ANONYMOUS (memory-only, never logged) context: false, "0", "false" or "anon"?

### `Context.latest({ dir, cwd } = {…})`

The id of the most recently modified session in the folder (of the `cwd` origin when given), or undefined when the folder has none.

### `Context.get length()`

the message count

### `Context.list({ dir, cwd, limit = 50 } = {…})`

Every session in the folder, LATEST FIRST (one entry per id), each with a small preview: the first meaningful line of the first user message (see meaningfulLine; whitespace-folded, capped) and `agent`, the stored agent name when it is not a default `agent-N` one.

### `Context.listAsync({ dir, cwd, limit = 50 } = {…})`

Nonblocking counterpart of list().

### `Context.messages()`

a snapshot array of the messages (changing it never changes the context)

### `Context.originOf({ id, dir } = {…})`

The ORIGIN FOLDER recorded in a session file's metadata line (the cwd the session ran in), or undefined (no such session).

### `Context.pop()`

the removed last message

### `Context.prepend(messages)`

Insert messages at the FRONT — e.g.

### `Context.remove(indexes)`

Remove the messages at `indexes`.

### `Context.rename(newId)`

Rename the session: BOTH the stable `id` and the file's NAME segment become `newId` (the same session — the date/uuid8 prefix carries over unchanged) and the old file is gone.

### `Context.renameById({ id, name, dir } = {…})`

Rename a STORED session by id (the sidebar/menu path for a session no store holds open — a live one renames through its store): loads it, renames it (see rename()) and closes it again.

### `Context.resume({ id, dir, save = true } = {…})`

Load a session file into a fresh store holding its live context.

### `Context.rollback(i)`

Remove every message at index >= i (RangeError unless i is an existing index).

### `Context.get save()`

whether this context is logged to disk

### `Context.saveSet(value)`

Enable or disable persistence without replacing the live context.

### `Context.get settings()`

the owner's settings snapshot riding the session file (undefined: none recorded — resume keeps the caller's configuration)

### `Context.settingsSet(value)`

Record the owner's SETTINGS snapshot (an Agent's (safe, thinking, endpoint/model, name, … — Agent writes it; the store only persists it; a default `agent-N` name never rides the file).

### `Context.get summary()`

one line for status/command output: `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise

### `Context.toJSON()`

JSON form: the message array.

### `Context.update(fn)`

A batch in-place change (a repair pass): `fn` receives the live message array and returns true when it changed anything — the context then logs a full rewrite.

### `Context.eventCallbackName(eventName)`

Map an event name to its camelCase callback name.

### `Context.eventDispatch(set, event)`

Dispatch one event through a (normalized) callback set.

### `Context.EventType = Object.freeze({…})`

The full normalized event vocabulary.

### `Context.eventValid(event)`

Is this a well-formed normalized response event (a known `type`; indexed events carry a non-negative integer `contentIndex`)?

### `Context.eventValidate(event)`

Validate a normalized response event (used by IO to check connector output).

### `Context.FALLBACK_CONTEXT_WINDOWS = Object.freeze({…})`

Curated context windows for the CURRENT OpenAI tier, from the models docs (developers.openai.com/api/docs/models, reviewed 2026-09-28 — the gpt-6 family lists 1.05M; o-series 200K).

### `Context.fallbackContextWindow(model)`

The curated fallback window for one model id, or null: an exact key, then the longest table prefix the id starts with ("gpt-6-sol" -> "gpt-6", "o3-2025-04-16" -> "o3").

### `Context.messageAppend(context, message, { merge = true } = {…})`

Append a message to a caller-owned context, MERGING when possible: the message's own adjacent same-sub-type blocks fold first; when the context's last message is mergeable with it (same type, no linkage), their content concatenates (and re-folds) instead of appending a new message.

### `Context.messageAssistant(content = [])`

assistant message from content blocks

### `Context.messageErrorText(msg)`

Presentation text of an assistant failure; tool-result boolean errors are distinct.

### `Context.messageFile(path, buffer)`

Wrap one local file's bytes as a canonical user message.

### `Context.messageHasContent(msg)`

Has this message any CONTENT a provider can consume?

### `Context.messageHasError(msg)`

Does this message report a FAILED RESPONSE?

### `Context.messageIsRecord(msg)`

Is this a metadata RECORD (a string `type`, never a numeric message type)?

### `Context.messageRebuild(msg)`

Rebuild a message from recognized schema fields only — the stale provider/cache identifier cleanup.

### `Context.messagesParse(input)`

Parse buffered CLI input into a context array per the shared grammar.

### `Context.messagesValid(ctx)`

Is this a context (an array of core-shaped messages and/or records)?

### `Context.messagesValidate(ctx)`

Validate a context array.

### `Context.messageSystem(text)`

system message wrapping plain text

### `Context.MessageType = Object.freeze({…})`

Numeric message types.

### `Context.messageUser(text, metadata = undefined)`

user message wrapping text or preserving ordered blocks

### `Context.messageValid(msg)`

Is this a core-shaped message (a numeric `type` and a `content` array)?

### `Context.messageValidate(msg, at = "message")`

Validate a message's CORE SHAPE, throwing on a violation.

### `Context.MIME_BY_EXTENSION = Object.freeze({…})`

Context-owned media-type map and byte detection for content blocks.

### `Context.mimeDetect({ path, buffer } = {…})`

Detect a media type from a filename extension or recognized leading bytes.

### `Context.mimeOf(block)`

Return a content block's canonical media type.

### `Context.TOKENS_PER_WORD = 4 / 3`

tokens ≈ words × 4/3 (token-per-word likelihood ratio)

### `Context.tokensEstimate(text)`

@returns {number} estimated token count

### `Context.tokensEstimateMessages(context = [])`

Estimated token count of a whole context (the input side of a request — also the live "window consumption" readout when no provider-reported count exists yet).

### `Context.usageEstimate(context = [], message)`

Estimate usage from the request context and the assembled response.

### `Context.usageFinalize(reported, context, message)`

Normalize provider-reported usage, or fall back to estimation.

### `Context.usageSummary(usage)`

One-line human-readable usage summary (e.g.

### `Context.wordCount(text)`

@returns {number} whitespace-separated words

## Env

### `Env.agentAdd(agent)`

Register an active Agent (Agent construction owns this call); it stays until `Agent.close()` removes it.

### `Env.agentCreate(options = {…})`

Create an Agent over this env (`env` is always this env).

### `Env.agentRemove(agent)`

Remove an active Agent (`Agent.close()` owns normal use).

### `Env.agents()`

Snapshot the active Agents in registration order.

### `Env.close()`

Release what this Env runs in the background: pending model-list retries stop, every MCP server it started is killed, and held settings writes reach disk.

### `Env.connection(selector, { remember = true } = {…})`

IO's handle on one pair: {endpoint, model, Protocol, url, settings, authSet(data), authReload(current)} (lib/env/models.js).

### `Env.constructor({ dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings, providers, toolDirs, skillDirs, promptDirs } = {…})`

Build the environment: scan and merge the layered settings (the package folder, user settings folder, and namespaced project files — see lib/env/load.js), seed the titled folder surface, register the built-in tools.

### `Env.create(options, initOptions = {…})`

Create a ready-to-use environment.

### `Env.EVENT`

The Env event vocabulary: Symbol constants for onEvent/offEvent.

### `Env.extend(plugin)`

Install a higher layer's Env members after the fact (a plugin): `methods`/`getters` land on Env.prototype and run on the env they were reached through (the safe view included); `events` add Symbol keys to Env.EVENT; `settings` add the layer's settings keys to the defaults schema.

### `Env.get folders()`

The folders that matter to a session, computed from current state (the project folder follows `cwd`): exactly one `project` and one `harness` (the package folder in use), the user `settings` folder unless disabled, then each tool root.

### `Env.login(name, config, options)`

Log an endpoint in — one transaction (lib/env/login.js): credentials (`auth`, else the provider shapes `token`), then with a `scope` the endpoint persists, is verified (the provider's connection test, then `verify(models)` over its new catalog entries) and its models are fetched — any failure rolls memory and files back.

### `Env.loginPresets()`

The login presets every non-secret provider publishes ({name, label, url, provider, oauth?, note?, ...}).

### `Env.logout(name)`

Remove an endpoint (the /logout contract): its configuration and auth files go with every in-memory trace; an environment-detected endpoint clears in memory only.

### `Env.models(secret = false)`

The model catalog: every known endpoint/model pair with its state already computed (lib/env/models.js ModelInfo — caps, secret, local, loginRequired, lastUsed, plugin capacity fields).

### `Env.get modelsReady()`

Settles when the background collection's first pass has answered (one-shot hosts: list models, resolve an endpoint-only selector) — including the lists of in-memory logins, fetched now on demand.

### `Env.offEvent(handle)`

Remove a generic Env lifecycle listener by its opaque handle.

### `Env.onEvent(event, callback)`

Subscribe to an Env event (distinct from Agent.onEvent's numeric events — these are Symbols).

### `Env.prompts()`

The merged prompts (same layers; a later same-named prompt replaces an earlier one), read fresh from disk — same entry shape.

### `Env.get settings()`

The LIVE settings view (lib/env/settings-view.js): reads apply the defaults schema and derived values (`settings.sessions` is the resolved sessions folder); assigning or deleting a key persists only that change, coalesced per tick, to the layer file that owns it (never the package folder).

### `Env.settingsSchema()`

The DEFAULTS SCHEMA: every top-level settings key Env (or a loaded tool — see the tools.js module contract's `settingsSchema()`) understands, its default and a one-line description.

### `Env.skills()`

The merged skills (package, settings, configured, environment and project layers; later layers merge into same-named skills), read fresh from disk: name -> {name, description, file, source, body}.

### `Env.systemPrompt()`

The system-prompt text(s) seeded into a FRESH context, read from disk on every call (package, user settings, then project AGENTS.md — or `settings.system`), with `{{skill}}` prefill.

### `Env.toolAdd(name, fn, schema, { builtin = false, file } = {…})`

Register a tool into the flattened callable lookup (lib/env/tool-registry.js — the safe/interactive schema metadata contract lives there).

### `Env.toolCall(name, args, context)`

Invoke one tool (lib/env/tool-registry.js).

### `Env.tools(safe = false, selector)`

The tool catalog: name -> ToolInfo ({name, schema, safe, trusted, sandbox, secret, interactive, builtin, file?, storage?, status?, onTimeout?, detect?} — never the callable).

## GTUI

### `GTUI.effect = freeze({…})`

Immutable constructors for host, task, timer, theme, and lifecycle effects.

### `GTUI.effect.after(ms, message)`

Deliver a message after a delay.

### `GTUI.effect.cancel(key)`

Cancel the task for a key.

### `GTUI.effect.copy(text, id)`

Copy text through the host.

### `GTUI.effect.notify(text)`

Ask the host to show a notification.

### `GTUI.effect.open(url)`

Ask the host to open a URL.

### `GTUI.effect.quit(code = 0)`

End the application with a status code.

### `GTUI.effect.refresh()`

Request a render without changing the model.

### `GTUI.effect.task(key, run)`

Run an abortable asynchronous task.

### `GTUI.effect.theme(tokens)`

Replace theme tokens.

### `GTUI.event = freeze({…})`

Immutable constructors for messages delivered to an application update function.

### `GTUI.event.copyDone(payload)`

Create a completed-copy event.

### `GTUI.event.focus(payload)`

Create a focus event.

### `GTUI.event.inputChange(payload)`

Create an input-change event.

### `GTUI.event.inputSubmit(payload)`

Create an input-submit event.

### `GTUI.event.key(payload)`

Create a key event.

### `GTUI.event.linkOpen(payload)`

Create a link-open event.

### `GTUI.event.menuCancel(payload = {…})`

Create a menu-cancel event.

### `GTUI.event.menuSelect(payload)`

Create a menu-selection event.

### `GTUI.event.paste(payload)`

Create a paste event.

### `GTUI.event.pointer(payload)`

Create a pointer event.

### `GTUI.event.resize(payload)`

Create a resize event.

### `GTUI.event.selectionCopy(payload)`

Create a selection-copy event.

### `GTUI.event.taskDone(payload)`

Create a completed-task event.

### `GTUI.event.taskFailed(payload)`

Create a failed-task event.

### `GTUI.constructor({ host, theme = {…} } = {…})`

Create a runtime for a host.

### `GTUI.dispatch(message)`

Deliver one message immediately to the running application.

### `GTUI.run(app)`

Start an application and return its eventual completion result.

### `GTUI.stop(reason = "stop", code = 0)`

Stop the application, canceling tasks and timers and restoring the host.

### `GTUI.host = freeze({…})`

Host constructors for tests and terminal execution.

### `GTUI.host.memory(...)`

Create a memory host for deterministic application tests.

### `GTUI.host.terminal(...)`

Create a terminal host for interactive execution.

### `GTUI.memory({ width = 80, height = 24, scrollBar } = {…})`

Create an in-memory host for application tests.

### `GTUI.memory._effect(value, send)`

Record an effect and acknowledge copy effects asynchronously.

### `GTUI.memory._render(next)`

Render a view through the in-memory layout engine.

### `GTUI.memory._restore()`

Clear runtime callbacks and record host restoration.

### `GTUI.memory._setTheme(theme)`

Install the resolved theme for subsequent layouts.

### `GTUI.memory._start(listener, binding)`

Start the runtime-to-host message protocol.

### `GTUI.memory.get effects()`

Recorded effects, copied so callers cannot mutate host state.

### `GTUI.memory.flush()`

Finish pending host output; memory hosts have nothing to flush.

### `GTUI.memory.get restoreCount()`

Number of completed host restoration cycles.

### `GTUI.memory.send(message)`

Send a host input message to the mounted application.

### `GTUI.memory.snapshot()`

Return the current rendered scene in semantic, testable form.

### `GTUI.scrollGlyph(value, fallback)`

Return a one-cell grapheme or the supplied fallback.

### `GTUI.terminal(options = {…})`

Construct a terminal host that owns input decoding and terminal rendering.

### `GTUI.view = freeze({…})`

Immutable constructors for renderable view nodes.

### `GTUI.view.button(props = {…}, label = "")`

A toolbar button (`{action, id?, icon?, pressed?, tone?, priority?}`): a click or Enter/Space emits `action.select {id, action}`.

### `GTUI.view.column(...)`

Create an immutable vertical container.

### `GTUI.view.feed(props = {…})`

Create an immutable feed control.

### `GTUI.view.footer(props = {…}, items = [])`

A one-line footer of app-pushed notification items (`{text, role?, priority?, align?: "start"|"end", action?}`): `start` items on the left, `end` items on the right, " · " between; a tight row drops the lowest `priority` first.

### `GTUI.view.grid(...)`

Create an immutable grid container.

### `GTUI.view.input(props = {…})`

Create an immutable text input control.

### `GTUI.view.menu(props = {…})`

Create an immutable menu control.

### `GTUI.view.overlay(...)`

Create an immutable overlay container.

### `GTUI.view.panel(...)`

Create an immutable bordered panel.

### `GTUI.view.row(...)`

Create an immutable horizontal container.

### `GTUI.view.scroll(...)`

Create an immutable scroll container.

### `GTUI.view.table(props = {…}, rows = [])`

Create an immutable table with frozen rows and cells.

### `GTUI.view.text(props = {…}, content = "")`

Create immutable text content.

### `GTUI.view.toolbar(...)`

A one-line row of `button`s with host-owned roving focus (`{id, focus, gap?, align?: "end"}`): while focused, ←/→ Tab/Shift+Tab Home/End move between buttons (`toolbar.change`), Enter/Space activate; other keys bubble.

## index

## IO

### `IO.Context`

The Context namespace for validating every provider-bound request.

### `IO.Env`

The global environment constructor used by IO and provider authors.

### `IO.authSet(auth, options)`

Route auth persistence to the endpoint's namespace and refresh the live settings view.

### `IO.close()`

Cancel the active request (terminal partial emitted by the in-flight write), close the connection, permanently disconnect the instance.

### `IO.connectionCreate({ signal, onBytes } = {…})`

A fresh provider connection over this endpoint/model for a provider tool's one-off request (context2msg/send/read/close); the caller closes it.

### `IO.constructor({ env, model, url, timeout, connectTimeout, stuckTimeout, settings, tools, safe = false, onData, onLog, remember = true } = {…})`

Configure one provider IO session: resolve the provider module from the registered endpoint and resolve the model, endpoint URL, and three timeouts from options > provider settings > provider metadata > defaults.

### `IO.get contextUsage()`

The provider-reported context readout of the CURRENT/last request: `{used, total}` in tokens, each undefined when the provider hasn't reported it.

### `IO.contextUsageSet({ used, total } = {…})`

Report actual context consumption and/or the model's available context window (provider → IO channel; connectors call this from their translators/metadata surfaces).

### `IO.fetch(url, init = {…}, { deadline, connectTimeout } = {…})`

fetch bounded by a wall-clock deadline and a fast connect fail-fast (provider tools' plain HTTP requests).

### `IO.get modelCurrent()`

effective model: per-request override wins over the instance default

### `IO.get planUsage()`

The provider-reported PLAN/QUOTA readout (rate limits, subscription allowances): `{label?, quotas}` where each quota entry is `{total?, remaining?, used?, reset?}` — whatever the provider publishes, nothing invented.

### `IO.planUsageSet({ label, quotas } = {…})`

Report plan/quota usage (provider → IO channel; connectors call this from their reportPlanUsage hook or metadata surfaces).

### `IO.get requestSignal()`

the in-flight request's abort signal (used by the HTTP backend)

### `IO.get settings()`

live provider-namespaced settings view (explicit overrides merged over the Env namespace).

### `IO.settingsSet(key, value)`

Set/clear a per-invocation settings override AFTER construction (e.g.

### `IO.get state()`

The request state machine's current state.

### `IO.tools()`

]: availability, safe mode, the selection, and the pair's provider tools applied; secret tools never publish)

### `IO.write(context, callbacks = {…}, options = {…})`

Run one provider request over a complete context.

### `IO.ProviderError.constructor(kind, message, detail = {…})`

Build a stable classified provider error.

### `IO.THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"]`

Selectable thinking levels, weakest -> strongest (IO maps them to native modes).

### `IO.timeoutsResolve({ env, model, timeout, settings } = {…})`

The effective overall request timeout without constructing a connection: explicit > endpoint settings > provider metadata > default.

## Jobs

### `async Jobs.daemonRun(projectRoot, options = {…})`

Run a foreground, cwd-bound best-effort daemon: one in-process scan (dispatchJobs) per wake.

### `async Jobs.disable(projectRoot, options = {…})`

Disable by renaming the active directory.

### `async Jobs.init(projectRoot, settings = {…}, options = {…})`

Enable folder-only Jobs, restoring a disabled directory without changing bytes.

### `Jobs.JobsError.constructor(code, message, details = {…})`

Construct a coded domain failure; details carry context such as the task filename or the underlying cause.

### `async Jobs.run(projectRoot, options = {…})`

Best-effort serial scan.

### `async Jobs.schedule(root, command, options = {…})`

Shared task command boundary.

### `async Jobs.status(projectRoot, options = {…})`

Read-only status projection.

### `async Jobs.validate(root, options = {…})`

Operational eligibility is checked at publication and invocation from folder state.

## Markdown

### `Markdown.BashSanitizer.constructor({ markdown = false } = {…})`

Create one sanitizer for one live tool call.

### `Markdown.BashSanitizer.end()`

Flush held bytes (dropping an unfinished escape) when the call ends.

### `Markdown.BashSanitizer.push(chunk)`

Sanitize the next raw chunk.

### `Markdown.classifyLine(line, state = {…})`

Classify one complete line of markdown.

### `async Markdown.lexMarkdown(text)`

Tokenize complete markdown text.

### `async Markdown.markdownEngine()`

Which engine whole-text rendering routes through: "marked" when the optional package resolved, "builtin" otherwise.

### `Markdown.mathBlockAt(lines, start)`

A complete, line-delimited display-math block, or null.

### `Markdown.mathText(node)`

Plain-text fallback for renderers without mathematical typesetting.

### `Markdown.parseGitDiff(text)`

Parse one complete unified Git diff synchronously, with exact source-line spans.

### `Markdown.parseInline(text)`

Tokenize inline markdown into flat spans.

### `Markdown.parseMath(source)`

Parse a bounded, safe TeX subset into presentation-independent nodes.

### `Markdown.renderInline(text, renderer = {…})`

Render one fragment of inline markdown through a renderer's inline callbacks, synchronously, via the builtin tokenizer (engine routing needs whole text — inline fragments don't have it).

### `async Markdown.renderMarkdown(text, renderer = {…})`

Render complete markdown text through a renderer's callbacks, engine-routed (see lexMarkdown).

### `Markdown.sanitizeText(text, { markdown = false, state = null, open = false } = {…})`

Sanitize a COMPLETE untrusted string for display.

### `Markdown.walkTokens(tokens, renderer = {…})`

Walk block tokens through a renderer (completed internally).

## Sandbox

### `Sandbox.osAvailable()`

Is OS write-sandbox enforcement in effect (own mechanism or a detected outer jail)?

### `Sandbox.osKind()`

The OS write-sandbox mechanism in effect: "seatbelt", "bwrap", "delegated" (an outer jail already confines this process; the wrap is a passthrough), or null (no enforcement; Agent forces safe mode).

### `Sandbox.osWrap(file, args, cwd, workingDirectory)`

Wrap a program invocation in the OS write sandbox: the [file, argv] to spawn (unchanged when no mechanism applies).

### `Sandbox.processStop(child, options)`

Stop a process/group and await closure; safe to call repeatedly.

### `Sandbox.scope()`

Create a process scope owned and closed by one tool dispatch.

### `Sandbox.spawn(file, args, options)`

Spawn a process using the same ownership policy as scoped calls.

## TUI

### `TUI.close(runtime)`

Close TUI-owned agents, sessions, and background resources.

### `TUI.createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit })`

Create the piped, cooked-mode front end; one input message per line.

### `TUI.createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows })`

The interactive REPL.

### `TUI.run(state)`

Run the complete TUI application from normalized declarative state.

### `TUI.TUI_ENGINES = TUI_MODES`

The rendering modes accepted by createRepl.

## Web
