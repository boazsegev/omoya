# API (2026-10-30)

## Tool contract — PUBLISHES / REQUIRES / RETURNS (add a tool by reading this)

### PUBLISHES — the module shape a tool file must export

Source: `lib/env/tools.js`

lib/env/tools.js — tool-folder scanning (private to Env).

The scan is NOT recursive: only a root's TOP-LEVEL .js files are
tool modules. Sub-folders are private to the tools — a well-designed
tool is a thin wrapper (tools/read.js) whose helpers/libraries live
beside it (tools/read/engine.js, tools/read/query.js, ...) and are
never imported or published by the scan.

Module contract: a module's toolDescription(env) — or describe(env)
when toolDescription is undefined (the fallback name) — returns an
object keyed
by exported function name, each value an MCP-like {description,
inputSchema} (plus optional harness metadata: safe/trusted/
sandbox/onTimeout/secret/fn — never published). `onTimeout` is an
Agent-facing callback, not a model-facing schema member. `secret:
true` hides the tool from the PUBLISHED catalog (never sent to the
model) while it stays callable directly (bin/scripts/tool, the TUI's
`/<tool>` and Tools menu). A described function is normally
published only when the module exports a callable of that name;
an entry may instead carry its own `fn` (a closure built at scan
time) for names that have no static export. The scan-time `env`
argument lets a module read live settings to decide which such
entries to contribute; it is REBUILT on every refresh, so settings edits take
effect on the next tool-refresh. Modules without any of the three
functions are omitted from the catalog (their import side effects
still run). Duplicate names are diagnosed (throw), never resolved
arbitrarily.

Every scan imports modules with a cache-busting `?v=<revision>`
(bumped on every refresh), so wrappers re-run and re-import their
helpers (stamped with Env.toolRevision()). Bun IGNORES query
strings on file:// URL imports — plain absolute paths only.

A module may also export `settingsSchema()` (zero-arg, sync, same
scan cadence as toolDescription): `{ [settingKey]: {default,
description} }`, merged into the DEFAULTS SCHEMA (see
lib/env/settings-schema.js, env.settingsSchema()) — a tool's own
self-documentation for the setting(s) it reads (tools/read.js
contributes `read` this way). Purely discovery metadata: an unknown
settings key is never rejected either way.

async scanToolRoots(roots, env, { trustedRoots = [] } = {…}): Scan tool roots into a flattened name -> { fn, schema, file, safe? }
map, plus every module's contributed settings-schema entries.

### PUBLISHES — registration and the catalog (Env.tools(safe, selector) -> ToolInfo; provider tools shadow)

Source: `lib/env/tool-registry.js`

registerTool(env, name, fn, schema, { builtin = false, file, allowTrusted = builtin } = {…}): Register a tool into the flattened callable lookup (the scan-load
calls this; programmatic tools may too). Duplicate flattened names
are diagnosed, never resolved arbitrarily. A schema with `safe:
true` publishes the tool for read-only safe mode. A tool with optional
mutating arguments MUST reject those arguments in safe mode and publish
a synchronous `readOnly(args)` classifier for sequential scheduling.
Otherwise safe tools are read-only for every invocation.
Safe-mode Agents publish and execute ONLY safe tools. A missing
`safe` key means false. Every tool receives the same harness context;
interaction is not execution policy. A schema with `trusted: true` requests unrestricted host
execution. It is honored only for tools loaded from the package
root; other roots cannot grant themselves trust. A package-root
`inProcess(args)` classifier can also opt individual calls out of the
forked worker; it is never honored for tools from other roots or programmatic registrations.
Trusted tools may still request the OS sandbox. A schema with `sandbox:
true` marks an ordinary tool for the OS-LEVEL write sandbox (lib/sandbox/os.js — the seatbelt/
bwrap kernel jail): the Agent runs its forked worker under the
wrapper, so the tool cannot WRITE outside the working folder no
matter what its code does. The jail needs a process boundary:
only file-scanned tools get it. `sandbox: false` is invalid policy input
and ignored: an unsafe, untrusted tool is always sandboxed.
`secret:
true` hides the tool from the published (model-facing) catalog while
it stays directly callable (bin/scripts/tool, the TUI's `/<tool>` input
and Tools menu) — for tools meant for the human operator, not the
model. `onTimeout` may be an Agent-facing callback for bounded
cleanup or a final result; it is never sent to the provider. All
harness keys are metadata, stripped from the published catalog
(toolSchemas).

toolsList(env, safe = false, selector): The catalog: eligible tools (only `safe: true` ones when `safe`), and a
pair's provider tools, which SHADOW the same-named global tool (its
schema and safety unless the provider declares its own).

async callTool(env, name, args, context = {…}): Exact flattened lookup + invoke. Missing names are ordinary errors
(Agent surfaces them as tool-result errors), never a crash. The
optional TOOL CONTEXT is handed to every tool as its second argument.
In-process dispatch supplies agent-local storage and messageSet(text), plus
background.start(options)/list()/output(id, from)/stop(id) capabilities.
Detectors receive storage, messageSet(text), agent, and env. Tools declaring
the same `storage` name share one storage box and one published message.
Forked sandbox workers receive the reduced data context plus explicit
JSONL request/reply bridges; host callbacks never cross that boundary.

### PUBLISHES — a worked example: the minimal wrapper shape (read-only, no ctx)

Source: `tools/read.js`

```js
/**
 * tools/read.js — the `read` tool: a cwd-rooted file access tool,
 * read-only unless `target` saves the result. Thin WRAPPER publishing the callable
 * implemented under tools/read/. The tool scan is NOT recursive:
 * sub-folders are never scanned. read/ owns query normalization,
 * guarded execution and serialization; `target` saves through write/save.js.
 * Shared contracts stay explicit. No helper is independently published as a tool.
 *
 * One exception BY DESIGN: tools/guard/ is the shared guard layer
 * EVERY tool imports (read, write, edit, bash) — the deterministic
 * path resolver (guard/resolve.js) and the fast-path content
 * trip-wire (guard/paths.js); path traversal policy is global,
 * never per-tool (see those files).
 *
 * Helper imports are stamped with the shared refresh revision
 * (toolRevision() — lib/tool-runtime.js, the tiny dependency-free
 * runtime the tool scan publishes it through): every refreshTools()
 * bumps it, the wrapper re-runs, and the helpers re-import fresh —
 * editing any read/* module applies on refresh without touching this
 * wrapper.
 */

import { toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp

const timestamp = toolRevision(); // shared tool-registry revision
const { read, readDescription, readSettingsSchema } = await import(`./read/read.js?now=${timestamp}`);

export { read };

export function toolDescription() {
  return { read: readDescription() };
}

/** This tool's own contribution to env.settingsSchema(). */
export function settingsSchema() {
  return readSettingsSchema();
}
```

### PUBLISHES — a worked example: sandboxed (`sandbox: true`, forked, write-jailed)

Source: `tools/write.js`

```js
/** Mutating text writer. Saving read results lives in read.target; both share tools/write/save.js. */
import { toolRevision } from "../lib/tool-runtime.js";
const { saveTarget, savePayload } = await import(`./write/save.js?revision=${toolRevision()}`);

/** Atomically create or overwrite a text file; the destination changes only after guarded checks pass. */
export async function write(args = {}, context) {
  if (context?.safe === true) throw new Error("write is unavailable in safe mode");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("write arguments must be an object");
  for (const key of Object.keys(args)) if (!["path", "content", "ask"].includes(key)) throw new Error(`Unknown write field: ${key}`);
  if (typeof args.content !== "string") throw new TypeError("write.content must be a string");
  if (![undefined, null, "", 0, -1].includes(args.ask) && typeof args.ask !== "boolean") throw new TypeError("write.ask must be a boolean");
  const target = await saveTarget(args.path, context);
  return savePayload(target, { payload: Buffer.from(args.content) }, context, { ask: args.ask === true });
}

export function toolDescription() {
  return { write: { trusted: true,
    description: "Create or overwrite a text file in the Agent folder. Use edit for targeted changes; use read with target to copy files or save read results.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
      path: { type: "string", description: "Destination path inside the Agent folder, relative to it or an absolute contained path." },
      content: { type: "string", description: "Full file text; an empty string creates or clears the file." },
      ask: { type: "boolean", description: "Ask permission if the text references an existing outside path or an existing absolute project path; without permission, the write is refused." },
    } },
  } };
}
```

### PUBLISHES — Agent-owned background commands: bash(background) and process-list/output/stop

Source: `tools/process.js`

async processList(_args = {…}, context): List processes started by this Agent's background bash. Read-only.

async processOutput({ id, from } = {…}, context): Read buffered output from one of this Agent's background processes. Read-only.

async processStop({ id } = {…}, context): Stop one of this Agent's background process groups. Unavailable in safe mode.

toolDescription(): 

### PUBLISHES — Agent's current filtered model-facing descriptors

Source: `lib/agent.js`

get tools(): Current model-facing tools: `const tools = await agent.tools`;
`tools.get(name)` returns a provider-neutral descriptor with its schema.
Uses IO's publication filter: dynamic availability,
configured selection, hidden-tool exclusion and the model's provider tools.
Provider dialect conversion remains IO/provider-owned; this is the current
catalog, not a capture of an earlier request's wire payload.

### REQUIRES — internal dispatch constructs every in-process call's (args, ctx); tools receive capabilities, hosts do not construct them

Source: `lib/agent/tool-context.js`

toolContextFor(agent, call, { trusted = false, info } = {…}): Build the context for an in-process tool or its timeout callback.

### REQUIRES — dispatch: which tools fork (sandboxed worker, REDUCED ctx) vs stay in-process (full ctx)

Source: `lib/agent/tool-exec.js`

async callToolFor(agent, name, args, call, dispatch): Invoke one tool: SANDBOXED (forked child, lib/agent/tool-sandbox.js)
when the tool is file-scanned (a child can rebuild it from the tool
roots). Execution policy is declarative and independent of harness
interaction: every unsafe, untrusted tool forks under the OS write jail;
safe/read-only and trusted tools execute in-process unless they explicitly
request `sandbox: true`. `sandbox: false` is ignored. `agent.folder` only
supplies an OS sandbox root — it never forces a worker.

### REQUIRES — a worked example: an interactive tool (`interactive: true`) using ctx.question.ask

Source: `tools/question.js`

tools/question.js — the `question` tool: ask the user one or more
structured questions mid-task (pi question-tool semantics): 1–4
questions, each with a ≤16-character header chip, 2–16 options
(label ≤60 characters + description, optional preview), and an
optional multiSelect flag. The engine appends its own free-text
affordance (pi's "Type something." row) — it is NOT an option here.

DISENTANGLED from the rendering engine: the tool owns argument
validation and answer normalization; the harness's QUESTION BRIDGE
(context.question.ask — provided by the Agent, which received it
from the TUI/HTML/WebSocket binding) owns rendering the questions
and previews and collecting the answers. The bridge is the
INTERNAL second argument, never part of the published schema.
Bridge answer shape, one per question:
  { labels: string[] }  — the chosen option label(s)
  { text: string }      — a custom typed answer
  { abandoned: true }   — the user pressed Esc
Without a bridge the tool REFUSES (throws): a session with no one
to ask cannot ask — CLI bindings wire the bridge ONLY into the
ACTIVE agent (the one being displayed), so a session running
headless execution has no question handler and every
question is refused. The refusal text tells the model to proceed
with its best judgment instead.

Read-only (safe: true): asking the user mutates nothing — safe-mode
Agents may ask questions. The forked, OS-sandboxed worker uses the
Agent's typed fd-3/fd-4 JSONL ask/answer bridge; no host callback crosses
the sandbox.

### REQUIRES — forked worker's serializable ctx: env, sandbox, deadline, onData, agent.folder; question bridge when enabled; no live Agent or IO

Source: `lib/agent/tool-worker.js`

lib/agent/tool-worker.js — the child-process side of
lib/agent/tool-sandbox.js.

Spawned as `<runtime> lib/agent/tool-worker.js`: reads ONE JSON line
from stdin — {dir, settings, roots, name, args, cwd, projectCwd,
file?, questionBridge?, detached?} — rebuilds an Env
from it, loads the ONE tool module the parent's registry named
(file; never a root rescan), invokes the tool, and writes ONE JSON
result line to stdout:
{ok: true, value} or {ok: false, error}. All ordinary failures are
reported on stdout with exit 0; a nonzero exit (or silence) means
the tool destroyed the process (e.g. process.exit) and the parent
reports that instead — which is the entire point of the sandbox.

THE RESULT LINE IS THE LAST THING WRITTEN — and it must survive
everything a tool printed at IMPORT (a script without an
import.meta.main guard can dump megabytes onto stdout while the
tool scan loads it): the process exits only after the writable
side FLUSHED. process.exit() right after write() discards
user-space pipe buffers — the truncated-result race the parent
reports as "worker exited without a result (code 0)".

This file is executed, not imported, and must stay runtime-agnostic
(no Bun-only APIs).

### RETURNS — every shape a tool's return value may take

Source: `lib/agent/tool-exec.js`

resultContent(value): Normalize a tool return value into result content blocks — the full
tool-answer contract. A tool may return:
  - a string → one text block;
  - an array of content blocks → used as-is;
  - `{content: [...]}` → the content array;
  - any other JSON value → JSON.stringify'd into one text block;
  - `{result, system?, display?}` → `result` is normalized by the rules above,
    while `system` (string or string[]) appends as System messages
    after the complete tool-call batch and `display` is retained on it for
    context viewers (handled by the caller, not here).
Throwing fails the call: the error message becomes the tool-result
error content (error: true on the result message).

async executeToolCall(agent, call, { notify = false } = {…}): Execute one tool call. NEVER throws — failures become tool-result
error messages for the model.

Returns { message, system, display }: the tool result, plus any
SYSTEM PAYLOAD and any DISPLAY PAYLOAD the tool attached. A tool
returning a plain object with a `system` and/or `display` key
answers briefly via `result` (any normal return shape) while
`system` (a string or string[]) appends as System messages after
all results in the assistant's tool-call batch, and `display` (a string or string[]) is
retained on that ToolResult for context viewers and also rides to
the binding. It is not exposed as normal tool-result content to
the model; a tool can show data without sending it to the model. A THROWN error may carry the same `system` payload
as `error.system`: the error becomes the tool-result error AND the
payload appends as System messages.

## Core tool catalog (live schemas)

### `bash`

Run a Bash command in the working folder; return output and any exit code. Prefer read to inspect folders.

Source: `tools/bash.js`; flags: sandbox

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The Bash command to run within a weak sandbox (no cd or ln).  `\\` is often rejected unless it matches known allowed path within this folder tree (save temporary scripts files before running them)."
    },
    "timeout": {
      "type": "integer",
      "description": "Requested milliseconds timeout (default: 120000; capped at 1200000)"
    },
    "env": {
      "type": "object",
      "description": "Extra environment variables for the command."
    },
    "background": {
      "type": "boolean",
      "description": "Use for processes intended to keep running (servers, daemons, etc'); not a timeout extension. Returns process id. Inspect with process-list/process-output or stop with process-stop."
    }
  },
  "required": [
    "command"
  ]
}
```

### `edit`

Replace exact text in one file. Read the file first, then send oldText/newText pairs from its current content. Merge nearby or overlapping changes into one edit. Set matchAll on an item to replace every occurrence of that item's oldText. Use edit-undo with the returned edit id to reverse it.

Source: `tools/edit.js`; flags: trusted

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File inside the Agent folder; use a relative or contained absolute path."
    },
    "edits": {
      "type": "array",
      "description": "The replacements to make. Match each oldText against the file as it is now, not against earlier edits in the same call. Never send overlapping or nested edits; merge them into one edit.",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "description": "The exact text to replace. Make it unique unless matchAll is true; never overlap another edit’s oldText."
          },
          "newText": {
            "type": "string",
            "description": "The replacement text."
          },
          "matchAll": {
            "type": "boolean",
            "description": "Replace every occurrence of this oldText. Omit to require a unique match."
          }
        },
        "required": [
          "oldText",
          "newText"
        ]
      }
    },
    "ask": {
      "type": "boolean",
      "description": "Ask the user for permission, showing the offending lines, when a newText names an existing outside path or an existing absolute project path. Omit it to refuse such edits outright."
    }
  },
  "required": [
    "path",
    "edits"
  ]
}
```

### `edit-undo`

Reverse a recent edit using its returned edit id and the same file path. The file must still hold the replacement text at the edited positions; otherwise read the file and make a new targeted edit. Undo itself returns an edit id for redo.

Source: `tools/edit.js`; flags: trusted

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The file path used for the original edit, inside the Agent folder."
    },
    "editId": {
      "type": "string",
      "description": "The edit id returned by a recent successful edit or edit-undo."
    }
  },
  "required": [
    "path",
    "editId"
  ]
}
```

### `job-schedule`

Manage scheduled project tasks: list, read, create, update, or remove. Use enabled: false to pause a task. Updates preserve omitted fields and take effect on a later scan; removing a task does not stop a running job. This tool does not run tasks or configure the scheduler.

Source: `tools/job-schedule.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "action"
  ],
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "read",
        "create",
        "update",
        "remove"
      ],
      "description": "Choose the task operation. For update, supply only fields to change; remove keeps history and running work."
    },
    "filename": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9 ._-]*\\.md$",
      "maxLength": 120,
      "description": "Leaf .md filename for read/create/update/remove; never a path or opaque task ID."
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "Task instructions. Required for create; omitted on update to preserve the current prompt."
    },
    "enabled": {
      "type": "boolean",
      "description": "Whether the task may run. Omitted on update to preserve the current value."
    },
    "schedule": {
      "description": "Task schedule: a string (once or every <duration>, e.g. every 1h), or an object with exactly one of at/every and optional days. Omit on update to preserve it.",
      "additionalProperties": false,
      "properties": {
        "at": {
          "type": "array",
          "minItems": 1,
          "description": "Run at these HH:MM times; append GMT for UTC, otherwise use local time. Do not combine with every.",
          "items": {
            "type": "string",
            "pattern": "^(?:[01][0-9]|2[0-3]):[0-5][0-9](?: GMT)?$"
          }
        },
        "every": {
          "type": "string",
          "pattern": "^[1-9][0-9]*[mhdw]$",
          "description": "Run at this interval: a positive number followed by m, h, d, or w. Do not combine with at."
        },
        "days": {
          "description": "Restrict runs with the string weekdays/weekends, or an array of day abbreviations (sun, mon, tue, wed, thu, fri, sat).",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "enum": [
              "sun",
              "mon",
              "tue",
              "wed",
              "thu",
              "fri",
              "sat"
            ]
          }
        }
      }
    }
  }
}
```

### `note-list`

List scratchpad notes for the current context: each title with its type badge. Use note-read for contents.

Source: `tools/note.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

