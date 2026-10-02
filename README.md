# Omoya

<a href='https://omoya.ai'><img src="https://omoya.ai/assets/logo.svg" alt="Omoya" height="4em" style="height:7em; float:left"></a>

**See what your agent sees.** A transparent agent harness for people, scripts, and the things you build next.

One zero-dependency [Bun](https://bun.sh/) core, for anywhere you want to run an AI Agent: a terminal interface, a scriptable headless loop, and an embeddable library.

Filesystem boundaries are enforced by the OS, not by prompt instructions. Every shipped provider — and OpenAI-/Anthropic-compatible third-party endpoints — normalizes into one event model.

## Why Omoya

**Stop context leaks** — where other agent tools stop at a project instructions file, Omoya makes the project the unit of everything: skills, prompts, settings, and scheduled jobs live in `ai-` files inside the folder they belong to, minimizing cross-project context leaks.

**Project memory and workflow** — Omoya's `core` skill encodes working conventions (memory files, task ledgers, delegation rules), leading to context-aware agents using practical conventions.

**Transparency** — inspect and edit the exact context the model receives, watch every tool call, read the unified diff of every edit.

**Convention over configuration** — auto-detection for local Ollama / LM Studio models, [SearXNG](https://docs.searxng.org/) (`SEARXNG_URL`), and known endpoints (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — zero-configuration functionality.

## Try it now

Make sure you have [bun](https://bun.sh) installed.

Run without installing:

```sh
bunx omoya --help                  # run without installing
bunx omoya --login                 # configure an endpoint (OAuth, token, or local)
bunx omoya                         # start the terminal interface
```

Or install globally:

```sh
bun add -g omoya                   # installs omoya, and its short form om
om --model ollama/gpt-oss:20b      # a local Ollama model needs no account at all
```

From a source checkout, `bin/` holds the same commands:

```sh
git clone https://github.com/boazsegev/omoya.git && cd omoya && bun bin/om --login
```

## The terminal interface

`om` is the long-running interface. It streams responses and thinking as they arrive, shows every tool call as it happens, and keeps the whole conversation open for inspection and correction.

- **Ctrl-O** — open the block viewer: full text of any message, thinking, or tool exchange; filter, search, copy
- **Ctrl-X** — main menu (help, commands, models, thinking level) · **Ctrl-P** — switch endpoint/model mid-session
- **Ctrl-C** — cancel a runaway response and keep the partial output
- **`/context-edit`**, **`/context-rollback`**, **`/context-system`** — correct, rewind, or extend the exact context the model receives
- **`/`** — browse commands and reusable prompts; Tab completes commands, arguments, and paths

Multi-line input, large-paste handling, queued follow-ups, mouse-aware overlays, themes, and inline or alternate-screen modes are built in. Run `om --help` for the complete key and command guide.

## The system message is yours

Fresh sessions layer instructions from three `AGENTS.md` files — the harness's own, your user settings folder's, and the working project's — plus `settings.system` and anything you append live. There is no hidden third-party agent CLI between your instructions and the model provider.

Reusable **skills** and **prompts** accumulate across package, user, and project roots (`ai-skills/`, `ai-prompts/`). Later same-named skills replace earlier instruction bodies; use `{{skill-name}}` to explicitly include another skill, or the previous definition when overriding that same skill. `{{skill-name[1-10]}}` includes 1-based, inclusive lines of its expanded body (excluding frontmatter). Cross-skill references resolve the effective definition; unknown placeholders stay literal, while cycles and invalid known ranges fail. Resource files overlay independently: the last existing match wins.

The `skill` tool accepts one name or an array, trims surrounding whitespace without splitting names, and deduplicates requests. Activation is atomic: unknown names fail without loading any new instructions. Skills already active in the current context succeed without reinjection, even after disk edits; edits apply to a new session. Prefilled skills count as active, and compaction/fork/resume retain them. Portable authored names should still follow Agent Skills naming conventions.

Use `skill-resource` with `{name: "web"}` to list available skill-relative resource identifiers (without activating the skill), or `{name: "web", path: "examples/build.js"}` to read an existing UTF-8 resource (up to 128 KiB); listings are optional and do not gate access. Add `target: "web/examples/build.js"` to save its exact bytes (including binary resources, up to 16 MiB) to a new project file, creating parent folders. Existing targets, traversal, and observed symlinks are refused; safe mode allows reads but refuses saving. Resources do not activate skills or execute code. Installation paths are not exposed. Ordinary `read` continues to read workspace files, with no skill-resource fallback.

## The project is the unit of memory

What an agent learns belongs to the project folder it learned it in: `ai-settings.json` (`om --init` writes a commented template), `ai-auth-*.json`, `ai-skills/`, `ai-prompts/`, `ai-jobs/`, `AGENTS.md`. None of it is visible from another project; the `ai-` prefix never changes, even if the harness is renamed (`bin/scripts/rename` rewrites every other name in one step). To share a tool, skill, or instruction everywhere, put it in the user settings folder.

## Providers are plugins

Some common provider protocols ship out of the box: OpenAI API, Anthropic API, Kimi/Moonshot API, and Ollama — with ready-made endpoints for common services such as Codex, Claude, GitHub Copilot, Azure OpenAI, xAI, etc'. `om --login` walks through hosted, OAuth, token-based, and local endpoints; `om --list` prints the available models. **Claude OAuth caution:** Anthropic may restrict accounts using subscription quotas with third-party harnesses, please use the Anthropic API-key / extra credits instead.

Auto-detection reads the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `XAI_API_KEY`, Azure OpenAI with its required `AZURE_OPENAI_BASE_URL`) and probes local servers — a running Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) server becomes a ready endpoint with no configuration. Dynamic discoveries may result in slow loading of available model lists, login with your API keys to cache data.

Every provider normalizes streaming text, thinking, tool calls, usage, and completion into one context and event model, so switching providers and models — even mid-session — changes nothing else.

A provider is a single protocol module; see [API.md](API.md) to add your own.

### Install extensions

Install an extension npm package alongside Omoya or in the user settings folder, then list its package name in that folder's `settings.json`:

```json
{ "extensions": ["@example/omoya-extension"] }
```

Omoya resolves each listed installed package at startup and treats its package root as another content layer: top-level JSON files (except `package.json` and npm lockfiles) merge as settings; `themes/*.json`, `providers/*.js`, `tools/*.js`, `skills/`, and `prompts/` follow the existing conventions. Folder scans do not recurse. Extension roots load in listed order after Omoya's package and before user settings; duplicate tool/provider names fail rather than silently replacing each other. An extension cannot add more extensions, nor can project settings select extensions. Only install extensions you trust: providers and tools execute code with access to host resources and credentials. Restart Omoya after installing or changing extensions.

## Tools with enforced boundaries

The built-in tools — `read`, `edit`, `write`, `bash`, `question`, `skill`, `skill-resource`, `note`, `worker-create`, `worker-message`, `worker-close`, `worker-status`, `mcp`, `web-search`, `web-fetch` — cover file reading and search, exact-text edits (a unified diff shows what the agent did, and each edit can be rolled back), file writing, bounded shell commands with cancellation, structured questions, a skill catalog, scratchpad notes, named workers, MCP servers, and web search and fetch.

### Direct tool access from your shell

Run any of the installed Omoya tools directly, no agent required:

```sh
om-tool --list
om-tool read '{"path":"README.md"}'
om-skills core
om-tools2bash    # generate direct shell wrappers for the tools
```

### Limiting side-effects to the agent's folder

Each agent has a working folder (defaults to `cwd`), **making it the agent's root**, enforced in layers rather than by prompt instructions: file tools refuse absolute paths and parent traversal; `read` rejects symbolic links; `bash` refuses `cd`, `ln`, and visible outside paths; mutating tools fork under an OS write sandbox (macOS Seatbelt, Linux Bubblewrap).

With no sandbox available, safe mode is forced: only read-only tools exist. `--safe` selects the same posture at any time.

Further safeguards:

- Session logs default to the user settings folder, outside the project tree. A project can explicitly redirect them inside its own tree; agents with write access there can then modify their own history.
- Tool schemas never carry security metadata.
- A package-shipped refusal list strips provider API keys from spawned child processes (a settings list you can extend — or disable).

**Note:** the OS sandbox confines writes, not reads — an agent can always find ways to read external data, even though its tools block its ability to alter that data. This allows the agent to analyze more data while limiting its side-effects and its ability to perform malicious actions. See [SECURITY.md](SECURITY.md).

## Embed the library

```js
import Agent from "omoya/agent";

const env = await Agent.Env.create();   // providers, endpoint detection, tools
const agent = new Agent({ env, model: "ollama/gpt-oss:20b", safe: true });
```

To isolate saved sessions for one project, put `{"sessions":"ai-sessions"}` in that project's `ai-settings.json`. Relative paths there resolve against the project folder; paths in user settings resolve against the settings folder. For an embedded, non-persisted override, pass `sessionsDir` to Env: `new Agent.Env({ cwd: projectPath, sessionsDir: "private-sessions" })`. Relative overrides resolve against `cwd`; absolute paths work too. Each Env keeps its own override, and neither the override nor session data is written to settings files. Existing agents keep their current Context file; create or resume a session to use a changed folder.

Model selection is always one qualified string, such as `"ollama/gpt-oss:20b"`. Assign `agent.model = "endpoint/model"` to validate the selection, update policy, remember it, and record session settings. `agent.run()` has no model override. IO also supports `io.model = "endpoint/model"` while idle, on its existing endpoint; its request-specific write override remains available. Construct another IO to switch endpoints. Web/TUI derive display fields, and provider adapters extract native model IDs only for wire translation.

Inspect the tools published to an agent with `const tools = await agent.tools`: a `Map` from tool name to provider-neutral descriptor (`name`, `description`, `inputSchema`). For example, `tools.get("read")` returns its schema, and `tools.has("read")` checks publication. The catalog uses the same filtering as IO: availability, safe mode, configured selection, hidden-tool exclusion, and provider-specific tools/schema overrides. It describes the current catalog before provider dialect conversion, not a historical wire capture. Both block viewers (^O / Ctrl+O) show it as a read-only virtual system block before the real messages, with a Markdown heading and description for each tool followed by its full published descriptor/schema in a JSON code block; it never enters conversation history. Tool-call context construction is internal to Agent dispatch, not a public Agent factory.

Single-value controls use property assignment: `agent.name`, `description`, `safe`, `thinking`, `spawnPermission`, `folder`, and `question`; `context.save` and `context.settings`; and provider reports `io.contextUsage` and `io.planUsage`. Keyed operations such as `io.settingsSet(key, value)` remain methods. Assignments evaluate to the supplied value—read the property afterwards to observe normalization or enforced safety.

**Ownership:** `new Context({ messages })` deep-copies its seed, so forked conversations do not share message objects. `context.messages()` returns a new array of live message objects; `at()`/`blockAt()` also return live objects. Direct edits change that context but do not mark it dirty; use Context edit/update methods for persistence. Env settings and nested model/tool descriptor values may likewise reference shared global data; mutate deliberately, never assume a defensive copy. Settings arrays currently require replacement for persistence and change notifications; in-place array behavior remains under consideration.

`omoya/agent` is the headless core — it publishes `Agent.Context`, `Agent.Env`, and `Agent.IO` without loading any CLI, Markdown, or UI code. Import `omoya/app` when you want those layers. See [API.md](API.md) and [API-schema.md](API-schema.md).

**Note**: The semantic versioning is designed to protect the embedded library users. changes to the APP / GTUI API aren't semantically versioned.

## Drive it from a script

`om-agent` runs the complete tool loop without the TUI: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. `om-io` performs exactly one provider request with no autonomous tool execution.

```sh
echo "Summarize this project" | om-agent --model ollama/gpt-oss:20b
echo "Hello" | om-io --model anthropic/claude-sonnet-5
```

Both accept structured context as JSON or JSONL (plain input becomes a user message). They stream stable JSONL events, exit distinctly per failure class (2 auth, 3 network, 4 provider, 5 malformed input), and cancel on SIGINT — the partial response is persisted, exit 130.

## Serve it to a browser

```sh
om --serve --port 9900
```

A standalone chat SPA over HTTP and WebSocket, carrying the same Agent/Env events used everywhere else. The server owns the agent; the browser only renders it — closing the tab detaches the view while the agent keeps running. It binds to loopback and checks the WebSocket Origin header. There is no auth token: **reaching the port means owning the agent**, so keep it off shared networks unless you put your own auth in front.

It offers the TUI's feature set: every slash command, a command palette (Ctrl/⌘+K, the TUI's ^X menu), the shared named theme catalog (independent `tui.theme` and `web.theme` selections, each falling back to global `theme`), endpoint sign-in and sign-out including browser OAuth, live thinking and tool-call cards, questions, agent and session naming, the context viewer, and queued-message recall.

