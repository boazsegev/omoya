# Omoya

<a href='https://omoya.ai'><img src="https://omoya.ai/assets/logo.svg" alt="Omoya" style="height:8em; float:left"></a>

**See what your agent sees.** A transparent agent harness for people, scripts, and the things you build next.

One zero-dependency [Bun](https://bun.sh/) core, for anywhere you want to run an AI Agent: a terminal interface, a scriptable headless loop, and an embeddable library.

Filesystem boundaries are enforced by the OS, not by prompt instructions. Every shipped provider — and OpenAI-/Anthropic-compatible third-party endpoints — normalizes into one event model.

## Why Omoya

**Stop context leaks** — where other agent tools stop at a project instructions file, Omoya makes the project the unit of everything: skills, prompts, settings, and scheduled jobs live in `ai-` files inside the folder they belong to, minimizing cross-project context leaks.

**Project memory and workflow** — Omoya's `core` skill encodes working conventions (memory files, task ledgers, delegation rules), leading to context-aware agents using practical conventions.

**Transparency** — inspect and edit the exact context the model receives, watch every tool call, read the unified diff of every edit.

**Convention over configuration** — auto-detection for local Ollama / LM Studio models, SearXNG (`SEARXNG_URL`), and known endpoints (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) — zero-configuration functionality.

## Try it now

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

From a source checkout, `bin/` holds the same commands: `git clone https://github.com/boazsegev/omoya.git && cd omoya && bun bin/om --login`.

## The terminal interface

`om` is the long-running interface. It streams responses and thinking as they arrive, shows every tool call as it happens, and keeps the whole conversation open for inspection and correction.

- **Ctrl-O** — open the block viewer: full text of any message, thinking, or tool exchange; filter, search, copy
- **Ctrl-X** — main menu (help, commands, models, thinking level) · **Ctrl-P** — switch endpoint/model mid-session
- **Ctrl-C** — cancel a runaway response and keep the partial output
- **`/context-edit`**, **`/context-rollback`**, **`/context-system`** — correct, rewind, or extend the exact context the model receives
- **`/`** — browse commands and reusable prompts; Tab completes commands, arguments, and paths

Multi-line input, large-paste handling, queued follow-ups, mouse-aware overlays, themes, and inline or alternate-screen modes are built in. Run `om --help` for the complete key and command guide.

## Providers are plugins

Four provider protocols ship out of the box — OpenAI Responses, Anthropic Messages, Kimi/Moonshot, and Ollama — with ready-made endpoints for OpenAI, the ChatGPT/Codex OAuth backend, GitHub Copilot, Azure OpenAI, xAI, and LM Studio. `om --login` walks through hosted, OAuth, token-based, and local endpoints; `om --list` prints the available models.

Auto-detection reads the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY` → `kimi`, `KIMI_API_KEY` → `kimi-coding`, `XAI_API_KEY`, Azure OpenAI with its required `AZURE_OPENAI_BASE_URL`) and probes local servers — a running Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) server becomes a ready endpoint with no configuration. Discoveries are dynamic: held in memory only, never persisted, re-detected at every startup. Every provider normalizes streaming text, thinking, tool calls, usage, and completion into one context and event model, so switching models — even mid-session — changes nothing else.

A provider is a single protocol module; see [API.md](API.md) to add your own.

## Tools with enforced boundaries

The built-in tools — `read`, `edit`, `write`, `bash`, `question`, `skill`, `note`, `worker`, `mcp`, `web-search`, `web-fetch` — cover file reading and search, exact-text edits (a unified diff shows what the agent did, and each edit can be rolled back), file writing, bounded shell commands with cancellation, structured questions, a skill catalog, scratchpad notes, named workers, MCP servers, and web search and fetch.

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

Session logs live outside the project tree, so cwd-scoped tools cannot rewrite their own history; tool schemas never carry security metadata; a package-shipped refusal list strips provider API keys from spawned child processes (a settings list you can extend — or disable).

**Note:** the OS sandbox confines writes, not reads — an agent can always find ways to read external data, even though its tools block its ability to alter that data. This allows the agent to analyze more data while limiting its side-effects and its ability to perform malicious actions. See [SECURITY.md](SECURITY.md).

## Embed the library

```js
import Agent from "omoya/agent";

const env = await Agent.Env.create();   // providers, endpoint detection, tools
const agent = new Agent({ env, model: "ollama/gpt-oss:20b", safe: true });
```

`omoya/agent` is the headless core — it publishes `Agent.Context`, `Agent.Env`, and `Agent.IO` without loading any CLI, Markdown, or UI code. Import `omoya/app` when you want those layers. See [API.md](API.md) and [API-schema.md](API-schema.md).

## Drive it from a script

`om-agent` runs the complete tool loop without the TUI: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. `om-io` performs exactly one provider request with no autonomous tool execution.

```sh
echo "Summarize this project" | om-agent --model ollama/gpt-oss:20b
echo "Hello" | om-io --model anthropic/claude-sonnet-4-6
```

Both accept structured context as JSON or JSONL (plain input becomes a user message). They stream stable JSONL events, exit distinctly per failure class (2 auth, 3 network, 4 provider, 5 malformed input), and cancel on SIGINT — the partial response is persisted, exit 130.

## Serve it to a browser

```sh
om --serve --port 9900
```

A standalone chat SPA over HTTP and WebSocket, carrying the same Agent/Env events used everywhere else. The server owns the agent; the browser only renders it — closing the tab detaches the view while the agent keeps running. It binds to loopback and checks the WebSocket Origin header. There is no auth token: **reaching the port means owning the agent**, so keep it off shared networks unless you put your own auth in front.

## The system message is yours

Fresh sessions layer instructions from three `AGENTS.md` files — the harness's own, your user settings folder's, and the working project's — plus `settings.system` and anything you append live. There is no hidden third-party agent CLI between your instructions and the model provider.

Reusable **skills** and **prompts** accumulate across package, user, and project roots (`ai-skills/`, `ai-prompts/`); the `skill` tool loads them into the conversation on demand.

## The web, without an account

**Web search and fetch** need no account: every call routes through the provider's own web backend, then a mapped MCP server, then a package backend — bounded, cached, and rate-limited. The package backend tries a configured or auto-detected SearXNG instance first (`SEARXNG_URL`/`SEARXNG_BASE`), then falls back to the aggregate engines (DuckDuckGo and Mojeek by default; `BRAVE_API_KEY` adds Brave).

## The project is the unit of memory

What an agent learns belongs to the project folder it learned it in: `ai-settings.json` (`om --init` writes a commented template), `ai-auth-*.json`, `ai-skills/`, `ai-prompts/`, `ai-jobs/`, `AGENTS.md`. None of it is visible from another project; the `ai-` prefix never changes, even if the harness is renamed (`bin/scripts/rename` rewrites every other name in one step). To share a tool, skill, or instruction everywhere, put it in the user settings folder.

## Sessions and jobs

Named sessions persist as JSONL under the user settings directory: resume, rename, edit, roll back, fork, or delete them; anonymous sessions write nothing. `om --resume latest` picks up where you left off.

`om-jobs` runs scheduled, headless agent tasks defined as plain Markdown files under `ai-jobs/tasks/` — a one-shot needs no frontmatter at all:

```sh
om-jobs init     # create ai-jobs/ (idempotent)
om-jobs run      # one best-effort scan, executes due tasks
```

The optional daemon is foreground-only; wire periodic runs into your own cron or service manager. Execution is best-effort and lock-free — never put credentials in task files.

## Settings

Configuration is layered — package, then the user settings directory, then environment-selected roots, then the project — with later layers overriding earlier ones and same-named skills accumulating. Settings files support JSON with comments.

| key | meaning |
|---|---|
| `providers` | Endpoint URLs, protocol names, model metadata, endpoint limits |
| `tools` | Additional trusted tool roots (package or user settings only) |
| `skills` / `prompts` | Additional instruction and prompt roots |
| `mcp` | MCP servers and launch settings |
| `tui` | Interface mode, theme, theme definitions |
| `think` | Default reasoning effort |
| `safe` | Start read-only |
| `timeout` / `toolTimeout` | Per-request and per-tool-call duration limits |

The context guard caps runaway turns at 90% of the context window. Namespace-derived variables (`OMOYA_SETTINGS_DIR`, `OMOYA_SKILLS_DIR`, `OMOYA_PROMPTS_DIR`, `OMOYA_OS_SANDBOX`) override discovery and sandbox behavior; endpoint detection reads the provider keys listed above; `web-search` reads `SEARXNG_URL`/`SEARXNG_BASE` and `BRAVE_API_KEY`. Command-line tokens apply to one invocation and are never persisted.

## Development

```sh
bun test
```

The suite runs hermetically against a scripted provider. Every shipped command — `omoya` and its short form `om`, `om-agent`, `om-io`, `om-tool`, `om-skills`, `om-jobs`, `om-tools2bash` (plus the `om-app`, `skills`, and `tools2bash` aliases) — has built-in `--help`.

## Make something nice

Use Omoya as a coding companion, a controlled research harness, a terminal workspace, a JSONL worker in a pipeline, or the engine inside a new interface. Add a provider. Write a tool. Build a workflow around sessions and events. Keep the parts you like and replace the parts you do not.
