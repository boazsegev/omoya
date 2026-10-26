# Omoya

<a href='https://omoya.ai'><img src="https://omoya.ai/assets/logo.svg" alt="Omoya" height="4em" style="height:7em; float:left"></a>

**See what your agent sees.** A transparent agent harness for people, scripts, and the things you build next.

Omoya runs an AI agent in your terminal, your browser, a script, or your own program. All four share one small [Bun](https://bun.sh/) core with no dependencies. You can read and edit everything the model sees. The operating system keeps the agent's writes inside its folder.

```sh
bunx omoya --login                 # configure an endpoint (OAuth, token, or local)
bunx omoya                         # start the terminal interface
```

## Why Omoya

- **See everything.** Read and edit the exact context the model receives. Watch every tool call and see a diff of every edit.

- **Writes stay in the agent's folder.** The OS sandbox enforces this, not a prompt. Without a sandbox, only read-only tools run.

- **Each project keeps its own memory.** Skills, prompts, settings, and jobs live in `ai-` files inside the project folder. This limits context leaks between projects.

- **Good work habits come built in.** The `core` skill teaches agents to keep memory files and task lists, and to delegate well.

- **No setup for what you already have.** Omoya finds local Ollama and LM Studio servers, SearXNG, and common API keys on its own.

- **Switch models freely.** All providers speak one event model. You can switch providers and models mid-session, and nothing else changes.

## Try it now

Install [Bun](https://bun.sh) first. Then run Omoya without installing it:

```sh
bunx omoya --help                  # run without installing
bunx omoya --login                 # configure an endpoint (OAuth, token, or local)
bunx omoya                         # start the terminal interface
```

Or install it globally:

```sh
bun add -g omoya                   # installs omoya, and its short form om
om --model ollama/gpt-oss:20b      # a local Ollama model needs no account at all
```

From a source checkout, `bin/` holds the same commands:

```sh
git clone https://github.com/boazsegev/omoya.git && cd omoya && bun bin/om --login
```

## Four ways to run it

### In the terminal

`om` streams answers and thinking as they arrive. It shows every tool call, and you can inspect or fix any part of the conversation.

- **Ctrl-O** — inspect messages, thinking and tools; filter/search/copy; press **A** for edit, fork and message actions
- **Ctrl-X** — searchable actions, projects, agents, saved sessions and scoped settings
- **Ctrl-P** — switch endpoint or model mid-session
- **Ctrl-C** — stop a response and keep what arrived so far
- **`/context-edit`**, **`/context-rollback`**, **`/context-system`** — fix, rewind, or extend what the model sees
- **`/`** — browse commands and saved prompts; Tab completes commands, arguments, and paths

Run `om --help` for every key and command.

### In a browser

```sh
om --serve --port 9900
```

The browser app runs the same agent engine as the terminal, with browser-specific controls. The server owns the agent, so closing a tab doesn't stop its work. One server can host several projects, each at its own URL.

**Safe by default.** The server listens only on loopback, so nothing outside your machine can reach it. Websites in your browser can't control it either. Omoya blocks DNS-rebinding attacks, where a website tricks your browser into talking to a local server.

**LAN access is opt-in.** Start with `--host 0.0.0.0` to use the app from other devices on your network. DNS-rebinding protection stays on, so this is just as safe on trusted networks. Never use `0.0.0.0` on public Wi-Fi or other public networks: it lets any device on the local network control the agent. For remote access, use an SSH tunnel (`ssh -L 9900:localhost:9900 <machine>`).

To keep the browser app and scheduled jobs running, start the `omd` daemon supervisor instead (`omd --port 9900`). With `omd`, you can restart the app from the browser when you want a fresh start.

### From a script

`om-agent` runs the full agent loop without the terminal interface. It reads a conversation on stdin and writes JSONL events to stdout. `om-io` sends exactly one request to the model and runs no tools.

```sh
echo "Summarize this project" | om-agent --model ollama/gpt-oss:20b
echo "Hello" | om-io --model anthropic/claude-sonnet-5
```

Both accept plain text, JSON, or JSONL. Each kind of failure has its own exit code: 2 auth, 3 network, 4 provider, 5 bad input. Ctrl-C saves the partial answer and exits with 130.

### Inside your program

```js
import Agent from "omoya/agent";

const env = await Agent.Env.open(process.cwd());   // providers, endpoint detection, tools
const agent = await Agent.create({ env, model: "ollama/gpt-oss:20b", can: { write: false } });
```

`omoya/agent` is the headless core. Import `omoya/app` to add the terminal, browser, and Markdown layers. Semantic versioning covers the library, not the App and GTUI APIs. See the [guide](GUIDE.md#embed-the-library) and [API.md](API.md).

## Providers

Omoya speaks the OpenAI, Anthropic, Kimi/Moonshot, Ollama, and Gemini APIs. Ready-made endpoints cover services such as Codex, Claude, GitHub Copilot, LM Studio, Azure OpenAI, and xAI.

- `om --login` sets up hosted, OAuth, token, or local endpoints.
- `om --list` prints the models you can use.

Omoya also finds endpoints on its own:

- **API keys** in your environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY`, `XAI_API_KEY`, `AZURE_OPENAI_API_KEY` with `AZURE_OPENAI_BASE_URL`, and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).
- **Local servers:** Ollama on `localhost:11434` and LM Studio on `localhost:1234`.

Finding models this way can be slow. Log in with your API keys to cache the model lists.

**Claude OAuth caution:** Anthropic may restrict accounts that use subscription quotas with other harnesses. Use an Anthropic API key or extra credits instead.

You can add your own provider as a single module. Extension packages can add providers, tools, skills, and themes. See the [guide](GUIDE.md#providers) for every ready-made endpoint, usage reports, and extensions.

## Tools with enforced boundaries

Built-in tools:

- **Files:** `read` (read and search), `edit` (exact edits with a diff), `edit-undo` (reverse a recorded edit), `write`
- **Shell:** `bash`, with time limits and cancellation
- **You:** `question` asks you something
- **Knowledge:** `skill`, `resource`, `note-list`, `note-read`, `note-write`
- **Other agents:** `worker-create`, `worker-message`, `worker-close`, `worker-status`, `request`
- **Outside world:** `mcp`, `web-search`, `web-fetch`

Each agent has a working folder, and it can only write inside it. The OS sandbox enforces this for every tool that changes files. Child agents get the same folder or a smaller one. `--safe` limits the agent to read-only tools at any time.

Two more safeguards protect your secrets. Programs the agent starts don't inherit variables with names like `KEY`, `TOKEN`, or `SECRET`. Session logs live in your user settings folder, outside the project, by default.

**Note:** the sandbox limits writes, not reads. An agent can still read data outside its folder, but it can't change it. This lets agents study more while keeping their side effects small. See [SECURITY.md](SECURITY.md).

You can also run any tool straight from your shell:

```sh
om-tool --list
om-tool read '{"path":"/absolute/path/to/README.md"}'  # direct calls resolve from /
om-skills core
om-tools2bash    # generate direct shell wrappers for the tools
```

## Your instructions, your project

Each new session builds its instructions from three `AGENTS.md` files: Omoya's own, your user folder's, and the project's. Your `settings.system` text and live additions come next. Nothing hidden sits between your instructions and the model.

What an agent learns stays in its project folder:

- `ai-settings.json` (`om --init` writes a commented template) and `ai-auth-*.json`
- `ai-skills/`, `ai-prompts/`, and `ai-jobs/`
- `AGENTS.md`

Other projects can't see these files. To share a skill, prompt, or instruction everywhere, put it in your user settings folder.

## Sessions and jobs

Omoya saves sessions as JSONL files in your user settings folder. You can resume, rename, edit, roll back, fork, or delete them. `om --resume latest` picks up where you left off. `--session false` keeps a session in memory only.

`om-jobs` runs scheduled agent tasks. Each task is a plain Markdown file in `ai-jobs/tasks/`:

```sh
om-jobs init     # create ai-jobs/ (idempotent)
om-jobs run      # one best-effort scan, executes due tasks
```

Run `om-jobs run` from cron or another scheduler, or let `omd` run it about every five minutes. Jobs run on a best-effort basis, with no lock. Never put passwords or keys in task files.

## Web search without an account

Web search and fetch work without an account. Omoya first tries the provider's own web tools, then an MCP server, then its built-in search. Built-in search uses [SearXNG](https://docs.searxng.org/) if you have it, then DuckDuckGo and Mojeek. Set `BRAVE_API_KEY` to add Brave.

## Learn more

- [GUIDE.md](GUIDE.md) — settings, the browser app, `omd`, the library, and other details
- [API.md](API.md) and [API-schema.md](API-schema.md) — generated library reference
- [SECURITY.md](SECURITY.md) — what Omoya protects, and its limits
- [omoya.ai](https://omoya.ai) — the documentation website

## Development

```sh
bun test
```

The tests use a scripted provider, with no real model calls. Every command has built-in `--help`: `omoya` (short form `om`), `om-agent`, `om-io`, `om-tool`, `om-skills`, `om-jobs`, `omd`, and `om-tools2bash`. The `om-app`, `skills`, and `tools2bash` aliases do too.

## Make something nice

Use Omoya as a coding partner, a research harness, a terminal workspace, a worker in a pipeline, or the engine inside a new interface. Add a provider. Write a tool. Build a workflow around sessions and events. Keep the parts you like and replace the rest.