Math in messages can use explicit `\(x^2\)` inline delimiters (recommended when prose also mentions prices), `$x^2$` for unambiguous inline formulas, or `$$` or `\[` and `\]` on separate lines around display math. Ambiguous numeric dollar spans such as `$13/day` or `$2/$10` remain prices, not math. The shared Markdown module parses a **small TeX subset** (Greek/common symbols, superscripts, subscripts, `\\frac{a}{b}`, `\\sqrt{x}`) into source-bearing structural nodes. The browser lays those out without external dependencies; hover a formula to see the original TeX. The terminal preserves the TeX source verbatim so even partial selections copy accurately. Unknown commands remain literal; this is not full KaTeX/LaTeX support. Code spans and fenced code are not parsed as math.

## The web, without an account

**Web search and fetch** need no account: every call routes through the provider's own web backend, then a mapped MCP server, then a package backend — bounded, cached, and rate-limited. The package backend tries a configured or auto-detected [SearXNG](https://docs.searxng.org/) instance first (`SEARXNG_URL`/`SEARXNG_BASE`), then falls back to the aggregate engines (DuckDuckGo and Mojeek by default; `BRAVE_API_KEY` adds Brave).

## File queries without shell pipelines

The read-only `read` tool handles cat/head/tail, listings, filename filters, and literal/regex search. `write.read` saves query payloads without sending them back through the model. Without an effective search it forces `annotate: false`, even if supplied true; searches honor `annotate` (default true) to retain source locations:

```js
read({ path: "README.md", annotate: false });
read({ path: "log.txt", lines: { from: -8 } }); // last eight lines
read({ path: "src", recursive: true, glob: ["*.js", "*.md"],
  exclude: "generated/**", search: { text: "TODO", regex: "\\bFIXME\\b", before: 2, after: 2 }, limit: 20 });
write({ path: "report.txt", read: { path: "src", recursive: true,
  glob: "*.md", search: { text: "TODO" }, info: true } });
```

`lines` is 1-based/inclusive; `characters` and `bytes` are 0-based/exclusive at the end. Negative indexes count from end (`-1` is last; exclusive `to: -1` omits the last character/byte). `lines.last` is an alternative tail selection. Zero offsets, zero limits, and valid booleans are intentional; wrong-type model fillers normalize to absence. Old flat `startLine`/`endLine`/`pattern`/`maxMatches` arguments are no longer accepted.

`ignore` defaults false: Git publishing exclusions often hide useful AI artifacts. Opt in with `ignore: true` to load `.gitignore` then `.ignore` and system exclusions; explicit files always bypass ignore rules. Symlinks are never followed. `info` gives contextual file metadata/listing counts/search paths and line counts. `annotate: false` strips payload decoration, not execution-status warnings. `binary` selects bytes; `base64` produces encoded text. No JSON format switch or separate copy API.