### `note-read`

Read scratchpad notes by title; omit titles to read every note.

Source: `tools/note.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "titles": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Note titles from note-list."
    }
  }
}
```

### `note-write`

Create, update or delete scratchpad notes in one call. Prefer content, summary and type fields; add other JSON fields as needed. Notes live only in the current context; store durable data in files.

Source: `tools/note.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "notes"
  ],
  "properties": {
    "notes": {
      "type": "object",
      "description": "Title → patch map; a null patch deletes that note.",
      "additionalProperties": {
        "description": "Patch for this title: set fields merge in (nested objects merge, arrays and scalars replace); a null field deletes it; a null patch deletes the note.",
        "properties": {
          "content": {
            "description": "The full note body."
          },
          "summary": {
            "description": "A one-line gist."
          },
          "type": {
            "description": "todo, active, done or info."
          }
        },
        "additionalProperties": true
      }
    }
  }
}
```

### `process-join`

Wait for this Agent's background Bash process; return its output and exit code like bash. Timeout starts on join and stops the process group.

Source: `tools/process.js`; flags: trusted, onTimeout

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Process id returned by background Bash."
    },
    "timeout": {
      "type": "integer",
      "minimum": 0,
      "description": "Milliseconds to wait from this call (default: 120000; capped at 1200000). Stops the process on timeout."
    }
  },
  "required": [
    "id"
  ]
}
```

### `process-list`

List this Agent's background Bash processes.

Source: `tools/process.js`; flags: safe

```json
{
  "type": "object",
  "properties": {}
}
```

### `process-output`

Read buffered output from this Agent's background Bash process.

Source: `tools/process.js`; flags: safe

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Process id returned by background Bash."
    },
    "from": {
      "type": "integer",
      "minimum": 0,
      "description": "Byte offset (default 0); pass the returned next offset on subsequent calls."
    }
  },
  "required": [
    "id"
  ]
}
```

### `process-stop`

Stop this Agent's background Bash process group. Unavailable in safe mode.

Source: `tools/process.js`; flags: trusted

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Process id returned by background Bash."
    }
  },
  "required": [
    "id"
  ]
}
```

### `question`

Ask the user to resolve a decision or provide missing information. Send 1–4 clear questions with distinct options; users can also give custom answers.

Source: `tools/question.js`; flags: safe, sandbox

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user (1-4 questions)",
      "items": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string",
            "description": "The complete question to ask the user. Clear, specific, ending with a question mark."
          },
          "header": {
            "type": "string",
            "description": "Very short chip/tag shown next to the question (max 16 characters)."
          },
          "details": {
            "type": "string",
            "description": "Optional supporting context, constraints, or consequences shown under the question."
          },
          "multiSelect": {
            "type": "boolean",
            "description": "Allow selecting multiple options instead of just one."
          },
          "options": {
            "type": "array",
            "description": "The available choices (2-16 options).",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string",
                  "description": "The display text for this option (max 60 characters)."
                },
                "description": {
                  "type": "string",
                  "description": "What this option means or what happens if chosen."
                },
                "preview": {
                  "description": "Optional focused preview: a plain string, or an object with type (text/code) and content. Add title or language when useful.",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "text",
                        "code"
                      ],
                      "description": "Display the preview as plain text or code."
                    },
                    "content": {
                      "type": "string",
                      "description": "Preview text or code to show for this option."
                    },
                    "language": {
                      "type": "string",
                      "description": "Code language for syntax highlighting; omit for plain text."
                    },
                    "title": {
                      "type": "string",
                      "description": "Short title for the preview."
                    }
                  }
                }
              },
              "required": [
                "label",
                "description"
              ]
            }
          }
        },
        "required": [
          "question",
          "header",
          "options"
        ]
      }
    }
  },
  "required": [
    "questions"
  ]
}
```

### `read`

Read files, list folders, or search contents. Heed skip and incomplete notices before assuming full coverage.

Source: `tools/read.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path"
  ],
  "properties": {
    "path": {
      "type": "string",
      "maxLength": 4096,
      "description": "File or folder, relative to the Agent folder or absolute inside the project. . is the current folder; ../ reaches project siblings."
    },
    "recursive": {
      "type": "boolean",
      "default": false,
      "description": "Include subfolders."
    },
    "ignore": {
      "type": "boolean",
      "default": false,
      "description": "Skip .gitignore/.ignore matches and system files in folder scans."
    },
    "glob": {
      "minLength": 1,
      "maxLength": 4096,
      "maxItems": 128,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "description": "Only files matching a glob string or array, e.g. *.md, src/**/*.js, {a,b}. Slashless patterns match filenames."
    },
    "exclude": {
      "minLength": 1,
      "maxLength": 4096,
      "maxItems": 128,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "description": "Skip files or subtrees matching a glob string or array; overrides glob."
    },
    "lines": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "from": {
          "type": "integer",
          "description": "Start."
        },
        "to": {
          "type": "integer",
          "description": "End."
        },
        "last": {
          "type": "integer",
          "minimum": 0,
          "description": "Last N lines instead of from/to."
        }
      },
      "description": "1-based inclusive line range; negative counts from the end (-1 is last)."
    },
    "characters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "from": {
          "type": "integer",
          "description": "Start."
        },
        "to": {
          "type": "integer",
          "description": "End."
        }
      },
      "description": "0-based, end-exclusive character slice of the selected lines; negative counts from the end."
    },
    "bytes": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "from": {
          "type": "integer",
          "description": "Start."
        },
        "to": {
          "type": "integer",
          "description": "End."
        }
      },
      "description": "0-based, end-exclusive byte slice; negative counts from the end. Requires binary."
    },
    "search": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "description": "Literal substring."
        },
        "regex": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "description": "JavaScript regex, without / delimiters."
        },
        "ignoreCase": {
          "type": "boolean",
          "default": false,
          "description": "Case-insensitive."
        },
        "invert": {
          "type": "boolean",
          "default": false,
          "description": "Select non-matching lines."
        },
        "before": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000,
          "default": 0,
          "description": "Context lines before each match."
        },
        "after": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000,
          "default": 0,
          "description": "Context lines after each match."
        }
      },
      "description": "Select lines matching text or regex (either)."
    },
    "limit": {
      "type": "integer",
      "minimum": 0,
      "default": 100,
      "description": "Maximum listing entries or matching lines (matching paths with info); context lines are extra. Omit with target to save all results within host budgets."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "default": 0,
      "description": "Skip this many entries or matches."
    },
    "info": {
      "type": "boolean",
      "default": false,
      "description": "Return metadata, counts, or matching paths with per-file match counts instead of content."
    },
    "annotate": {
      "type": "boolean",
      "default": true,
      "description": "Include MIME types, ranges, and locations; false gives plain text or paths."
    },
    "binary": {
      "type": "boolean",
      "default": false,
      "description": "Read raw bytes; search then returns a match report."
    },
    "base64": {
      "type": "boolean",
      "default": false,
      "description": "Base64-encode the selected data. Not with info."
    },
    "target": {
      "type": "string",
      "description": "Save the complete selected result to this project file instead of returning it; refuse incomplete output. Available only if `write` is available."
    }
  }
}
```

### `request`

List Projects. Exchange requests / replies with external agents (not your worker/parent). Use to collaborate on complex tasks that require a number of teams to complete, or to file bug reports or ask questions in other projects. Not for delegating tasks to workers. Not for copying resources from other projects (user `resource`). Start an agent with `to: "new:<role-name>@<project>"`; later use the <name>@<project> from the result or from a received request's label. The receiver may refuse. Replies arrive as messages; finish your turn to wait. Projects: this (your own project).

Source: `tools/request.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "to",
    "prompt"
  ],
  "properties": {
    "to": {
      "type": "string",
      "minLength": 3,
      "description": "<name>@<project>, or new:<role-name>@<project> (e.g. new:api-reviewer@this) to start an agent."
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "Self-contained: include context and expected outcome. Use skill when available."
    },
    "model": {
      "type": "string",
      "description": "Model for a new agent; omit unless critical. Matching a contact's current model is ignored."
    },
    "safe": {
      "type": "boolean",
      "description": "Start the new agent read-only; false on an existing contact is ignored."
    }
  }
}
```

### `resource`

List, read or copy files of a skill or a project. A path missing from a skill is looked up in the project of the same name. Copies never overwrite: an existing destination is saved as "<name> 002.<ext>". Symbolic links are never followed: searches and listings skip them; copies refuse them. Projects: this (your own project).

Source: `tools/resource.js`; flags: safe, trusted

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Skill or project name."
    },
    "path": {
      "type": "string",
      "description": "File, folder or glob relative to the skill or project root. Omit for the root. Folders and glob matches list automatically without target."
    },
    "list": {
      "type": "boolean",
      "default": false,
      "description": "List names instead of reading file content. With target, copy the selected resources."
    },
    "target": {
      "type": "string",
      "description": "Copy selected resources to this file or folder in your folder, with or without list; an existing folder receives the copy. Multiple matches use a folder, numbered if a file occupies target."
    }
  },
  "required": [
    "name"
  ]
}
```

### `skill`

Load relevant skills before starting a task and follow their instructions. Omit names to list available skills; pass an array of catalog names to load them.

Source: `tools/skill.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "names": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Skill names to load, e.g. [\"api-design\"]. Omit to list the catalog."
    }
  }
}
```

### `splice`

Copy source lines into target lines; source stays unchanged. Write a temporary source and use this tool for large edits. Use edit-undo with the returned edit id.

Source: `tools/splice.js`; flags: trusted

```json
{
  "type": "object",
  "required": [
    "source",
    "target"
  ],
  "properties": {
    "source": {
      "type": "object",
      "description": "Existing file and 1-based inclusive lines to copy.",
      "required": [
        "path",
        "from",
        "to"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "Source file inside the Agent folder."
        },
        "from": {
          "type": "integer",
          "description": "First source line."
        },
        "to": {
          "type": "integer",
          "description": "Last source line."
        }
      }
    },
    "target": {
      "type": "object",
      "description": "Existing file and 1-based inclusive lines to replace; at inserts before a line (or appends at line count + 1). If given with at, from and to must both equal at.",
      "required": [
        "path"
      ],
      "properties": {
        "path": {
          "type": "string",
          "description": "Target file inside the Agent folder."
        },
        "from": {
          "type": "integer",
          "description": "First line to replace."
        },
        "to": {
          "type": "integer",
          "description": "Last line to replace."
        },
        "at": {
          "type": "integer",
          "description": "Insert before this line; line count + 1 appends."
        }
      }
    }
  }
}
```

### `web-fetch`

Read one HTTP(S) page or API response as Markdown, text, or JSON text. Supply the direct URL; check truncation notices before assuming the response is complete.

Source: `tools/web.js`; flags: safe, trusted

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "HTTP(S) URL without embedded credentials"
    }
  },
  "required": [
    "url"
  ]
}
```

### `web-search`

Search the internet for relevant pages. Use a focused query and limit the number of results; use web-fetch to read a result's full page.

Source: `tools/web.js`; flags: safe, trusted

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query, including any engine syntax"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 40,
      "default": 40,
      "description": "Maximum number of results to return (1–40)."
    }
  },
  "required": [
    "query"
  ]
}
```

### `worker-close`

Close named workers, /regex/ matches, or all with ["*"]. Busy workers are asked to hand off their work first.

Source: `tools/worker-close.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "workers"
  ],
  "properties": {
    "workers": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "description": "Worker names, /regex/ patterns, or [\"*\"] for all workers. Use * alone."
    }
  }
}
```

### `worker-create`

Create named workers and optionally send the same self-contained first prompt to each. Omit or empty prompt creates idle workers. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive as messages; finish your turn rather than waiting.

Source: `tools/worker-create.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "workers"
  ],
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Self-contained first prompt sent unchanged to each worker; omit or use an empty string to create idle workers."
    },
    "workers": {
      "type": "array",
      "minItems": 1,
      "description": "Workers to create. Give each a unique name and any model, role, or scope options it needs.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "description": "Short unique role name, e.g. reviewer. Workers can't read their own name."
          },
          "model": {
            "type": "string",
            "description": "Model for the worker; omit to use yours."
          },
          "thinking": {
            "type": "string",
            "enum": [
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ],
            "description": "Thinking level; omit unless critical. Default to empty or medium."
          },
          "description": {
            "type": "string",
            "description": "Worker's role description."
          },
          "safe": {
            "type": "boolean",
            "description": "Start the worker read-only."
          },
          "subfolder": {
            "type": "string",
            "description": "Existing subfolder of your folder that limits the worker's writes; omit for your folder."
          }
        }
      }
    }
  }
}
```

### `worker-message`

Send one prompt to named workers, /regex/ matches, or all with ["*"]. Replies arrive as messages; finish your turn rather than waiting.

Source: `tools/worker-message.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "to",
    "prompt"
  ],
  "properties": {
    "to": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      },
      "description": "Worker names, /regex/ patterns, or [\"*\"] for all workers. Use * alone."
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "Self-contained message sent unchanged to each worker. A leading /compact or /<prompt> runs that command (see worker-status)."
    }
  }
}
```

### `worker-status`

Show workers (busy/idle), models with free capacity, and the commands a message may start with (/compact, /<prompt>). Omit flags for all sections. Not for worker polling / busy waiting (just finish your turn and they will update you when they're done).

Source: `tools/worker-status.js`; flags: safe, trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workers": {
      "type": "boolean",
      "description": "Include workers and their models."
    },
    "models": {
      "type": "boolean",
      "description": "Include models and their free capacity."
    },
    "commands": {
      "type": "boolean",
      "description": "Include message commands."
    }
  }
}
```

### `write`

Create or overwrite a text file in the Agent folder. Use edit for targeted changes; use read with target to copy files or save read results.

Source: `tools/write.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path",
    "content"
  ],
  "properties": {
    "path": {
      "type": "string",
      "description": "Destination path inside the Agent folder, relative to it or an absolute contained path."
    },
    "content": {
      "type": "string",
      "description": "Full file text; an empty string creates or clears the file."
    },
    "ask": {
      "type": "boolean",
      "description": "Ask permission if the text references an existing outside path or an existing absolute project path; without permission, the write is refused."
    }
  }
}
```
## Agent

### `class Agent`

The agent: the ordered context, the provider/model selection, the
tool loop, the pending queue and the session persistence, behind one
headless object.

### `Agent.Context`

