# Changelog

Omoya releases are listed newest first. The embedded library follows [Semantic Versioning](https://semver.org/); App and GTUI APIs do not. Tool descriptions and model-facing schemas can change between runs as the agent receives the current tool catalog.

## 0.2.3 — 2026-10-08

### Browser workspace and agent workflows

- The Web app displays streamed thinking, tool output, and inline images. Copying a selection preserves Markdown, including lists and task lists.
- `bash` can start a background command; use `process` to inspect its output or stop it. `worker-status` now includes the commands workers accept. Trusted extension packages can register lifecycle hooks; the new `visual-check` skill and `web-demo` script support visual review of Web changes.
- HTTP MCP servers can authenticate with OAuth, with sign-in available in the CLI, TUI, and Web app. MCP resources and prompts can be listed and read through the `mcp` tool. Configure tokens through sign-in rather than storing them in project settings.
- Tool-result images are forwarded to model providers that support them.

### One Env per project folder

- **`Env.envs`** maps each absolute project folder to its one open Env (a frozen snapshot per read). The constructor registers an Env and `env.close()` removes it; **a second open Env for the same folder throws**, so look it up first. `env.closed` reports closure, and a closed Env refuses `agentCreate`/`childCreate`. `Env.create` closes its Env when loading fails.
- **`env.cwd` is read-only** (the absolute registry key). `env.name` is the project name: the shortest path suffix no other open Env shares (`fiz/bar/foo` and `faz/bar/foo` when two `foo` folders are open). The web app lists projects by `env.name`; pin records no longer store `name`.
- `Env.use(folder, fn)` runs `fn` with that folder's open Env, creating one when missing and closing it afterwards unless agents joined it. Tools called without an Agent's Env (`skill`, `skill-resource`) use the root folder's Env this way.
- `new Agent()` without `env` reuses the open Env of `process.cwd()`, else creates one that closes with its last Agent (or at once when construction is rejected).
- **Reserved agent names**: the name setter, `agentCreate`, and `childCreate` reject names that read as an address or a privileged identity — exactly `new`, `all`, `everyone`, a chat role (`assistant`, `human`, `model`, `tool`, `function`, `ai`) or the product name, and any name containing `user`, `admin`, `group`, `root`, `sudo`, `system`, `developer`, `owner`, `operator`, `supervisor`, `moderator`, `privilege` or `authori`. Matching ignores case, full-width forms, accents, invisible characters, Cyrillic/Greek look-alike letters and (for contained words) separators. An older session's reserved name is not restored on resume.
- **Resume is confined to the project**: `agent.contextResume(id)` and `new Agent({contextId})` refuse a session recorded in another folder ("resume anywhere" is removed; `contextResume` returns `{id, file}`). `--resume <id>` on the command line still moves to the session's folder before the Env is built.
- Project groups: a pin record may carry `groups: {<name>: true}`. Web Settings › Projects shows each project's groups; its ＋ menu joins or leaves a group or creates one. Joining pins the project. Protocol: `project.group {path, group, member}`; project entries carry `groups`.
- With several projects visible, agents are named `<project>/<agent>`: the web sidebar and palette in the all-projects view, and the terminal UI agent menu, which now lists the agents of every open Env grouped by project.
- **Web group views**: `/group:<group>/` shows the agents and saved sessions of a group's served projects (a project whose URL is the same path wins; an unknown or empty group answers 404). The project menu opens the all-projects view, each group's view, or the current project; group members switch in place, other projects open their own URL. Viewers of a project that leaves the group move to another member (else to `/`). Group names cannot contain `/`. Protocol: `scope` "group" with `group`.
- Web saved sessions: the filter always shows; multi-project views list every shown project's saved sessions in alphabetical, collapsible per-project sections with counts (also with one project); resume, rename and delete act in the owning project. `/session-resume <id>` reaches a saved session of any open project: in place when the view shows that project, else by opening the project's URL with `?resume=<id>` (new `navigate {url}` packet); completion lists the viewed project's sessions.
- Fixed: web pop-up menus opened from a modal dialog (Settings) rendered behind it and could not be clicked.
- Fixed: web selection copy failed for lists and other block sequences, copying the displayed text instead of the original Markdown.

### Pinned projects in the web app

- Settings › Projects lists every served project. On local connections, 📌 pins or unpins a project and × stops serving it. Removing a project unpins it and closes its idle agents; saved sessions stay on disk. Removal is refused while its agents are working, and the last project cannot be removed. Viewers of a removed project move to another project; a removed project's own URL redirects to the root view.
- Pinned projects are saved to `projects.json` in the user settings folder as `projects.<folder> = {models: {"<endpoint>/<model>": <timestamp>}}`. Every `om --serve` start serves them. Project settings cannot pin projects.
- A pinned project remembers its own recent models (up to 8). A new session there starts on its newest available model before falling back to the global last-model memory. `ModelInfo` gains `projectLastUsed`.
- Settings schema entries may name a `file`: writes to that key always persist there. `projects` uses this.
- Protocol: `project.pin {path, pinned}` and `project.remove {path}` are new client packets, and the server sends `project.removed {url}` to viewers of a removed project. Project entries carry `pinned`. `canAddProject` is renamed `canManageProjects`.

### Disable endpoints; edit max active from settings

- `providers.<endpoint>.disabled: true` switches an endpoint off without signing out (for example, while its token budget is depleted). Its models leave menus, completions, and last-model selection. New agents and workers cannot use it, and open agents refuse their next request. `env.models(true)` still lists its pairs with `disabled: true`, and sign-out still reaches it.
- Both apps edit endpoint settings: the terminal UI menu (`^X` › Endpoints) and the web Settings › Endpoints section switch an endpoint on or off and set `maxActive` for an endpoint or a single model. Leave `maxActive` unset to inherit; 0 excludes. Each change persists only that settings path. `CLI.endpointPolicies(env)` and `CLI.endpointPolicySet(env, selector, change)` serve both apps. The web protocol adds `endpoint.policy {selector, change}`, and `endpoints` packets carry `policies`.
- Fixed: a per-model preference such as `providers.<endpoint>.models.<model>.maxActive` replaced that model's catalog metadata (context window, thinking modes) instead of merging with it.

### Web app shows its project

- The web app shows `📁 project / agent` in the header and starts tab titles with the project name. The project menu lists served folders and lets local clients add an existing absolute directory (or `~/…` / `~`, expanded on the server; `~user/` is refused); switching navigates to its project URL. Settings ends with the full project path. `hello` and `projects` carry project entries and `canManageProjects`; `project.add {path}` replies with `project.added {url}`.
- The tool-access chip and setting read `Read/Write` (was `Read/write`) in both the web app and the terminal UI.

### Saving read results moved to `read`

- `read` gains `target`: it saves the selected file, listing, or search report to a project file instead of returning it to the model. Use it for copies and saved reports. **`write.source` is removed**: use `read({ path: "notes.md", target: "copy.md" })` instead of `write({ path: "copy.md", source: { path: "notes.md" } })`. `target` is refused in safe mode and never runs in parallel with other tool calls. `write` now takes text `content` only, and `content` is required.

- `read.target` no longer inherits the preview's default 100-result limit or long-line excerpts. Omit `limit` to save all selected results within host budgets; explicit limits/ranges still apply. Oversized or unreadable search inputs now refuse the save rather than leave a partial report. Budget exhaustion leaves existing destinations unchanged.

- Shorter `read` and `write` tool descriptions: together their schemas are less than half their previous size, leaving more context for the conversation. The `read` and `skill-resource` descriptions say saving is available only when the `write` tool is available.

- Fixed: tools loaded from tool folders lost their read-only classification, so a `skill-resource` call saving a `target` could run in parallel with reads. Such calls now run in order.

### MCP over HTTP

- `mcp.<name>` settings accept a `url` for Streamable HTTP servers, next to stdio `command`. Optional `headers` expand `${VAR}` from the filtered environment; an unset variable is a connection error. Both the current stateless protocol and the earlier session-based protocol are supported. URLs must use https, or http on a loopback host.

- MCP connection status is reliable: idle servers are no longer reported as unavailable, and status updates when a server connects, fails, or exits. Cancelling a call cancels only that request instead of stopping the shared server. Changing MCP settings closes outdated servers.

- Stdio MCP servers start in the project folder, so relative commands and arguments resolve against it.

### Safer Web and agent boundaries

- The Web server answers only requests addressed to this machine's names on its port, which blocks DNS-rebinding pages from driving the local agent. LAN use with `--host 0.0.0.0` still works.

- An agent's writes (`write`, `edit`, saved targets, and the shell write sandbox) stay inside its Agent folder; reads can still reach the project. A worker inherits its leader's folder when none is given and cannot move outside it.

- File tools accept absolute paths inside the project; tool output shows them relative to the Agent folder.

### Fixes

- Binary image reads no longer truncate images at the 64 KiB text-output budget. Complete images use the host's `read.fileBytes` budget; partial or over-budget images return a notice instead of invalid image data.

- Anthropic/Claude, OpenAI, and Kimi reject unsupported image formats before sending, with a conversion instruction.

- Copying a selection in Web gives Markdown again, including task lists and selections spanning several messages.

- Kimi thinking models receive their earlier reasoning back as `reasoning_content`, as Moonshot requires across tool loops and turns.

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