Finite `read` settings bound work: `scanBytes` (64 MiB), `fileBytes` (16 MiB), `files` (10000), `entries` (20000), `grepFileSizeLimit` (5 MiB per discovered search file), `outputBytes` (64 KiB), `artifactBytes` (16 MiB for `write.read`), `regexMs` (1000), and `timeoutMs` (30000). Positive safe integers customize budgets; nonpositive values do not disable them. Counts stopped by budgets are incomplete. Explicit result limits are intentional; execution/serialization failures prevent saving. Raw binary saves contain bytes, not annotations; status is never inserted into saved data. `write` accepts exactly one `content` or `read` and still overwrites existing files, now through atomic replacement.

## Sessions and jobs

Sessions are logged as JSONL under the user settings directory: resume, rename, edit, roll back, fork, or delete them. Logging is one switch — `--session false` (or the TUI/web logging toggle) keeps a session in memory only, and turning logging on later writes the whole conversation. `om --resume latest` picks up where you left off.

`om-jobs` runs scheduled, headless agent tasks defined as plain Markdown files under `ai-jobs/tasks/` — a one-shot needs no frontmatter at all:

```sh
om-jobs init     # create ai-jobs/ (idempotent)
om-jobs run      # one best-effort scan, executes due tasks
```

`om-jobs` prints short notes; problems and warnings — task file, time, message, and the job's outcome and session id — are logged readably in `ai-jobs/errors/YYYY-MM-DD.md`. The optional daemon is foreground-only; wire periodic runs into your own cron or service manager. Execution is best-effort and lock-free — never put credentials in task files.

