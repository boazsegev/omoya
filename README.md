# Omoya

**A transparent agent harness for people, scripts, and the things you build next.**

Omoya puts the whole agent loop in your hands: model selection, system instructions, context, tools, sessions, and security policy. Use the terminal interface for hands-on work, stream structured events through a headless process, or embed the Bun library in your own project.

It is intentionally direct. You see what the model sees, inspect what it does, interrupt it, and keep its filesystem work scoped to the current working tree.

## Install and start

Requires [Bun](https://bun.sh/). Every command has built-in `--help`.

### From the package registry

```sh
bunx omoya --help          # run without installing
bun add -g omoya           # or install globally
omoya --login
om                         # short form of omoya
```

Use a local Ollama model directly:

```sh
om --model ollama/gpt-oss:20b
```

### From a source checkout

Clone the public repository; a checkout generates local shims in `bin/`:

```sh
git clone https://github.com/boazsegev/omoya.git
cd omoya
bun bin/om --help
export PATH="$(pwd)/bin:$PATH"   # optional: put them on PATH
omoya --login
om
```

Commands: `omoya`/`om` (TUI), `om-agent` (headless loop), `om-io` (single request), `om-tool`, `om-skills`, `om-jobs`.

## Ways to use it

### Work interactively

`om` is the long-running terminal interface. It streams responses and thinking, shows tool activity as it happens, and keeps the context available for inspection and editing.

```sh
om
om --resume latest
om --safe
```

Key controls:

- **Ctrl-X** — main menu · **Ctrl-P** — endpoint and model · **Ctrl-M** — model · **Ctrl-O** — inspect message, thinking, and tool blocks · **Ctrl-C** — cancel, keeping partial output
- **`/context-system`**, **`/context-edit`** — manage instructions and context
- **`/session-new`**, **`/session-resume`** — persistent sessions
- **`/`** — browse commands and reusable prompts

The interface supports multi-line input, paste handling, command and path completion, mouse-aware overlays, queued follow-ups, context rollback, session switching, and themes. Run `om --help` for the full key and command guide.

### Build on the library

`lib/agent.js` is the headless core entry point (`omoya/agent`); it publishes the full core tree: `Agent.Context`, `Agent.Env`, `Agent.IO`. `lib/index.js` is the package-root wrapper and also exposes the Jobs domain.

```js
import Agent from "omoya/agent";

const env = await Agent.Env.create(); // providers, endpoint detection, tools
const agent = new Agent({ env, model: "ollama/gpt-oss:20b", safe: true });
```

CLI, Markdown, and UI concerns live behind `omoya/app`, so headless consumers never load those graphs:

```js
import Omoya from "omoya/app";
const repl = Omoya.TUI.createRepl({ agent, env });
```

### Drive it from a script

`om-agent` runs the complete tool loop without the TUI: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. `om-io` performs exactly one provider request without autonomous tool execution.

```sh
echo "Summarize this project" | om-agent --model ollama/gpt-oss:20b
echo "Hello" | om-io --model ollama/gpt-oss:20b
```

Both accept structured context as JSON or JSONL; plain input becomes a user message. Stable event streams, distinct exit codes, cancellation, timeouts, and stdout/stderr separation make them automation-ready building blocks.

### Serve it to a browser

`om --serve` starts a standalone chat SPA over HTTP with a WebSocket carrying the same Agent/Env events used everywhere else — the server owns the Agent, the browser only renders it. Closing or reloading the browser detaches that view only: active agents and their workers continue running until they finish, are cancelled, or the web server stops; reconnect to view their retained state.

```sh
om --serve --port 9900 --host 127.0.0.1
```

It binds to loopback, checks the WebSocket Origin header, and ships no auth token: **reaching the port means owning the agent**. Keep it off shared networks unless you put your own auth in front.

## What makes it useful

### The system message is yours

Fresh sessions layer system instructions from three `AGENTS.md` files — the harness's own, your user settings folder's, and the working project's — or from `settings.system` pointing at inline text or another file. Supply inline instructions or files, include reusable skills, append system messages from the TUI, and inspect or edit the active context. There is no hidden third-party agent CLI between your instructions and the model provider.

### Tools are visible and composable

The included tool set covers:

- scoped file reading, search, binary inspection, writing, and exact edits
- shell commands with bounded output and cancellation
- structured questions that return answers to the waiting agent
- a reusable skill catalog (prompt catalogs are TUI-only)
- MCP servers and per-server shortcut tools
- temporary notes and task state
- named child workers with attributed response routing
- live tool discovery and refresh

Run tools directly, without starting an agent:

```sh
om-tool --list
om-tool read '{"path":"README.md"}'
om-skills
```

Custom tools, skills, and prompts can live in the user settings area. Project-local `ai-skills/` and `ai-prompts/` folders are also discovered (see [The project is the unit of memory](#the-project-is-the-unit-of-memory)); executable project-local tools are deliberately excluded from the trusted search path.

### Providers are plugins

Included connectors: OpenAI Responses-compatible (including the ChatGPT/Codex OAuth backend), Anthropic Messages-compatible, GitHub Copilot (API token or OAuth), Kimi/Moonshot, and Ollama. The login flow configures hosted, OAuth, token-based, and local endpoints. Connectors normalize streaming text, thinking, tool calls, usage, and completion into one context and event model; switch models without leaving the TUI.

### Sessions remain useful outside the UI

Named sessions persist as JSONL under the user settings directory, outside the working project. Resume, rename, edit, roll back, fork, or delete them. Anonymous sessions write nothing. The agent also supports pending messages, context compaction, per-turn and total context limits, tool-call and request limits, and configurable thinking levels.

### The TUI is part of the harness

The terminal interface is built in-process on the same agent and context layers used by scripts, with streaming Markdown, expandable tool and thinking blocks, menus, questionnaires, and session-aware background work.

### Web search and fetch

`web-search` and `web-fetch` are the built-in internet tools. Every call resolves through a fixed priority order:

1. the **provider's own web backend**, when the connected provider offers one (disable it with `settings.web.provider: false`)
2. an **MCP server** mapped by `settings.web.mcp` (`server`, `searchTool`/`fetchTool`, `shadow`) — MCP errors fall through with a diagnostic note
3. the **package backend**, which needs no account

The search package backend tries any configured **SearXNG** instances first — `SEARXNG_URL`/`SEARXNG_BASE` (or `web.search.backends`) is auto-detected the same way local provider servers are — then aggregates the enabled engines (**DuckDuckGo** and **Mojeek** by default, **Brave** when `BRAVE_API_KEY` is set, plus optional **Swisscows**) with rank fusion across engines, de-duplication, and tracking-parameter removal. `web-fetch` converts pages to Markdown (using the optional `@mozilla/readability` when installed, else the built-in converter), returning text and JSON bodies as-is. Both are bounded: result/output caps, redirects, timeouts, burst and rolling rate limits, and short-lived caches; `settings.web.debug: true` prefixes the taken code path to the result.

## Filesystem security

Omoya treats the **current working folder as the agent's root**, enforced in layers rather than by prompt instructions alone.

**Enforced boundaries:**

- File tools accept only relative paths inside the working folder; absolute paths and parent traversal are refused.
- `read` rejects symbolic links in requested paths and in listings or searches.
- `bash` refuses `cd`, `ln`, `ls`, and visible arguments pointing outside the working folder; use `read` for folder inspection.
- Mutating forked tools run under an OS write sandbox: macOS Seatbelt, or Bubblewrap on Linux when installed, permitting writes only in the working folder.
- With no supported sandbox available, the agent **forces safe mode**: only read-only tools are published. This cannot be disabled.
- `--safe` at any time publishes and executes read-only tools only; unsafe calls are refused, not hidden.
- Tool schemas exclude harness security metadata; operator-only secret tools are never published to models.
- Project settings cannot add executable tool roots, provider code, or MCP server commands — those come only from the package or the user settings folder.
- Session logs live outside the project tree, so cwd-scoped file tools cannot rewrite their own history.
- A configured refusal list strips sensitive environment variables from tool child processes.

**Important limit — reads are not fully sandboxed.** The OS sandbox confines writes, not reads. Shell commands legitimately need runtimes, system libraries, and installed programs; static checks catch visible outside paths but are not a complete shell parser. A command can construct a path dynamically, or follow a pre-existing symlink in the working tree and read its target. **Do not run the agent in a tree containing untrusted symlinks, and do not rely on `bash` to protect secrets outside that tree.** See [SECURITY.md](SECURITY.md) for the threat model.

## The project is the unit of memory

What an agent learns belongs to the **project folder** it learned it in — not to a global notion of you. Everything Omoya keeps inside a project uses the literal `ai-` prefix, which never changes even if the harness is renamed:

- `ai-settings.json` — project config (`om --init` writes a commented template)
- `ai-auth-*.json` — endpoint credentials saved while working here
- `ai-skills/`, `ai-prompts/` — skills and prompts that apply only here
- `ai-jobs/` — project Jobs files and state (see [Project jobs](#project-jobs))
- `AGENTS.md` — the project's own system-prompt layer

None of it is visible from another project. To share something everywhere — a tool, skill, prompt, or standing instructions — put it in the user settings folder (`~/.<ns>-settings`) or its `AGENTS.md`. Sessions are the deliberate exception: stored centrally under user settings so cwd-scoped tools can't rewrite their own history, but each records its starting folder, so resume only offers sessions tied to the current project.

## Settings

Configuration is layered; later layers override earlier ones, same-named skills accumulate, and settings files support JSON with comments:

1. package settings, providers, tools, skills, prompts
2. the user settings directory (`$<NS>_SETTINGS_DIR`, normally `~/.<ns>-settings`)
3. optional environment-selected skill and prompt roots
4. the project folder — only its `ai-settings.json`, `ai-auth-*.json`, `ai-skills/`, `ai-prompts/`

`lib/namespace.js` is the single switch for runtime identity: env vars (`<NS>`), the settings folder (`<ns>`), and every `bin/` executable. `bin/scripts/rename` rewrites it and regenerates all wrappers plus `package.json`'s `bin`/`name` fields in one step. The project-local `ai-` prefix is the one exception — deliberately constant across renames.

| key | meaning |
|---|---|
| `providers` | Endpoint URLs, protocol names, model metadata, endpoint limits |
| `tools` | Additional trusted tool roots (package or user settings only) |
| `skills` / `prompts` | Additional instruction and prompt roots |
| `mcp` | MCP servers and launch settings |
| `tui` | Interface mode, theme, theme definitions |
| `think` | Default reasoning effort |
| `safe` | Start read-only |
| `timeout` / `toolTimeout` | Provider and tool execution limits |

Write a documented project settings template with `./bin/om --init`. Command-line tokens apply only to that invocation and are never persisted.

## Environment variables

The harness reads a small set of environment variables. `OMOYA_*` names are namespace-derived (`lib/namespace.js` — `OMOYA_`/`omoya` become `<NS>_`/`<ns>` when the package is renamed); the plain `AI_*` settings names are the legacy spellings, still honored.

**Configuration and discovery:**

| variable | effect |
|---|---|
| `OMOYA_SETTINGS_DIR` / `OMOYA_SETTINGS` / `AI_SETTINGS_DIR` / `AI_SETTINGS` | Override the user settings folder (first non-empty wins; created when missing). Without one, an existing `~/.ai-settings` legacy home is used, else the namespace home. |
| `OMOYA_SKILLS_DIR` | Delimiter-separated extra skill roots, scanned after the package and settings layers. |
| `OMOYA_PROMPTS_DIR` | Delimiter-separated extra prompt roots, accumulated the same way. |
| `OMOYA_OS_SANDBOX` | Set to `none` to disable the OS write-sandbox probe (the Agent then forces safe mode). Intended for tests and restricted hosts. |

**Endpoint auto-detection.** At startup every loaded provider may probe the process environment and the local network for endpoints (`Env.detectEndpoints()`). Discoveries are DYNAMIC: they live in memory only — never persisted, re-detected every startup, and a key or server removed from the environment leaves nothing behind. An endpoint already configured in settings always wins.

| variable | detected endpoint |
|---|---|
| `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) | `openai` (OpenAI Responses) |
| `AZURE_OPENAI_API_KEY` (+ required `AZURE_OPENAI_BASE_URL`) | `azure-openai` (OpenAI Responses) |
| `XAI_API_KEY` | `xai` (OpenAI Responses) |
| `MOONSHOT_API_KEY` (+ optional `MOONSHOT_BASE_URL`) | `kimi` (Moonshot platform) |
| `KIMI_API_KEY` | `kimi-coding` (Kimi for Coding relay) |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) (+ optional `ANTHROPIC_BASE_URL`) | `anthropic` (Anthropic Messages) |

Local servers are probed on their well-known ports — no variables needed:

| probe | detected endpoint |
|---|---|
| `http://localhost:11434` (Ollama `/api/tags`) | `ollama` |
| `http://localhost:1234/v1` (LM Studio `/models`) | `lm-studio` (OpenAI-compatible) |

The `web-search` tool also reads `SEARXNG_URL` / `SEARXNG_BASE` (a SearXNG backend — point one at a local instance to search without any API key) and `BRAVE_API_KEY` (the Brave Search API credential for the default `brave-api` engine). See [Web search and fetch](#web-search-and-fetch).

## Project jobs

`om-jobs` runs scheduled, headless agent tasks defined as Markdown files under `ai-jobs/tasks/`. The `ai-jobs/` folder alone enables Jobs; `om-jobs disable` renames it to `ai-jobs-disabled/`.

```sh
om-jobs init     # create/validate ai-jobs/ (idempotent, no daemon)
om-jobs run      # one best-effort scan; executes due tasks
om-jobs status   # read-only report
```

Results go to stdout, diagnostics to stderr; failures exit 1, cancellation exits 130.

- **Tasks** are Markdown with optional frontmatter: `id`, `enabled`, `schedule`, `tools`, `timeout`, `model`. Plain Markdown is a valid one-shot. Schedules accept `once`, `every 1h`, or `at: [...]` plus optional `days` (local clock, or ` GMT` for UTC). Invalid metadata blocks only that task.
- **Daemon** is optional and foreground-only (`om-jobs daemon foreground`): it scans, waits five minutes after each run, and exits if `ai-jobs/` disappears. There is no detached control plane — wire periodic runs into your own cron or service manager.
- **Best-effort, lock-free.** Concurrent scans may duplicate execution; there is no exactly-once guarantee. Each task runs in a fresh headless Agent; questions and login block; failures are not silently replayed. Never put credentials in task files.
- **Agent access** is through the nonsecret `job-schedule` tool (`list`, `read`, `create`, `update`, `remove`); lifecycle remains operator-only.

Library consumers use `Omoya.Jobs` (`jobsStatus`, `initializeJobs`, `scheduleJobs`, `dispatchJobs`); handle `JobsError.code` at the boundary. See [API.md](API.md) and [API-schema.md](API-schema.md) for signatures, and `test/fixtures/jobs/` for runnable examples covering one-shots, recurring schedules, GMT market hours, and error cases.

## Development

```sh
bun test
```

The test suite uses a scripted provider for hermetic runs.

## Make something nice

Use Omoya as a coding companion, a controlled research harness, a terminal workspace, a JSONL worker in a pipeline, or the engine inside a new interface. Add a provider. Write a tool. Build a workflow around sessions and events. Keep the parts you like and replace the parts you do not.
