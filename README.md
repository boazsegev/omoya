# Omoya

**A transparent agent harness for people, scripts, and the things you build next.**

`Omoya` puts the whole agent loop in your hands: model selection, system instructions, context, tools, sessions, and security policy. Use the terminal interface for hands-on work, stream structured events through a headless process, or embed the Bun library in your own project.

It is intentionally direct. You can see what the model sees, inspect what it does, interrupt it, change course, and keep its filesystem work scoped to the current working tree.

## Install and start

Omoya requires [Bun](https://bun.sh/). Start the interactive workspace with `omoya` or its short form, `om`.

### Install from the package registry

Run without installing globally:

```sh
bunx omoya --help
bunx om --help
```

Or install the command globally:

```sh
bun add -g omoya
omoya --login
om
```

Use a local Ollama model directly:

```sh
om --model ollama/gpt-oss:20b
```

### Run from a source checkout

From an Omoya source checkout, run its generated local shims directly:

```sh
bun bin/omoya --help
bun bin/om --help
```

To make a source checkout's commands available in the current shell:

```sh
export PATH="$(pwd)/bin:$PATH"
omoya --login
om
```

The source checkout generates `bin/` shims, including `omoya` and `om`.

Every command has built-in help:

```sh
omoya --help
om --help
om-agent --help
om-io --help
om-tool --help
om-skills --help
```

## Ways to use it

### Work interactively

`omoya` (or `om`) is the long-running terminal interface. It streams responses and thinking, shows tool activity as it happens, and keeps the current context available for inspection and editing.

```sh
om
om --resume latest
om --safe
```

Useful controls include:

- **Ctrl-X** — open the main menu
- **Ctrl-P** — choose an endpoint and model
- **Ctrl-M** — choose a model from the current endpoint
- **Ctrl-O** — inspect complete message, thinking, and tool blocks
- **Ctrl-C** — cancel the active response without losing its partial output
- **`/context-system`** — add system instructions explicitly
- **`/context-edit`** — revise context messages
- **`/session-new`** and **`/session-resume`** — manage persistent work
- **`/`** — browse commands and reusable prompts

The interface supports multi-line input, paste handling, command and path completion, mouse-aware overlays, queued follow-up messages, context rollback, session switching, and selectable themes. Run `om --help` (or `bun bin/om --help` from a source checkout) for the complete key and command guide.

### Build on the library

`lib/agent.js` is the headless core entry point. It publishes the complete
core dependency tree: `Agent.Context`, `Agent.Env`, and `Agent.IO`.
`lib/index.js` is an equivalent package-root wrapper that also exposes the independent Jobs domain:

```js
import Agent from "omoya/agent";

const env = await Agent.Env.create(); // providers, endpoint detection, and tools
const agent = new Agent({
  env,
  model: "ollama/gpt-oss:20b",
  safe: true,
});
```

Jobs remains in the primary library entry because tools and headless hosts may
use it. CLI, Markdown, and UI concerns belong to the application entry point.
Import `omoya/app` when those are needed:

```js
import Omoya from "omoya/app";
const repl = Omoya.TUI.createRepl({ agent, env });
```

This keeps headless applications free of CLI, Markdown, and UI graphs while
giving full applications one clear opt-in import. `Agent.Env.create()` prepares
providers, endpoint detection, and tools, so the resulting environment is ready
for an Agent without additional setup.

### Drive it from a script

`om-agent` runs the complete tool loop without the TUI. It reads one context from standard input and writes normalized JSONL events to standard output; diagnostics stay on standard error.

```sh
echo "Summarize this project" \
  | om-agent --model ollama/gpt-oss:20b
```

For exactly one provider request without autonomous tool execution, use `om-io`:

```sh
echo "Hello" \
  | om-io --model ollama/gpt-oss:20b
```

Both commands accept structured context as JSON or JSONL. Plain input becomes a user message. Stable event streams, distinct exit codes, cancellation handling, timeouts, and stdout/stderr separation make them suitable building blocks for automation.

### Serve it to a browser

`om --serve` starts a standalone chat SPA (like duck.ai or the ChatGPT web app) served over HTTP with a WebSocket carrying the same Agent/Env events used everywhere else — the server owns the Agent, the browser only renders it.

```sh
om --serve
om --serve --port 9900 --host 127.0.0.1
```

It binds to loopback by default, checks the WebSocket's Origin header, and ships no auth token: reaching the port means owning the agent, so keep it off shared networks unless you put your own auth in front of it.

## What makes it useful

### The system message is yours

Fresh sessions layer system instructions from three `AGENTS.md` files, in order — the harness's own, your user settings folder's, and the working project's own — or from `settings.system` when you point it at inline text or a different file instead of the package default. You can supply inline instructions or files, include reusable skills, append system messages from the TUI, and inspect or edit the active context.

There is no hidden third-party agent CLI between your instructions and the model provider.

### Tools are visible and composable

The included tool set covers:

- scoped file reading, search, binary inspection, writing, and exact edits
- shell commands with bounded output and cancellation
- structured questions that return answers to the waiting agent
- a reusable skill catalog (prompt catalogs are available from the TUI, not as an agent tool)
- MCP servers and per-server shortcut tools
- temporary notes and task state
- direct child workers, controlled by name with attributed response routing
- live tool discovery and refresh
- explicit Agent ownership, capacity observation, and spawn permission

Run tools directly, without starting an agent:

```sh
om-tool --list
om-tool read '{"path":"README.md"}'
om-skills
```

Custom tools, skills, and prompts can live in the user settings area. Project-local `ai-skills/` and `ai-prompts/` folders are also discovered — see [The project is the unit of memory](#the-project-is-the-unit-of-memory). Executable project-local tools are deliberately excluded from the trusted tool search path.

### Providers are plugins

Included connectors support OpenAI Responses-compatible endpoints (including the ChatGPT/Codex OAuth backend), Anthropic Messages-compatible endpoints, GitHub Copilot (API token or OAuth), Kimi/Moonshot chat completions, and Ollama. The login flow can configure hosted, OAuth, token-based, and local endpoints supported by those connectors.

Provider connectors normalize streaming text, thinking, tool calls, usage, and completion into one context and event model. Model selection can be changed without leaving the TUI.

### Sessions remain useful outside the UI

Named sessions are persisted as JSONL under the user settings directory, outside the working project. They can be resumed, renamed, edited, rolled back, forked, or deleted. Anonymous sessions write nothing.

The agent also supports pending messages, context compaction, per-turn context growth limits, total context limits, tool-call limits, request limits, and configurable thinking levels.

### The TUI is part of the harness

The terminal interface is built in-process on the same agent and context layers used by scripts. It provides streaming Markdown, expandable tool and thinking blocks, menus, questionnaires, and session-aware background work.

## Filesystem security

Omoya treats the **current working folder as the agent's root**. The policy uses several layers rather than relying on prompt instructions alone.

### Enforced boundaries

- File tools accept relative paths inside the working folder. Absolute paths and parent traversal are refused.
- The `read` tool rejects symbolic links in requested paths and in folder listings or searches.
- `bash` refuses `cd`, `ln`, `ls`, and visible command arguments that point outside the working folder. Use `read` for folder inspection and listing.
- Mutating forked tools run under an OS write sandbox: macOS Seatbelt when applicable, or Bubblewrap on Linux when installed.
- The OS sandbox mounts or permits the working folder as writable while denying writes elsewhere.
- If no supported OS write sandbox is available, the agent **forces safe mode** and exposes only tools marked read-only. This cannot be disabled through the retired sandbox environment flags.
- `--safe` can be selected at any time to publish and execute only read-only tools. Unsafe tool calls are refused, not merely hidden.
- Agent-facing tool schemas exclude harness security metadata, and operator-only secret tools are not published to models.
- Project settings cannot add executable tool roots, provider code, or MCP server commands. Those trust-bearing extensions must come from the package, user settings, or administrator-controlled roots.
- Session logs live outside the project tree, so cwd-scoped file tools cannot rewrite their own history.
- A configured refusal list strips sensitive environment variables from tool child processes.

### Important limit: reads are not fully sandboxed

The OS sandbox confines **writes**, not all reads. Shell commands need access to runtimes, system libraries, headers, and installed programs. Static command checks catch visible outside paths, but they are not a complete shell parser.

A shell command may construct a path dynamically or follow a symbolic link that already exists in the working tree and read its target when the operating system permits it. Filesystem race conditions also cannot be eliminated completely by the current path checks.

**Do not run the agent in a working tree containing untrusted symbolic links, and do not rely on `bash` to protect secrets stored outside that tree.** See [SECURITY.md](SECURITY.md) for the concise threat-model notes.

## The project is the unit of memory

Most agent harnesses build up a global notion of *the user*. Omoya defaults the other way: what an agent learns belongs to the **project folder** it learned it in.

Everything Omoya keeps inside a project lives in files and folders prefixed `ai-` — literally that string, not a template of the product's name. Renaming the executables with `bin/scripts/rename` changes what you type at the prompt; it never touches this prefix, so a project's Omoya-managed files stay recognizable no matter what the harness is called this week:

- `ai-settings.json` — this project's own config (`om --init` writes a fully commented template)
- `ai-auth-*.json` — endpoint credentials saved while working in this project
- `ai-skills/` and `ai-prompts/` — skills and prompts that only apply here
- `ai-jobs/` — this project's Jobs task files and durable state (see [Project jobs](#project-jobs))
- `AGENTS.md` — this project's own system-prompt layer, always read when present

None of it is visible from another project. Open a different folder and the agent starts from the package defaults again, as if it had never seen the first one. To make something available *everywhere* instead — a tool, a skill, a prompt, or your own standing instructions — put it in the user settings folder (`~/.<ns>-settings` by default, see below) or that folder's own `AGENTS.md`. That layer is shared on purpose; project folders are isolated on purpose.

Sessions are the one exception to "lives inside the project," deliberately: they're stored together in one folder under user settings, outside any project's own tree, so an agent's cwd-scoped file tools can never rewrite their own history. But every session records the folder it started in, so resuming (`om --resume`, `/session-resume`) only ever offers sessions tied to the current project — centralized storage, project-scoped visibility.

## Settings

Configuration is layered so shared defaults and project intent can coexist:

1. package settings, providers, tools, skills, and prompts
2. the namespace user settings directory (`$<NS>_SETTINGS_DIR`, normally `~/.<ns>-settings`)
3. optional environment-selected skill and prompt roots, plus the administrator-controlled system tool root
4. the project folder (cwd) — only its `ai-settings.json`, `ai-auth-*.json`, `ai-skills/`, and `ai-prompts/`

`lib/namespace.js` is the single switch for the runtime names that DO follow the product's identity — env vars (`<NS>`), the user settings folder (`<ns>`), and every `bin/` executable. Running `bin/scripts/rename` rewrites it and regenerates the whole wrapper set plus `package.json`'s `bin`/`name` fields in one step — nothing is a separate manual migration. The project-local `ai-` prefix is the one exception: it is intentionally NOT derived from any of this, so it stays constant across renames and across every namespace that ever runs against a project.

Later settings override earlier settings. Skills with the same name accumulate rather than replace one another. System instructions layer in order, and settings files support JSON with comments.

| key | meaning |
|---|---|
| `providers` | Named endpoint URLs, protocol names, model metadata, and endpoint limits |
| `tools` | Additional trusted tool roots from package or user settings only |
| `skills` / `prompts` | Additional reusable instruction and prompt roots |
| `mcp` | User-configured MCP servers and their launch settings |
| `tui` | Interface mode, theme, and theme definitions |
| `think` | Default reasoning effort |
| `safe` | Start with read-only tools only |
| `timeout` / `toolTimeout` | Provider and tool execution limits |

Create a documented project settings template with:

```sh
./bin/om --init
```

Temporary command-line tokens apply only to that invocation and are not persisted.

## Development

```sh
bun test
```

The test suite uses a scripted provider for hermetic runs.

## Make something nice

Use Omoya as a focused coding companion, a controlled research harness, a terminal workspace, a JSONL worker in a pipeline, or the engine inside a new interface. Add a provider. Write a tool. Build a workflow around sessions and events. Keep the parts you like and replace the parts you do not.

The project is designed to make that kind of experimentation visible, inspectable, and enjoyable.

## Project jobs

`om-jobs` is generated from `${NAMES.pr}-jobs` (rename regenerates the wrapper).
Run it from the project root. Manual `run` is the primary flow; it needs no
resident process and does not make host calls.

```sh
om-jobs init
om-jobs run
om-jobs status
```

JSON results go to stdout and diagnostics to stderr. Refusals/failures exit 1,
cancellation exits 130, and `status` exits 1 when Jobs is not enabled.

- **init** creates/validates `ai-jobs/` and enables local Jobs. It is idempotent
  while enabled and never launches a daemon or task work.
- **run** performs one best-effort scan. It never initializes, reactivates, repairs,
  or launches a daemon.
- **status** is read-only: it shows folder eligibility, task projections/outcomes,
  and diagnostics. `prepared` is unknown liveness, not proof that anything is running.
- **disable** renames `ai-jobs/` to `ai-jobs-disabled/`, preserving bytes.

Task files are Markdown under `ai-jobs/tasks/`. Optional frontmatter keys are
`id`, `enabled`, `schedule` (below), `tools`, `timeout`, and `model`. Omitted
tools inherit normal Agent availability; `tools: []` means none. `timeout` is an
Agent request setting, not a whole-job deadline. Pause a task with
`enabled: false`. Invalid declared metadata blocks only that task and records a
redacted diagnostic in `ai-jobs/errors/`; plain Markdown is a valid one-shot.
Never put credentials in task files.

### Optional daemon and user-owned restart

The daemon is only a foreground, best-effort convenience wake. It scans
immediately, then waits five minutes **after the run child completes**. It is
tied only to its runtime cwd and exits before a wake if `ai-jobs/` is absent,
disabled, or damaged.

```sh
om-jobs daemon foreground  # attach it to your own service/restart policy
```

There is no detached start/status/stop control plane, PID record, or singleton.
Multiple foreground daemons are allowed. SIGINT/SIGTERM are process-local.

If you want periodic or restarted operation, configure it yourself with an
explicit Bun runtime, installed wrapper path, and project cwd; Jobs neither
installs nor edits this configuration. For example (replace both absolute paths):

```cron
*/5 * * * * /absolute/path/to/bun /absolute/path/to/om-jobs run >/tmp/om-jobs.log 2>&1
```

Use the same explicit runtime/wrapper/cwd in your service manager, preferably
with `om-jobs daemon foreground`; do not rely on a shell's PATH or implicit cwd.

`ai-jobs/` alone enables Jobs; `ai-jobs-disabled/` alone disables it. `init`
restores the latter by rename and `disable` renames the former. Both directories
are a collision; symlinks and incomplete layouts are damaged. There are no locks
or coordination records: concurrent scans, CRUD, daemons, archives, state writes,
or disable operations may duplicate execution, lose updates, or race. Users own
filesystem and process changes.

### Task schedules and dispatcher filtering

Schedules are task-local calendar rules evaluated by every manual or daemon
scan. A scan computes local or GMT eligibility and executes only due tasks.
Changing a task affects later scans; it does not alter any user-owned cron or
service configuration.

Task schedules accept `once`, `every 1h`, or structured schedules with exactly
one of `at` (nonempty time array) and `every` (duration), plus optional `days`.
Days accept `weekdays`, `weekends`, or unique lowercase names such as
`[mon, wed, fri]`; omission means every day. Bare times use the local clock and
day; a ` GMT` suffix uses UTC clock and day. Mixed bases, duplicate times and
unknown days are invalid. A scan admits due task occurrences, not an exact-time
alarm: choose a wake cadence fine enough for the desired response time.

For a fixed-GMT stock-market open/close report (illustrative fixed times, **not**
an exchange holiday/DST calendar), create a task:

```yaml
---
schedule:
  at: ["14:30 GMT", "21:00 GMT"]
  days: weekdays
---
Summarize the market at the configured opening and closing times.
```

For an elapsed hourly task admitted only on local weekdays:

```yaml
---
schedule:
  every: 1h
  days: weekdays
---
Review the project and report new work.
```

The nonsecret **job-schedule** tool exposes only `list`, `read`, `create`,
`update`, `remove`. Agent create/update accepts structured `prompt`, `schedule`, and `enabled`
fields and authors canonical Markdown/YAML; it does not expose raw source, tools,
ID, model, or timeout. Agent-created tasks inherit normal tools. Updates preserve
omitted fields and user-authored metadata, including manual tool restrictions.
Filename selectors are ASCII leaf `.md` names beginning with a letter/digit, at
most 120 characters; IDs are opaque parser values, not paths. Create is
atomic/no-clobber; update is atomic/last-writer-wins. Duplicate active IDs are
refused. New tasks wait for a later scan; removing a task preserves history and
never cancels already-running work. The mutation API is unavailable to read-only
Agents.

Publication and invocation independently check enabled local activation,
canonical root, and real project layout. An Agent's folder must equal the project
root. Registration never grants extra tool, secret, or host permissions.
Lifecycle is operator-only; `job-schedule` writes only task files and redacted
diagnostics. Disabling renames the whole active tree. If it happens after an
attempt is prepared, that attempt can remain prepared; restoring the tree lets a
later scan reconcile it as consumed without replaying it. There is deliberately
no lock, generation, or cross-process finalization: an old execution that spans a
disable/restore can finalize the restored tree, while an execution that finishes
while disabled reports `JOBS_FINALIZE_UNAVAILABLE` and never recreates `ai-jobs`.

Each admitted task uses a fresh headless Agent. Questions/login block; no
interactive approval or delegation is granted. One-shots are archived before
execution and failures are not silently replayed. Remote accepted work can outlive
local cancellation; there is no exactly-once guarantee.

Library consumers use the canonical namespace (also exposed as `Omoya.Jobs`):

```js
import Omoya from "./lib/index.js";
const { Jobs } = Omoya;
const status = await Jobs.jobsStatus(projectRoot); // read-only
await Jobs.initializeJobs(projectRoot);            // explicit local enable
await Jobs.scheduleJobs(projectRoot, {
  action: "create", filename: "summary.md", source: "Summarize the project.",
});
await Jobs.dispatchJobs(projectRoot);               // explicit manual scan
```

Handle `JobsError.code` at the boundary: disabled, absent, collision, or damaged
state needs explicit operator action; invalid task input needs correction. Do not
blindly retry a consumed attempt. See
[API.md](API.md) and [API-schema.md](API-schema.md) for signatures. Reusable
examples under `test/fixtures/jobs/` cover plain one-shots, recurring YAML,
disabled tasks, invalid metadata, duplicate IDs, archive collisions, fixed-GMT
market open/close, and local hourly weekdays.