## Settings

Configuration is layered — package, then the user settings directory, then environment-selected roots, then the project — with later layers overriding earlier ones and same-named skills accumulating. Settings files support JSON with comments.

| key | meaning |
|---|---|
| `providers` | Endpoint URLs, protocol names, model metadata, endpoint limits, per-endpoint model `filter` regex |
| `tools` | Tool policy: `folders` array (trusted package/user roots only), `timeout` (120000 ms), `timeoutLimit` (1200000 ms), `concurrency` (3) |
| `skills` / `prompts` | Additional instruction and prompt roots |
| `mcp` | MCP servers and launch settings |
| `tui` | Interface mode, theme, theme definitions |
| `think` | Default reasoning effort |
| `safe` | Start read-only |
| `timeout` / `tools.timeout` | Per-request and per-tool-call duration limits |

Tool durations accept millisecond numbers or unit strings such as `"30s"`. Project settings may adjust `tools.timeout`, `tools.timeoutLimit`, and `tools.concurrency`, but `tools.folders` is stripped from every project settings/auth file. Folder arrays accumulate across trusted layers. Old `tool`, `toolTimeout`, `toolTimeoutLimit`, and root-level `tools` arrays are replaced by this object:

```json
{
  "tools": {
    "folders": [],
    "timeout": 120000,
    "timeoutLimit": 1200000,
    "concurrency": 3
  }
}
```

Environment variables:

| variable | effect |
|---|---|
| `OMOYA_SETTINGS_DIR`, `OMOYA_SKILLS_DIR`, `OMOYA_PROMPTS_DIR` | Override settings, skill, and prompt discovery |
| `OMOYA_OS_SANDBOX` | Override sandbox behavior |
| Provider keys ([listed above](#providers-are-plugins)) | Endpoint auto-detection |
| `SEARXNG_URL` / `SEARXNG_BASE`, `BRAVE_API_KEY` | `web-search` backends |

The `OMOYA_` prefix is namespace-derived and follows the harness name. The context guard caps runaway turns at 90% of the context window. Command-line tokens apply to one invocation and are never persisted.

## Development

```sh
bun test
```

The suite runs hermetically against a scripted provider. Every shipped command — `omoya` and its short form `om`, `om-agent`, `om-io`, `om-tool`, `om-skills`, `om-jobs`, `om-tools2bash` (plus the `om-app`, `skills`, and `tools2bash` aliases) — has built-in `--help`.

## Make something nice

Use Omoya as a coding companion, a controlled research harness, a terminal workspace, a JSONL worker in a pipeline, or the engine inside a new interface. Add a provider. Write a tool. Build a workflow around sessions and events. Keep the parts you like and replace the parts you do not.
