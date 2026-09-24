# API (2026-09-24)

## Markdown

### `Markdown.parseGitDiff(text)`

Parse one complete unified Git diff synchronously, with exact source-line spans.

### `async Markdown.markdownEngine()`

Which engine whole-text rendering routes through: "marked" when the optional package resolved, "builtin" otherwise.

### `async Markdown.lexMarkdown(text)`

Tokenize complete markdown text: `marked`'s lexer (gfm, breaks) when available, the builtin lexer otherwise — same token shapes either way, ready for walkTokens.

### `async Markdown.renderMarkdown(text, renderer = {…})`

Render complete markdown text through a renderer's callbacks, engine-routed (see lexMarkdown).

### `Markdown.renderInline(text, renderer = {…})`

Render one fragment of inline markdown through a renderer's inline callbacks, synchronously, via the builtin tokenizer (engine routing needs whole text — inline fragments don't have it).

### `Markdown.parseInline(text)`

Tokenize inline markdown into flat spans.

### `Markdown.classifyLine(line, state = {…})`

Classify one complete line of markdown.

### `Markdown.walkTokens(tokens, renderer = {…})`

Walk block tokens through a renderer (completed internally).

## Context

### `Context.parseInput(input)`

Parse a buffered input string (such as CLI input after EOF) into a context array.

### `Context.MessageType = Object.freeze({…})`

Numeric message types.

### `Context.ContentType = Object.freeze({…})`

Content block discriminators.

### `Context.textContent(text)`

Wrap plain text in a text content block.

### `Context.userMessage(text, metadata = undefined)`

user message wrapping text or preserving ordered blocks

### `Context.systemMessage(text)`

system message wrapping plain text

### `Context.assistantMessage(content = [])`

assistant message from content blocks

### `Context.mimetypeOf(block)`

Return a content block's canonical media type.

### `Context.MIME_BY_EXTENSION = Object.freeze({…})`

Context-owned media-type map and byte detection for content blocks.

### `Context.detectMime({ path, buffer } = {…})`

Detect a media type from a filename extension or recognized leading bytes.

### `Context.binaryContent(path, buffer)`

Build a canonical base64 binary Context block without leaking its source path.

### `Context.fileMessage(path, buffer)`

Wrap one local file's bytes as a canonical user message.

### `Context.isMessage(msg)`

Is this a core-shaped message (a numeric `type` and a `content` array)?

### `Context.isRecord(msg)`

Is this a metadata RECORD (a string `type`, never a numeric message type)?

### `Context.isContext(ctx)`

Is this a context (an array of core-shaped messages and/or records)?

### `Context.hasContent(msg)`

Has this message any CONTENT a provider can consume?

### `Context.validateMessage(msg, at = "message")`

Validate a message's CORE SHAPE, throwing on a violation.

### `Context.validateContext(ctx)`

Validate a context array.

### `Context.EventType = Object.freeze({…})`

The full normalized event vocabulary.

### `Context.callbackName(eventName)`

Map an event name to its camelCase callback name.

### `Context.isResponseEvent(event)`

Is this a well-formed normalized response event (a known `type`; indexed events carry a non-negative integer `contentIndex`)?

### `Context.validateResponseEvent(event)`

Validate a normalized response event (used by IO to check connector output).

### `Context.normalizeCallbacks(callbacks = {…}, binding = {…})`

Build the full callback set for a binding.

### `Context.dispatch(set, event)`

Dispatch one event through a (normalized) callback set.

### `Context.parseContext(input)`

Parse buffered CLI input into a context array per the shared grammar.

### `Context.createAssembler()`

Create an assembler that consumes normalized IO response events into one assistant message.

### `Context.assemblyCallbacks(assembler)`

The callback set (camelCase, matching lib/context/events.js) that assembles a response — Context "supplies the callback set".

### `Context.foldContent(content)`

Fold ADJACENT same-sub-type text/thinking blocks within one content array (a stream with repeated indexes, or a cross-message merge, can leave runs of them — one logical block should BE one block).

### `Context.mergeableMessages(a, b)`

Can two CONSECUTIVE messages merge into one?

### `Context.appendMessage(context, message, { merge = true } = {…})`

Append a message to a caller-owned context, MERGING when possible: the message's own adjacent same-sub-type blocks fold first; when the context's last message is mergeable with it (same type, no linkage), their content concatenates (and re-folds) instead of appending a new message.

### `Context.at(context, i)`

Address a message: context[i], validated (throws on a bad integer index or shape).

### `Context.blockAt(context, i, j)`

Address a content block: context[i].content[j], validated (RangeError when j is out of range).

### `Context.rebuildMessage(msg)`

Rebuild a message from recognized schema fields only — the stale provider/cache identifier cleanup.

### `Context.rebuildBlock(block)`

Rebuild one content block per the module-header field policy.

### `Context.editMessage(context, i, newMessage)`

Replace context[i] with an edited message, rebuilt from recognized fields (stale provider/cache identifiers dropped).

### `Context.editBlock(context, i, j, newBlock)`

Replace context[i].content[j] with an edited block.

### `Context.rollbackTo(context, i)`

Roll back to index i: remove messages at index >= i.

### `Context.pop(context)`

Remove and return the last message.

### `Context.removeMessages(context, indexes)`

Remove selected message indexes and return them in source order.

### `Context.TOKENS_PER_WORD = 4 / 3`

tokens ≈ words × 4/3 (token-per-word likelihood ratio)

### `Context.wordCount(text)`

@returns {number} whitespace-separated words

### `Context.estimateTokens(text)`

@returns {number} estimated token count

### `Context.estimateContextTokens(context = [])`

Estimated token count of a whole context (the input side of a request — also the live "window consumption" readout when no provider-reported count exists yet).

### `Context.estimateUsage(context = [], message)`

Estimate usage from the request context and the assembled response.

### `Context.finalizeUsage(reported, context, message)`

Normalize provider-reported usage, or fall back to estimation.

### `Context.usageSummary(usage)`

