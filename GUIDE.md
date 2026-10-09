# Omoya guide

This guide holds the details behind the [README](README.md). [API.md](API.md) is the generated library reference. [SECURITY.md](SECURITY.md) describes the trust model.

## Project files

Project files use the `ai-` prefix (see the [README](README.md#your-instructions-your-project)). This prefix never changes, even if the harness is renamed. `bin/scripts/rename` rewrites every other name in one step.

To share a tool, skill, or instruction across all projects, put it in the user settings folder.

## Skills, prompts, and resources

A **skill** is a reusable set of instructions an agent can load. A **prompt** is a reusable task text. Both build up across three roots: the package, the user settings folder, and the project. Each root keeps them in `ai-skills/` and `ai-prompts/`.

#### Overriding and including skills

When two roots define a skill with the same name, the later one replaces the earlier instruction body. Placeholders let you reuse text:

- `{{skill-name}}` includes another skill. Inside a skill that overrides itself, it includes the previous definition.
- `{{skill-name[1-10]}}` includes only lines 1–10 of that skill's expanded body. Lines are 1-based and inclusive, and frontmatter is not counted.
- A reference to another skill uses that skill's effective (final) definition.
- Unknown placeholders stay as literal text.
- Cycles fail. Invalid line ranges on a known skill also fail.

Resource files overlay separately: for each path, the last existing match wins.

#### Loading skills with the `skill` tool

Call `skill` with an array of catalog names to load them. Omit `names` to list the available skills.

- Direct calls also accept a single name. Names are trimmed, not split, and duplicates are removed.
- Loading is atomic. If any name is unknown, the call fails and loads nothing new.
- A skill already active in the current context succeeds without being injected again, even if its file changed. Disk edits apply in a new session.
- Prefilled skills count as active. Compaction, fork, and resume keep them.

Names you write for portable skills should still follow the Agent Skills naming conventions.

#### Reading and copying skill files with `resource`

The `resource` tool lists, reads, or copies files that belong to a skill.

| Call | Result |
|---|---|
| `{name: "web"}` or `list: true` | Lists one level of the skill's resources |
| `{name: "web", path: "examples/build.js"}` | Reads a UTF-8 file, up to 128 KiB |
| add `target: "web/examples/build.js"` | Copies a file, folder, or glob into the caller's folder |

How paths and listing work:

- An omitted `path` selects the skill's root.
- Without a target, folders and glob matches list automatically.
- `list: true` on a file lists its name instead of its content.

Where files come from:

- Skill overlays take priority for each path.
- If no skill has the path, a reachable project (`this` or a grouped project) is used, after request permission.
- Results name the source, never installation paths.

How copying works:

- A `target` means copy, not list. It works with or without `list`.
- Several glob matches go into a target folder, created if needed. Each match keeps its basename. If a file already occupies the target, a numbered folder is used instead.
- If the target file exists, the copy gets ` 002` (then ` 003`, and so on) before the extension. If the target is an existing folder, copies go inside it.
- Each source file is limited to 16 MiB.

Limits:

- Path traversal and observed symlinks are refused.
- Safe mode or missing write permission refuses copying.
- Resources never activate skills or run code.

## Providers

A provider is one module that speaks one model protocol. Omoya ships five, with ready-made endpoints for many services. Most services reach Omoya through the OpenAI or Anthropic protocol.

### Built-in providers

| Protocol | Ready-made endpoints |
|---|---|
| OpenAI | `openai`, `openai-codex`, `azure-openai`, `github-copilot`, `github-copilot-oauth`, `xai`, `lm-studio` |
| Anthropic | `anthropic`, `claude` (subscription OAuth), `deepseek-anthropic`, `minimax-anthropic`, `zai-anthropic` |
| Kimi/Moonshot | `kimi`, `kimi-coding`, `kimi-cn`, `moonshot` |
| Ollama | `ollama` |
| Gemini | `gemini`, `gemini-oauth` |

Run `om --login` to set up an endpoint and `om --list` to see its models. Omoya also finds API keys and local Ollama and LM Studio servers on its own; the [README](README.md#providers) lists what it looks for. To add your own provider, see [API.md](API.md).

### Provider notes

#### Claude subscriptions

Anthropic may restrict accounts that use subscription quotas with other harnesses. Use an Anthropic API key or extra credits instead.

#### Gemini

The Gemini provider speaks Google's **Interactions** HTTP/SSE protocol directly. Its default API version is a provider detail. Compatible services can use a custom API base URL.

**Server-side history.** By default, the provider uses Google's server-side interaction history (`previous_interaction_id`). Gemini may store these interactions under Google's retention policy. If you edit earlier messages, the replay metadata becomes invalid and Omoya resends the local history.

**API key login.** The default `gemini` endpoint uses a [Google AI Studio API key](https://aistudio.google.com/apikey).

**OAuth login (`gemini-oauth`).** To offer the separate `gemini-oauth` login choice, you need your own OAuth client:

1. Create a Google Cloud Desktop OAuth client with the [Generative Language API enabled](https://ai.google.dev/gemini-api/docs/oauth).
2. Set `GOOGLE_GEMINI_OAUTH_CLIENT_ID`, `GOOGLE_GEMINI_OAUTH_CLIENT_SECRET`, and `GOOGLE_CLOUD_PROJECT` before starting Omoya.

Instead of the variables, the CLI wizard can read the downloaded Desktop client JSON. Choose OAuth under `gemini`, and it will prompt for the project ID.

The browser signs in to **your own project**. It uses the Google `cloud-platform` scope and a loopback redirect (`http://127.0.0.1:18995/callback`).

Keep these points in mind:

- OAuth tokens and client configuration are stored in the selected endpoint's auth file. Protect it: it holds the refresh token and the Desktop client secret.
- Usage counts against Developer API quota and billing, **not Gemini Apps subscription allowance**.
- Gemini CLI Google-account credentials and the consumer web endpoint are not compatible presets.

### Usage and quota reporting

Omoya reports two kinds of usage data. Session totals add up across the session. Account limits (quota) are snapshots from the provider. Costs come only from provider reports and are never inferred from prices.

#### Session totals: `agent.usage`

`agent.usage` sums the session's `inputTokens`, `outputTokens`, reported `cost`, and optional cache and reasoning counters.

- `totalTokens` is input plus output.
- Cache reads and writes are part of input. Reasoning is part of output. They are not extra tokens.
- `serviceTier`, `inferenceGeo`, and bounded provider-specific `details` describe the latest request only. They do not accumulate.

Account limits stay separate, in `agent.context.planUsage`. The TUI and Web usage views group the shared fields, then show quota and bounded extension data once.

#### Normalizing reports in provider adapters

Provider adapters call `Agent.Context.usageNormalize(report)` before emitting the final usage event. It maps provider field names to the shared fields. When fields conflict:

- Explicit shared fields win over provider aliases.
- Nested cache details win over root-level cache fields.
- Reasoning-token counts win over thinking-token aliases.

For example, `usageNormalize({ prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } })` returns `{ inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 7 }`.

`usageFinalize(report, messages, response)` runs normalization, then estimates token counts for the whole request/response pair when either count is missing or invalid. Its `source` field marks that the fallback was used.

Other rules:

- Negative or invalid token fields are omitted.
- Unknown metrics are kept as snapshots, not guessed to be additive counters.
- OpenAI per-item attribution is never kept.
- Extension snapshots are capped: depth 6, 256 nodes, 16 array entries, 1,024 characters per string, and 16 KiB of total text. Extra data is omitted.

#### Account quota: `context.planUsage`

`context.planUsage` normalizes these quota fields: `total`, `used`, `remaining`, `unit`, `reset`, `windowSeconds`, `status`, `allowed`, and `limitReached`.

- Common aliases are accepted, such as `window_seconds`, `limit_window_seconds`, `reset_at`, `used_percent`, and `used_ratio`. Explicit counts win over ratios.
- A window's duration is independent of its reset time.
- Any duration label works, such as `4h` or `1d`. Omoya does not assume a fixed 5h/7d pair.
- Recognized Anthropic unified headers become window or account state. Overage stays separate from rolling quotas.
- OpenAI subscription names appear once, as plan labels. Separate code-review and additional quota scopes stay distinct.

The TUI and Web views hide redundant raw window seconds. They group the remaining bounded metadata under Provider details and Plan details. Extension fields that are false, zero, null, or unknown stay visible.

### Install extensions

An extension is an npm package that adds settings, themes, providers, tools, skills, prompts, or hooks. Install it alongside Omoya or in the user settings folder. Then list its package name in that folder's `settings.json`:

```json
{ "extensions": { "@example/omoya-extension": true } }
```

Restart Omoya after installing or changing extensions.

**Only install extensions you trust.** Providers, tools, and hooks run code with access to host resources and credentials.

#### How extensions load

At startup, Omoya resolves each enabled, installed package. A later trusted layer may disable one with `false`. Each package root becomes another content layer:

- Top-level JSON files merge as settings, except `package.json` and npm lockfiles.
- `themes/*.json`, `providers/*.js`, `tools/*.js`, `skills/`, `prompts/`, and `hooks/*.js` follow the usual conventions.
- Folder scans do not recurse.

Load order and limits:

- Extensions load in the order of their keys, after Omoya's package and before user settings.
- Duplicate tool or provider names fail. They never silently replace each other.
- An extension cannot add more extensions.
- Project settings cannot select extensions.

#### Hooks

A hook is code that observes agent events. A `hooks/<name>.js` module exports `hooks(env)`, which returns an object like this:

`{ [Agent.EVENT.MESSAGE_COMMITTED]: (payload, agent) => { /* observe */ } }`

Import `Agent` from `omoya/agent`. Each key must be an existing Symbol from `Agent.EVENT`.

- Hooks observe asynchronously.
- A failing hook never fails a turn. Failures are reported on `Agent.EVENT.LOG`, once per hook and event.
- Hooks load from the harness package, installed extensions, and the user settings folder, **never the project**.
- `tool-refresh` reloads hooks as well as tools.

## Tools

Each tool description gives short usage instructions. For provider compatibility, built-in input schemas avoid `anyOf`/`oneOf` and multi-type arrays.

- Fields that accept several shapes describe their forms in text, without a restrictive type.
- Conditional requirements are explained in descriptions and checked at runtime.
- Argument names and supported forms are unchanged. This includes string or array globs and null note-deletion patches.

Omit unused fields instead of sending placeholder values. Runtime recovery remains internal.

### Folder boundaries and safe mode

Each agent has a working folder, which defaults to the environment's `cwd`. **This folder is the agent's write root**: the only place it can write.

#### What each tool may touch

- `write` and `edit` only write inside the agent folder.
- `read` can read the agent folder and the environment's project tree, including `../` paths to project siblings.
- `read` rejects symbolic links.
- `bash` refuses `cd`, `ln`, and visible paths outside both trees.

Embedded independent agents can have a folder outside the environment tree. Child agents inherit their parent's write root or a narrower one. `worker-create` cannot widen it.

#### The OS sandbox

Mutating tools run in a forked process under an OS write sandbox rooted at the agent folder. Omoya uses macOS Seatbelt or Linux Bubblewrap.

The Bash path scanner is not the write policy. Reading visible project siblings works, but the kernel sandbox blocks writes to them.

#### Safe mode

Safe mode means only read-only tools can run. If no sandbox is available, safe mode is forced. `--safe` turns it on at any time.

The full tool catalog stays published in both modes, so the model's cache survives toggles. Unsafe calls return a read-only refusal.

#### Further safeguards

- Session logs default to the user settings folder, outside the project tree. A project can redirect them inside its own tree. Agents with write access there can then change their own history.
- Tool schemas never carry security metadata.
- Child processes do not inherit environment variables whose names contain a `KEY`, `TOKEN`, `AUTH`, `OAUTH`, `PASSWORD`, `PASS`, or `SECRET` segment, by default. Trusted `settings.env` can pass one through or set a value. Environment additions from tools or MCP merge last and need caller authorization.

### File queries without shell pipelines

The `read` tool replaces common shell commands: cat, head, tail, listings, filename filters, and literal or regex search.

```js
read({ path: "README.md", annotate: false });
read({ path: "log.txt", lines: { from: -8 } }); // last eight lines
read({ path: "src", recursive: true, glob: ["*.js", "*.md"],
  exclude: "generated/**", search: { text: "TODO", regex: "\\bFIXME\\b", before: 2, after: 2 }, limit: 20 });
read({ path: "src", recursive: true, target: "report.txt",
  glob: "*.md", search: { text: "TODO" }, info: true });
```

#### Saving output with `target`

`read` with `target` saves the result to a file instead of returning it to the model. Use it to copy files or save listings and reports.

- It is refused in safe mode. It runs as a sequential mutating call.
- Without an effective search, it forces `annotate: false`, even if you pass true.
- Searches honor `annotate` (default true), so saved results keep source locations.

#### Selecting ranges

- `lines` is 1-based and inclusive.
- `characters` and `bytes` are 0-based and exclusive at the end.
- Negative indexes count from the end. `-1` is the last item. An exclusive `to: -1` omits the last character or byte.
- `lines.last` is another way to select a tail.
- Zero offsets, zero limits, and valid booleans are taken as intended. Model filler values of the wrong type count as absent.
- The old flat arguments `startLine`, `endLine`, `pattern`, and `maxMatches` are no longer accepted.

#### Other options

- `ignore` defaults to false, because Git publishing exclusions often hide useful AI files. Set `ignore: true` to apply `.gitignore`, then `.ignore`, plus system exclusions. Files named explicitly always bypass ignore rules.
- Symlinks are never followed.
- `info` returns metadata instead of content: file details, listing counts, or matching paths with line counts.
- `annotate: false` strips decoration from the payload, but not execution-status warnings.
- `binary` selects raw bytes. `base64` produces encoded text.
- There is no JSON format switch. Copies use `target`.

#### Work budgets

Finite `read` settings limit how much work one call can do:

| Setting | Default | Limits |
|---|---|---|
| `scanBytes` | 64 MiB | total bytes scanned |
| `fileBytes` | 16 MiB | one file |
| `files` | 10000 | files visited |
| `entries` | 20000 | listing entries |
| `grepFileSizeLimit` | 5 MiB | each discovered search file |
| `outputBytes` | 64 KiB | returned output |
| `artifactBytes` | 16 MiB | `read` with `target` |
| `regexMs` | 1000 | regex run time |
| `timeoutMs` | 30000 | whole call |

Positive safe integers change a budget. Zero or negative values do not disable it. Counts cut short by a budget are marked incomplete.

#### Budgets when saving

- With `target`, an omitted `limit` saves all selected listing or search results within these budgets.
- Annotated searches save full lines, not preview excerpts.
- Explicit limits, offsets, and ranges are still honored.
- If a budget runs out, or a search input is too large or unreadable, nothing is saved. An existing destination stays unchanged.
- Raw binary saves hold bytes only, without annotations. Status text is never inserted into saved data.

`write` takes text `content` only. Both `write` and `read` with `target` overwrite existing files by atomic replacement.

## Embed the library

You can run Omoya inside your own program. Open an environment (Env), then create an Agent in it:

```js
import Agent from "omoya/agent";

const env = await Agent.Env.open(process.cwd());   // providers, endpoint detection, tools
const agent = await Agent.create({ env, model: "ollama/gpt-oss:20b", can: { write: false } });
```

#### Where sessions are saved

To keep one project's saved sessions apart, put `{"sessions":"ai-sessions"}` in that project's `ai-settings.json`. Relative paths there resolve against the project folder. Relative paths in user settings resolve against the settings folder.

To override the folder from code without saving the change, pass `sessionsDir` to Env:

```js
await Agent.Env.open(projectPath, { sessionsDir: "private-sessions" })
```

- Relative overrides resolve against `cwd`. Absolute paths work too.
- Each Env keeps its own override.
- Neither the override nor session data is written to settings files.
- Existing agents keep their current Context file. Create or resume a session to use a changed folder.

### One Agent, one conversation

Each Agent holds exactly one conversation. `agent.context` and `agent.env` are read-only, so you cannot swap them out. Create a new Agent for a new conversation.

To resume a saved session, pass its id: `await Agent.create({ env, contextId: "saved-id" })`. If no session has that id, a new session is created.

To branch a conversation, copy its messages into a new Context and give that Context to a new Agent:

```js
const fresh = await Agent.create({ env, model: agent.model });
const fork = await Agent.create({ env, model: agent.model, context: new Agent.Context({
  messages: agent.context.messages(), save: false, origin: env.folder,
}) });
```

A Context you pass in is used unchanged. The Agent does not add another system prompt or overwrite its stored preferences.

A new Agent starts clean. It has no old usage totals, pending messages, tool storage, or workers. Close the old Agent when you no longer need it.

Agent has no `contextNew`, `contextFork`, `contextResume`, or `reseat` API. Replacing the session and switching views in the TUI or Web interface is the App's job.

### Models, IO, and teardown

#### Choosing a model

A model is always named by one qualified string, such as `"ollama/gpt-oss:20b"`. The part before the slash is the endpoint.

Assign `agent.model = "endpoint/model"` to change the model. This validates the choice, updates policy, remembers it, and records it in the session settings. `agent.run()` has no model override.

#### Switching models and endpoints on IO

IO is the object that talks to a provider endpoint.

- While idle, set `io.model = "endpoint/model"` to change the model on the same endpoint.
- `io.write()` has no model or endpoint override.
- To switch endpoints, construct another IO and assign it to `agent.io` while the Agent is idle. The Agent keeps the same Context.
- `io.cancel()` stops the current request. The IO stays usable.
- `io.close()` disconnects the IO for good.

The Web and TUI interfaces derive their own display fields from the model string. Provider adapters pull out the native model ID only when they translate requests for the wire.

#### Creating core objects

Use the async factories:

- `await Agent.Env.open(path, options)` creates an Env.
- `await Agent.create(options)` creates an Agent.

Calling `new Env(...)` or `new Agent(...)` directly throws an error. Both factories are async, even when they reuse an existing Env. The other core constructors (`IO`, `Context`, `Env.SettingsStore`) are still available. All five check their options.

For read-only execution, set `agent.can.write = false`. Tools are still classified by the `safe` metadata in their schema.

#### Closing core objects

Await `close()` on each core object. This releases what the object owns and finishes pending saves.

- Closing an Agent refuses new work at once, but lets the current turn finish. Call `cancel()` first if you want to interrupt it.
- Closing again waits for the same result.
- If releasing something fails, `close()` reports the failure. It does not pretend to succeed.

#### Inspecting the tool catalog

To see which tools an agent offers the model, use `const tools = await agent.tools`. It is a `Map` from tool name to a provider-neutral descriptor with `name`, `description`, and `inputSchema`. For example, `tools.get("read")` returns the read tool's schema, and `tools.has("read")` checks whether it is offered.

The catalog applies the same filters as IO:

- availability
- configured selection
- hidden-tool exclusion
- provider-specific tool and schema overrides

It shows the current catalog before conversion to the provider's format. It is not a record of what was sent earlier.

Both block viewers (^O / Ctrl+O) show the catalog as a read-only virtual system block before the real messages. Each tool gets a Markdown heading and description, followed by its full published descriptor and schema in a JSON code block. This block never enters the conversation history.

#### What stays internal

- Tool-call context is built inside Agent dispatch. There is no public factory for it.
- Tools receive their own transient `storage`, a bound `messageSet(text)`, and `background` process capabilities. These are not Agent methods for the host.
- Agent exposes only the display-message readout.
- Loop policy and compaction guard and queue options are internal. Public `run` accepts only `timeout` and `after`.

### Automatic compaction and the runaway guard

Compaction shrinks a long conversation so it fits the model again. Omoya can start it automatically.

Configure `context` in user or project settings. You can override its keys per endpoint at `providers.<endpoint>.context`, or per model at `providers.<endpoint>.models.<model>.context`. An Agent reads these settings when it is created and when it selects a model. For example:

```json
{"context":{"autocompact":0.4,"autocompactMax":200000}}
```

There are two independent triggers. Whichever enabled limit is reached first starts compaction before the next provider request.

| Key | Default | Meaning |
|---|---|---|
| `autocompact` | `0.4` | Compact at this share of a **known** model context window. |
| `autocompactMax` | 200,000 tokens | Compact at this absolute token count. Works even when the model window is unknown. |

`autocompact` accepts:

- a fraction below 1 (`0.4`), or a percentage above 1 (`40`)
- `true`, which selects 40%
- `false`, `0`, `1`, or `100`, which turn off only this trigger

`autocompactMax` accepts a nonnegative safe integer, not a percentage. `0` turns off only this trigger.

To turn off *all* automatic compaction, set both keys to `0`.

#### What happens after compaction

- A successful compaction keeps waiting messages and continues the original run. The exceptions are a run that is cancelled, closed, or stopped by the runaway guard.
- A failed compaction keeps the original context.

The runaway guard stops a run that uses too much of the context window. Compaction does **not** reset it. Its limits still count usage from before compaction:

- `context.cap`: overall limit, default 90%
- `context.turn`: per-turn limit, default 40%

Both guard limits need a known model window.

### Properties and permissions

#### Properties

Controls with a single value are plain properties. Assign to change them:

- On the Agent: `agent.name`, `description`, `thinking`, `folder`, and `question`.
- On the Context: `context.save` and `context.settings`.
- Provider reports: `context.contextUsage` and `context.planUsage`.

Operations that take a key stay methods, such as `io.settingsSet(key, value)`.

An assignment evaluates to the value you supplied. Read the property afterwards to see the normalized value or any enforced safety limit.

#### Permissions

Permissions live in `agent.can`:

| Key | Behavior |
|---|---|
| `read` | Always true. |
| `write` | Reflects sandbox and parent restrictions. |
| `delegate` | Controls creating child agents. |
| `request` | Controls requests to other root agents and project resources. |
| `interact` | Defaults to true. Always false for children. Can be turned off explicitly. |

- For workers, `delegate` and `request` read false and ignore writes. They return to their defaults once the worker is detached from a closed parent.
- Questions and `ask` actions need `interact`. When it is denied, they return only `tool unavailable`.
- Tools may define more keys.
- Only boolean values grant or deny. Any other value makes Omoya ask the user.

### Settings from the library

#### Responsive settings

`await Env.open(path)` returns a ready Env. Settings respond at once: reads show the current values, and writes apply immediately.

- `env.settings` reads the current settings.
- Discovered themes appear under `env.settings.themes`. Theme files mount at `themes`, never at the settings root. Pass `themes: false` to skip theme-file discovery.
- Overrides passed as `Env.open(path, { settings })` live in a separate, temporary settings node.
- Files save in the background, in one grouped round. `await env.settingsFlush()` waits until they are saved.
- `env.settings.toJSON()` returns a plain snapshot.
- The settings aggregator is public as `Env.SettingsStore`.

Two events report changes:

- `Env.EVENT.SETTINGS_CHANGED` fires once per storage or poll round when values changed.
- `Env.EVENT.SETTINGS_LOADED` fires when a poll round finished reading files, even if the versions were equal.

Reads fire neither event, and writing an equal value changes nothing. Polling rereads a file only when its metadata changed, and never after this process's own save.

#### Global settings before startup

`await Agent.Env.ready()` loads package, installed-extension, and user settings. It does not open a project Env or start providers, tools, or models. Prefer this to waiting for `SETTINGS_LOADED`, because it also works after loading has finished.

Read the live global-only view through `Agent.Env.settings`. For example, `Agent.Env.settings.projects` holds the pinned projects. Each record is keyed by absolute folder and has derived `name` and `folder` fields.

Editing pinned projects:

- Edit global pins through this view, or through an instance's `env.settings.projects`. Use the folder key or the name as an alias.
- A new folder pin written through the instance view inherits that Env's current true groups. A write through the global view adds no groups.
- Only pin data is saved. Derived fields and name aliases are never saved.

Other rules:

- Global writes apply at once. `await Agent.Env.settingsFlush()` waits until they are saved.
- `await Agent.Env.close()` releases only this static view. It does not close open project Envs.
- Set `OMOYA_SETTINGS_DIR` (the prefix follows the harness name) before first access.
- `Env.open(path, {})`, or options set to their default values, reuse the canonical project Env. Non-default options get their own isolated Env.

```js
import Agent from "omoya/agent";
try {
  await Agent.Env.ready();
  const projects = Agent.Env.settings.projects.toJSON();
  for (const path of Object.keys(projects)) {
    const env = await Agent.Env.open(path, {});
    try { console.log(env.name); }
    finally { await env.close(); }
  }
} catch (error) {
  console.error("Settings startup failed:", error.message);
} finally {
  await Agent.Env.close();
}
```

### Ownership

Some objects are copied and some are shared. Know which before you change them.

- `new Context({ messages })` deep-copies the messages you pass in. Forked conversations do not share message objects.
- `context.messages()` returns a new array, but the message objects in it are live. `at()` and `blockAt()` also return live objects.
- Editing a live message directly changes that context but does not mark it as changed. Use the Context edit and update methods so the change is saved.
- Env settings and nested model or tool descriptor values may point at shared global data. Change them on purpose, and never assume you got a defensive copy.
- Settings arrays are detached snapshots. Editing one in place does not update the Env. Replace the whole value to save it and notify listeners.

### Entry points

`omoya` and `omoya/agent` share one headless entry point, `lib/agent.js`. It exports the `Agent` constructor as both default and named export. Core features hang off it as `Agent.Context`, `Agent.Env`, `Agent.IO`, and `Agent.Jobs`.

Import `omoya/app` for `{ Agent, App }`. App adds `App.CLI`, `App.Markdown`, `App.TUI`, `App.Web`, and `App.GTUI`. Core and presentation modules are not repeated as top-level aliases.

`App.CLI` publishes only process-facing operations:

- argument and stdin handling
- signal and exit handling
- terminal login wizards
- session-origin adoption
- settings-template writing

Catalogs, credentials, and settings use Env directly. OAuth flow, tool formatting, and usage-summary formatting are private App helpers.

Load guidance with `agent.skillLoad(names)`. For catalog formatting, use `agent.env.skillCatalog()`, `promptCatalog()`, and `skillSection(entry)`. See [API.md](API.md) and [API-schema.md](API-schema.md).

**Note**: Semantic versioning protects users of the embedded library. Changes to the App and GTUI APIs are not covered by semantic versioning.

## The browser app

The browser app runs the terminal agent's engine in your browser. It is not a separate chat service. Start it with `om --serve --port 9900` and open the local URL it prints.

The app shows the same agent events as the terminal. You can:

- Watch responses, thinking, tool calls, and edit diffs as they arrive.
- Answer the agent's questions, and inspect or edit the context the model receives.
- Use every slash command, or open the command palette with Ctrl/⌘+K.
- Choose a theme, sign in to endpoints, and resume or rename sessions.

The server owns the agent. Closing a tab only detaches your view; the agent keeps working.

#### Several projects on one server

One server can serve several projects. The root URL lists their agents and saved sessions. Each project has its own URL, and groups give shared views across projects.

- Add an existing folder from the project menu.
- In Settings › Projects, pin a project to serve it on the next start, or stop serving one. These actions work only from local connections.
- The app remembers recent models for each pinned project, so you can return to the work you left there.
- Local clients can edit the description in an existing pin record. This does not replace the record's model or group data.

### Requests between projects

Projects in the same group can work together. The `request` tool sends a self-contained message to another root agent. The message can be a handoff, a question, or a reply.

#### Starting and reaching other agents

`to: "new:<role-name>@<project>"` starts a fresh agent, for example `new:api-reviewer@lib`. If the name is taken, Omoya adds `-2`.

- The project can be `this` (always your own project) or a project in your group.
- The new agent inherits the caller's permissions, model, and session logging.
- `model` picks another model, as in `worker-create`.
- `safe: true` makes the new agent read-only.

The result gives the new agent's address, such as `api-reviewer@lib`. The receiver owns a handed-off task and may refuse it.

After that, each side reaches the other as `<name>@<project>`. The name is fixed at first contact. An unknown name fails with a hint to use `new:`. A closed contact resumes from its saved session. Nothing closes automatically.

`resource` reads or copies files from projects you can reach.

#### Permission

Every request and project resource needs `agent.can.request`. When it is unset, Omoya asks the user once. Hosts without a question interface (embedding, `agent`) refuse unless the host sets it to `true`.

#### Library API

Library hosts use `agent.request({to, prompt, safe?, model?})`, `agent.contacts`, and `env.settings.projects`.

Reading `env.settings.projects` returns records keyed by absolute folder. It includes:

- The Env's own project, even when it is not pinned.
- Pinned projects you can reach that share a group with it.

Each record also has derived `name` and `folder` fields. Name aliases point to the same records, and `this` points to the own folder's record. Aliases and derived fields are never saved.

Both `env.settings.projects` and `Agent.Env.settings.projects` write global pins, by folder key or name alias. Writes through the instance view can create new folder pins, even though its reads are filtered. The two views differ when you add a new pin:

- Assigning `env.settings.projects[folder]` copies every true group from this Env's current global pin. The new entry is then reachable.
- Assigning through `Agent.Env.settings.projects` does not add groups.

A project's name is the shortest unique suffix of its folder path. Agents never see folder paths.

### Settings in the browser

The browser always receives a complete snapshot of the effective settings. Each load or update event sends all current values, including defaults and new plugin keys. A removed key disappears; it does not survive a merge. Server-only `auth` subtrees are never sent.

Browser modules can import `settingsRead()` and `settingsSubscribe(listener)` from `app/settings-service.js`. Both return detached snapshots. `settingsSubscribe` returns an unsubscribe function.

Raw Env values, including named theme definitions, stay separate from agent controls and derived display preferences. Changes to theme catalogs, stylesheets, collapse preferences, and preview heights apply to the open view. They do not clear the conversation or your draft.

### Exit and restart

The Settings panel ends with an **Exit app** button. When the app runs under the `omd` supervisor, the button reads **Restart app**, and `omd` relaunches the app in a fresh process.

After an exit request, or a SIGINT/SIGTERM signal, the button changes to **Crash now**. The app then waits for agents to finish:

- Each time a request finishes or fails, a one-minute timer restarts.
- When the timer runs out, the app exits only if all served agents are idle.
- If an agent is still busy, nothing happens until the next request finishes or fails.

**Crash now** stops the process groups that Omoya's sandbox owns, then aborts the app at once. Unsaved changes can be lost. Child processes that escaped those groups are not stopped.

### The omd supervisor

`omd` keeps the browser app and scheduled jobs running under a separate supervisor process. Run `omd`, or `omd --port 9900`.

#### Where it runs

- **Browser app:** starts in the first available pinned project, sorted by path. If no project is pinned, it starts in the launch folder.
- **Jobs:** `omd` checks available pinned projects for an `ai-jobs/` folder. An unpinned launch folder is skipped. If no pinned projects are available, it checks the launch folder instead.
- **Discovery errors:** if project discovery fails, `omd` logs the error, starts the browser app in the launch folder, and skips jobs for that check.

Each eligible project gets its own fresh jobs process. All projects scan in parallel: once at startup, then five minutes after all jobs processes finish.

#### Restarts and fresh code

The browser app and jobs run in fresh child processes, so each restart or scan loads changed library code. When the browser app exits for any reason, including **Restart app**, `omd` restarts it after a capped delay. This does not stop `omd` or the jobs schedule. With `omd`, you can restart the app from the browser whenever you want a fresh start.

Every child starts from a fresh login-shell environment (`$SHELL -l -i`). So profile edits, such as new API keys, apply at the next app restart or jobs scan. Keys removed from your profile are removed too. Variables that exist only in the supervisor's own environment (inline overrides) pass through unchanged.

#### Limits

- To stop `omd` and its tracked children, send SIGINT/SIGTERM directly to the `omd` process.
- Do not run several supervisors, or several jobs scans at once, for the same project. Jobs have no cross-process lock.
- `omd` does not install a system service or detach itself.

### Network exposure

**Safe by default.** The server listens only on loopback, so only this machine can reach it. Websites open in your browser cannot control it either.

Omoya blocks DNS rebinding with any `--host` setting. DNS rebinding is an attack where a website tricks your browser into talking to a local server. The server answers only requests addressed to this machine's own names on its port:

- loopback names
- the bound host
- the OS hostname and its `.local` form
- current network interface addresses

WebSocket and upload requests must also come from the app's own origin.

**LAN access is opt-in.** Start with `--host 0.0.0.0` to use the app from other devices on your network. DNS-rebinding protection stays on, so this is just as safe on trusted networks. Never use `0.0.0.0` on public Wi-Fi or other public networks. The app has no login, so it lets any device on the local network control the agent.

Some actions always need a connection from this machine: adding, pinning, grouping, and removing projects, editing descriptions, and exiting the app.

For remote access, use an SSH tunnel that keeps the same port: `ssh -L 9900:localhost:9900 <machine>`.

### Math

Messages can contain math. Use these delimiters:

- `\(x^2\)` for inline math. This is the recommended form when the text also mentions prices.
- `$x^2$` for inline formulas that cannot be mistaken for prices.
- `$$`, or `\[` and `\]`, on their own lines around display math.

Dollar spans that look like prices, such as `$13/day` or `$2/$10`, stay prices, not math. Code spans and fenced code are never parsed as math.

Omoya supports only a **small TeX subset**: Greek and common symbols, superscripts, subscripts, `\\frac{a}{b}`, and `\\sqrt{x}`. Unknown commands stay as literal text. This is not full KaTeX/LaTeX support.

- **Browser:** draws formulas without external dependencies. Hover a formula to see its original TeX.
- **Terminal:** shows the TeX source exactly, so even partial selections copy correctly.

## Sessions and jobs

Omoya logs sessions as JSONL files in the user settings folder. You can resume, rename, edit, roll back, fork, or delete them. `om --resume latest` picks up where you left off.

Logging is one switch. `--session false`, or the logging toggle in the terminal or browser app, keeps a session in memory only. If you turn logging on later, Omoya writes the whole conversation.

`om-jobs` runs scheduled agent tasks without an interface. Each task is a plain Markdown file under `ai-jobs/tasks/`. A one-shot task needs no frontmatter at all.

```sh
om-jobs init     # create ai-jobs/ (idempotent)
om-jobs run      # one best-effort scan, executes due tasks
```

`om-jobs` prints short notes. Problems and warnings go to `ai-jobs/errors/YYYY-MM-DD.md` in readable form. Each entry has the task file, time, message, and the job's outcome and session id.

`omd` is the only bundled supervisor that runs jobs periodically. `om-jobs daemon foreground` is no longer a CLI action. Use `om-jobs run` for one scan, or call it from your own cron or service manager.

Jobs run best-effort, without locks. Never put credentials in task files.

## Settings

Settings come from an ordered list of sources. When two sources set the same key, the later one wins:

1. Package and installed-extension JSON (read-only).
2. Detected endpoints (memory only).
3. The user folder's files: `settings.json` (where new keys go by default), `projects.json`, `last-model.json`, login auth files (`auth-<endpoint>.json`, mounted at `providers`), and other JSON files.
4. The project's `ai-auth-*.json` and `ai-settings.json`.
5. Explicit `Env.open(path, { settings })` overrides, held in a separate in-memory node.

Merging and writing follow these rules:

- Objects merge by key. Arrays and scalars replace.
- Writes to an overridden key stay in the override node. Other writes go to the source that owns the key, and may be saved to disk.
- Deleting a key reveals the value from the next source.
- Only a login, or you, creates an auth file. Endpoint data without a file stays in memory.
- Every open project shares one global store per user folder. A user change shows up everywhere at once. Project files stay local.
- Settings files accept JSON with comments. Saving an empty file deletes it.

| key | meaning |
|---|---|
| `providers` | Endpoint URLs, protocol names, model metadata, and endpoint limits. Per-endpoint model `filter` regex; `disabled: true` switches an endpoint off |
| `tools` | Tool policy: `folders` path-to-boolean map (trusted package/user roots only), `timeout` (120000 ms), `timeoutLimit` (1200000 ms), `concurrency` (3) |
| `skills` / `prompts` | Extra roots as path-to-boolean maps (`false` disables a path) |
| `extensions` | Installed packages or existing folders, as name/path-to-boolean maps. Package/user scope only, never project. Extensions may add providers and tools |
| `env` | Variables for child processes: `false` removes one; `true` passes the inherited value through; any other non-nullish value sets it |
| `mcp` | MCP server definitions, trusted package/user scope only: `{url, oauth:{clientId?,issuer?}}` for HTTP OAuth, or `command` for stdio. Never keep tokens in settings |
| `projects` | Global pins, stored only in the user's `projects.json`. Folder-keyed records; see the example below |
| `tui` | Interface mode and theme choice (`tui.theme`) |
| `themes` | Named themes for the terminal and browser. See below for where theme files load from |
| `last-model` | Recently used pairs (user `last-model.json`): `{"<endpoint>/<model>": <ISO timestamp>}` |
| `think` | Default reasoning effort |
| `safe` | Start read-only |
| `timeout` / `tools.timeout` | Time limits for each request and each tool call |

A `projects` record looks like this:

```json
{"<absolute folder>": {"models": {"<endpoint>/<model>": "<ISO timestamp>"}, "description": "...", "groups": {"<group>": true}}}
```

- **Derived fields:** reads add `name` and `folder`; neither is saved.
- **Instance view:** `env.settings.projects` shows only reachable records, plus its own record even when unpinned. Name aliases, including `this`, point to the same records.
- **Writes:** both the global and instance views write global pins. Instance writes can create new folder pins despite the read filter.
- **Groups:** a new folder pin assigned through the instance view copies all true groups from its Env's current global pin, so it becomes reachable. The global view does not add groups.

See [Requests between projects](#requests-between-projects).

Theme files: each `themes/*.json` file (in the package, extensions, or user folder) and each project `ai-themes/*.json` file holds `{"<name>": {...}}`. These files load only under `themes`.

#### MCP sign-in

HTTP MCP sign-in is a manual step. Configure the server under `mcp`, then run `om --mcp-login <name>`. You can also use `/mcp-login <name>` in the terminal app or the browser app's login panel.

- If authorization fails, the `mcp` tool reports how to sign in. It never opens a browser.
- MCP tokens live only in user-scope auth files, apart from settings and project files.
- Omoya's hosted OAuth client metadata is at `https://omoya.ai/oauth/client.json`. Deploy `website/build/` before using CIMD sign-in. Authorization servers may instead accept a configured `clientId` or support dynamic registration.
- `mcp` also supports the `resources`/`resource` and `prompts`/`prompt` actions. Content from a server is untrusted tool-result data.

#### Tool settings

Tool durations accept milliseconds as a number, or a string with a unit such as `"30s"`.

- Project settings may change `tools.timeout`, `tools.timeoutLimit`, and `tools.concurrency`.
- `tools.folders` is removed from every project settings or auth file.
- Folder path maps add up across trusted layers. Set a path to `false` to disable it.

Legacy arrays are rejected with migration guidance. Back up the settings file, then convert each array to a `{ "path": true }` map. This object replaces the old `tool`, `toolTimeout`, `toolTimeoutLimit`, and root-level `tools` arrays:

```json
{
  "tools": {
    "folders": {},
    "timeout": 120000,
    "timeoutLimit": 1200000,
    "concurrency": 3
  }
}
```

#### Environment variables

| variable | effect |
|---|---|
| `OMOYA_SETTINGS_DIR`, `OMOYA_SKILLS_DIR`, `OMOYA_PROMPTS_DIR` | Change where settings, skills, and prompts are found |
| `OMOYA_OS_SANDBOX` | Change sandbox behavior |
| Provider keys ([listed in the README](README.md#providers)) | Endpoint auto-detection |
| `SEARXNG_URL` / `SEARXNG_BASE`, `BRAVE_API_KEY` | `web-search` backends |

The `OMOYA_` prefix comes from the harness name and changes with it.

The context guard stops runaway turns at 90% of the context window. Command-line options apply to one run and are never saved.
