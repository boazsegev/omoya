# Changelog

Omoya releases are listed newest first. The embedded library follows [Semantic Versioning](https://semver.org/); App and GTUI APIs do not. Tool descriptions and model-facing schemas can change between runs as the agent receives the current tool catalog.

## 0.2.2 — 2026-10-05

### Clearer tools, quicker reads

- Improved tool names, descriptions, and schemas so models can choose arguments more reliably across providers. The `write` tool now calls its read-query input `source`, not `read`: use `write({ path, source: { path: "notes.md" } })`. The old input name is no longer accepted. Built-in schemas avoid constructs some providers do not support; runtime validation still accepts the documented input forms.

- Filtered folder reads skip files that cannot match before checking their metadata. Search uses one isolated worker per query and avoids indexing files with no matches.

### Better Web and worker experience

- Web displays user messages as Markdown. Tool display output, including edit diffs, remains visible on collapsed cards and after a session reload.

- Worker creation checks every assigned subfolder before creating a batch. An invalid folder no longer leaves a partly created team. Each worker uses its assigned folder for file tools and sandboxing.

## 0.2.1 — 2026-10-04

### Easier context and tool workflows

- The `read` tool now groups line, character, byte, and search options. Negative range indexes count from the end; folder queries support inclusion, exclusion, result limits, and offsets. Ignore filtering is opt-in with `ignore: true`, and symlinks are not followed. Queries have scan, time, and output limits, so a stopped scan is marked incomplete rather than presented as a full result.

- `write` gained a read-query input for saving a selected file, listing, or search result without sending the content through the model. At the time of this release, the input was called `read`; **0.2.2 renames it to `source`**. `write` accepts this input or `content`, not both, and leaves the destination unchanged if the query fails or is incomplete.

- Skills can be activated together by name. Unknown names fail the request without partly activating it; already active skills are not injected again. Activation survives compaction, forks, and resumed sessions. `skill-resource` can list resource names, read a resource, or save its exact bytes to a new project file without activating the skill.

- Generated API documentation now includes public fields, namespace statics, and property accessors. Context construction copies seed messages, so forks do not share message objects; child cleanup and worker bootstrap were also tightened.

### Update library integrations

**These library changes have no compatibility aliases.** See [API.md](API.md) for the full signatures.

- Set single-value Agent, Context, and IO controls through properties rather than `*Set()` methods—for example, `agent.model = selector`. Keyed methods such as `IO.settingsSet(key, value)` remain. Set the model on the Agent instead of passing model or endpoint overrides to `Agent.run`; `io.model` changes only while idle and within its endpoint. The removed `modelAccess` and endpoint local/remote classification have no replacements; authentication storage scopes have not changed.

- Use `await agent.tools` to inspect the current model-facing tool descriptors instead of `Agent.toolCallable(name)`. `Agent.toolContext` is no longer public. TUI and Web show tools in a read-only block without adding them to the conversation history.

- Same-named skill definitions now replace, rather than append to, lower layers. To retain an earlier definition, include `{{skill-name}}` explicitly; use `{{skill-name[L1-L2]}}` for a line range.

- Replace `/team` with `/task` for delegation or `/author` for sourced document work.

## 0.2.0 — 2026-10-02

### More capable interfaces and more reliable requests

- Use the expanded `om --serve` Web app for command-palette navigation, theme previews, endpoint sign-in, and session and context editing. Web and TUI both expose model, thinking, safety, and logging controls. The TUI adds a block-oriented transcript, context gauge, highlighted code fences, and a turn-activity footer. Both share themes but save their selections independently.

- Search and fetch can use provider-hosted tools when available, then fall back to MCP or local backends. OpenAI, Anthropic, and Kimi API-key providers were tested. Disable provider web access for either tool at global, endpoint, or model scope. Web backends have bounded connection and response times; debug output identifies the backend used. Kimi's direct fetch returns extracted text and images, not preserved hyperlinks. Claude Pro/Max OAuth users must sign in again: its provider changed from `anthropic-claude` to `claude`. Anthropic may restrict subscription-quota use with third-party harnesses; the Anthropic API-key provider is unchanged.

- Read-only tools marked `safe: true` can run in parallel, up to `tools.concurrency` (default 3). Mutating calls remain sequential barriers, and results keep their call order. Mutating calls no longer overlap through `toolCall.async`.

- Failed or partial provider responses remain visible on the assistant message. A failed *last* message is retracted on the next request so the agent can retry; a user reply preserves it. Empty or reasoning-only answers and incomplete OpenAI responses no longer silently end a turn. Rate-limit responses with retry delays schedule a continuation rather than an immediate hidden retry.

- Install trusted extension packages through the user settings folder's `settings.json` to add settings, themes, providers, tools, skills, and prompts. Extensions load after Omoya's package and before user settings; project settings cannot install more extensions. Provider and tool extensions run code with host access, so install only packages you trust and restart after changing them.

### Daily-use fixes

- Model discovery retries empty or timed-out startup probes in the background; Codex uses its authenticated catalog. Recent selection remembers up to eight endpoint/model pairs and skips unavailable endpoints when restoring. The context gauge caches its window registry, with offline fallbacks, instead of repeatedly downloading it or delaying the first request.

- Kimi attachments are cached per IO instance, and provider content keeps text, thinking, and tool calls in order. Kimi streamed tool-call arguments were fixed. Dynamic endpoints track changes without saving credentials; resumed sessions restore agent settings unless an explicit launch model overrides them. Logging can be enabled on an existing unlogged conversation without losing its messages.

- Scheduled jobs now run in-process; stopping the daemon cancels the active job. Errors and warnings appear in readable `ai-jobs/errors/YYYY-MM-DD.md` records, and `om-jobs` prints concise results.

- Safe mode blocks unsafe tools inherited from a parent or required by sandbox policy, while newly registered read-only tools remain available. Untrusted tool output cannot inject terminal control sequences into TUI or Web. Fixed a TUI context-edit crash and Web question and agent-state display problems after reload. The website gained a refreshed homepage and a generated 404 page.

### Update library integrations

**The 0.2.0 library and provider changes have no compatibility aliases.** The items below name the main migrations; [API.md](API.md) and [API-schema.md](API-schema.md) document current methods and settings.

- **Presentation:** Import `App.TUI`, `App.Web`, `App.GTUI`, or `App.Markdown` instead of top-level presentation exports. `omoya/app` exports core, `CLI`, and `App`; the old `lib/tui.js`, `lib/web.js`, and `lib/markdown.js` entry points are gone.

- **Context and sessions:** Each Agent owns `agent.context`. Use Context methods to read and edit messages; logging and naming also belong to Context. An omitted or false `contextId` creates memory-only context. Replace `session`/`sessionSave` with `contextId`/`contextSave`, and `newSession`/`resumeSession`/`fork` with `contextNew`/`contextResume`/`contextFork`. File operations move to `Context.list`, `listAsync`, `latest`, `resume`, `renameById`, and `deleteById`. CLI labels still say “session.” Session storage is `env.settings.sessions`, not `sessionsDir` or the Agent's `sessionDir` option.

- **Agent methods and events:** Agent setters use noun-first names such as `modelSet` and `safeSet`; `enqueue`/`enqueueFile`/`drainPending` become `pendingAdd`/`pendingAddFile`/`pendingDrain`, `compact` becomes `contextCompact`, and `createChild` becomes `childCreate`. Edit messages through `agent.context`, not Agent pass-throughs. Request events are `REQUEST_START`, `REQUEST_DONE`, and `REQUEST_ERROR` per provider request. Tool-call events use `tool_call_start`/`delta`/`end`; third-party providers must emit the new names.

- **Env and settings:** `Env` owns settings, endpoint discovery, login, tools, and MCP servers. `env.settings` is a live view: changing a key persists that change to its owning layer. `Env.extend({ methods, getters, events, settings })` installs Agent-owned Env members. Agent membership events are `AGENT_ADDED` and `AGENT_REMOVED`; listen on agents for request events. The former endpoint-keyed members, raw internal fields, provider-kit statics, and manual refresh/save controls are removed. MCP tools appear only while servers are configured; project settings cannot set `mcp`.

- **Models and login:** `env.models(secret)` returns a Map keyed by `endpoint/model`, including capabilities and agent capacity. It fills in the background; use `Env.EVENT.MODELS_CHANGED` to refresh displays. `env.login(name, { provider, url, token|auth }, { scope, verify })` leaves no saved login after a failed test or verification; without `scope`, login is memory-only.

- **Tools and safe mode:** Pass safety to `env.tools(safe, selector)` or `toolCall` through `context.safe`; `env.safe` and `env.safeEnv` are removed. The selected provider's web tools can take precedence over global tools. Tool status uses `context.statusSet(info)`. Skills and prompts come from `env.skills()` and `env.prompts()`; MCP servers are also Env tool sources.

- **IO and providers:** Use `IO.close()` instead of `kill()`; `settingsSet`, `modelCurrent`, `contextUsageSet`, `planUsageSet`, and `IO.timeoutsResolve` replace the older method names. Context data helpers use noun-first names such as `messageUser` and `contentText`; `Context.contentIndexer()` provides shared block numbering. Providers import only Context and the namespace foundation. Provider errors carry `kind` or `status`; tool opt-outs use global, endpoint, or model settings.

- **Jobs:** The public surface is `init`, `disable`, `status`, `run`, `daemonRun`, `schedule`, `validate`, and `JobsError`. `Jobs.run` returns `{ outcomes, errors, warnings, log }`; the full scan stays on disk. `daemonRun` resolves without a result.

- **Policy and compaction:** `context.cap`/`context.turn` replace the old guard keys; `retry.attempts`/`retry.base`/`retry.max` replace the old retry keys. Agents resolve policy when created and when selecting a different model; other settings edits apply to the next Agent. Optional `settings.context.autocompact` defaults off; `true` compacts at 65% of the context window, while a fraction or percentage sets another threshold. It compacts before a provider request, preserves unanswered messages, and leaves context intact if compaction fails. Global, endpoint, and model context settings can override each other per key.

- **Sandbox helpers:** `Sandbox.osKind()`, `Sandbox.osAvailable()`, and `Sandbox.osWrap()` replace the Env statics. Duration parsing lives in `lib/util.js`.

## 0.1.1 — 2026-09-25

- Find the right way to start faster: the rewritten README and homepage include a `bunx` quickstart and runnable examples for the TUI, JSONL CLIs, embedded library, Web app, scheduled jobs, and direct tool commands.

- Fixed invalid model selection across CLI and Web, the TUI login overlay at startup, and Kimi message ordering and notice selection. Improved the tools, docs, and both interfaces.

- The npm package now includes keywords, a linked README logo, and this changelog. Release checks passed 1,838 tests and 25 website checks.

## 0.1.0 — 2026-09-23

- Initial public release: use a transparent Bun AI agent harness through a TUI, JSONL agent/IO CLIs, or an embedded library. Includes provider plugins, direct tool commands, scheduled jobs, and project-scoped memory.