One-line human-readable usage summary (e.g.

## Env

### `Env.create(options, initOptions = {…})`

Create a ready-to-use environment.

### `Env.constructor({ dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings } = {…})`

Build the environment: scan and merge the layered settings (the package folder, user settings folder, and namespaced project files — see lib/env/load.js), seed the titled folder surface, register the built-in tools.

### `Env.get settings()`

the merged settings tree (live reference)

### `Env.get toolTimeout()`

Default Agent-enforced duration of one tool call.

### `Env.get toolTimeoutLimit()`

Hard ceiling for a tool's schema-declared, model-requested `timeout` argument.

### `Env.get contextGuardCap()`

The Agent tool loop's runaway guard: the OVERALL context-usage ceiling, a (0,1] fraction of the model's context window (settings value > 1 reads as a percentage).

### `Env.get contextGuardTurnCap()`

The Agent tool loop's runaway guard: the PER-TURN context-growth ceiling, a (0,1] fraction of the model's context window — even starting near-empty, one agent turn alone cannot consume more than this before it's stopped.

### `Env.get maxAttempts()`

Provider-request attempts per IO turn (settings.maxAttempts, default 3): the first write plus its retries — only failure classes that can heal with time retry (Env.RETRYABLE_KINDS); the interval grows from retryBase, doubling per attempt, capped at retryMax (lib/env/reliability.js).

### `Env.retryDelay(attempt)`

One retry's delay (lib/env/reliability.js): retryBase doubling per attempt, capped at retryMax, jittered against lockstep.

### `Env.contextWindow(endpoint, model)`

The model's context window in tokens, WHEN KNOWN: an explicit provider-settings override (`<provider>.contextWindow`) wins over the cached model descriptor's `contextWindow` (the models() snapshot persisted in the provider's auth namespace).

### `Env.contextConsumption(context, lastUsage)`

Current context consumption in tokens: the provider-reported input count of the last request when available (the exact number the provider processed), else the word-count estimate of the live context (the token-per-word likelihood ratio).

### `Env.resolveSystemPrompt()`

The system-prompt text(s) for a FRESH session — read fresh from disk on EVERY call, never cached (lib/env/system-prompt.js).

### `Env.endpointSettings(endpoint)`

Live endpoint configuration plus endpoint-keyed auth/model cache (lib/env/endpoints.js).

### `Env.authSet(endpoint, data, { scope } = {…})`

Persist endpoint-keyed auth/model data: creates/updates `auth-<endpoint>.json` holding `{ [endpoint]: data }` (tokens + cached model list) in the endpoint's scope — the project folder ("local") or the effective user-settings folder ("package", the default; the package folder itself is used only when settingsDir is null).

### `Env.saveEndpoint(name, endpoint, { scope = "package" } = {…})`

Add/update one configured endpoint and persist it to the scope's settings file (the user settings folder or namespaced project file).

### `Env.removeEndpoint(name)`

Remove an endpoint — the /logout contract: its configuration drops out of the scope's settings file, its auth file is deleted, and every in-memory trace is removed.

### `Env.batch(fn)`

Run fn inside a WRITE BATCH: every settings-file write it triggers (authSet, saveEndpoint — a login performs several) is held in memory and each file lands ONCE, atomically, when the outermost batch ends.

### `Env.flushSettings()`

Flush any batched settings writes now (a no-op outside a batch).

### `Env.saveTheme(name)`

Select and persist a named TUI theme in the effective settings file.

### `Env.registerAgent(agent)`

Register an active Agent.

### `Env.agents()`

Snapshot the active sessions.

### `Env.removeAgent(agent)`

Remove an active Agent.

### `Env.onEvent(event, callback)`

Subscribe to a generic Env lifecycle event (distinct from Agent.onEvent's numeric turn events — these are Symbols).

### `Env.offEvent(handle)`

Remove a generic Env lifecycle listener by its opaque handle.

### `Env.agentsEndpointLimit(endpoint, model)`

Effective active-Agent cap for an endpoint/model scope.

### `Env.agentsAt(endpoint, model)`

Count registered active Agents at an endpoint, optionally one model.

### `Env.agentEndpointAvailable(endpoint, model)`

Current unreserved active-Agent capacity; never reserves a slot.

### `Env.agentsEndpointLimitSet(options)`

Persist an endpoint/model active-Agent cap.

### `Env.registerProvider(name, ProviderClass)`

Register and internally complete a basename-keyed protocol class.

### `Env.provider(name)`

a communication protocol class by basename

### `Env.providerNames()`

registered communication protocol basenames

### `Env.knownEndpoints()`

Known endpoint presets offered by the login wizards (lib/env/endpoints.js).

### `Env.endpointScope(name)`

The scope an endpoint's settings/auth live in: "local" when its configuration came from the namespaced PROJECT settings file, "package" otherwise (user settings or package files).

### `Env.endpoint(name)`

one named endpoint configuration

### `Env.endpointLocal(name)`

Is an endpoint LOCAL (lib/env/endpoints.js endpointLocal): project- scope configuration or a record publishing `local: true` / `remote: false` — the shared predicate the model-list access policy classifies with.

### `Env.isDynamic(name)`

Is the endpoint ENVIRONMENT-DEFINED (auto-detected from the process environment)?

### `Env.endpointNames({ includeSecret = false, access = "all" } = {…})`

Endpoint names; secret entries are hidden unless explicitly requested.

### `Env.get local()`

Are LOCAL endpoints exposed to linked-agent spawning?

### `Env.get remote()`

Are REMOTE (public) endpoints exposed to linked-agent spawning?

### `Env.registerTool(name, fn, schema, { builtin = false, file } = {…})`

Register a tool into the flattened callable lookup (lib/env/tool-registry.js — the safe/interactive schema metadata contract lives there).

### `Env.updateToolStatus(name, info)`

Merge a live-status object into a tool's registry entry; /status prints it, the TUI renders it below the status bar.

### `Env.toolStatus()`

tools with a live status object

### `Env.toolNames()`

all flattened tool names

### `Env.get safe()`

The SAFE VIEW of this environment: one cached facade (a Proxy) whose TOOL surface is limited to read-only (`safe: true`) tools (lib/env/tool-registry.js).

### `Env.safeToolNames()`

The READ-ONLY tools: schemas published with `safe: true`.

### `Env.toolSchemas(names, options)`

The publishable tool catalog.

### `Env.defaultsSchema()`

The DEFAULTS SCHEMA: every top-level settings key Env (or a loaded tool — see the tools.js module contract's `settingsSchema()`) understands, its default and a one-line description.

### `Env.defaultProviderRoots()`

Protocol roots: installed/package providers, an optional custom package root, and configured paths (never the project folder).

### `Env.loadProviders({ dirs, detect = true } = {…})`

Load default-exported provider classes, keyed by each file basename.

### `Env.endpointModels(name, { refresh = false, url, signal } = {…})`

One endpoint's model MAP.

### `Env.refreshModels({ timeout = 2000 } = {…})`

Query EVERY configured endpoint for its available models (parallel, each bounded by `timeout`): the startup cache renewal.

### `Env.detectEndpoints({ timeout = 300 } = {…})`

Run provider-owned endpoint probes and fill only absent settings entries.

### `Env.hasTool(name)`

@returns {boolean}

### `Env.toolEntry(name)`

The registry entry for a tool ({fn, schema, builtin?, file?, safe?, interactive?, sandbox?, onTimeout?, status?}), or undefined.

### `Env.defaultToolRoots()`

Tool-folder roots: the installed package and user settings folders, administrator-controlled system roots, and explicitly configured `settings.tools` roots.

### `Env.defaultSkillRoots()`

Skill roots, accumulated from the package, settings, configured, environment, and project layers.

### `Env.defaultPromptRoots()`

Prompt roots, ACCUMULATED the same way as skill roots.

### `Env.skillCatalog({ debug = false, roots } = {…})`

The merged skill catalog as `# Skill Catalog` text.

### `Env.skillBodies(names, { roots } = {…})`

The full bodies of the named skills, each wrapped in `<skill name="...">` tags.

### `Env.promptCatalog({ debug = false, roots } = {…})`

The merged prompt catalog, same shape as skillCatalog().

### `Env.promptNames({ roots } = {…})`

The merged prompt NAMES (sorted) — completion candidates.

### `Env.promptNamesAsync({ roots } = {…})`

Async prompt names, with the same roots and override semantics.

### `Env.promptBody(name, { roots } = {…})`

One prompt's body, verbatim (no interpolation).

### `Env.loadTools({ dirs } = {…})`

Tool scan-and-load: import each root's TOP-LEVEL JS modules (the scan is NOT recursive) and publish described-and-exported callables.

### `Env.refreshToolAvailability()`

Recheck dynamic tool eligibility before a model request; does not rescan modules.

### `Env.refreshTools()`

Rescan the tool roots and rebuild the tool/schema/callable maps.

### `Env.toolTimestamp()`

The shared tool-refresh revision: bumped on every refreshTools() scan.

### `Env.osSandboxKind()`

The OS write-sandbox mechanism in effect: "seatbelt", "bwrap", "delegated" (an OUTER jail already confines this process — the wrap is a passthrough), or null (no enforcement — the Agent forces safe mode then).

### `Env.osSandboxAvailable()`

Is OS write-sandbox ENFORCEMENT in effect for this process — our own mechanism (seatbelt on macOS, bwrap on Linux) or an OUTER jail we detected (a nested seatbelt confines us already)?

### `Env.osSandboxWrap(file, args, cwd)`

Wrap a program invocation in the OS write sandbox: the [file, argv] to spawn (the input unchanged when no mechanism applies).

### `Env.callTool(name, args, context)`

Exact flattened lookup + invoke.

### `Env.createAgent(options = {…})`

Convenience Agent factory, creating an agent attached to this `Env` instance.

### `Env.deepMerge(a, b)`

Objects merge recursively; arrays concatenate; scalar collisions take the later value (incidental read order — not a precedence mechanism).

### `Env.parseDuration(value)`

Parse a duration: a positive millisecond numeral or a unit string ("500ms", "20s", "5m", "1.5h").

### `Env.tryDuration(value)`

parseDuration that never throws — invalid/empty input is undefined.

### `Env.DEFAULT_TOOL_TIMEOUT = 120_000`

Default Agent-enforced cap for one tool call: two minutes.

### `Env.DEFAULT_TOOL_TIMEOUT_LIMIT = 20 * 60_000`

Maximum model-requested tool duration: twenty minutes.

### `Env.TOOL_ON_TIMEOUT_LIMIT = 60_000`

Maximum Agent-facing onTimeout cleanup/final-response grace.

### `Env.DEFAULT_CONTEXT_GUARD_CAP = 0.9`

The overall context-usage ceiling: 90% (always leaves /compact room).

### `Env.DEFAULT_CONTEXT_GUARD_TURN_CAP = 0.4`

The per-turn context-growth ceiling: 40%.

### `Env.retryDelay(settings, attempt)`

One attempt's delay: retryBase doubling per retry (attempt 0 is the first RETRY — the write before it already happened), bounded by retryMax, spread by up to a quarter of the base so simultaneous retries do not land in lockstep.

### `Env.RETRYABLE_KINDS = Object.freeze(["network", "provider", "auth"])`

The classified error kinds an Agent retries after a growing interval (lib/agent/run.js).

### `Env.awaitTimeout(ms, wait)`

awaitTimeout — race a completion event against a deadline (the Promise.race pattern), resolving true for completion and false for the deadline.

### `Env.THINKING_LEVELS = ["default", "off", "low", "medium", "high", "xhigh"]`

Selectable thinking levels, "default" first, then weakest → strongest.

### `Env.DEFAULT_THINKING = "high"`

The effort used when the model advertises no default of its own.

### `Env.resolveEffort(think, { levels, defaultLevel } = {…})`

Translate a `think` option to one native effort symbol.

### `Env.sortEfforts(levels)`

Order native effort symbols weakest → strongest, dropping duplicates (unranked symbols keep their relative order at the end).

### `Env.registryEffortLevels(entry)`

The effort symbols a models.dev registry entry declares (`reasoning_options: [{type: "effort", values}]`), or undefined.

### `Env.supportedValues(message)`

The values an API error lists as supported ("...

### `Env.defineProvider(Protocol, { name } = {…})`

Complete a standalone provider class with OpenAI-compatible defaults.

### `Env.ProviderError.constructor(kind, message, detail = {…})`

Build a stable classified provider error.

### `Env.classifyError(err, providerName)`

Classify a raw error into the stable provider taxonomy.

### `Env.depletionError(classified)`

The shared TOKEN-DEPLETION predicate: exact signals only.

### `Env.writeJsonAtomic(file, value)`

Atomically write one JSON value (pretty-printed, trailing newline): temp file in the same folder + rename.

### `Env.ENV_EVENT = Object.freeze({…})`

Generic Env lifecycle events.

### `Env.defaultSettingsDir()`

The namespace user settings folder, resolved in compatibility order: environment overrides, an existing legacy `.ai-settings` home, then the namespace home (created when missing).

### `Env.defaultSessionsDir()`

The namespace sessions folder under settings (created when missing).

### `Env.isToolModuleFile(name)`

Tool-module filename filter: files named like benches, tests, or demos are NEVER imported by the tool scan.

### `async Env.scanToolRoots(roots, env, { trustedRoots = [] } = {…})`

Scan tool roots into a flattened name -> { fn, schema, file, safe?

### `Env.osSandboxAvailable()`

Is OS write-sandbox ENFORCEMENT in effect for this process — our own mechanism (seatbelt/bwrap) or an OUTER jail we detected (a nested seatbelt confines us already)?

### `Env.osSandboxKind()`

The sandbox mechanism in effect: "seatbelt", "bwrap", "delegated" (an outer jail enforces writes — our wrap is a passthrough), or null (no enforcement — the Agent forces safe mode then).

### `Env.osSandboxWrap(file, args = [], cwd = process.cwd(), workingDirectory = cwd)`

Wrap a program invocation in the OS sandbox: the [file, argv] to spawn — the wrapper and its arguments followed by the original program — or the input unchanged when no mechanism applies.

### `Env.HttpStatusError.constructor(status, statusText, body)`

Build the error from a non-2xx response (the body's first 200 characters ride in the message).

### `Env.defaultConnect(url, aiio)`

stateless HTTP connection

### `async Env.defaultSend(connection, msg)`

Default send: msg = [headers, body].

### `async Env.defaultSendHeaders(connection, headers)`

@param {object} headers plain object

### `async Env.defaultSendBody(connection, body)`

Completes the request: POSTs the JSON body (nil body -> no payload) and stores the Response for defaultRead.

### `async Env.defaultRead(connection)`

Blocking-await line reader: resolves the next whole line-delimited JSON message, nil at end-of-stream.

### `async Env.defaultClose(connection)`

Teardown: cancel the body stream; idempotent.

### `Env.singleShot(init = {…})`

Fetch init for ONE-SHOT catalog/registry calls (the /models listing, the models.dev registry): `connection: close` so the platform's keep-alive agent does NOT park the socket ESTABLISHED for reuse.

## IO

### `IO.constructor({ env, model, url, timeout, connectTimeout, stuckTimeout, settings, tools, onData, onLog } = {…})`

Configure one provider IO session: resolve the provider module from the registered endpoint and resolve the model, endpoint URL, and three timeouts from options > provider settings > provider metadata > defaults.

### `IO.get state()`

The request state machine's current state.

### `IO.get settings()`

live provider-namespaced settings view (explicit overrides merged over the Env namespace)

### `IO.setOption(key, value)`

Set/clear a per-invocation settings override AFTER construction (e.g.

### `IO.tools()`

the current publishable tool catalog (availability applied)

### `IO.authSet(auth, options)`

Route auth persistence to the endpoint's namespace and refresh the live settings view.

### `IO.get requestSignal()`

the in-flight request's abort signal (used by the HTTP backend)

### `IO.get currentModel()`

effective model: per-request override wins over the instance default

### `IO.get contextUsage()`

The provider-reported context readout of the CURRENT/last request: `{used, total}` in tokens, each undefined when the provider hasn't reported it.

### `IO.setContextUsage({ used, total } = {…})`

Report actual context consumption and/or the model's available context window (provider → IO channel; connectors call this from their translators/metadata surfaces).

### `IO.get planUsage()`

The provider-reported PLAN/QUOTA readout (rate limits, subscription allowances): `{label?, quotas}` where each quota entry is `{total?, remaining?, used?, reset?}` — whatever the provider publishes, nothing invented.

### `IO.setPlanUsage({ label, quotas } = {…})`

Report plan/quota usage (provider → IO channel; connectors call this from their reportPlanUsage hook or metadata surfaces).

### `IO.write(context, callbacks = {…}, options = {…})`

Run one provider request over a complete context.

### `IO.kill()`

Cancel the active request (terminal partial emitted by the in-flight write), close the connection, permanently disconnect the instance.

### `IO.sanitizeRequest(msg)`

Sanitize the connector's outgoing msg into the [headers, body] convention: headers a plain object with string-valued entries (undefined/null/function entries dropped, values stringified), body JSON-serializable or nil.

### `IO.bodyBytes(body)`

The request body's size in bytes as it would go on the wire (UTF-8 JSON, BEFORE any transport compression) — 0 for a nil body.

### `IO.connectBudget(baseMs, bytes)`

The connection-timeout budget for one request: the base timeout plus one millisecond per request-body byte (before compression) — larger prompts get proportionally more time to produce a first response.

### `IO.resolveTimeout({ env, model, timeout, settings } = {…})`

The effective overall request timeout without constructing a connection: explicit > endpoint settings > provider metadata > default.

### `IO.Env`

The global environment constructor used by IO and provider authors.

### `IO.Context`

The Context namespace for validating every provider-bound request.

### `IO.ProviderError.constructor(kind, message, detail = {…})`

Build a stable classified provider error.

### `IO.classifyError(err, providerName)`

Classify a raw error into the stable provider taxonomy.

### `IO.defineProvider(Protocol, { name } = {…})`

Complete a standalone provider class with OpenAI-compatible defaults.

### `IO.HttpStatusError.constructor(status, statusText, body)`

Build the error from a non-2xx response (the body's first 200 characters ride in the message).

### `IO.defaultConnect(url, aiio)`

stateless HTTP connection

### `async IO.defaultSend(connection, msg)`

Default send: msg = [headers, body].

### `async IO.defaultSendHeaders(connection, headers)`

@param {object} headers plain object

### `async IO.defaultSendBody(connection, body)`

Completes the request: POSTs the JSON body (nil body -> no payload) and stores the Response for defaultRead.

### `async IO.defaultRead(connection)`

Blocking-await line reader: resolves the next whole line-delimited JSON message, nil at end-of-stream.

### `async IO.defaultClose(connection)`

Teardown: cancel the body stream; idempotent.

## Agent

### `Agent.EVENT`

The numeric event vocabulary for Agent.onEvent: START, TEXT_START, TEXT_DELTA, TEXT_END, THINKING_START, THINKING_DELTA, THINKING_END, TOOLCALL_START, TOOLCALL_DELTA, TOOLCALL_END, DONE, ERROR, MESSAGE_COMMITTED, LOG, TOOL_EXECUTE, TOOL_DATA, TOOL_RESULT, CLOSE_MARKED, CLOSED, SENT_MESSAGE — see Agent.onEvent's documentation for each value's meaning and payload.

### `Agent.RESPONSE_CALLBACK_EVENTS`

The [responseCallbackName, Agent.EVENT] pairs: every EVENT value's corresponding option-callback name ("onTextDelta" for Agent.EVENT.TEXT_DELTA, …), for hosts that prefer per-event callbacks over one onEvent listener.

### `Agent.constructor({ env, model, url, timeout, settings, context, tools, parent, name, description, session, sessionDir, sessionSave = true, createIO, toolCall, safe, spawnPermission, question, } = {…})`

Build an agent over an environment; wires the session store (a named file session, a resumed one, an injected store, or none) and takes ownership of the seed context — a NEW (non-resumed) context starts with the seeded system prompt as its FIRST message(s).

### `Agent.onEvent(event, callback)`

Register a synchronous listener for one numeric Agent.EVENT value.

### `Agent.offEvent(handle)`

Remove one registration; returns false when it is absent.

### `Agent.toolStorage(toolname)`

Return this agent's mutable, transient storage object for one tool.

### `Agent.toolStorageClear(toolname)`

Clear one tool's transient storage, or every tool store when omitted.

### `Agent.get parent()`

The creating Agent, or undefined when none was supplied.

### `Agent.get children()`

Snapshot of direct child Agents.

### `Agent.createChild(options = {…})`

Construct one direct child through the environment factory.

### `Agent.childAdd(child)`

Register one direct child Agent.

### `Agent.childRemove(child)`

Remove one direct child Agent.

### `Agent.get name()`

Human-friendly Agent name.

### `Agent.set name(value)`

Set the human-friendly Agent name.

### `Agent.get description()`

Human-friendly Agent description; an empty string is valid.

### `Agent.set description(value)`

Set the human-friendly Agent description.

### `Agent.get safe()`

safe mode: only read-only (`safe`) tools publish and execute

### `Agent.setModel(selector)`

Select an exact, configured endpoint/model pair for subsequent turns.

### `Agent.setSafe(value)`

Switch safe mode at runtime (the /safe command, the ^X menu).

### `Agent.get sessionSave()`

whether the current SessionStore saves to disk

### `Agent.sessionSaveSet(value)`

Enable or disable saving for the current SessionStore.

### `Agent.get spawnPermission()`

Generic delegation permission.

### `Agent.setSpawnPermission(value)`

Set generic delegation permission; non-booleans restore tool-owned asking.

### `Agent.setFolder(folder)`

Narrow this agent's tool working folder to an existing folder inside its environment project.

### `Agent.get folder()`

The agent-local root used for file tools and their OS sandbox.

### `Agent.setQuestion(callbacks)`

Set (or replace) the QUESTION BRIDGE at runtime — the binding's rendering engine wires it once its overlays exist (the TUI hands its questionnaire overlay to the Agent after construction; see the constructor's `question` option for the contract).

### `Agent.toolContext({ question = null, env, call, agent, storage, trusted = false, resetTimeout } = {…})`

Construct the public tool-call context.

### `Agent.updateToolMessage(name, text)`

Set (or clear) a tool's sticky MESSAGE on THIS agent — a compact live text the TUI renders above the input area (collected from the VIEWED agent; lib/agent/tool-messages.js).

### `Agent.toolMessages()`

tools with a live sticky message

### `Agent.detectToolMessages()`

Re-detect tool-provided display information from the current context.

### `Agent.run(options = {…})`

Run the tool loop until done/error (lib/agent/run.js).

### `Agent.compact()`

/context-compact: ask the model to summarize the conversation (a structured, self-contained prompt), then replace the context with the surviving SYSTEM messages plus one ASSISTANT message holding the marked summary (lib/agent/compact.js).

### `Agent.get usage()`

Cumulative usage across every request THIS Agent has made — every IO terminal event's usage envelope, summed in memory.

### `Agent.get contextUsage()`

The context-window readout for the status surface (most exact first: the provider's own report, the last provider-reported envelope, the word-count estimate marked `approximate`).

### `Agent.get planUsage()`

The provider-reported PLAN/QUOTA readout of the current endpoint (`{label?, quotas}`; in-memory, last-known).

### `Agent.get busy()`

Whether an agent run is currently in progress.

### `Agent.get endRequested()`

Whether this agent asked to end after its current turn settles.

### `Agent.get closeMarked()`

Whether close has been requested, including while a turn finishes.

### `Agent.get closed()`

Whether close cleanup has completed.

### `Agent.close()`

Refuse new messages now and close after the current turn, or immediately when idle.

### `Agent.requestEnd()`

Ask to END this agent (its job is done): the current turn finishes first; the run loop then closes the agent instead of idling forever.

### `Agent.get ioState()`

The connection/work state for the TUI's status indicator: "working" (a run is in flight), "disconnected" (the last turn failed connection-class), "idle" (otherwise).

### `Agent.cancel()`

Cancel the in-flight request (IO kill → terminal partial).

### `Agent.fork(id)`

Fork the current session into a NEW session id: the live context continues under a fresh store (flushed immediately); the old file stays behind as a snapshot.

### `Agent.newSession(id)`

Start a NEW session with an EMPTY context (re-seeded with the system prompt): the old session file is closed (its flushed content stays on disk — fork() first to keep a snapshot).

### `Agent.renameSession(name)`

Rename the current session: the session file takes the proper name (`session-<name>.jsonl`; the old name's file is gone) — /session-name.

### `Agent.enqueue(message)`

Deliver a user message: while a request is in flight it is queued for the next request; while idle it is appended and starts a request immediately.

### `Agent.enqueueFile(fileName)`

Read an existing file as a binary user message and deliver it.

### `Agent.pathInfo(path, options = {…})`

Inspect a path using the Agent's file-security boundary.

### `Agent.get pending()`

the pending queue (a copy — drainPending to remove)

### `Agent.drainPending()`

Remove EVERY pending message, returning them (the TUI's Option+↑ recall: the queued messages go back into the input area, merged, for editing).

### `Agent.resumeSession(id)`

Resume an EXISTING session: the live context is replaced with the session's stored context under its store; the old session file is closed (its flushed content stays on disk).

### `Agent.listSessions()`

Every session in the store's folder, latest first, each with a first-user-message preview (the ^X menu's Resume sub-menu, /resume's Tab completion).

### `Agent.listSessionsAsync()`

Nonblocking counterpart of listSessions().

### `Agent.latestSessionId()`

the latest session's id (undefined: no sessions)

### `Agent.get thinking()`

the current thinking level (undefined = provider default)

### `Agent.setThinking(level)`

Set the thinking level for subsequent requests (THINKING_LEVELS; each provider translates it to the nearest symbol the model accepts).

### `Agent.append(message)`

Append a caller-built message (e.g.

### `Agent.edit(i, message)`

Replace context[i] (Context edit semantics: rebuilt from recognized fields, stale provider identifiers dropped), mirrored to the session store when one is wired.

### `Agent.editBlock(i, j, block)`

Replace context[i].content[j] (the containing message is rebuilt).

### `Agent.rollback(i)`

Remove every message at index >= i (RangeError when i is not an existing index).

### `Agent.pop()`

Remove and return the last message (undefined on an empty context).

### `Agent.removeMessages(indexes)`

Remove selected context messages.

### `Agent.SessionStore.constructor({ id, dir, context = [], origin, process: proc, uuid, name, save = true } = {…})`

Open a store for a session id (the file is created on the first flush of a non-empty context); registers the crash-safe finish hook.

### `Agent.SessionStore.get save()`

whether this store writes its context to disk

### `Agent.SessionStore.saveSet(value)`

Enable or disable persistence without replacing the live context.

### `Agent.SessionStore.append(message, options)`

Append a message, MERGING with the last one when possible (consecutive same-type messages / same-sub-type blocks fold — Context appendMessage).

### `Agent.SessionStore.prepend(messages)`

Insert messages at the FRONT of the context — Agent's seeded system prompt, which must always be the first message(s) of a fresh context.

### `Agent.SessionStore.edit(i, message)`

Replace context[i] through Context (stale identifiers dropped).

### `Agent.SessionStore.editBlock(i, j, block)`

Replace context[i].content[j] through Context.

### `Agent.SessionStore.rollback(i)`

Remove all messages at index >= i.

### `Agent.SessionStore.pop()`

Remove the last message.

### `Agent.SessionStore.removeMessages(indexes)`

Remove selected messages.

### `Agent.SessionStore.flush()`

Synchronously make the CURRENT context durable (see _planFlush for the remove/none/append/full decision).

### `Agent.SessionStore.close()`

Flush and detach the finish hook.

### `Agent.SessionStore.rename(newId)`

Rename the session: BOTH the stable `id` and the file's NAME segment become `newId` (the same session — the date/uuid8 prefix carries over unchanged) and the old file is gone.

### `Agent.SessionStore.originOf({ id, dir } = {…})`

The ORIGIN FOLDER recorded in a session file's metadata line (the cwd the session ran in), or undefined (no such session).

### `Agent.SessionStore.resume({ id, dir, process: proc, save = true } = {…})`

Load a session file into a fresh store holding its live context.

### `Agent.SessionStore.list({ dir, cwd, limit = 50 } = {…})`

Every session in the folder, LATEST FIRST, each with a small preview: a snippet of the first user message (whitespace-folded, capped).

### `Agent.SessionStore.listAsync({ dir, cwd, limit = 50 } = {…})`

Nonblocking counterpart of list().

### `Agent.SessionStore.latest({ dir, cwd } = {…})`

The id of the most recently modified session in the folder (of the `cwd` origin when given), or undefined when the folder has none.

### `Agent.SessionStore.deleteAll({ dir } = {…})`

Delete EVERY session file in the folder (the /sessions-delete-all!

### `Agent.sessionDir()`

The default namespace session folder under settings (created when missing) — outside the project tree by design (see the header).

### `Agent.loadMessages(data)`

Parse session data (file text or an already-parsed value) into a context array.

### `Agent.sameFolder(a, b)`

Two folder paths are the same place (realpath when it exists).

### `Agent.findSessionFile(folder, id)`

Find a session file in `folder` by its STABLE `id` (a directory scan reading each file's first line — cheap even at hundreds of files; the file name does not encode `id` directly).

### `Agent.resolveAgentPath(path, { folder = process.cwd(), boundary = folder } = {…})`

Resolve a relative path from `folder`, bounded by `boundary` (the project root by default).

### `async Agent.rejectAgentSymlinks(resolved, { folder = process.cwd() } = {…})`

Reject existing symbolic links along a resolved, in-root path.

### `async Agent.pathInfo(path, { folder = process.cwd(), requireExists = true } = {…})`

Validate and inspect a path rooted at an Agent folder.

### `Agent.onFinish(fn, { process: proc = process } = {…})`

Register a synchronous cleanup to run at process finish.

### `Agent.runFinish()`

Run every registered cleanup.

### `Agent.armFinishSignals({ process: proc = process, signals = ["SIGINT", "SIGTERM", "SIGHUP"], } = {…})`

Trap termination signals: run cleanups synchronously, then re-raise the signal with our handlers removed so the process dies by the signal itself.

### `Agent._resetFinish()`

Test-only reset: forget cleanups and arming state.

### `Agent.callToolSandboxed({ env, name, args, timeout = DEFAULT_TOOL_TIMEOUT, sandbox = false, detached = true, cwd, spawnImpl = spawn, onChild, onData, onQuestion, questionBridge = false, })`

Run one tool call in a forked child process; never throws — every failure (spawn error, crash, timeout, bad result line) resolves as {ok: false, error}.

### `Agent.DEFAULT_TOOL_TIMEOUT = ENV_DEFAULT_TOOL_TIMEOUT`

Default Agent-enforced tool-call duration (120 seconds).

### `Agent.resultContent(value)`

Normalize a tool return value into result content blocks — the full tool-answer contract.

### `Agent.thinkValue(level)`

Map a thinking-level word to the request option value: off/false/0 → false, on/true/1 → true, level words (low/medium/high/xhigh) pass through, undefined/"default" → undefined (the model's default).

### `Agent.reseatAgent(agent, { id } = {…})`

Build the FRESH Agent that replaces `agent` for a new session.

### `Agent.isAnonymousId = (id) => id === "0" || id === "false" || id === "anon"`

The anonymous-session id spellings: "0", "false", "anon" (sessions.js).

### `Agent.RESPONSE_CALLBACK_EVENTS = Object.freeze([…]`

IO callback property paired directly with its numeric Agent event.

## CLI

### `async CLI.execute(command)`

Execute one normalized administrative command.

### `CLI.parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] })`

Parse argv into a flat options object.

### `CLI.EXIT = Object.freeze({…})`

Exit codes shared by the command-line tools.

### `CLI.exitCodeFor(terminal)`

Map a terminal done/error event (or an error-shaped `{kind}`) to the process exit code.

### `CLI.close({ env, agent } = {…})`

Close a command-line library runtime.

### `async CLI.readStdin()`

Read all of stdin, resolving only at EOF.

### `async CLI.readContextFromStdin()`

Read stdin to EOF and parse it into a context array.

### `async CLI.resolveModelCombo(value, env, { url } = {…})`

Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model.

### `CLI.listModelCandidates(env, { access = env.settings?.modelAccess ?? "all" } = {…})`

Published endpoint/model completion candidates (cache-only).

### `CLI.listEndpointModels(env, { access = env.settings?.modelAccess ?? "all" } = {…})`

Published endpoints with published cached model ids for the menu; loginRequired flags endpoints whose credentials failed (see Agent).

### `async CLI.listModels(env, { access = env.settings?.modelAccess ?? "all" } = {…})`

Query each published endpoint and return its currently available public model ids.

### `CLI.readLastCombo(env)`

the last-used combo, or null when none is stored

### `CLI.writeLastCombo(env, { endpoint, model } = {…})`

Persist a selected endpoint/model combo (in the user settings folder).

### `async CLI.selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {…})`

No implicit endpoint/model exists: with neither `--model` nor a valid last-model.json, interactive callers start model-less.

### `CLI.armCancelSignals({ onCancel, process: proc = process })`

Arm SIGINT/SIGTERM cancellation for a CLI binding.

### `async CLI.loginEndpoint(env, { name, provider, url, token, auth, scope = "package", } = {…})`

Configure one endpoint, invoke its protocol login (or accept a pre-seeded `auth`, e.g.

### `CLI.logoutEndpoint(env, name)`

Remove an endpoint (the /logout and --logout contract): its entry drops out of settings.json, its auth file is deleted, and the live Env forgets it (see Env.removeEndpoint).

### `async CLI.runLoginWizard(env, { input = process.stdin, output = process.stderr, } = {…})`

Cooked terminal wizard used by `--login`.

### `CLI.defaultUrl(provider)`

Known setup defaults only; runtime endpoint discovery remains class-owned.

### `CLI.renderSettingsTemplate(env)`

Render the template text: one commented-out line per known key, sorted, its default (or `null` when there isn't one) as the placeholder value and its description as a trailing comment.

### `CLI.writeSettingsTemplate(env, { force = false } = {…})`

Write a fresh namespaced settings template into the project folder (env.cwd).

### `CLI.resolveToolArgs(raw, entry)`

Resolve a raw JSON-args string into a tool's actual args object.

### `CLI.resolveCliToolArgs(argv, entry)`

Resolve the tool CLI's shell-friendly non-JSON arguments.

### `CLI.unwrapToolResult(value)`

Split a tool's return value into its {result, system?, display?} envelope (see the Tool contract's RETURNS section) — a plain return value is `result` with no side channels.

### `CLI.formatToolResult(result)`

A result value as printable text: a string as-is, else pretty JSON — ALWAYS a string (JSON.stringify(undefined) is the JS value undefined, not text, so that case is coerced explicitly).

### `async CLI.runOAuthFlow(descriptor, options = {…})`

Run one OAuth sign-in.

### `CLI.completeOAuthPaste(input)`

Feed a pasted redirect URL / code#state to the in-flight flow.

### `async CLI.refreshOAuthTokens(descriptor, refresh, { signal } = {…})`

Refresh stored OAuth credentials without repeating browser/device authorization.

### `CLI.tokensToAuth(tokens, previous = {…})`

Map a token response to the stored auth payload.

### `CLI.parseAuthorizationInput(input)`

Parse pasted authorization input: a full redirect URL (`...?code=…&state=…`), `code#state`, or a bare code.

### `CLI.oauthPasteOnly(descriptor)`

Is this flow paste-only (grant shape A with a NON-loopback redirect URI — the provider hosts the callback page and shows the code)?

### `CLI.adoptResumeOrigin({ resume, anonymous = false } = {…})`

Adopt an explicitly resumed session's origin folder as the cwd.

### `CLI.usageSummary(usage)`

One-line human-readable usage summary (e.g.

## Jobs

### `Jobs.taskFilename(value)`

File selectors are leaf Markdown names, not task IDs or paths.

### `async Jobs.validateJobsLayout(root)`

Refuse missing/redirected durable directories; this query never repairs layout.

### `async Jobs.validateJobsOperational(root, options = {…})`

Operational eligibility is checked at publication and invocation from folder state.

### `async Jobs.readTaskEntries(root)`

Pure filesystem snapshot: no admission, error reporting, state writes, or symlink following.

### `async Jobs.scheduleJobs(root, command, options = {…})`

Shared task command boundary.

### `async Jobs.jobsStatus(projectRoot, options = {…})`

Read-only status projection.

### `Jobs.normalizeDays(value, code = "JOBS_TASK_SCHEDULE")`

Normalize aliases or unique lowercase named arrays; omitted input means all days.

### `Jobs.JobsError.constructor(code, message, details = {…})`

Construct a coded domain failure; details are caller diagnostics, not safe-to-log source.

### `Jobs.JOBS_DATA_DIRECTORY = "ai-jobs"`

Active portable Jobs directory name.

### `Jobs.JOBS_DISABLED_DIRECTORY = "ai-jobs-disabled"`

Disabled portable Jobs directory name.

### `Jobs.JOBS_PATH_NAMES = Object.freeze({ tasks: "tasks", completed: "completed", state: "state…`

Names inside the portable Jobs directory.

### `Jobs.jobsPaths(projectRoot)`

Return absolute paths derived from the caller's active project root.

### `async Jobs.canonicalProjectRoot(projectRoot, io = {…})`

Canonical paths are process-local inputs, never Jobs data.

### `Jobs.parseTask(filename, source)`

Parse one task without filesystem side effects; declared bad frontmatter rejects the task.

### `Jobs.parseTasks(tasks)`

Parse independently so duplicate ids and empty prompts remain task-local rejections.

### `Jobs.taskId(filename)`

Validate and return a nonempty filename-derived default task ID.

### `Jobs.taskStateKey(id)`

Map opaque IDs to bounded safe ledger filenames; unsafe IDs use a stable hash.

### `async Jobs.loadTasks(projectRoot, entries, io)`

Parse entries purely, then durably report only all-or-nothing frontmatter fallbacks.

### `async Jobs.reportTaskDiagnostic(projectRoot, diagnostic, io = {…})`

Atomically record one frontmatter fallback without retaining source text, metadata names, values, or filenames.

### `Jobs.taskDiagnosticKey(diagnostic)`

Stable SHA-256 key for a filename/failure code; contains no source text.

### `Jobs.JOBS_STATE_VERSION = 2`

Persisted occurrence schema version; unsupported versions are refused.

### `Jobs.createTaskState(task)`

Create the durable, task-local occurrence ledger.

### `Jobs.statePath(projectRoot, taskId)`

Resolve a task ledger path through the domain-owned safe ID mapping.

### `Jobs.validateTaskState(value, taskId)`

Validate the complete persisted v2 schema before it is used for admission.

### `Jobs.validateArchiveReference(value)`

A durable archive location is portable project-local data, never a host path.

### `Jobs.resolveArchiveReference(projectRoot, reference)`

Resolve only a previously validated relative reference against this active Jobs root.

### `async Jobs.loadTaskState(projectRoot, task, io = fs)`

Read and validate a ledger, or return a fresh state when absent; does not persist.

### `async Jobs.saveTaskState(projectRoot, state, io = fs)`

Atomic replace of one task ledger; callers own cross-file reconciliation.

### `Jobs.admitOccurrence(state, task, now)`

Admit one execution per scan, coalescing earlier eligible and excluded history.

### `Jobs.recordAttempt(state, occurrenceId, attempt)`

Persist a new attempt before any irreversible source move.

### `Jobs.reconcileAttempt(state, occurrenceId, attemptId, archivePresent)`

Reconciliation is visible: an interrupted archive is consumed, never due again.

### `Jobs.finalizeAttempt(state, occurrenceId, attemptId, outcome, archivePresent, session = null)`

Finalize the current attempt in the same dispatch cycle, without crash reconciliation.

### `async Jobs.loadAllTaskStates(projectRoot, io = fs)`

Read all ledgers, including removed one-shots, for crash reconciliation.

### `Jobs.newAttemptId(occurrence, sequence = occurrence.attempts.length)`

Derive an occurrence-local attempt ID; callers persist it before archival.

### `async Jobs.allocateArchive(projectRoot, localDate, sourceFilename, io = fs)`

Allocate an unused date-local archival name.

### `async Jobs.moveToArchive(source, archive, io = fs)`

Atomically claim destination without overwrite, then remove source hardlink.

### `async Jobs.snapshotAndArchive(source, archive, io = fs)`

Snapshot source bytes before move.

### `async Jobs.archiveExists(path, io = fs)`

Check archive presence; absence returns false, other I/O failures throw JobsError.

### `async Jobs.ensureJobsLayout(projectRoot, io = fs)`

Ensure the standard active layout.

### `async Jobs.initializeJobs(projectRoot, settings = {…}, options = {…})`

Enable folder-only Jobs, restoring a disabled directory without changing bytes.

### `async Jobs.validateJobsActivation(projectRoot, settings = {…}, options = {…})`

Validate active folder state without writing or coordinating with other processes.

### `async Jobs.disableJobs(projectRoot, options = {…})`

Disable by renaming the active directory.

### `Jobs.cycleRecord(at)`

Create the location-neutral public result record for one Jobs scan.

### `async Jobs.dispatchJobs(projectRoot, options = {…})`

Best-effort serial scan.

### `async Jobs.runJobAgent(task, options = {…})`

One fresh, headless Agent run against a SHARED per-wake Env.

### `async Jobs.foregroundJobsDaemon(projectRoot, options = {…})`

Run a foreground, cwd-bound best-effort daemon.

## TUI

### `TUI.TUI_ENGINES = TUI_MODES`

The rendering modes accepted by createRepl.

### `TUI.createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows })`

The interactive REPL.

### `TUI.close(runtime)`

Close TUI-owned agents, sessions, and background resources.

### `TUI.run(state)`

Run the complete TUI application from normalized declarative state.

### `TUI.createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit })`

Create the piped, cooked-mode front end; one input message per line.

## GTUI

### `GTUI.view = freeze({…})`

Immutable constructors for renderable view nodes.

### `GTUI.view.text(props = {…}, content = "")`

Create immutable text content.

### `GTUI.view.table(props = {…}, rows = [])`

Create an immutable table with frozen rows and cells.

### `GTUI.view.feed(props = {…})`

Create an immutable feed control.

### `GTUI.view.input(props = {…})`

Create an immutable text input control.

### `GTUI.view.menu(props = {…})`

Create an immutable menu control.

### `GTUI.view.row(...)`

Create an immutable horizontal container.

### `GTUI.view.column(...)`

Create an immutable vertical container.

### `GTUI.view.grid(...)`

Create an immutable grid container.

### `GTUI.view.panel(...)`

Create an immutable bordered panel.

### `GTUI.view.scroll(...)`

Create an immutable scroll container.

### `GTUI.view.overlay(...)`

Create an immutable overlay container.

### `GTUI.effect = freeze({…})`

Immutable constructors for host, task, timer, theme, and lifecycle effects.

### `GTUI.effect.task(key, run)`

Run an abortable asynchronous task.

### `GTUI.effect.cancel(key)`

Cancel the task for a key.

### `GTUI.effect.after(ms, message)`

Deliver a message after a delay.

### `GTUI.effect.copy(text, id)`

Copy text through the host.

### `GTUI.effect.open(url)`

Ask the host to open a URL.

### `GTUI.effect.notify(text)`

Ask the host to show a notification.

### `GTUI.effect.theme(tokens)`

Replace theme tokens.

### `GTUI.effect.refresh()`

Request a render without changing the model.

### `GTUI.effect.quit(code = 0)`

End the application with a status code.

### `GTUI.event = freeze({…})`

Immutable constructors for messages delivered to an application update function.

### `GTUI.event.key(payload)`

Create a key event.

### `GTUI.event.paste(payload)`

Create a paste event.

### `GTUI.event.pointer(payload)`

Create a pointer event.

### `GTUI.event.resize(payload)`

Create a resize event.

### `GTUI.event.focus(payload)`

Create a focus event.

### `GTUI.event.inputChange(payload)`

Create an input-change event.

### `GTUI.event.inputSubmit(payload)`

Create an input-submit event.

### `GTUI.event.menuSelect(payload)`

Create a menu-selection event.

### `GTUI.event.menuCancel(payload = {…})`

Create a menu-cancel event.

### `GTUI.event.selectionCopy(payload)`

Create a selection-copy event.

### `GTUI.event.linkOpen(payload)`

Create a link-open event.

### `GTUI.event.taskDone(payload)`

Create a completed-task event.

### `GTUI.event.taskFailed(payload)`

Create a failed-task event.

### `GTUI.event.copyDone(payload)`

Create a completed-copy event.

### `GTUI.memory({ width = 80, height = 24, scrollBar } = {…})`

Create an in-memory host for application tests.

### `GTUI.memory.send(message)`

Send a host input message to the mounted application.

### `GTUI.memory.flush()`

Finish pending host output; memory hosts have nothing to flush.

### `GTUI.memory.snapshot()`

Return the current rendered scene in semantic, testable form.

### `GTUI.memory.get effects()`

Recorded effects, copied so callers cannot mutate host state.

### `GTUI.memory.get restoreCount()`

Number of completed host restoration cycles.

### `GTUI.memory._start(listener, binding)`

Start the runtime-to-host message protocol.

### `GTUI.memory._render(next)`

Render a view through the in-memory layout engine.

### `GTUI.memory._setTheme(theme)`

Install the resolved theme for subsequent layouts.

### `GTUI.memory._effect(value, send)`

Record an effect and acknowledge copy effects asynchronously.

### `GTUI.memory._restore()`

Clear runtime callbacks and record host restoration.

### `GTUI.terminal(options = {…})`

Construct a terminal host that owns input decoding and terminal rendering.

### `GTUI.constructor({ host, theme = {…} } = {…})`

Create a runtime for a host.

### `GTUI.dispatch(message)`

Deliver one message immediately to the running application.

### `GTUI.stop(reason = "stop", code = 0)`

Stop the application, canceling tasks and timers and restoring the host.

### `GTUI.run(app)`

Start an application and return its eventual completion result.

### `GTUI.host = freeze({…})`

Host constructors for tests and terminal execution.

### `GTUI.host.memory(...)`

Create a memory host for deterministic application tests.

### `GTUI.host.terminal(...)`

Create a terminal host for interactive execution.

### `GTUI.scrollGlyph(value, fallback)`

Return a one-cell grapheme or the supplied fallback.

## index