Constructor namespace; see [Agent.Context](#agentcontext) for its full contract.

Returns `typeof Agent.Context` — The shared constructor namespace.

### `Agent.Env`

Constructor namespace; see [Agent.Env](#agentenv) for its full contract.

Returns `typeof Agent.Env` — The shared constructor namespace.

### `Agent.IO`

Constructor namespace; see [Agent.IO](#agentio) for its full contract.

Returns `typeof Agent.IO` — The shared constructor namespace.

### `Agent.Jobs`

Constructor namespace; see [Agent.Jobs](#agentjobs) for its full contract.

Returns `typeof Agent.Jobs` — The shared constructor namespace.

### `Agent.EVENT`

The Symbol event vocabulary for Agent.onEvent — events about THIS
agent only (Env reports membership: AGENT_ADDED/AGENT_REMOVED):
REQUEST_START, TEXT_START, TEXT_DELTA, TEXT_END, THINKING_START,
THINKING_DELTA, THINKING_END, TOOL_CALL_START, TOOL_CALL_DELTA,
TOOL_CALL_END, REQUEST_DONE, REQUEST_ERROR,
MESSAGE_COMMITTED, LOG, TOOL_EXECUTE, TOOL_DATA, TOOL_RESULT,
CLOSE_MARKED, CLOSED, SENT_MESSAGE, CONTEXT_REPLACED — see Agent.onEvent's
documentation for each value's meaning and payload.

### `Agent.EVENT_CALLBACKS`

The [responseCallbackName, Agent.EVENT] pairs: every EVENT value's
corresponding option-callback name ("onTextDelta" for
Agent.EVENT.TEXT_DELTA, …), for hosts that prefer per-event
callbacks over one onEvent listener.

### `Agent.NAMES`

Namespace-derived runtime names. `Namespace` is the canonical product
name; the public library façades retain their own names (see lib/agent.js).
The UPPER/lower variations supply prefixes for environment variables and
namespace-specific runtime paths.

### `Agent.busy`

**Read** — `get busy()`

Whether an agent run is currently in progress. @returns {boolean}

### `Agent.can`

Live agent-owned capability map. `read` is always true; `write` is subject to sandbox and parent restrictions; a child's `delegate` and `interact` are always false. Tools may define their own keys; only boolean values allow or deny, others require asking. Assignments persist with session settings.

Returns `{read: boolean, write: boolean, delegate: *, interact: boolean, [capability: string]: *}` — Live agent-owned capability map. `read` is always true; `write` is subject to sandbox and parent restrictions; a child's `delegate` and `interact` are always false. Tools may define their own keys; only boolean values allow or deny, others require asking. Assignments persist with session settings.

### `Agent.cancel()`

Cancel active IO and every pending tool dispatch; queued calls never start.
Dispatch owns sandbox teardown. Resolves after active dispatch resources
are released; repeated cancellation is safe and needs no escalation.

### `Agent.childCreate(options = {…})`

Construct one direct child through the environment factory. The parent
relationship is authoritative for ownership and delegation denial.

- `[options]` (object)

Returns `Promise<Agent>`

Throws — {Error} when this agent's env is closed (env.agentCreate)

### `Agent.children`

**Read** — `get children()`

Snapshot of directly owned workers.

### `Agent.close()`

Mark closure synchronously, refusing admission immediately. Finish an active
turn without cancelling it; callers who need interruption call cancel().
Await completion for all owned IO, context persistence, background processes,
registry and hook removal, never the borrowed Env. Concurrent and repeated
calls await the same outcome. CLOSE_MARKED
precedes cleanup; CLOSED follows every attempted release. All cleanup and
listener failures are reported together after the remaining releases run.

Returns `Promise<void>` — Completion of owned teardown; rejects with AggregateError on failures.

### `Agent.closeMarked`

**Read** — `get closeMarked()`

Whether close has been requested, including while a turn finishes.

### `Agent.closed`

**Read** — `get closed()`

Whether close cleanup has completed.

### `Agent.compact(focus = "")`

Compact: ask the model to summarize the conversation
(a structured, self-contained prompt), then continue in a new context
with the surviving SYSTEM messages plus one ASSISTANT message
holding the marked summary (lib/agent/compact.js). Compact is an
ordinary turn observed through Agent events; a no-op (context
untouched) when the model's turn returns no usable summary text.

- `[focus]` (string) — optional user guidance appended to the summary prompt

Returns `Promise<{ok: boolean, before: number, summaryText?: string}>`

### `Agent.constructor(options = {…}, construction)`

Build an agent over an environment; wires the session store (a
named file session, a resumed one, an injected store, or none) and
takes ownership of the seed context — a NEW (non-resumed) context
starts with the seeded system prompt as its FIRST message(s).

- `[options]` (Object)
- `options.env` (Env) — required borrowed environment; use Agent.create() for asynchronous acquisition
- `[options.model]` (string) — default `<endpoint>/<model>` selector
- `[options.context]` (Array|Context) — seed messages (deep-copied into the owned Context), or a ready Context used as is (then no `session`) (seed arrays receive the system prompt ahead of them; a ready Context is adopted without changing its messages or stored settings)
- `[options.tools]` (string[]) — availability selection (omitted/["*"]=all, []=none)
- `[options.parent]` (Agent) — creating Agent, or unset for non-Agents
- `[options.name]` (string) — display name (default: `agent-<counter>`); names that read as an address or a privileged identity are reserved (see `name`)
- `[options.description]` (string) — display description (empty allowed)
- `[options.folder]` (string) — existing env.folder-relative or absolute working folder; validated before the agent is registered (omitted uses env.folder)
- `[options.can]` (object) — agent capabilities: read is always true; write false denies mutations while preserving the full catalog, and is forced false without OS sandbox or when the parent denies writes; delegate allows child creation (false denies; other values ask); interact defaults true but is false for children. Additional tool-owned keys are allowed.
- `[options.contextId]` (string|false) — names the context: an existing id (in env.settings.sessions) is resumed — only a session recorded in env.folder; an absent id creates it. `false` (or omitted, or an anonymous spelling "0"/"false"/"anon") gives a memory-only context that is not logged — (agent.context.save = true) starts logging it at any time.
- `[options.contextSave=true]` (boolean) — whether a context named by `contextId` is logged to disk
- `[options.createIO]` ((opts:object)=>object) — IO factory (tests inject fakes)
- `[options.onStart]` ((payload: object) => void) — response callback; onStart, onTextStart, onTextDelta, onTextEnd, onThinkingStart, onThinkingDelta, onThinkingEnd, onToolCallStart, onToolCallDelta, onToolCallEnd, onDone, and onError map to Agent.EVENT_CALLBACKS. Supplied callbacks register through onEvent before Env membership events; done/error fire after request bookkeeping.

Throws — {TypeError} Direct construction, missing or invalid Env, non-object options, unknown own keys (including symbols), non-function response callbacks, and unknown toolCall keys are rejected before Context adoption. Use can.write instead of the removed safe key; count limits and toolCall.async are unsupported.

### `Agent.contacts`

**Read** — `get contacts()`

Sorted contact addresses (`alias@project`); aliases never change.

Returns `string[]` — Sorted contact addresses (`alias@project`); aliases never change.

### `Agent.context`

**Read** — `get context()`

The live conversation owned and closed by this Agent. Mutate its messages/settings through Context; construct another Agent for another conversation. Identity is read-only for the Agent's lifetime.

Returns `Context` — The live conversation owned and closed by this Agent. Mutate its messages/settings through Context; construct another Agent for another conversation. Identity is read-only for the Agent's lifetime.

### `Agent.contextUsage`

**Read** — `get contextUsage()`

The context-window readout for the status surface (most exact
first: the provider's own report, the last provider-reported
envelope, the word-count estimate marked `approximate`).

Returns `{used: number, total: number|null, approximate: boolean}`

### `Agent.create(options = {…})`

Open an Agent with a ready Env. When env is omitted, acquire the Env for
cwd (the process cwd by default) through Env.open. The returned Env is
borrowed: the caller, not Agent.close(), decides when to close it.
`folder` independently selects the Agent's tool root, never the Env path.

- `[options={}]` (object) — Agent creation options plus cwd and envOptions.
- `[options.cwd=process.cwd()]` (string) — Env project path, only when env is omitted.
- `[options.envOptions]` (object) — Options forwarded to Env.open, only when env is omitted.

Returns `Promise<Agent>` — A fully constructed Agent; options are not mutated or retained.

Throws — {TypeError|Error} Invalid options or Env startup/Agent construction failure; fix inputs before retrying. Env acquisition is not undone if Agent construction fails.

### `Agent.description`

**Read** — `get description()`

Human-friendly Agent description; an empty string is valid.

**Write** — `set description(value)`

Describe the agent (recorded into a logged context's settings).

- `value` (string)

Returns `void` — Assignment records the new description.

### `Agent.env`

**Read** — `get env()`

Borrowed, read-only environment identity; Agent never closes it.

Returns `Env` — Borrowed, read-only environment identity; Agent never closes it.

### `Agent.finishAdd(fn, { process: proc = process } = {…})`

Register `fn` for synchronous execution on the configured process's `exit` event.

- `fn` (() => void) — Cleanup callback; must be synchronous and may run more than once.
- `[options]` (Object) — Registration options.
- `[options.process=process]` (NodeJS.Process) — Process to attach the exit hook to.

Returns `() => void` — Idempotent function that unregisters `fn` from the shared cleanup set.

Throws — {TypeError} If `fn` is not a function.

### `Agent.finishRun()`

Invoke a snapshot of all registered cleanups synchronously; swallow callback errors.

Returns `void`

### `Agent.folder`

**Write** — `set folder(folder)`

Set this agent's tool working folder to an existing directory.
`undefined` restores the parent folder for children, or Env.folder for independent Agents.
Embedded independent Agents may use another tree.

- `folder` (string|undefined|null) — absolute or env.folder-relative

Returns `void` — Read folder afterwards for the resolved root.

**Read** — `get folder()`

The agent-local root used for file tools and their OS sandbox.

### `Agent.fork({ id, through } = {…})`

Create an independent Agent from a deep copy of this conversation at a message boundary.
The source is neither closed nor changed; the returned Agent owns its new Context
and has no parent. Its runtime work, event listeners and usage are not copied.

Returns `Promise<Agent>` — A new Agent owned by the caller; close it independently.

Throws — {TypeError|RangeError|Error} Invalid options, boundary, existing session id, or a closing/running source; correct the input or wait for the source to become idle. Factory failures leave the source intact; retry after resolving the failure.

### `Agent.io`

**Read** — `get io()`

The selected IO session, lazily created for this Agent's model; undefined when no model is selected.

Returns `IO|undefined` — Agent-owned active provider IO; the Context is never stored in IO between requests.

Effects — Creates a provider IO on first read without sending a request.

**Write** — `set io(value)`

Adopt another idle IO session for subsequent requests using the same Context.

- `value` (IO) — IO using this Env, configured with this Agent's safety/tool policy.

Returns `void` — The adopted IO is closed with this Agent. The caller owns and closes any displaced IO obtained from the getter.

Throws — {TypeError} Invalid IO, another Env, busy/closed Agent or IO; correct configuration or await idle before retrying. Validation failures leave selection unchanged.

Effects — Selects and records value.model, then replaces the cached IO. Reassigning the same IO is idempotent.

### `Agent.ioState`

**Read** — `get ioState()`

The connection/work state for the TUI's status indicator:
"working" (a run is in flight), "disconnected" (the last turn
failed connection-class), "idle" (otherwise).

Returns `"idle"|"working"|"disconnected"`

### `Agent.model`

**Write** — `set model(selector)`

Select an exact, configured endpoint/model pair for subsequent turns.
Validation happens before the live model changes, so a failed attempt
leaves the current selection intact.

- `selector` (string|undefined) — `<endpoint>/<model>`; undefined clears the selection

Returns `void` — Assign the selector; read model for the current value.

Throws — {TypeError} Invalid selector or unavailable endpoint/model; keep the old selection and choose a valid model.

Effects — Records the default model and session settings; undefined clears it. Repeating a valid selection is safe and updates its last-used timestamp.

**Read** — `get model()`

The current qualified model selector. Assign to validate and record a whole model-state change; an active request finishes on its already-open IO.

Returns `string|undefined` — The current qualified model selector. Assign to validate and record a whole model-state change; an active request finishes on its already-open IO.

### `Agent.name`

**Read** — `get name()`

Human-friendly Agent name.

**Write** — `set name(value)`

Rename the agent (recorded into a logged context's settings).
Reserved (any case, look-alike letters and separators ignored): `new`,
`all`, `everyone`, chat role names, the product name, and names containing
`user`, `admin`, `group`, or another authority word (root, sudo, system,
developer, owner, operator, supervisor, moderator, privilege, authority).

- `value` (string)

Returns `void` — Assignment records the new name; read name for the current value.

Throws — {TypeError} For a non-string or reserved name.

### `Agent.offEvent(handle)`

Remove one registration; returns false when it is absent.

### `Agent.onEvent(event, callback)`

Register a synchronous listener for one Symbol Agent.EVENT value.
Response payloads deliberately omit IO's string `type`. Indexed
payloads carry `contentIndex` plus `content`, the assembled block
after that IO event was consumed. End-event `text`, when present,
is the provider-normalized authoritative full block snapshot.
MESSAGE_COMMITTED receives the stored message after persistence.
SENT_MESSAGE receives a user message when it enters context.
The possible `event` values (the Agent.EVENT constants):
- `Agent.EVENT.REQUEST_START` — a provider request began (once per request; a tool-loop run makes several); payload is the request start
- `Agent.EVENT.TEXT_START` / `TEXT_DELTA` / `TEXT_END` — one
  assistant text block began / grew / completed; indexed payloads
  (`contentIndex`, `content`)
- `Agent.EVENT.THINKING_START` / `THINKING_DELTA` / `THINKING_END` —
  the same lifecycle for a thinking (reasoning) block
- `Agent.EVENT.TOOL_CALL_START` / `TOOL_CALL_DELTA` / `TOOL_CALL_END` —
  the same lifecycle for one streamed tool call
- `Agent.EVENT.REQUEST_DONE` — the provider request completed (after its bookkeeping)
- `Agent.EVENT.REQUEST_ERROR` — the provider request failed; payload carries the error
- `Agent.EVENT.MESSAGE_COMMITTED` — a message was persisted to the
  context (payload is the stored message)
- `Agent.EVENT.LOG` — one diagnostic log line (payload is the line)
- `Agent.EVENT.TOOL_EXECUTE` — a tool call is about to run
- `Agent.EVENT.TOOL_DATA` — one chunk of a tool's live output
- `Agent.EVENT.TOOL_RESULT` — a tool call's outcome was appended
- `Agent.EVENT.CLOSE_MARKED` — close() was requested (no new work)
- `Agent.EVENT.CLOSED` — close cleanup completed; the agent is dead
- `Agent.EVENT.SENT_MESSAGE` — a user message entered context
- `Agent.EVENT.CONTEXT_REPLACED` — compaction switched contexts; {previous, context}
- `Agent.EVENT.THROTTLED` — a delayed continuation was scheduled; {until} is epoch ms

- `event` (symbol) — one Agent.EVENT constant (see the list above)
- `callback` ((payload: object) => void) — synchronous listener; returned promises are not awaited. Async listeners must observe their own rejections and cannot delay teardown.

Returns `number` — deterministic opaque registration handle (offEvent removes it)

### `Agent.parent`

**Read** — `get parent()`

The creating Agent, or undefined when none was supplied.

### `Agent.pending`

**Read** — `get pending()`

Unsent messages queued while busy (array copy; message objects are shared).
 An error leaves them pending until a later run or pendingPop().

### `Agent.pendingPop()`

Remove ALL unsent pending messages, returning them (the TUI's Option+↑
recall: the queued messages go back into the input area, merged,
for editing).

Returns `Array` — the drained messages

### `Agent.question`

**Write** — `set question(callbacks)`

Set (or replace) the QUESTION BRIDGE at runtime — the binding's
rendering engine wires it once its overlays exist (the TUI hands
its questionnaire overlay to the Agent after construction; see
the constructor's `question` option for the contract). Applies to
the next tool call.

Returns `void`

**Read** — `get question()`

The live question bridge; a trusted host capability, never provider data.

Returns `object|null` — The live question bridge; a trusted host capability, never provider data.

### `Agent.request(request)`

Send a request (handoff, question or reply) to another root agent and return
at once; replies arrive later as user-role messages labelled with the
sender's contact address. Requires `can.request === true`; workers never may.
`to: "<name>@<project>"` (see `contacts`) messages a known agent again: queued
while busy, resumed from its saved session when closed, never duplicated.
`to: "new:<name>@<project>"` starts a fresh root agent with that role name
(a taken name gets `-2`, `-3`…) in `this` (this project) or a pinned project
sharing a settings group. It inherits this Agent's capabilities, model,
thinking, tools, IO factory and session logging; `safe: true` makes it read-only
and `model` picks a known model with free capacity. On a known contact,
`safe: false` and a `model` equal to that contact's current model are
harmless; changing either setting requires a new agent. An empty string,
false or null model means no override for both kinds of request. The
receiver gains this Agent as a known agent, so it can reply.

Returns `Promise<string>` — The target's contact address (`<alias>@<project>`).

Throws — {TypeError|Error} Invalid input, worker caller, missing permission, unknown project/contact/model, unsaved closed contact, or creation failure.

### `Agent.run(options = {…})`

Run the tool loop until done/error (lib/agent/run.js).

- `[options]` (Object)
- `[options.timeout]` (number|string) — per-request provider-request timeout
- `[options.after]` (number) — non-negative delay in ms before running; an immediate run cancels a pending delayed continuation

Returns `Promise<object|null>` — terminal done/error, or null if a delayed run is superseded

Throws — {TypeError} Unsupported options, including model/endpoint and internal loop controls; assign agent.model before running.

Effects — Executes provider requests and tools, updates this Context and usage, and persists completed turns. Concurrent calls share the active run.

### `Agent.send(message)`

Submit a user message: while a request is in flight it is queued for
the next request; while idle it is appended and starts a request
immediately. Pending messages send only after the in-flight IO turn
settles (never mid-response). The flush appends them AFTER any
tool results (tool calls answer first), append-merged into one
user message (consecutive same-type merging). An identical user
submission immediately following another user submission is ignored:
it is normally an accidental second submit while a run is starting.
User slash messages are interpreted just before IO, after all
pending and direct context writes: /compact triggers compaction,
and registered /prompt (or //prompt) expands with trailing text.
Unknown slash commands remain text; other UI commands are not executed.
A user message is TRIMMED of surrounding whitespace (trailing EOLs,
tabs, every white space) before it is queued; a submission that is
whitespace only carries no turn at all — it behaves exactly like
/continue: no message is appended and the existing context runs.

- `message` (object|string) — a context message, or plain text converted to a user message

Returns `Promise<object>` — the active run's terminal done/error event. Invalid input and closed-agent submissions return a rejected Promise without changing the queue or context. Awaiting a busy send waits for that run, not a distinct reply; on failure queued messages remain pending.

### `Agent.sendFile(fileName)`

Read an existing file as a binary user message and deliver it.
The path is resolved inside the Agent folder; missing files, folders,
and paths outside that folder fail before any message is queued.

- `fileName` (string) — Agent-folder-relative file path

Returns `Promise<object>` — the run's terminal done/error event

### `Agent.skillLoad(names)`

Activate named skills in this Agent's Context, or list the Env catalog.
Validate all requested names before injection; already active skills are no-ops.

- `[names]` (string|string[]) — Names to activate; omitted lists available skills.

Returns `string` — Catalog text or activation summary; inputs are not retained or mutated.

Throws — {TypeError|Error} Invalid names, unknown skills, or closed Agent; correct names before retrying. Lookup failures inject nothing.

Effects — Appends durable system guidance; repeated activation in the same Context is idempotent.

### `Agent.thinking`

**Read** — `get thinking()`

the current thinking level (undefined = provider default)

Returns `string|undefined` — the current thinking level (undefined = provider default)

**Write** — `set thinking(level)`

Set the thinking level for subsequent requests (THINKING_LEVELS;
each provider translates it to the nearest symbol the model accepts).
Applies to already-open provider connections too.

- `[level]` (string) — none/low/medium/high/xhigh/max (undefined: the model's default)

### `Agent.throttledUntil`

**Read** — `get throttledUntil()`

Epoch-ms deadline of a pending continuation, or null.

### `Agent.toolMessages()`

tools with a live sticky message

Returns `Array<{name: string, text: string}>` — tools with a live sticky message

### `Agent.tools`

**Read** — `get tools()`

Current model-facing tools: `const tools = await agent.tools`;
`tools.get(name)` returns a provider-neutral descriptor with its schema.
Uses IO's publication filter: dynamic availability,
configured selection, hidden-tool exclusion and the model's provider tools.
Provider dialect conversion remains IO/provider-owned; this is the current
catalog, not a capture of an earlier request's wire payload.

Returns `Promise<Map<string, object>>` — Fresh map/descriptors, no callables or execution metadata. Nested schemas are shared registry data.

Throws — {Error} Availability-check failures propagate; retry by reading again after correcting the tool/environment.

Effects — Rechecks dynamic availability; does not open a provider connection or mutate context. O(n) in catalog size.

### `Agent.usage`

**Read** — `get usage()`

Cumulative usage across every request THIS Agent has made — every
IO terminal event's usage envelope, summed in memory. Never
persisted: a fresh Agent starts at zero. Only canonical token/cache/reasoning
counters and reported cost are summed; totalTokens is inputTokens + outputTokens.
Cache counters are input subsets; reasoningTokens is an output subset. Optional
serviceTier, inferenceGeo and bounded provider details describe only the latest
request (missing metadata clears previous values). Unknown numeric details are
snapshots, not additive counters. Quotas remain separate Context.planUsage snapshots.
The returned deep snapshot shares no mutable data with this Agent; reading has no effects.

Returns `{inputTokens: number, outputTokens: number, cost: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cacheWrite5mTokens?: number, cacheWrite1hTokens?: number, uncachedInputTokens?: number, reasoningTokens?: number, serviceTier?: string, inferenceGeo?: string, details?: object}`

## Agent.Context

### `class Context`

The conversation context: an ordered message list (a private array —
read it through length/at/messages()/iteration, change it through the
methods below), optionally NAMED (`id`/`name`) and LOGGED to a
session file in `dir` (`save`). Crash safety is the owner's: an Agent
flushes its context from a process-finish hook.

### `Agent.Context.append(message, options)`

Append a message, MERGING with the last one when possible
(consecutive same-type messages / same-sub-type blocks fold —
Context.appendMessage); `{merge: false}` keeps a boundary.

- `message` (object)

Returns `object|undefined` — the stored message, or `undefined` when an empty message is skipped

### `Agent.Context.at(i)`

The message at index `i` (negative counts from the end).

- `i` (number)

Returns `object|undefined`

### `Agent.Context.blockAt(i, j)`

Block `j` of message `i` (RangeError when either index is out of range).

- `i` (number)
- `j` (number)

Returns `object`

### `Agent.Context.close()`

Flush and close; subsequent mutations fail. Flush errors propagate and
leave the context open.

Returns `Promise<void>` — Resolves once durable; on failure reopens for retry.

### `Agent.Context.constructor(options = {…})`

Create a context, optionally named and logged (the file is created
on the first flush of a started conversation).

- `[options]` (Object)
- `[options.id]` (string|false) — session id (default: random UUID); false, "0", "false", "anon" normalize to an anonymous context with no id or logging
- `[options.dir]` (string) — the sessions folder (env.settings.sessions); required to log
- `[options.messages]` (Array) — initial messages, deep-copied into this context; no objects are shared with another context
- `[options.origin]` (string) — the folder the session RUNS in (default: process.cwd()) — recorded in the file's metadata line; resume's scans list only sessions of the current folder
- `[options.uuid]` (string) — carry an existing sessionUUID forward (Context.resume() only — a fresh session always gets a new one)
- `[options.name]` (string) — carry an existing stored NAME forward (Context.resume() only — see the module doc)
- `[options.settings]` (object) — the session-owned agent settings snapshot (Agent-managed; see the settings setter)
- `[options.save]` (boolean) — whether the context is logged to disk (default: whenever a `dir` is given); false or an anonymous id keeps it in memory

Throws — {TypeError} Invalid options container or unknown own top-level key (including symbols) before reading metadata or creating a folder; stored settings remain unrestricted.

### `Agent.Context.contextUsage`

**Read** — `get contextUsage()`

Provider-reported context consumption and model window (tokens). A stable immutable
snapshot until the next accepted report or invalidation; identity changes even when a
report repeats the same numbers. Values survive replacing IO and are not persisted.

Returns `{used: number|undefined, total: number|undefined}` — The current Context's report.

Effects — None.

**Write** — `set contextUsage({ used, total } = {…})`

Merge a provider report into this conversation. Nonnegative finite used and positive
finite total values are floored; invalid values do not replace previous data.

Returns `void` — No result.

Effects — Updates in-memory Context usage; reports survive changing transport IO.

### `Agent.Context.contextUsageInvalidate({ window = false } = {…})`

Invalidate exact input consumption after structural changes (e.g. compaction).
On a different model identity, also discard the old model's window; an IO
replacement for the same model does not require invalidation.

Returns `void` — No result.

Effects — Clears in-memory `used`, and optionally `total`; does not affect quota or persisted messages.

### `Agent.Context.created`

**Read** — `get created()`

Creation timestamp in ISO form.

Returns `string` — Creation timestamp in ISO form.

### `Agent.Context.deleteAll({ dir } = {…})`

Delete EVERY session file in the folder (the /sessions-delete-all!
contract — the user confirmed; foreign files stay untouched).

- `[options]` (Object)
- `[options.dir]` (string)

Returns `{deleted: number}`

### `Agent.Context.deleteById({ id, dir } = {…})`

Permanently delete a STORED session by id: every session file whose
metadata carries that id (a leftover duplicate goes with it). A store
still holding it open would re-persist it — close it first.

- `options` (Object)
- `options.id` (string)
- `[options.dir]` (string)

Returns `{deleted: number}`

### `Agent.Context.dir`

**Read** — `get dir()`

Session logging directory.

Returns `string|undefined` — Session logging directory.

### `Agent.Context.dirty`

**Read** — `get dirty()`

Where the context changed since its entries were last accepted:
`false` when nothing did, else the index of the first changed entry
(an edit, insertion, removal or reorder there; may be 0). Every
append accepts the current entries again, except a changed message
that still carries replay data (provider fields on text, thinking or
tool-call blocks, such as a thinking signature): that one stays
dirty until the replay data is removed, so a provider sees an edit
of history it already answered even when new messages followed.
Removing trailing entries is not a change.

Returns `false|number`

### `Agent.Context.edit(i, message)`

Replace message `i` (rebuilt from recognized fields; stale provider
identifiers dropped).

- `i` (number)
- `message` (object)

Returns `object` — the stored message

### `Agent.Context.editBlock(i, j, block)`

Replace block `j` of message `i` (the message is rebuilt).

- `i` (number)
- `j` (number)
- `block` (object)

Returns `object` — the stored block

### `Agent.Context.errorPop()`

Retract a trailing FAILED RESPONSE before the context is submitted
again: an assistant message carrying `error` that is still the last
message was not responded to — the user continued as it stands — so
it goes and the request is re-attempted. Anything added after it (a
user reply) keeps it: then it is part of the conversation.

Returns `object|undefined` — the removed message

### `Agent.Context.file`

**Read** — `get file()`

Backing session file, when a logging directory exists.

Returns `string|undefined` — Backing session file, when a logging directory exists.

### `Agent.Context.fileOf({ id, dir } = {…})`

The session file holding `id` in `dir` (a metadata-line scan), or
undefined.

Returns `string|undefined`

### `Agent.Context.flush()`

Synchronously make the CURRENT context durable (choosing remove, none,
append or full rewrite). Idempotent; a no-op when
nothing changed since the last flush. Filesystem errors propagate.

Returns `void`

### `Agent.Context.flushAsync()`

Async counterpart for a live loop (Agent's request/tool turns); the
synchronous flush() remains the crash/exit contract.
"remove"/"append" plans are tiny and interleave-free, so they commit
synchronously; only a "full" rewrite yields, snapshotting one version
so a mutation while I/O is pending remains dirty for the following
flush rather than being lost. I/O errors reject the returned promise.

Returns `Promise<void>`

### `Agent.Context.id`

**Read** — `get id()`

Canonical identifier; undefined for anonymous memory-only contexts. Use rename() to name one.

Returns `string|undefined` — Canonical identifier; undefined for anonymous memory-only contexts. Use rename() to name one.

### `Agent.Context.latest({ dir, cwd } = {…})`

The id of the most recently modified session in the folder (of
the `cwd` origin when given), or undefined when the folder has none.

- `[options]` (Object)
- `[options.dir]` (string)
- `[options.cwd]` (string) — only sessions of THIS origin folder

Returns `string|undefined`

### `Agent.Context.length`

**Read** — `get length()`

the message count

Returns `number` — the message count

### `Agent.Context.list({ dir, cwd, limit = 50 } = {…})`

Every session in the folder, LATEST FIRST (one entry per id), each
with a small preview: the first meaningful line of the first user
or assistant message with text (a compacted session's summary) (see meaningfulLine; whitespace-folded, capped) and `agent`,
the stored agent name when it is not a default `agent-N` one. With `cwd`, only sessions whose metadata records THAT
origin folder list (the resume contract: a project sees its own
sessions; foreign metadata-less files are skipped by
the FIRST-LINE scan, never parsed in full). Previews are read
only for the newest `limit` files (stats are cheap; parsing is
not). Unreadable files list without a preview, never an error.

- `[options]` (Object)
- `[options.dir]` (string)
- `[options.cwd]` (string) — only sessions of THIS origin folder
- `[options.limit]` (number) — max sessions returned (default 50)

Returns `Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>`

### `Agent.Context.listAsync({ dir, cwd, limit = 50 } = {…})`

Nonblocking counterpart of list(). It deliberately has its own async
folder identity rather than calling sameFolder(), whose realpathSync
would stall the interactive loop.

Returns `Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>`

### `Agent.Context.messages()`

A new array of LIVE message objects. Mutating a message changes this context only, without marking it dirty; use edit/update for persistence bookkeeping. Construction deep-copies seeds, so forks never share message objects.

Returns `object[]` — A new array of LIVE message objects. Mutating a message changes this context only, without marking it dirty; use edit/update for persistence bookkeeping. Construction deep-copies seeds, so forks never share message objects.

### `Agent.Context.name`

Stored or automatically derived session label; remains writable.

Returns `string|undefined` — Stored or automatically derived session label; remains writable.

### `Agent.Context.origin`

**Read** — `get origin()`

Origin project folder recorded in metadata.

Returns `string` — Origin project folder recorded in metadata.

### `Agent.Context.originOf({ id, dir } = {…})`

The ORIGIN FOLDER recorded in a session file's metadata line (the
cwd the session ran in), or undefined (no such session). A
session resumes only in an Env of this folder; an explicit
--resume <id> makes it the process cwd before the Env is built.

- `options` (Object)
- `options.id` (string)
- `[options.dir]` (string)

Returns `string|undefined`

### `Agent.Context.planUsage`

**Read** — `get planUsage()`

Last complete provider quota/metadata deep snapshot. Replaces reports; never persisted.

**Write** — `set planUsage(report = {…})`

Replace a provider report with an independent bounded canonical snapshot.
Canonical quota fields outrank count/percentage and snake-case aliases;
windowSeconds is a duration, never a reset. Known Anthropic unified header
details become window/account state; unconsumed details remain available.

- `[report={}]` (object) — Complete plan report; neither mutated nor retained.

Returns `void` — No result. Idempotent; no failures for JSON data.

Effects — Replaces in-memory quotas/metadata only; never persisted or added to Agent lifetime totals.

### `Agent.Context.pop()`

the removed last message

Returns `object|undefined` — the removed last message

### `Agent.Context.prepend(messages)`

Insert messages at the FRONT — e.g. an Agent's seeded system
prompt, always the first message(s) of a fresh context.

- `messages` (object[])

### `Agent.Context.remove(indexes)`

Remove the messages at `indexes`.

- `indexes` (number[])

Returns `object[]` — the removed messages

### `Agent.Context.rename(newId)`

Rename the session: BOTH the stable `id` and the file's NAME
segment become `newId` (the same session — the date/uuid8 prefix
carries over unchanged) and the old file is gone. Refuses to
clobber an EXISTING other session (a directory scan by `id`, the
file name no longer being a direct function of it).

- `newId` (string)

Returns `{id: string, file: string}`

### `Agent.Context.renameById({ id, name, dir } = {…})`

Rename a STORED session by id (the sidebar/menu path for a session
no store holds open — a live one renames through its store): loads
it, renames it (see rename()) and closes it again.

- `options` (Object)
- `options.id` (string)
- `options.name` (string) — the new id/name
- `[options.dir]` (string)

Returns `{id: string, file: string}`

Throws — {Error} when no such session exists or the name is taken

### `Agent.Context.resume({ id, dir, save = true } = {…})`

Load a session file into a fresh store holding its live context.
The file is found by a directory scan matching `id` against each
file's metadata line (the file name is a presentation detail, not
a direct function of `id` — see the module doc). Non-message
records in the file are quietly ignored (tolerant reader — see
loadMessages).

- `options` (Object)
- `options.id` (string)
- `[options.dir]` (string)
- `[options.save=true]` (boolean) — whether the resumed context keeps logging

Returns `Context` — the loaded context

### `Agent.Context.rollback(i)`

Remove every message at index >= i (RangeError unless i is an
existing index).

- `i` (number)

Returns `object[]` — the removed messages

### `Agent.Context.save`

**Read** — `get save()`

whether this context is logged to disk

Returns `boolean` — whether this context is logged to disk

**Write** — `set save(value)`

Enable or disable persistence without replacing the live context. Enabling
saving gives an anonymous context a fresh id and makes the complete current context eligible for the next flush.

- `value` (boolean)

Returns `void` — Read save after assignment for the logging state.

### `Agent.Context.settings`

**Read** — `get settings()`

the owner's settings snapshot riding the
 session file (undefined: none recorded — resume keeps the caller's
 configuration)

Returns `object|undefined` — the owner's settings snapshot riding the session file (undefined: none recorded — resume keeps the caller's configuration)

**Write** — `set settings(value)`

Record the owner's SETTINGS snapshot (an Agent's (safe, thinking,
  endpoint/model, name, … — Agent writes it; the store only persists
  it; a default `agent-N` name never rides the file). Only JSON-typed
  values ride the file; undefined entries are
  dropped. Marks the store dirty (the next flush is a FULL rewrite:
  the metadata line changes).

- `value` (object)

### `Agent.Context.summary`

**Read** — `get summary()`

one line for status/command output:
 `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise

Returns `string` — one line for status/command output: `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise

### `Agent.Context.toJSON()`

JSON form: the message array.

### `Agent.Context.update(fn)`

A batch in-place change (a repair pass): `fn` receives the live
message array and returns true when it changed anything — the
context then logs a full rewrite. Stored messages are replaced,
never mutated.

- `fn` ((messages: object[]) => boolean)

Returns `boolean` — whether anything changed

### `Agent.Context.uuid`

**Read** — `get uuid()`

Persistent session UUID.

Returns `string` — Persistent session UUID.

### `Agent.Context.ContentType = Object.freeze({…})`

Content block discriminators.

### `Agent.Context.EventType = Object.freeze({…})`

The full normalized event vocabulary.

### `Agent.Context.FALLBACK_CONTEXT_WINDOWS = Object.freeze({…})`

Curated context windows for the CURRENT OpenAI tier, from the models
docs (developers.openai.com/api/docs/models, reviewed 2026-09-28 —
the gpt-6 family lists 1.05M; o-series 200K). OpenAI's API-key
surface publishes NO window anywhere (/models, /models/{id}, and the
response envelope are all bare — probed with
ai-tmp/probe-openai-models.js), so the status gauge reads this table
while a lazy registry lookup (lib/env/model-windows.js) fills the
endpoint's model cache. Any provider-published or looked-up value
outranks it. Review when a new tier ships.

### `Agent.Context.MIME_BY_EXTENSION = Object.freeze({…})`

Context-owned media-type map and byte detection for content blocks.

### `Agent.Context.MessageType = Object.freeze({…})`

Numeric message types. 0 is reserved.

### `Agent.Context.TOKENS_PER_WORD = 4 / 3`

tokens ≈ words × 4/3 (token-per-word likelihood ratio)

### `Agent.Context.assemblerCallbacks(assembler)`

Build the camelCase callback set used by Context to feed response events to
an assembler. Includes callbacks for start, text/thinking block events,
tool-call events, done, and error.

- `assembler` (ReturnType<typeof createAssembler>) — Assembler receiving the events; no default is provided.

Returns `Object<string, function(object): void>` — Callbacks keyed by names such as `onStart`, `onTextDelta`, `onDone`, and `onError`.

Effects — Creates a new callback object; each callback delegates to assembler.consume and therefore mutates that assembler.

Throws — Throws if assembler is missing or does not provide consume, or if event processing throws when a callback is invoked.

### `Agent.Context.assemblerCreate()`

Create an assembler that folds normalized response events into one
assistant message. Events mutate the in-progress message; valid message
snapshots on `start`, `done`, or `error` replace it. Unknown event types are
ignored, and malformed tool-call JSON is retained as raw text. The returned
message remains partial until completion and is exposed by reference.

Returns `{consume: (event: object) => void, message: () => object}` — The event consumer and accessor for the current message.

Throws — Creating the assembler does not intentionally throw. Its returned `consume` method can propagate errors from malformed events or message mutations; JSON parse errors for tool arguments are suppressed.

### `Agent.Context.callbacksNormalize(callbacks = {…}, binding = {…})`

Build the full callback set for a binding.

- `[callbacks={}]` (Object) — consumer-supplied callbacks, keyed by camelCase callback name. A function is used as-is; explicit `false` or `null` selects a no-op; an omitted or `undefined` callback gets the binding default.
- `[binding={}]` (Object) — binding-appropriate default handlers.
- `[binding.onData]` ((event:object)=>void) — receives every event whose callback was omitted (stdout replacement)
- `[binding.onLog]` ((line:string)=>void) — receives error reports (stderr replacement)
- `[binding.onTerminal]` ((event:object)=>void|false|null) — completes the binding; called for `done` and `error` even when the consumer supplied its own terminal callback. `false` or `null` disables this additional call.

Returns `Object` — Complete callback set keyed by camelCase names.

Throws — {Error} If an invoked binding handler throws; its error propagates to the caller.

### `Agent.Context.contentBinary(path, buffer)`

Build a canonical base64 binary Context block without exposing the source path.

- `path` (string) — Non-empty local path; only its basename is retained.
- `buffer` (Uint8Array) — Binary data to encode.

Returns `{type: "binary", mimetype: string, filename: string, content: string}` — A block containing the basename, detected media type, and base64 data.

Throws — {TypeError} If path is not a non-empty string or buffer is not a Uint8Array.

### `Agent.Context.contentIndexer()`

Create a per-request content-block indexer for a provider translator. `of`
reuses an index for a previously seen wire-item key, while `next` always
reserves a fresh index; indexes are dense and follow first appearance.

Returns `{of: (key: *) => number, next: () => number}` — Indexing operations.

### `Agent.Context.contentText(text)`

Wrap a value's string representation in a text content block.

- `text` (*) — Value converted with `String()`.

Returns `TextContent` — A block with `type: ContentType.Text` and the converted text.

Throws — {*} Propagates a thrown value encountered during string conversion.

### `Agent.Context.eventCallbackName(eventName)`

Map an event name to its camelCase callback name.
"text_delta" -> "onTextDelta"; "tool_call_start" -> "onToolCallStart".

- `eventName` (string) — normalized event name to convert.

Returns `string` — The corresponding camelCase callback name.

Throws — {TypeError} If `eventName` does not support `split` (for example, it is not a string).

### `Agent.Context.eventDispatch(set, event)`

Dispatch one event through a normalized callback set. Validates the event
before invoking its matching callback; callback errors propagate to the caller.

- `set` (Object) — callback set returned by `normalizeCallbacks`.
- `event` (object) — normalized response event to dispatch.

Returns `void`

Throws — {TypeError} If `event` is invalid or the callback cannot be invoked; errors thrown by the callback also propagate unchanged.

### `Agent.Context.eventValid(event)`

Is this a well-formed normalized response event (a known `type`;
indexed events carry a non-negative integer `contentIndex`)?

- `event` (*) — value to check.

Returns `boolean` — `true` for an object with a known event type and, for indexed events, a non-negative integer `contentIndex`; otherwise `false`.

### `Agent.Context.eventValidate(event)`

Validate a normalized response event (used by IO to check connector
output). Returns the same object; throws on violation.

- `event` (*) — value to validate.

Returns `object` — The same event object when it is valid.

Throws — {TypeError} If the value is not a well-formed normalized response event.

### `Agent.Context.fallbackContextWindow(model)`

The curated fallback window for one model id, or null: an exact key,
then the longest table prefix the id starts with ("gpt-6-sol" ->
"gpt-6", "o3-2025-04-16" -> "o3").

- `model` (*) — bare model id; non-string or empty values are rejected

Returns `number|null` — matching fallback token window, or `null` when none

### `Agent.Context.messageAppend(context, message, { merge = true } = {…})`

Append a message to a caller-owned context, MERGING when possible:
the message's own adjacent same-sub-type blocks fold first; when the
context's last message is mergeable with it (same type, no linkage),
their content concatenates (and re-folds) instead of appending a new
message. Consecutive same-type text messages — queued user input,
repeated /system, a cancel-partial assistant followed by the next
turn's — become ONE message, so the context (and every replay of
it) shows one merged block per sub-type, not a chain of fragments.
Mutates the array in place.

- `context` (Array<object>) — Caller-owned context array, mutated in place.
- `message` (object) — Message or metadata record to append.

Returns `object|undefined` — The stored message (the previous message when merged, otherwise the appended value), or `undefined` when an empty message is skipped.

Throws — {TypeError} If context/message validation fails.

Throws — {TypeError} If folding or merge comparisons fail during processing.

### `Agent.Context.messageAssistant(content = [])`

Create an assistant message using the supplied content blocks.

- `[content=[]` (Content[]) — ] - Ordered content blocks; defaults to an empty array.

Returns `Message` — An assistant message whose content is the supplied array; no validation or copying is performed.

### `Agent.Context.messageErrorText(msg)`

Get the presentation text of a normalized assistant failure; tool-result
boolean errors are distinct and produce an empty string.

- `msg` (*) — Value whose error field is inspected.

Returns `string` — The error string, `error.message`, or an empty string.

### `Agent.Context.messageFile(path, buffer)`

Wrap one local file's bytes in the canonical user-message content structure.

- `path` (string) — Non-empty local file path passed to {@link binaryContent}.
- `buffer` (Uint8Array) — File bytes passed to {@link binaryContent}.

Returns `{type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>}` — A user message containing a single binary content block.

Throws — {TypeError} If either argument fails {@link binaryContent}'s validation.

### `Agent.Context.messageHasContent(msg)`

Has this message any CONTENT a provider can consume? A block with
no payload — a text/thinking block whose text is empty, a block
reduced to its discriminator alone — is not content; an empty
content array is not content either. Chat-completions dialects
serialize an empty assistant message as `content: null` and
providers 400 the whole request over it (corrupted sessions), so
emptiness is a hard contract, not a style point.

- `msg` (*) — Value whose `content` blocks are inspected.

Returns `boolean` — True if at least one block carries provider-consumable content.

### `Agent.Context.messageHasError(msg)`

Does this message report a FAILED RESPONSE? A provider or transport
failure is normalized as the response message carrying `error` — a
text string or {message, retry} for timed rate limits — beside whatever content arrived before it (possibly
none: the error is then its whole payload). A tool result's boolean
`error: true` is not one: that is the tool's own (answered) failure.

- `msg` (*) — Value whose normalized response error is inspected.

Returns `boolean` — True for a nonempty error string or nonempty `error.message`.

### `Agent.Context.messageIsRecord(msg)`

Test whether a value is a metadata record: a non-array object with a
string `type` (not a numeric message type). Records may share context and
session files with messages; they are not messages and are skipped by
message validators. Other components pass them through unmerged or filter
them from provider-bound contexts as appropriate.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` carries a string `type`.

### `Agent.Context.messageRebuild(msg)`

Rebuild a message from recognized schema fields only — the stale
provider/cache identifier cleanup. See the module header for the
field policy.

- `msg` (object) — Message to validate and rebuild.

Returns `object` — A new message containing recognized fields only.

Throws — {TypeError} If the message is invalid.

### `Agent.Context.messageSystem(text)`

Create a system message containing one text block made from the given value.

- `text` (*) — Value converted to a string for the text block.

Returns `Message` — A system message with one text content block.

Throws — {*} Propagates a thrown value encountered during string conversion.

### `Agent.Context.messageUser(text, metadata = undefined)`

Create a user message from plain text or an existing ordered block array.
Non-array input is converted to a text block; array input is used as-is.
If supplied, metadata is spread over the message and can override its fields.

- `text` (string|Content[]|*) — Plain-text value to convert, or an array of content blocks to preserve.
- `[metadata=undefined]` (*) — Optional value whose enumerable own properties are spread last onto the message.

Returns `Message` — The resulting user message.

Throws — {*} Propagates a thrown value from text conversion or metadata getters/spread.

### `Agent.Context.messageValid(msg)`

Test whether a value has the core message shape: a non-array object with
a numeric `type` and an array `content`.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` has the core message shape.

### `Agent.Context.messageValidate(msg, at = "message")`

Validate a message's CORE SHAPE, throwing on a violation.
Returns the SAME object reference — metadata is never copied,
stripped, or reordered. Emptiness is deliberately NOT part of the
shape: appendMessage WARNS and drops an empty incoming message,
and IO DROPS empty messages from every provider-bound context
(no dialect can carry one), while a merge that consumed an
incoming message's whole payload into the previous message may
legitimately leave it empty inside the live array.

- `msg` (*) — Value to validate.
- `[at="message"]` (string) — Address hint for error messages (e.g. "context[2]").

Returns `object` — The same `msg` reference, unchanged.

Throws — {TypeError} If `msg` is not a non-array object with a numeric `type` and array `content`; the error includes the address hint.

### `Agent.Context.messagesParse(input)`

Parse buffered CLI input into a context array using the shared grammar.
First, the entire input is parsed as JSON; if that is an array, it is
returned unchanged. Otherwise, each nonblank line is parsed independently:
message objects and valid messages in arrays are included, while other
values become user text messages containing the original line.

- `input` (string) — Complete stdin text after EOF; there is no default.

Returns `Array<object>` — The resulting context array. This is synchronous and returns no Promise.

Throws — {TypeError} If input is not a string and line processing attempts to call `split` on it.

Effects — Pure parser: does not read stdin or otherwise perform I/O. JSON parse errors are caught and treated as non-JSON input.

### `Agent.Context.messagesValid(ctx)`

Test whether a value is a context array containing only core-shaped
messages and/or metadata records.

- `ctx` (*) — Value to test.

Returns `boolean` — True when `ctx` is such an array; an empty array passes.

### `Agent.Context.messagesValidate(ctx)`

Validate a context array, allowing metadata records and validating every
other entry as a message. Returns the same array reference without mutation.

- `ctx` (*) — Value to validate as a context.

Returns `Array` — The same `ctx` array, unchanged.

Throws — {TypeError} If `ctx` is not an array or any non-record entry fails message validation; entry errors identify their context index.

### `Agent.Context.mimeDetect({ path, buffer } = {…})`

Determine a media type from a filename extension, then recognized leading bytes.

Returns `string` — The matching media type, or `application/octet-stream` when neither input identifies a supported type.

Throws — {TypeError} If options is `null` and therefore cannot be destructured.

### `Agent.Context.mimeOf(block)`

Return a content block's media type, preferring its non-empty `mimetype`
field and then its non-empty `mime` field.

- `block` (Object|null|undefined) — Block to inspect; nullish values are allowed.

Returns `string|undefined` — The selected media type, or `undefined` when neither field is a non-empty string.

Throws — {*} Propagates a thrown value from a getter for `mimetype` or `mime`; accessors may be read more than once.

### `Agent.Context.tokensEstimate(text)`

Estimate a token count for text, rounding the heuristic up to a whole token.
Non-string inputs produce zero.

- `text` (*) — value to estimate when it is a string

Returns `number` — estimated whole-token count

### `Agent.Context.tokensEstimateMessages(context = [])`

Estimated token count of a whole context (the input side of a
request — also the live "window consumption" readout when no
provider-reported count exists yet). Counts words per block: the
historical one-giant-string + word-array version allocated several
full copies of the context per call, per frame. Reuses per-block scans only
while the current text/argument string values are unchanged; live in-place
field and content-array edits are observed on the next call.

- `[context=[]` (Array) — ] - context messages; each message's supported content-block text and arguments are counted

Returns `number` — estimated input tokens, rounded up to a whole token

Throws — {TypeError} if `context` is not iterable

### `Agent.Context.usageAdd(total, reported)`

Add one request report to lifetime usage. Sum only schema counters; recompute
totalTokens; replace (and clear absent) metadata/details with the latest report.

- `total` (object) — Previous totals; neither mutated nor retained.
- `reported` (*) — Request usage, normalized or wire-shaped; never retained.

Returns `object` — New independent totals. Non-idempotent: call once per billed attempt.

Effects — None. Invalid reports are ignored; no failures for JSON input.

### `Agent.Context.usageDetails(value)`

Copy bounded JSON-safe usage/plan extensions, omitting invalid values, cycles,
attribution and prototype keys. Limits: 256 nodes, depth 6, 16 array entries,
1024 characters/string, 128/key and 16K total text. Truncation adds no counters.

- `value` (*) — Untrusted details; neither mutated nor retained.

Returns `*` — Independent bounded JSON value, or undefined for unsupported input.

Effects — None. Idempotent; no failures for JSON data. Work is bounded by these limits.

### `Agent.Context.usageEstimate(context = [], message)`

Estimate usage from the request context and the assembled response.

- `[context=[]` (Array) — ] - request messages used for input estimation
- `[message=undefined]` (object) — assembled assistant message used for output estimation; its content text/arguments are concatenated before estimating

Returns `{inputTokens:number, outputTokens:number, source:"estimate"}` — estimated usage

Throws — {TypeError} if `context` is not iterable

### `Agent.Context.usageFinalize(reported, context, message)`

Normalize provider-reported usage, or fall back to estimation.
Provider token counts win only as a complete pair: partial/invalid
counts use estimation (no mixed token sources), retaining normalized counters,
finite reported cost and bounded extensions. Input is neither mutated nor retained.
Repeated calls with the same report/context/message are idempotent; no side effects.

- `reported` (*) — connector-extracted usage; accepted only when both inputTokens and outputTokens (or known aliases) are nonnegative finite numbers. Known aliases are consumed; unknown fields become bounded latest-report details
- `[context=undefined]` (Array) — request context for fallback input estimation; when omitted, the estimator's empty-array default applies
- `[message=undefined]` (object) — assembled message for fallback output estimation

Returns `{inputTokens:number, outputTokens:number, totalTokens:number, source:string, cost?:number, [key: string]: *}` — independent canonical snapshot with reported or estimated token counts

Throws — {TypeError} if fallback estimation is needed and `context` is not iterable

### `Agent.Context.usageHeaders(headers, { exclude = [] } = {…})`

Capture bounded unrepresented rate-limit header extensions, excluding unrelated headers.

- `headers` (Headers|object) — Response headers exposing forEach; neither retained nor mutated; absent input returns an empty map.
- `[options={}]` (object) — Header filtering options.
- `[options.exclude=[]` (string[]) — ] Header names already represented as quotas, case-insensitive.

Returns `Object<string, string>` — Independent bounded header map. Idempotent, no side effects.

Throws — {TypeError} If exclude is not an array of strings; correct options before retrying.

### `Agent.Context.usageNormalize(reported)`

Normalize a request's usage without estimating tokens. Canonical fields outrank
aliases; cache/reasoning detail fields outrank legacy root fields, reasoning
outranks thinking. All token counts include cached/reasoning subsets, not extras.
Unknown extensions become bounded latest-report `details`; consumed aliases disappear.

- `reported` (*) — Provider data; neither mutated nor retained. Invalid fields are omitted.

Returns `object` — Independent snapshot with nonnegative counters, finite reported cost, derived totalTokens, optional serviceTier/inferenceGeo and bounded details. Idempotent.

Effects — None. No failures for JSON input; detail processing is bounded.

### `Agent.Context.wordCount(text)`

Count runs of non-whitespace characters without allocating a split array.
Non-string and empty inputs produce zero.

- `text` (*) — value to count when it is a string

Returns `number` — number of whitespace-separated words

## Agent.Env

### `class Env`

The sole global environment object: settings, auth, providers,
tools, and the titled folder surface.

### `Agent.Env.EVENT`

The Env event vocabulary: Symbol constants for onEvent/offEvent.
Env events report what EXISTS in this environment: the native
MODELS_CHANGED (models() answers differently — re-read it) and the
membership events plugins install (Agent's AGENT_ADDED/AGENT_REMOVED);
what an object does is that object's own events.
SETTINGS_CHANGED announces changed settings values (once per storage or
poll round). SETTINGS_LOADED announces a finished poll round that read
files, including equal versions. Reads never emit either.

### `Agent.Env.SettingsStore`

The settings aggregator Env builds its settings from (lib/env/settings-store.js):
an ordered list of file, folder/glob and memory sources, last wins, with an
optional parent store; immediate reads and writes, grouped asynchronous
`loaded`/`saved`/`updated` notices. Usable on its own for any JSON settings.
Read the [SettingsStore contract and standalone examples](/api/contracts/#settings%20store)
for constructor/source specs, precedence, node handles, methods and errors.

### `Agent.Env.async agentCreate(options = {…})`

Create an Agent over this env (`env` is always this env).

- `[options]` (object) — Agent constructor options

Returns `Promise<Agent>` — the new, registered Agent

Throws — {Error} when this env is closed (env.closed)

### `Agent.Env.agents()`

Snapshot registered Agents in registration order. Awaiting Agent.close()
ensures its owned teardown and removal; close-marked Agents remain
registered until releases settle. Inactivity and garbage collection
never change this lifecycle registry.

Returns `object[]`

### `Agent.Env.close()`

Release only the static global settings facade, awaiting pending I/O. Does
not close registered project Envs. Repeated/concurrent calls are idempotent;
the next static settings/ready access after completion acquires fresh state.

Returns `Promise<void>` — Resolves after release or rejects on persistence failure.

### `Agent.Env.close()`

Release what this Env runs in the background: pending model-list
retries stop, every MCP server it started is killed, and its settings
subscription and source graph close. Idempotent; rejects after cleanup if an owned release fails. A closed Env
leaves Env.envs (env.closed) but stays readable; it does not start
new MCP connections or create new agents.

Returns `Promise<void>` — Resolves after owned teardown and pending settings persistence; concurrent/repeated calls await the same outcome.

Throws — {Error|AggregateError} One or more release failures, after all releases have been attempted.

### `Agent.Env.closed`

**Read** — `get closed()`

whether close() has run (the Env left Env.envs).

Returns `boolean` — whether close() has run (the Env left Env.envs).

### `Agent.Env.connection(selector, { remember = true } = {…})`

IO's handle on one pair: {endpoint, model, Protocol, url, settings,
authSet(data), authReload(current)} (lib/env/models.js). An unknown
endpoint, or a model its non-empty catalog lacks, throws.

- `selector` (string) — `<endpoint>/<model>`

Returns `object`

### `Agent.Env.constructor(options = {…}, acquisition)`

Internal construction; public consumers acquire a ready Env with Env.open(path, options).
Build the environment: assemble layered source nodes (the
package folder, user settings folder, and namespaced project
files — see lib/env/source-graph.js), seed the titled folder surface,
register the built-in tools. Providers and tools load afterwards
(loadProviders/loadTools).

- `[options]` (Object)
- `[options.dir]` (string) — package folder to scan (default: this package's root)
- `[options.settingsDir]` (string|null) — the USER SETTINGS folder (default: the namespace setting or namespace home folder, created when missing) — scanned after the package folder and the target of every dynamic settings write; null disables the layer (embedded/test hosts)
- `[options.cwd]` (string) — the PROJECT folder (default: process.cwd()); constructor-internal, not the Env.folder property — separate from `dir` so a test (or an embedding host) can isolate both independently; consumed by the folder surface below and by the system prompt's project-local AGENTS.md layer (env.systemPrompt())
- `[options.settings]` (Object) — explicit settings, merged LAST (override)
- `[options.sessionsDir]` (string) — ephemeral session log folder for this Env only; relative to cwd, overrides configured sessions without writing settings. Must be a non-empty path.
- `[options.providers]` (Object<string, Function>) — extra provider classes by name (embedders, tests); they take precedence over a scanned class of the same name
- `[options.toolDirs]` (string[]) — the tool roots initialization scans instead of the default ones (embedders, tests)
- `[options.skillDirs]` (string[]) — the skill roots read instead of the accumulated default layers (embedders, tests)
- `[options.promptDirs]` (string[]) — the prompt roots, likewise
- `[options.themes=true]` (boolean) — load theme files under settings.themes from package, extension, user, and project roots; false opts out
- `[options.auth=true]` (boolean) — retain credentials from settings layers; false strips all nested auth fields for reduced tool-worker environments (not filesystem read confinement)

Throws — {TypeError} Invalid options container or unknown own top-level keys (including symbols) before registration or settings work; settings/provider payload keys remain open.

### `Agent.Env.envs`

**Read** — `static get envs()`

The registered project Envs by project folder — at most one per canonical
folder. Non-default embedding Envs from Env.open(path, options) never enter
this registry. close() deregisters project Envs. A frozen snapshot per read.

Returns `Readonly<Object<string, Env>>` — absolute folder -> Env

### `Agent.Env.extend(plugin)`

Install a higher layer's Env members after the fact (a plugin):
`methods`/`getters` land on Env.prototype and run on the env they
were reached through (the safe view included); `events` add Symbol
keys to Env.EVENT; `settings` add the layer's settings keys to the
defaults schema. An existing name throws — plugins extend Env,
never override it (lib/env/extend.js).

Returns `{EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void}` — the plugin's own event symbols and its (sole) way to emit them

### `Agent.Env.folder`

**Read** — `get folder()`

The absolute project folder used by this Env (fixed for its lifetime).

Returns `string` — The absolute project folder used by this Env (fixed for its lifetime).

### `Agent.Env.folders`

**Read** — `get folders()`

The folders that matter to a session, computed from current state
(the project folder follows `folder`): exactly one `project` and one
`harness` (the package folder in use), the user `settings` folder
unless disabled, then each tool root.

Returns `ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>`

### `Agent.Env.login(name, config, options)`

Log an endpoint in — one transaction (lib/env/login.js): credentials
(`auth`, else the provider shapes `token`), then with a `scope` the
endpoint persists, is verified (the provider's connection test, then
`verify(models)` over its new catalog entries) and its models are
fetched — any failure rolls memory and files back. Without a scope
the registration is in-memory only (an invocation-only endpoint);
its models arrive in the background.

- `name` (string) — the endpoint name

Returns `Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>`

### `Agent.Env.loginPresets()`

The login presets every non-secret provider publishes ({name, label,
url, provider, oauth?, note?, ...}).

Returns `object[]`

### `Agent.Env.logout(name)`

Remove an endpoint (the /logout contract): its configuration and auth
files go with every in-memory trace; an environment-detected endpoint
clears in memory only.

- `name` (string)

Returns `{name: string, dynamic: boolean}`

### `Agent.Env.mcpLogin(name, options)`

Start explicit browser OAuth for a configured HTTP MCP server; never invoked by a tool call.

- `name` (string) — Configured MCP server name.

Returns `Promise<{name: string}>` — Signed-in server identity; rejects on discovery, registration, callback or token error.

### `Agent.Env.mcpPaste(input)`

Supply a complete loopback redirect URL to a pending MCP OAuth flow.

- `input` (string) — Complete callback URL with code, state and optional issuer.

Returns `boolean` — Whether a sign-in flow accepted the callback input.

### `Agent.Env.mcpStatus()`

List configured MCP server connection and sign-in states; exposes no credentials.

Returns `Array<{name: string, state: string}>` — Live per-server state.

### `Agent.Env.models(secret = false)`

The model catalog: every known endpoint/model pair with its state
already computed (lib/env/models.js ModelInfo — caps, secret,
loginRequired, lastUsed, plugin capacity fields). The Map and outer
records are snapshots, but nested capability values may reference shared
environment/provider state. Mutate deliberately; this is not a defensive
deep copy. Re-read on Env.EVENT.MODELS_CHANGED.

- `[secret=false]` (boolean) — include hidden pairs (flagged `secret`)

Returns `Map<string, object>` — `endpoint/model` -> ModelInfo

### `Agent.Env.modelsReady`

**Read** — `get modelsReady()`

Settles when the background collection's first pass has answered
(one-shot hosts: list models, resolve an endpoint-only selector) —
including the lists of in-memory logins, fetched now on demand.
Resolved at once when no collection runs.

Returns `Promise<void>`

### `Agent.Env.name`

**Read** — `get name()`

The project name. A pinned project answers its pin record's derived
`settings.projects[folder].name` (the shortest suffix no other pin shares);
an unpinned one the shortest suffix no pinned or other open Env's folder
shares (conflicts resolve on the first differing parent folders:
`fiz/bar/foo`, `faz/bar/foo`); the root folder is `/`.

Returns `string`

### `Agent.Env.offEvent(handle)`

Remove the listener registered with {@link onEvent}.

- `handle` (number) — opaque handle returned by onEvent

Returns `boolean` — true if a listener was removed; otherwise false

### `Agent.Env.onEvent(event, callback)`

Subscribe to an Env Symbol event. Env reports settings/model changes
and plugin membership changes; Agent reports its own request/tool events.
Membership plugins add Env.EVENT constants such as AGENT_ADDED and
AGENT_REMOVED, whose payload is {agent}.

- `event` (symbol) — one Env.EVENT constant
- `callback` ((payload: object) => void)

Returns `number` — opaque handle (offEvent removes it)

### `Agent.Env.open(path, options)`

Acquire a fully initialized Env for a project folder. With no options, concurrent
callers share the canonical folder's registered Env; each caller owns a close()
obligation. Options that retain constructor/startup defaults (including {})
also reuse the canonical Env. Meaningful overrides create an isolated Env,
never registered or returned by a path-only lookup. `path` is
authoritative; options.cwd is not accepted. `options.init` controls startup
(providers/tools/detect/models default true); models collection begins in the
background and modelsReady awaits its first pass. Explicit options.settings
overlay persisted configuration in a per-Env memory node: writes to owned
override keys remain ephemeral; writes to other keys follow normal settings
ownership and may persist. Inputs are not mutated; constructor settings are
copied into the store, while provider/root references follow constructor rules.

- `path` (string) — Project folder, relative or absolute; aliases share filesystem identity.
- `[options]` (object) — Constructor options other than cwd, plus optional init settings.

Returns `Promise<Env>` — Ready Env; caller must await close() when finished.

Throws — {TypeError|Error} Invalid path/options or startup failure. Failed new Envs close before rejection; after fixing input or disk state, retry is safe.

### `Agent.Env.promptCatalog(options = {…})`

Format this environment's current prompt catalog as Markdown.

Returns `string` — Detached catalog text; reads entries without retaining or mutating them.

Effects — Reads prompt files; repeated calls reflect current catalog contents.

### `Agent.Env.prompts()`

The merged prompts (same layers; a later same-named prompt
replaces an earlier one), read fresh from disk — same entry shape.

Returns `Map<string, {name: string, description: string, file: string, source: string, body: string}>`

### `Agent.Env.ready()`

Await complete initial global settings discovery, without starting providers,
models, tools or a project Env. Safe before or after loading; use this barrier
rather than waiting for a possibly already-fired SETTINGS_LOADED event.

Returns `Promise<Object>` — The same live view as static Env.settings.

Throws — {Error} Startup/discovery failure; repair sources, await static close(), and retry.

### `Agent.Env.ready()`

Complete asynchronous folder discovery and graph startup once. The constructor
exposes cached, possibly incomplete settings immediately; await this for
complete startup settings. SETTINGS_CHANGED announces changed values;
SETTINGS_LOADED announces completed discovery/reload batches after all
detected files and their effective settings views finish loading.

Returns `Promise<Env>` — This environment after its source graph is ready.

### `Agent.Env.settings`

**Read** — `static get settings()`

Live process-global settings from package, extensions and user sources only.
`settings.projects` contains pinned records keyed by absolute folder. Each
record reads with derived `name` (shortest unique folder suffix) and `folder`;
neither derived field nor any name alias is persisted. Pins can be edited
here or through an instance's reachable-project settings view. Unlike
instance writes, a global write of a new folder pin does not add groups.
No project Env is opened or registered. Reads may be partial before static
ready(); writes follow the same authorization/defaults/persistence rules as
instance settings. Nested views are stable; arrays are detached snapshots.
The process owns this facade until static close(); existing project Envs
retain their shared sources independently. Configure the settings directory
through the namespace environment variable before first access.

Returns `Object` — Global live settings, including defaults and unknown keys.

### `Agent.Env.settings`

**Read** — `get settings()`

The LIVE settings view (lib/env/settings-view.js): reads apply the
defaults schema and derived values (`settings.sessions` is the
resolved sessions folder); assigning or deleting a key persists
only that change to the writable owner in memory immediately; file-backed
updates coalesce and persist asynchronously. Await settingsFlush() for
durability or write errors. Nested objects are path-stable live views;
arrays are detached snapshots: replace the whole array to persist and emit events;
in-place edits of a returned array do not change the Env.
`settings.projects` reads as a live view of reachable project records,
keyed by absolute folder and by name aliases pointing to the SAME records.
It includes this Env's own folder even when unpinned, plus pinned projects
sharing a group. `projects.this` aliases this Env's own folder record.
Writes through folder keys or name aliases edit global pins, including new
folder pins; the reachable filter restricts reads, not writes. Assigning
`settings.projects[folder]` for a new pin inherits every true group from
this Env's own current global pin, making the new entry reachable. Global
`Env.settings.projects` writes do not auto-add groups. Each returned record
has derived `name` and `folder`; aliases and derived fields are never
persisted. `Env.settings.projects` also permits global pin edits.

Returns `Object`

### `Agent.Env.settingsFlush()`

Persist pending global settings edits; reads/writes are already immediate.

Returns `Promise<void>` — Resolves after persistence; rejects on write failure (retry safe).

### `Agent.Env.settingsFlush()`

Wait for queued settings writes in this Env's shared and project file nodes.
Assignments update the live view immediately; this explicit barrier makes
their latest values durable or rejects on a file write error.

Returns `Promise<void>` — Settles after outstanding writes complete.

### `Agent.Env.settingsSchema()`

The DEFAULTS SCHEMA: every top-level settings key Env (or a
loaded tool — see the tools.js module contract's `settingsSchema()`)
understands, its default and a one-line description. Discovery
only (`ai init`, API.md) — an unknown settings key is never
rejected either way.

Returns `Object} key -> {default, description`

### `Agent.Env.skillCatalog(options = {…})`

Format this environment's current skill catalog as Markdown.

Returns `string` — Detached catalog text; reads entries without retaining or mutating them.

Effects — Reads skill files; repeated calls reflect current catalog contents.

### `Agent.Env.skillLoad(names, { active = new Set() } = {…})`

Validate named skills and return their instruction payload without injecting it.

- `[names]` (string|string[]) — Names to load; omitted lists the catalog.

Returns `string|{result: string, system: string[]}` — Detached catalog text or a complete activation payload.

Throws — {TypeError|Error} Invalid names or unknown skills; correct the complete request before retrying. No partial payload is returned.

Effects — Reads the current skill catalog; performs no context or file mutation.

### `Agent.Env.skillSection(skill)`

Format a skill entry for injection into a Context.

Returns `string` — Detached skill section; input is neither mutated nor retained.

Throws — {TypeError} If the entry lacks a string name; pass a catalog entry before retrying.

Effects — None; repeated calls with the same entry return the same text.

### `Agent.Env.skills()`

Effective skills, read fresh from package/settings/configured/environment/
project layers. Later bodies override; {{name}} and {{name[L1-L2]}}
explicitly compose bodies (self references use the previous definition).
Line ranges are 1-based/inclusive over expanded bodies, excluding metadata.
Unknown placeholders remain literal; cycles/invalid known ranges throw.
`directories` lists the skill's resource folders in layer order (later
layers override earlier ones); tools must not show them to models.

Returns `Map<string, {name: string, description: string, file: string, source: string, body: string, directories: string[]}>`

### `Agent.Env.systemPrompt()`

The system-prompt text(s) seeded into a FRESH context, read from
disk on every call (package, user settings, then project
AGENTS.md — or `settings.system`), with `{{skill}}` prefill.

Returns `string[]` — zero to three texts, in layering order

### `Agent.Env.toolAdd(name, fn, schema, { builtin = false, file } = {…})`

Register a tool into the flattened callable lookup
(lib/env/tool-registry.js — the safe/interactive schema metadata
contract lives there).

- `name` (string) — flattened tool name
- `fn` (Function) — the callable
- `schema` (object) — MCP-like {description, inputSchema, safe?, interactive?, sandbox?, onTimeout?, readOnly?}; readOnly(args) classifies optional mutating invocations as sequential barriers.

Returns `Function` — fn

### `Agent.Env.toolCall(name, args, context)`

Invoke one tool (lib/env/tool-registry.js). The context is handed to
the tool as its second argument; Env reads: `safe` (refuse a tool
that is not read-only), `selector` + `io` (the pair's provider tool
serves first; undefined falls through to the global tool), `signal`
and `deadline`, and adds `statusSet(info)` — the tool's own live
status. When context.agent is supplied, the optional Agent plugin's
private _toolContextCreate hook supplies missing tool capabilities.
Missing names are ordinary errors, never a crash.

- `name` (string)
- `args` (object)
- `[context]` (object)

Returns `Promise<*>` — the tool's return value

### `Agent.Env.tools(safe = false, selector)`

The tool catalog: name -> ToolInfo ({name, schema, safe, trusted,
sandbox, secret, interactive, builtin, file?, storage?, status?,
onTimeout?, detect?, readOnly?} — never the callable). Nested schemas/status values
are shared live registry data, not defensive copies; mutating them can
affect all consumers without a refresh/event. Dynamic availability is
rechecked first (concurrent callers share one check). With a
selector, that pair's provider tools (`provider: true`) shadow a
global tool of the same name.

- `[safe=false]` (boolean) — read-only (`safe: true`) tools only
- `[selector]` (string) — `<endpoint>/<model>`

Returns `Promise<Map<string, object>>`

## Agent.IO

### `class IO`

One provider IO session: context in, normalized response events out.

### `Agent.IO.Provider`

Wire-completed provider constructor for trusted host/provider code.

Returns `Function` — Wire-completed provider constructor for trusted host/provider code.

### `Agent.IO.authSet(auth, options)`

Route auth persistence to the endpoint's namespace and refresh the
live settings view.

- `auth` (object) — Authentication data to persist.

Returns `object` — The persisted endpoint section returned by the Env connection.

Throws — {Error} Propagates persistence or Env connection errors.

Effects — Persists endpoint authentication and updates the underlying live settings view.

### `Agent.IO.cancel()`

Interrupt the active request, emitting a terminal partial; IO remains reusable.

Returns `Promise<void>` — Resolves after the in-flight request settles; no-op when idle/closed.

Effects — Aborts the owned connection signal, awaits teardown, and returns to idle. Repeated calls are safe.

### `Agent.IO.close()`

Permanently disconnect after interrupting any active request.

Returns `Promise<void>` — Resolves when the request settles and its connection closes; concurrent/repeated calls await the same outcome.

Throws — {Error|AggregateError} Request finalization or connection teardown failures, after the instance enters closed. Repeated close reports the same failure; construct a new IO to reconnect.

Effects — Aborts the owned connection signal and transitions irreversibly to closed.

### `Agent.IO.connectTimeout`

**Read** — `get connectTimeout()`

Current default connection watchdog in milliseconds.

Returns `number` — Current default connection watchdog in milliseconds.

### `Agent.IO.connectionCreate({ signal, onBytes } = {…})`

A fresh provider connection over this endpoint/model for a
provider tool's one-off request (context2msg/send/read/close);
the caller closes it.

- `[options={}]` (object) — Connection options.
- `[options.signal]` (AbortSignal) — Signal assigned to abort its transport.
- `[options.onBytes]` ((bytes: Uint8Array) => void) — Raw response-byte progress callback.

Returns `object` — A newly constructed provider connection; caller owns and must close it.

Throws — {Error} If the provider constructor fails.

Effects — Creates a new provider connection and optionally attaches the signal and byte callback.

### `Agent.IO.constructor(options = {…})`

Configure one provider IO session. Resolves the registered endpoint and
provider; URL, credentials and timeout defaults read Env's live
provider configuration, including after this IO is cached.

- `[options={}]` (Object) — Constructor options.
- `options.env` (object) — Env registry; required.
- `options.model` (string) — Registered `<endpoint>/<model>` selector.
- `[options.tools]` (string[]) — Tool selection: omitted or ["*"] means all, [] none, otherwise the named subset.
- `[options.safe=false]` (boolean) — Whether to publish read-only tools only.
- `[options.onData]` ((event:object)=>void) — Optional default data callback.
- `[options.onLog]` ((line:string)=>void) — Optional default log callback.
- `[options.remember=true]` (boolean) — Whether Env.connection records this pair as last used.

Returns `IO` — The initialized provider IO session.

Throws — {TypeError} Invalid options container, unknown own top-level keys (including symbols), missing `env`, a separate endpoint option, or invalid qualified model. Key validation precedes provider lookup; settings payload keys remain open.

Throws — {ProviderError} If endpoint resolution reports a provider-classified failure; other resolution errors propagate.

Effects — Resolves and retains the provider link and initializes this instance in the idle state.

### `Agent.IO.context`

The Context of the request in flight (null while idle); providers read its `dirty` and may edit replay data in it.

Returns `?Context` — The Context of the request in flight (null while idle); providers read its `dirty` and may edit replay data in it.

### `Agent.IO.env`

The shared live environment.

Returns `Env` — The shared live environment.

### `Agent.IO.fetch(url, init = {…}, { deadline, connectTimeout } = {…})`

fetch bounded by a wall-clock deadline and a fast connect fail-fast
(provider tools' plain HTTP requests).

- `url` (string|URL) — Request URL.
- `[init={}]` (object) — Fetch initialization; any supplied signal is honored.

Returns `Promise<Response>` — Resolves to the fetch response.

Throws — {TypeError} May reject for invalid fetch arguments; transport and deadline failures reject the promise.

Effects — Starts a bounded HTTP request using the global `fetch` implementation.

### `Agent.IO.model`

**Read** — `get model()`

Qualified endpoint/model selector; assignment changes the model only while idle and on this connection's endpoint.

Returns `string` — Qualified endpoint/model selector; assignment changes the model only while idle and on this connection's endpoint.

**Write** — `set model(selector)`

Select a model on the same endpoint. Validation precedes mutation; busy/closed IO refuses selection. @param {string} selector Qualified model. @throws {TypeError|ProviderError} Invalid, cross-endpoint, busy, or closed selection.

### `Agent.IO.name`

Connection endpoint name.

Returns `string` — Connection endpoint name.

### `Agent.IO.protocol`

Provider protocol registry name.

Returns `string` — Provider protocol registry name.

### `Agent.IO.provider`

Live provider metadata; never serialize wholesale to a model.

Returns `object` — Live provider metadata; never serialize wholesale to a model.

### `Agent.IO.settings`

**Read** — `get settings()`

Build the live provider-namespaced settings view with per-instance
agent-local thinking applied. The returned `think` is the model's native mode,
mapped from the library level and narrowed by model/provider capabilities.

Returns `object` — A fresh merged settings object; undefined native thinking means provider default.

Effects — None; does not mutate the Env settings.

### `Agent.IO.settingsSet(key, value)`

Set/clear the Agent's thinking selection AFTER construction.
Provider configuration changes must go through Env.

- `key` (string)
- `value` (*) — Thinking level; `undefined` restores the Env default.

Returns `void`

Effects — Changes this IO instance's non-persisted thinking selection.

### `Agent.IO.state`

**Read** — `get state()`

Read the request state machine's current state.

Returns `"idle"|"sending"|"reading"|"cancelling"|"closing"|"closed"` — Current lifecycle state.

Effects — None; this is a read-only view.

### `Agent.IO.stuckTimeout`

**Read** — `get stuckTimeout()`

Current default reading watchdog in milliseconds.

Returns `number` — Current default reading watchdog in milliseconds.

### `Agent.IO.timeout`

**Read** — `get timeout()`

Current default overall request timeout in milliseconds.

Returns `number` — Current default overall request timeout in milliseconds.

### `Agent.IO.tools()`

Return this request's publishable tool catalog, filtered by availability,
safe mode, configured selection, and the endpoint's provider tools.

Returns `Array<{name: string, ...Object}>` — Fresh tool descriptors; secret tools are excluded.

Effects — None; reads the request's tool catalog snapshot.

### `Agent.IO.url`

**Read** — `get url()`

Effective URL from the current Env provider configuration.

Returns `string` — Effective URL from the current Env provider configuration.

### `Agent.IO.write(context, callbacks = {…}, options = {…})`

Run one provider request over a complete context.

- `context` (Context) — The conversation; metadata records and empty messages are filtered before validation/provider conversion, and IO updates its root record during the request.
- `[callbacks={}]` (Object) — CamelCase response callbacks for this request.
- `[options={}]` (Object) — Per-request overrides.
- `[options.timeout]` (number|string) — Overall request cap override.
- `[options.connectTimeout]` (number|string) — Connection timeout override.
- `[options.stuckTimeout]` (number|string) — Reading watchdog override.

Returns `Promise<object>` — Resolves with the terminal done/error event. Rejects TypeError for a non-Context argument or any model/endpoint write override without reserving the instance; rejects ProviderError for a closed/busy instance or malformed context.

Effects — Reserves the instance synchronously, may refresh OAuth, starts one request, and returns the instance to idle after request finalization unless closed.

### `class ProviderError extends Error`

The stable provider failure class (auth/network/provider/malformed).

### `Agent.IO.ProviderError.constructor(kind, message, detail = {…})`

Build a classified error, assigning the supplied detail fields onto it.

- `kind` ("auth"|"network"|"provider"|"malformed") — failure class; not validated by this constructor
- `message` (string) — error message passed to {@link Error}
- `[detail={}]` (object) — enumerable metadata fields to copy onto the error; may override existing fields

Returns `ProviderError` — The constructed error instance.

Throws — Propagates errors raised while copying enumerable detail properties.

### `Agent.IO.Context`

The Context namespace for validating every provider-bound request.

### `Agent.IO.Env`

The global environment constructor used by IO and provider authors.

### `Agent.IO.THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"]`

Selectable thinking levels, weakest -> strongest (IO maps them to native modes).

### `Agent.IO.timeoutsResolve(options = {…})`

Resolve a request timeout using the Env's provider settings and an optional per-request override. @param {{env: Env, model: string, timeout?: number|string}} options Request inputs; no provider settings override. @returns {number} Milliseconds. @throws {TypeError|Error} Missing Env, unsupported settings override, or invalid model.

## Agent.Jobs

### `class Jobs`

Frozen static namespace for the folder-only Jobs operations exported by this
module. Instances have no API; use the static methods/properties instead.

- `...args` (never) — No constructor arguments are accepted.

Returns `Jobs` — A Jobs namespace instance (normally unused; use static members).

### `class JobsError extends Error`

Error type used for actionable Jobs failures.

### `Agent.Jobs.JobsError.constructor(code, message, details = {…})`

Create a coded jobs-domain error.

- `code` (string) — Stable error code identifying the failure.
- `message` (string) — Human-readable error message passed to `Error`.
- `[details={}]` (object) — Optional contextual data, such as a task filename or underlying cause.

Returns `JobsError` — The initialized error instance.

Throws — Any exception raised while the native `Error` constructor converts the supplied message.

Effects — Initializes the native error state and sets `name`, `code`, and `details` on the instance.

### `async Agent.Jobs.daemonRun(projectRoot, options = {…})`

Run a foreground best-effort daemon bound to the project root.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Daemon options; supports `signal`, `state`, `execution`, `scan`, and `delay`.

Returns `Promise<void>` — Resolves when stopped or Jobs becomes unusable; rejects on initial validation or daemon errors.

Throws — {JobsError} If the project is not operational when starting.

### `async Agent.Jobs.disable(projectRoot, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

Throws — {JobsError} If layout is invalid or active and disabled roots collide.

### `async Agent.Jobs.init(projectRoot, settings = {…}, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

Throws — {JobsError} If layout is invalid or active and disabled roots collide.

### `async Agent.Jobs.run(projectRoot, options = {…})`

Dispatch one best-effort serial scan of due Jobs.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Scan options, including injected clock, filesystem, validation, executor, and execution settings.

Returns `Promise<object>` — Frozen scan result containing outcomes, errors, warnings, and optional error-log path.

Throws — {JobsError} For invalid clock values; scan and persistence failures are generally returned as errors.

### `async Agent.Jobs.schedule(root, command, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

Throws — {JobsError} For invalid commands, read-only mutation, ineligible Jobs, or invalid task metadata; filesystem errors may also reject.

### `async Agent.Jobs.status(projectRoot, options = {…})`

Read a non-mutating projection of Jobs eligibility, tasks, schedule, attempts, and last scan.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Options such as clock, defaults, and validation context.

Returns `Promise<object>` — Status projection with diagnostics; does not create folders or start a daemon.

### `async Agent.Jobs.validate(root, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

Throws — {JobsError} For invalid commands, read-only mutation, ineligible Jobs, or invalid task metadata; filesystem errors may also reject.

## App

### `class App`

Application presentation namespace. Importing it loads CLI, GTUI, TUI,
Markdown and Web. Its static references are borrowed, not copied or owned;
neither import nor construction starts a server or opens a terminal.

### `App.CLI`

Constructor namespace; see [App.CLI](#appcli) for its full contract.

Returns `typeof App.CLI` — The shared constructor namespace.

### `App.GTUI`

Constructor namespace; see [App.GTUI](#appgtui) for its full contract.

Returns `typeof App.GTUI` — The shared constructor namespace.

### `App.Markdown`

Constructor namespace; see [App.Markdown](#appmarkdown) for its full contract.

Returns `typeof App.Markdown` — The shared constructor namespace.

### `App.TUI`

Constructor namespace; see [App.TUI](#apptui) for its full contract.

Returns `typeof App.TUI` — The shared constructor namespace.

### `App.Web`

Constructor namespace; see [App.Web](#appweb) for its full contract.

Returns `typeof App.Web` — The shared constructor namespace.

## App.CLI

### `class CLI`

Static namespace exposing every named CLI operation.

### `App.CLI.EXIT = Object.freeze({…})`

Exit codes shared by the command-line tools.

### `async App.CLI.adoptResumeOrigin({ resume, anonymous = false, dir } = {…})`

Move the process to the recorded origin folder for an explicit session resume.
Skips cwd changes for anonymous, absent, `"true"`, and `"latest"` resume values.
Resolves the session origin (using `dir` or the configured sessions folder),
verifies that folder exists, then changes `process.cwd()` before environment setup.

- `[options={}]` (Object) — Resume selection and session lookup options.
- `[options.resume]` (string) — The `--resume` value; values other than `"true"` and `"latest"` are treated as explicit session IDs.
- `[options.anonymous=false]` (boolean) — Whether this is an anonymous session.
- `[options.dir]` (string) — Session directory passed to origin lookup; defaults to the configured sessions folder when omitted or nullish.

Returns `Promise<string|null>` — The origin folder after changing cwd, or `null` when no explicit origin should be adopted.

Throws — {Error} If the session has no recorded origin or its origin folder no longer exists. `process.chdir()` errors also propagate.

### `App.CLI.armCancelSignals({ onCancel, process: proc = process })`

Arm SIGINT/SIGTERM cancellation for a CLI binding.

- `options` (Object) — configuration object
- `options.onCancel` ((signal: string) => void) — invoked once, with "SIGINT" or "SIGTERM", on the first caught signal
- `[options.process=process]` (NodeJS.Process) — process-like signal emitter; defaults to the global Node.js `process` and can be injected for tests

Returns `() => void` — disarm function; removes both listeners, and is safe to call repeatedly

Throws — {TypeError} if `onCancel` is not a function

Throws — {*} if registering either signal listener throws; the error propagates, and a SIGINT listener already registered is not rolled back if SIGTERM registration fails

Effects — Registers SIGINT and SIGTERM listeners on the selected process. The first signal invokes `onCancel` once; any exception from it propagates from the signal handler and does not allow a later retry. Calling the returned function removes both listeners; if removal throws, the error propagates and the disarm function remains marked as used.

### `async App.CLI.close({ env, agent } = {…})`

Close a command-line library runtime. This is the sole public housekeeping
boundary: agents are cancelled, sessions are flushed/closed, and tool-owned
background resources are released. Repeated calls are safe.

Returns `Promise<{agent?: object, session: {id: string, file?: string}|null}>` — The explicit agent and its context's id/file when present, otherwise a null session. Resolves after owned teardown; rejects after all releases when cleanup fails.

### `App.CLI.exitCodeFor(terminal)`

Map a terminal done/error event (or an error-shaped `{kind}`) to the
process exit code.

Returns `number` — The mapped process exit code; this function is synchronous and has no side effects.

### `App.CLI.finishSignalsArm({ process: proc = process, signals = ["SIGINT", "SIGTERM", "SIGHUP"], } = {…})`

Arm process termination signals to run Agent's synchronous finish hooks,
then re-raise the received signal so the process retains signal exit semantics.
Repeated arming returns the existing disarm function without changing options.
This is an opt-in CLI binding; it is not suitable for asynchronous cancellation.

- `[options]` (Object) — Signal-arming options.
- `[options.process=process]` (NodeJS.Process) — Process on which to install handlers and call `kill`.
- `[options.signals=["SIGINT", "SIGTERM", "SIGHUP"]` (string[]) — ] Signals to handle.

Returns `() => void` — Idempotent function that removes these signal handlers and permits rearming.

Effects — Registers a process exit listener (once per process) and handlers for the selected signals. On a signal, runs Agent.finishRun(), removes the signal handlers, then calls process.kill(process.pid, signal). Finish callbacks may run again on exit and must be synchronous and idempotent.

### `App.CLI.parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = [] })`

Parse command-line arguments into a flat options object. Value-taking flags
use `--name value`; boolean flags use `--name`. `--help` and `-h` return
`{help: true}` immediately. Repeated flags overwrite earlier values.
Configured duration values are converted with `durationParse`; configured
numeric values are converted with `Number` and must be finite and positive.
Flag relationships and value-specific transformations remain caller policy.

- `argv` (string[]) — Arguments to parse, typically `process.argv.slice(2)`.
- `spec` (Object) — Flag-name configuration.
- `spec.flags` (string[]) — Names of value-taking flags (required).
- `[spec.bools=[]` (string[]) — ] - Names of valueless boolean flags.
- `[spec.durations=["timeout"]` (string[]) — ] - Value-taking flag names converted by `durationParse` when present.
- `[spec.numbers=[]` (string[]) — ] - Value-taking flag names converted to finite, positive numbers when present.

Returns `Object` — Parsed options; values are strings except converted duration/number values, boolean flags (`true`), or `{help: true}`.

Throws — {Error} For positional arguments, unknown flags, missing values, invalid duration values, or configured numbers that are not finite and positive. Duration errors are prefixed with the flag name.

### `async App.CLI.readContextFromStdin()`

Read standard input through EOF and parse its UTF-8 contents as messages.

Returns `Promise<Array<object>>` — The parsed context/message array.

Throws — {Error} Rejects if reading stdin fails or message parsing throws.

### `async App.CLI.readStdin()`

Read and buffer all bytes from standard input until the stream reaches EOF,
then decode the concatenated bytes as UTF-8.

Returns `Promise<string>` — The complete stdin contents as a UTF-8 string.

Throws — {Error} Rejects if reading the stdin stream fails.

### `async App.CLI.runLoginWizard(env, { input = process.stdin, output = process.stderr, } = {…})`

Run the cooked-terminal wizard used by `--login`. Lists known endpoints
from `Env.loginPresets` alongside a manual URL option, then prompts for
endpoint details and credentials or browser OAuth where available. Closes
its readline interface on completion or failure.

- `env` (object) — Environment providing presets and endpoint login.
- `[options={}]` (object) — I/O options; defaults to `{}`.
- `[options.input=process.stdin]` (import("node:stream").Readable) — Prompt input stream.
- `[options.output=process.stderr]` (import("node:stream").Writable) — Wizard and OAuth output stream.

Returns `Promise<*>` — Resolves with the result of the selected endpoint login.

Throws — {Error} If no protocols are loaded, a choice is invalid, the URL is missing, or OAuth/login fails; propagates errors from the login operation.

### `async App.CLI.runMcpLogin(env, name, { input = process.stdin, output = process.stderr } = {…})`

Start explicit MCP browser sign-in. Loopback callback wins without waiting
for Enter; in a terminal, a full pasted redirect URL is a fallback.

- `env` (object) — Environment with mcpLogin/mcpPaste methods.
- `name` (string) — Configured MCP server name.

Returns `Promise<{name: string}>` — Signed-in server identity.

### `async App.CLI.selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {…})`

Select a qualified model from CLI input or the last-used published model.

- `env` (object) — Environment providing model resolution and login.
- `args` (object) — CLI arguments: model selector and optional invocation-only URL.
- `[options={}]` (object) — Selection options.
- `[options.lastUsed=false]` (boolean) — Consider the newest available last-used model when no explicit model is supplied.
- `[options.log=()=>{}]` (Function) — Log the selected last-used qualified model.

Returns `Promise<string|undefined>` — Qualified `<endpoint>/<model>`, or undefined if unresolved.

Throws — {Error} Invalid input or catalog failures; explicit URL login failures leave the model unresolved.

Effects — May register an invocation-only endpoint; never persists the URL here.

### `App.CLI.usageSummary(usage)`

Format one terminal usage envelope for CLI diagnostics without mutating it.

Returns `string` — One-line token summary with finite provider cost when supplied.

### `App.CLI.writeSettingsTemplate(env, { force = false } = {…})`

Write a namespaced settings template to the project settings path under `env.folder`.
Refuses to replace an existing file unless `options.force` is true.

Returns `string` — Path of the written settings file.

Throws — {Error} If the file already exists and force is false, or if rendering or writing the template fails. An existing file is not overwritten on the refusal path.

## App.GTUI

### `class GTUI`

Run a synchronous application against a GTUI host.
The application supplies init, update, view, and optional bindings/dispose;
update transitions may return effects. GTUI applies messages, renders views,
and manages host/task/timer cleanup.

### `App.GTUI.constructor({ host, theme = {…} } = {…})`

Create a runtime for a host.

Returns `GTUI` — configured runtime

Throws — {TypeError} if host is missing

### `App.GTUI.dispatch(message)`

Deliver one message immediately to the running application.

- `message` (object) — application message

Returns `void`

### `App.GTUI.run(app)`

Start an application and return its eventual completion result.

Returns `Promise<{reason: string, code: number}>` — completion promise; rejects on runtime failure

Throws — {Error} if already running; TypeError if required callbacks are absent

### `App.GTUI.stop(reason = "stop", code = 0)`

Stop the application, canceling tasks and timers and restoring the host.

- `[reason="stop"]` (string) — completion reason
- `[code=0]` (number) — completion code

Returns `void`

### `App.GTUI.effect = freeze({…})`

Immutable constructors for host, task, timer, theme, and lifecycle effects.

### `App.GTUI.effect.after(ms, message)`

Describe delayed message delivery.

- `ms` (number) — delay in milliseconds
- `message` (object) — message to dispatch

Returns `object` — frozen timer effect

### `App.GTUI.effect.cancel(key)`

Describe cancellation of a keyed task.

- `key` (*) — task identity

Returns `object` — frozen cancellation effect

### `App.GTUI.effect.copy(text, id)`

Request host-mediated text copying.

- `text` (string) — text to copy
- `[id]` (*) — optional correlation identifier

Returns `object` — frozen copy effect

### `App.GTUI.effect.notify(text)`

Request a host notification.

- `text` (string) — notification text

Returns `object` — frozen notification effect

### `App.GTUI.effect.open(url)`

Request host-mediated URL opening.

- `url` (string) — URL to open

Returns `object` — frozen open effect

### `App.GTUI.effect.quit(code = 0)`

Request application shutdown.

- `[code=0]` (number) — completion status code

Returns `object` — frozen quit effect

### `App.GTUI.effect.refresh()`

Request a render without changing the model.

Returns `object` — frozen refresh effect

### `App.GTUI.effect.task(key, run)`

Describe an abortable asynchronous task.

- `key` (*) — task identity
- `run` (Function) — async task receiving signal and send

Returns `object` — frozen task effect

### `App.GTUI.effect.theme(tokens)`

Replace theme tokens at runtime.

- `tokens` (object) — theme token mapping

Returns `object` — frozen theme effect

### `App.GTUI.event = freeze({…})`

Immutable constructors for messages delivered to an application update function.

### `App.GTUI.event.copyDone(payload)`

Create a completed-copy event.

- `payload` (object) — event fields

Returns `object` — frozen copy-done event

### `App.GTUI.event.focus(payload)`

Create a focus event.

- `payload` (object) — event fields

Returns `object` — frozen focus event

### `App.GTUI.event.inputChange(payload)`

Create an input-change event.

- `payload` (object) — event fields

Returns `object` — frozen input-change event

### `App.GTUI.event.inputSubmit(payload)`

Create an input-submit event.

- `payload` (object) — event fields

Returns `object` — frozen input-submit event

### `App.GTUI.event.key(payload)`

Create a key event.

- `payload` (object) — event fields

Returns `object` — frozen key event

### `App.GTUI.event.linkOpen(payload)`

Create a link-open event.

- `payload` (object) — event fields

Returns `object` — frozen link-open event

### `App.GTUI.event.menuCancel(payload = {…})`

Create a menu-cancel event.

- `[payload={}]` (object) — event fields

Returns `object` — frozen menu-cancel event

### `App.GTUI.event.menuSelect(payload)`

Create a menu-selection event.

- `payload` (object) — event fields

Returns `object` — frozen menu-selection event

### `App.GTUI.event.paste(payload)`

Create a paste event.

- `payload` (object) — event fields

Returns `object` — frozen paste event

### `App.GTUI.event.pointer(payload)`

Create a pointer event.

- `payload` (object) — event fields

Returns `object` — frozen pointer event

### `App.GTUI.event.resize(payload)`

Create a resize event.

- `payload` (object) — event fields

Returns `object` — frozen resize event

### `App.GTUI.event.selectionCopy(payload)`

Create a selection-copy event.

- `payload` (object) — event fields

Returns `object` — frozen selection-copy event

### `App.GTUI.event.taskDone(payload)`

Create a completed-task event.

- `payload` (object) — event fields

Returns `object` — frozen task-done event

### `App.GTUI.event.taskFailed(payload)`

Create a failed-task event.

- `payload` (object) — event fields

Returns `object` — frozen task-failed event

### `App.GTUI.host = freeze({…})`

Host constructors for tests and terminal execution.

### `App.GTUI.host.memory(...)`

Create a memory host for deterministic application tests.

### `App.GTUI.host.terminal(...)`

Create a terminal host for interactive execution.

### `App.GTUI.memory({ width = 80, height = 24, scrollBar } = {…})`

Create an in-memory host for application tests. It records rendered
semantics and effects; it never emits terminal bytes.

Returns `object` — in-memory host implementing the GTUI host protocol

### `App.GTUI.memory.effects`

**Read** — `get effects()`

Recorded effects, copied so callers cannot mutate host state.

Returns `object[]` — shallow copy of recorded effects

### `App.GTUI.memory.flush()`

Finish pending host output; memory hosts have nothing to flush.

Returns `void`

### `App.GTUI.memory.restoreCount`

**Read** — `get restoreCount()`

Number of completed host restoration cycles.

Returns `number` — restoration count

### `App.GTUI.memory.send(message)`

Send a host input message to the mounted application.

- `message` (object) — input message

Returns `void`

### `App.GTUI.memory.snapshot()`

Return the current rendered scene in semantic, testable form.

Returns `object` — scene snapshot with current dimensions

### `App.GTUI.scrollGlyph(value, fallback)`

Validate a one-cell grapheme for use as a scroll indicator.

- `value` (*) — candidate glyph
- `fallback` (*) — result when candidate is invalid

Returns `*` — candidate when it is a one-cell grapheme, otherwise fallback

### `App.GTUI.terminal(options = {…})`

Construct a terminal host that owns input decoding and terminal rendering,
or return `options.host` unchanged.

- `[options={}]` (object) — terminal streams, mode, dimensions, and policies

Returns `object` — supplied or newly-created GTUI host

### `App.GTUI.view = freeze({…})`

Immutable constructors for renderable view nodes.

### `App.GTUI.view.button(props = {…}, label = "")`

Create a button node; activation emits `action.select {id, action}`.
`pressed` styles an on toggle and `tone` adds a role.

- `[props={}]` (object) — button properties
- `[label=""]` (*) — label converted to a string

Returns `object` — frozen button node

### `App.GTUI.view.column(...)`

Create an immutable vertical container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen column node

### `App.GTUI.view.feed(props = {…})`

Create an immutable feed control.

- `[props={}]` (object) — feed properties

Returns `object` — frozen feed node

### `App.GTUI.view.footer(props = {…}, items = [])`

Build a one-line footer of app-pushed notification items, aligned start/end;
tight rows drop lowest priority first. Empty items yield null.

- `[props={}]` (object) — row properties
- `[items=[]` (Array<object>) — ] items with text and optional role, priority, align, action

Returns `object|null` — frozen footer row, or null when empty

### `App.GTUI.view.grid(...)`

Create an immutable grid container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen grid node

### `App.GTUI.view.input(props = {…})`

Create an immutable controlled text input. The value remains application-owned.
`mask: true` displays one bullet per codepoint; a non-empty string requests
a one-cell mask glyph (invalid glyphs use a bullet). Masking preserves the
actual value and UTF-16 caret/selection offsets, hides completions, disables
Copy, and omits the actual value from JSON and ordinary debug inspection.
Masking is presentation, not encryption: direct node.value access still
returns the actual value; input.change/input.submit carry it to the owner.

- `[props={}]` (object) — Input properties including optional value, mask, caret, selection, focus, and placeholder. Properties are shallow-copied; referenced objects are retained, not mutated.

Returns `object` — Frozen input node; construction has no side effects and is retry-safe.

Throws — {Error} Propagates property-access or mask string processing errors.

### `App.GTUI.view.menu(props = {…})`

Create an immutable menu control. `searchItems` optionally supplies a
broader item list used only while the type-to-filter query is nonempty;
the empty query displays `items`. Filtering does not mutate either list.
Action items with `alwaysVisible:true` remain during filtering. Set
`labelOverflow:"clip-middle"` for single-row labels preserving both ends,
`"clip-end"` for single-row labels clipped at the tail; the default wraps. menu.change reports {id,item,query,reason}, with reason
"filter" for query edits and "navigation" for arrow moves.

- `[props={}]` (object) — menu properties

Returns `object` — frozen menu node

### `App.GTUI.view.overlay(...)`

Create an immutable overlay container. `passive: true` draws its last
child above `anchorAction` in the first child's canvas without reserving
layout rows or capturing input; `position: "above-right"` aligns its right edge.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen overlay node

### `App.GTUI.view.panel(...)`

Create an immutable bordered panel.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen panel node

### `App.GTUI.view.row(...)`

Create an immutable horizontal container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen row node

### `App.GTUI.view.scroll(...)`

Create an immutable scroll container. Keyboard scroll.change events carry
source:"keyboard" and repaint immediately; wheel paints remain coalesced.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen scroll node

### `App.GTUI.view.table(props = {…}, rows = [])`

Create an immutable table with frozen rows and cells.

- `[props={}]` (object) — table properties
- `[rows=[]` (object[]) — ] rows; each row's cells are copied and frozen

Returns `object` — frozen table node

### `App.GTUI.view.text(props = {…}, content = "")`

Create immutable text content.

- `[props={}]` (object) — text-node properties
- `[content=""]` (*) — text content

Returns `object` — frozen text node

### `App.GTUI.view.toolbar(...)`

Create a horizontal toolbar container with host-owned roving focus.
Children use `{id, focus, gap?, align?: "end"}`; while focused, navigation
keys move focus and Enter/Space activate; other keys bubble.

- `[props={}]` (object) — toolbar properties
- `[children=[]` (Array|*) — ] button children

Returns `object` — frozen toolbar node

## App.Markdown

### `class BashSanitizer`

Streaming sanitizer — one instance PER LIVE TOOL CALL (typically one
bash command). Holds the look-back buffer that catches escape sequences
split across chunks, so concurrent calls must never share an instance.

### `App.Markdown.BashSanitizer.constructor({ markdown = false } = {…})`

Create one sanitizer for one live tool call.

Returns `BashSanitizer` — A new streaming sanitizer instance.

Throws — {TypeError} If `options` is `null` and cannot be destructured.

### `App.Markdown.BashSanitizer.end()`

Flush held bytes when the call ends, dropping any unfinished escape and balancing streamed emphasis.
Resets the pending buffer and emphasis state for this instance.

Returns `string` — Sanitized text remaining in the buffer, plus any needed closing Markdown markers.

### `App.Markdown.BashSanitizer.push(chunk)`

Sanitize the next raw chunk. A trailing INCOMPLETE escape is held
back (not emitted) until the following chunk completes it — or end().

- `chunk` (string) — Raw chunk, coerced with `String(chunk ?? "")`.

Returns `string` — Display-safe portion of the stream; any incomplete trailing escape is withheld. Coercion exceptions from the supplied chunk propagate to the caller.

### `class Markdown`

Canonical markdown module namespace. Static-only by design.

### `App.Markdown.classifyLine(line, state = {…})`

Classify one complete Markdown source line into its block kind.
Fence markers are recognized against and update the supplied fence
state; while inside a fence, non-closing lines are classified as code.
Outside fences, block markers are checked in horizontal-rule, heading,
list, and quote order; unmatched lines are plain text.

- `line` (string) — One source line, without a trailing `\n`.

Returns `{kind: "fence", lang: string, raw: string` — | {kind: "code", raw: string} | {kind: "hr", width: number, raw: string} | {kind: "heading", depth: number, text: string, raw: string} | {kind: "list", indent: string, marker: string, ordered: boolean, text: string, raw: string} | {kind: "quote", text: string, raw: string} | {kind: "text", text: string, raw: string}} Classification object. `raw` is always the source line; where present, `text` is content with the block marker stripped. List `marker` preserves the source marker (for example, `-`, `*`, or `2.`); normalization is left to the renderer.

Throws — {TypeError} If `line` is not a string or `state` is null/undefined when explicitly supplied; regular-expression matching and state access require valid inputs.

### `async App.Markdown.lexMarkdown(text)`

Tokenize complete markdown text. A unified Git diff is detected first
and returned as its own single token (see parseGitDiff); otherwise
`marked`'s lexer (gfm, breaks) runs when available without math
delimiters; otherwise the builtin lexer handles math. Same token shapes for walkTokens.

- `text` (string) — Complete markdown source; nullish values are coerced to an empty string at runtime.

Returns `Promise<Array<object>>` — Resolves to marked-shaped block tokens; recognized unified Git diffs are returned as a single token.

Throws — {Error} Rejects if engine loading or tokenization fails.

### `async App.Markdown.markdownEngine()`

Determine which engine whole-text rendering routes through, lazily loading and caching optional-engine availability.

Returns `Promise<"marked"|"builtin">` — Resolves to `"marked"` when the optional package is available, or `"builtin"` otherwise; import failure selects `"builtin"`.

### `App.Markdown.mathBlockAt(lines, start)`

Find a complete, line-delimited display-math block; an unclosed block is not consumed.

- `lines` (string[]) — Source lines.
- `start` (number) — Candidate opening-line index.

Returns `{end: number, text: string, source: string, tree: object}|null` — Block data and parsed AST, or null.

### `App.Markdown.mathText(node)`

Convert a math AST node to a plain-text fallback representation.

- `node` (object|null|undefined) — Math AST node; nullish input produces an empty string.

Returns `string` — Plain-text rendering; recursively visits child nodes.

### `App.Markdown.parseGitDiff(text)`

Parse one complete unified Git diff synchronously, with exact source-line spans.

- `text` (string) — Source text; coerced to a string by the parser.

Returns `object|null` — The Git-diff token, or `null` when the text is not a complete recognized diff.

Throws — {TypeError} If converting `text` to a string fails.

### `App.Markdown.parseInline(text)`

Tokenize inline markdown into flat, non-nested spans, choosing the earliest recognized markup.
Code spans, links, math, strong, and emphasis are recognized; unrecognized content remains text.

- `text` (string|null|undefined) — one line/fragment; nullish values are treated as empty, otherwise converted with String

Returns `Array<{type: string, text: string, href?: string, source?: string, tree?: object}>` — Ordered spans; math spans also contain source and parsed tree

Throws — {Error} May propagate errors raised by inline-math parsing

### `App.Markdown.parseMath(source)`

Parse a bounded TeX subset into presentation-independent nodes; unknown commands remain literal.

- `source` (*) — Input converted to a string (nullish values become empty).

Returns `{type: string, [key: string]: any}` — AST node; over-limit input is returned as one literal symbol.

Throws — String conversion may throw for hostile values.

### `App.Markdown.renderInline(text, renderer = {…})`

Render one fragment of inline markdown through a renderer's inline
callbacks, synchronously, via the builtin tokenizer (engine routing
needs whole text — inline fragments don't have it). This is the
primitive incremental renderers style complete lines with.

- `text` (string) — Inline markdown (no block structure).
- `[renderer={}]` (object) — Inline callbacks; missing callbacks default to plain text.

Returns `string` — The synchronously rendered inline fragment.

Throws — {Error} Propagates errors thrown during parsing or by renderer callbacks.

### `async App.Markdown.renderMarkdown(text, renderer = {…})`

Render complete markdown text through a renderer's callbacks,
engine-routed (see lexMarkdown). Rendered tokens join with one
"\n"; source blank lines are space tokens, so one blank line remains
one blank line in the output.

- `text` (string) — Complete markdown source passed to {@link lexMarkdown}.
- `[renderer={}]` (object) — Marked-style callbacks; missing callbacks default to plain text.

Returns `Promise<string>` — Resolves to rendered output with tokens joined by newlines.

Throws — {Error} Rejects if tokenization or rendering fails.

### `App.Markdown.sanitizeText(text, { markdown = false, state = null, open = false } = {…})`

Sanitize a COMPLETE untrusted string for display.
 - \r\n and lone \r (progress-bar carriage returns) become \n
 - ANSI escape sequences are removed: CSI, OSC (BEL- or ST-terminated),
   DCS/SOS/PM/APC (ST-terminated), charset/designate/short ESC forms
 - SGR bold/italic/underline become Markdown markers when markdown=true
   (balanced across style changes; nothing left open at the end)
 - C0 controls (except \t, \n), DEL, and C1 controls are dropped
A trailing INCOMPLETE escape is removed — this string is finished.

- `text` (string)
- `text` (string) — Input value, coerced with `String(text ?? "")`.

Returns `string` — Sanitized display text, with optional balanced Markdown emphasis markers.

Throws — {TypeError} If `options` is `null` and cannot be destructured.

Throws — {Error} If input coercion throws an error.

### `App.Markdown.walkTokens(tokens, renderer = {…})`

Render marked-shaped block tokens, completing missing renderer callbacks
with plain-text defaults. Nested block and inline content is rendered
recursively; top-level block results are joined with one newline.
List and table callbacks receive normalized item/cell metadata, and gitdiff
callbacks receive per-line classifications before the enclosing callback.

- `tokens` (Array<object>|null|undefined) — block tokens; nullish input is treated as empty
- `[renderer={}]` (object) — renderer callbacks; missing callbacks use plain-text defaults

Returns `string` — rendered block output

Throws — {TypeError} if tokens is not an array, a token is nullish, or a renderer callback throws

## App.TUI

### `class TUI`

Empty namespace class for the TUI module, published as `App.TUI` by
`lib/app.js`; static API members are assigned below.

### `App.TUI.createApp(agent, { env = agent?.env, cwd = "", sources, completionIO, log, open, columns, rows } = {…})`

App lifecycle and presentation. Call dispose to detach UI bridges, then await closeWorkspace to release App-created agents and acquired project Envs; borrowed unrelated resources remain open.

- `agent` (object) — the Agent this app starts on ("main")
- `[options]` (object)
- `[options.env=agent.env]` (object) — Env, for status/menu facts
- `[options.cwd]` (string) — the process working folder
- `[options.sources]` (object) — lib/tui-app/completion.js sources
- `[options.completionIO]` (object) — completion filesystem hooks ({listDir}); defaults to real directory reads resolved under cwd
- `[options.open]` ((url: string) => void) — browser opener handed to the OAuth flow; undefined uses the flow's system-browser default
- `[options.log]` ((line: string) => void) — an external diagnostics mirror (piped `--input` runs: stdout IS the terminal byte stream, not human-parseable, so the caller may want every notice ALSO written somewhere plain — parity with the legacy engines' `log` option)

Returns `{init: Function, update: Function, view: Function, bindings: Function, currentAgent: Function, closeWorkspace: Function, dispose: Function, abandonPending: Function, theme: object}` — App lifecycle and presentation. Call dispose to detach UI bridges, then await closeWorkspace to release App-created agents and acquired project Envs; borrowed unrelated resources remain open.

### `App.TUI.TUI_ENGINES = TUI_MODES`

The rendering modes accepted by {@link createRepl} (currently `inline` and `alt`).

### `App.TUI.close(runtime)`

Close TUI-owned agents, sessions, and background resources by delegating to
the CLI cleanup routine. Controllers returned by `createRepl` and
`createLineRepl` also expose an idempotent `close()` method.

Returns `Promise<{agent?: object, session?: {id: string, file?: string}|null}>` — Cleanup result returned by the CLI routine.

Effects — Delegates cleanup of the supplied runtime's TUI-owned resources.

### `App.TUI.createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit })`

Create the piped, cooked-mode front end, which reads one input message per
line. Re-exported from `./line-repl.js`; this module does not wrap it.

Returns `object` — The line-oriented REPL controller.

### `App.TUI.createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows })`

The interactive REPL. `options.engine` picks the rendering mode:
"inline" (native scrollback) or "alt" (default alternate screen).
Both modes use the same option contract. The function validates the mode
and delegates controller creation to the interactive REPL implementation.

- `options` (Object) — REPL configuration; required, with no default.
- `options.agent` (object) — Agent that owns conversation state and turns.
- `[options.env]` (object) — Environment supplied to the REPL; omitted by default.
- `[options.engine="alt"]` ("inline"|"alt") — Rendering mode; nullish or omitted selects `alt`.
- `options.input` (NodeJS.ReadableStream) — Required stdin-like input stream.
- `[options.write]` ((chunk: string) => void) — Terminal output sink; omitted by default.
- `[options.output]` (NodeJS.WritableStream) — Terminal output/resize source; omitted by default.
- `[options.resizeEmitter]` (NodeJS.EventEmitter) — Explicit resize source; omitted by default.
- `[options.log]` ((line: string) => void) — Diagnostics mirror; omitted by default.
- `[options.onExit]` (() => void) — Callback after terminal restoration; omitted by default.
- `[options.cwd]` (string) — Working folder used for the title; omitted by default.
- `[options.signals]` (NodeJS.EventEmitter) — Signal source; omitted by default.
- `[options.columns]` ((() => number)|number) — Viewport width override; omitted by default.
- `[options.rows]` ((() => number)|number) — Viewport height override; omitted by default.

Returns `{start: () => Promise<void>, close: () => void}` — Controller with asynchronous `start` and synchronous `close` methods.

Throws — {Error} If `engine` is neither `inline` nor `alt`; the error lists available engines.

Effects — Creates/delegates creation of an interactive terminal controller using the supplied streams and callbacks.

### `App.TUI.run(state)`

Run the complete TUI application from normalized declarative state.
Executables own argument parsing and process-exit policy; the runner
creates the environment and Agent, selects the mode, and performs cleanup.

- `[state]` (object) — Normalized application state; optional and forwarded unchanged, with no default applied here.

Returns `Promise<{code: number, agent: object, session: object|null}>` — Promise resolving to the application exit code, Agent, and session result.

Effects — Runs the application and its cleanup lifecycle through `runApplication`.

## App.Web

### `class Web`

Static Web facade: serve(state) starts a host and returns its awaited stop/done lifecycle.

### `App.Web.serve(state = {…})`

Start the initial workspace, the project registry, and every pinned project (user projects.json).
