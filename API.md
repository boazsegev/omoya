# API (2026-10-04)

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
root; other roots cannot grant themselves trust.
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
Forked sandbox workers receive the reduced data context plus explicit
JSONL request/reply bridges; host callbacks never cross that boundary.

### PUBLISHES — a worked example: the minimal wrapper shape (read-only, no ctx)

Source: `tools/read.js`

```js
/**
 * tools/read.js — the `read` tool: an independent, read-only,
 * cwd-rooted file access tool. Thin WRAPPER publishing the callable
 * implemented under tools/read/. The tool scan is NOT recursive:
 * sub-folders are never scanned. read/ owns query normalization,
 * guarded execution and serialization; write.read consumes those explicit
 * shared contracts. No helper is independently published as a tool.
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
/** Mutating writer. Optional read query uses the shared engine, never provider dispatch. */
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import { dirname, basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { toolRevision } from "../lib/tool-runtime.js";
const revision = toolRevision();
const { rejectSymlinkPath, resolveCwdPath } = await import(`./guard/resolve.js?now=${revision}`);
const { enforceContentPolicy } = await import(`./guard/paths.js?now=${revision}`);
const { executeReadQuery } = await import(`./read/engine.js?revision=${revision}`);
const { serializeReadResult } = await import(`./read/serialize.js?revision=${revision}`);
const { readQuerySchema, normalizeReadQuery } = await import(`./read/query.js?revision=${revision}`);
const { readScope } = await import(`./read/fs.js?revision=${revision}`);

function absent(value) {
  return value === undefined || value === null || value === -1 || value === 0 || typeof value === "boolean" || (Array.isArray(value) && !value.length);
}

function checkWrite(context) {
  context?.signal?.throwIfAborted();
  if (context?.deadline !== undefined && Date.now() >= context.deadline) throw new Error("write deadline exhausted");
}

async function destination(path, scope) {
  const resolved = await rejectSymlinkPath(resolveCwdPath(path, scope), { cwd: scope.boundary });
  try {
    const metadata = await lstat(resolved);
    if (!metadata.isFile()) throw new Error("write destination must be a regular file");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return resolved;
}

function sameFile(result, metadata) {
  return metadata && result.metadata.isFile() && metadata.dev === result.metadata.dev && metadata.ino === result.metadata.ino;
}

async function queryPayload(query, resolved, context) {
  const normalized = normalizeReadQuery(query);
  // Saving source data must not insert display decoration; searches retain useful locations.
  if (!normalized.search) normalized.annotate = false;
  const result = await executeReadQuery(normalized, context, { artifact: true });
  let metadata;
  try { metadata = await lstat(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (result.source === resolved || sameFile(result, metadata)) throw new Error("write.read source and destination must differ");
  const payload = serializeReadResult(result);
  if (!result.selectionComplete) throw new Error(`write.read refused incomplete output: ${result.status.join("; ")}`);
  const skipped = Object.entries(result.skips).filter(([, count]) => count).map(([name, count]) => `${count} ${name} skipped`);
  return { payload, binary: result.binary && !result.query.base64, status: [...result.status, ...skipped] };
}

async function atomicWrite(resolved, payload, context, scope) {
  checkWrite(context);
  await mkdir(dirname(resolved), { recursive: true });
  await rejectSymlinkPath(resolved, { cwd: scope.boundary });
  const temporary = join(dirname(resolved), `.${basename(resolved)}.${randomUUID()}.tmp`);
  let handle;
  let previous;
  try { previous = await lstat(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(payload);
    if (previous?.isFile()) await handle.chmod(previous.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = null;
    checkWrite(context);
    await destination(relativeDestination(resolved, scope), scope);
    await rename(temporary, resolved);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function relativeDestination(resolved, scope) {
  // resolveCwdPath requires a relative spelling; never expose the host path.
  return relative(scope.cwd, resolved) || ".";
}

/** Exactly one effective content/read; destination changes only after guarded successful serialization. */
export async function write(args = {}, context) {
  if (context?.safe === true) throw new Error("write is unavailable in safe mode");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("write arguments must be an object");
  for (const key of Object.keys(args)) if (!["path", "content", "read", "ask"].includes(key)) throw new Error(`Unknown write field: ${key}`);
  const hasContent = !absent(args.content);
  const hasRead = !absent(args.read) && args.read !== "";
  if (hasContent === hasRead) throw new TypeError("write requires exactly one effective content or read");
  if (hasContent && typeof args.content !== "string") throw new TypeError("write.content must be a string");
  if (!absent(args.ask) && typeof args.ask !== "boolean") throw new TypeError("write.ask must be a boolean");
  checkWrite(context);
  const scope = readScope(context);
  const resolved = await destination(args.path, scope);
  const data = hasRead ? await queryPayload(args.read, resolved, context) : { payload: Buffer.from(args.content), binary: false, status: [] };
  if (!data.binary) await enforceContentPolicy({ path: args.path, content: data.payload.toString("utf8"),
    ask: args.ask === true || typeof context?.question?.ask === "function", context, askable: true, cwd: scope.boundary, lax: true });
  await atomicWrite(resolved, data.payload, context, scope);
  return `Successfully wrote ${data.payload.length} bytes to ${args.path}${data.status.length ? ` (${data.status.join("; ")})` : ""}`;
}

export function toolDescription() {
  return { write: { trusted: true,
    description: "Create or overwrite a project file atomically. Supply content OR read (shared read query), never both. read saves selected text/report or raw binary without a model round-trip; incomplete/budget-failed output leaves destination unchanged.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", description: "Destination path relative to the working folder, inside the project." },
      content: { anyOf: [{ type: "string" }, { type: "null" }, { type: "boolean" }, { type: "integer", enum: [-1, 0] }, { type: "array", maxItems: 0 }], description: "Text to save, including empty string. Exactly one effective content or read; wrong-type model fillers are absent." },
      read: { anyOf: [readQuerySchema(), { type: "null" }, { type: "boolean" }, { type: "integer", enum: [-1, 0] }, { type: "array", maxItems: 0 }, { type: "string", const: "" }], description: "Shared read query. Without an effective search, annotate is forced false even if supplied true; searches honor annotate (default true). Save payload, not status/preview blocks. Binary saves bytes; base64 saves encoded text. Explicit selection limits are honored; execution-incomplete output is refused." },
      ask: { anyOf: [{ type: "boolean" }, { type: "null" }, { type: "integer", enum: [-1, 0] }, { type: "array", maxItems: 0 }], description: "Request permission when saved text references an existing path outside the project. Wrong-type model fillers are absent." },
    } },
  } };
}
```

### PUBLISHES — Agent's current filtered model-facing descriptors

Source: `lib/agent.js`

get tools(): Current model-facing tools: `const tools = await agent.tools`;
`tools.get(name)` returns a provider-neutral descriptor with its schema.
Uses IO's publication filter: dynamic availability, effective safety,
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
    right after the tool result and `display` is retained on it for
    context viewers (handled by the caller, not here).
Throwing fails the call: the error message becomes the tool-result
error content (error: true on the result message).

async executeToolCall(agent, call, { notify = false } = {…}): Execute one tool call. NEVER throws — failures become tool-result
error messages for the model.

Returns { message, system, display }: the tool result, plus any
SYSTEM PAYLOAD and any DISPLAY PAYLOAD the tool attached. A tool
returning a plain object with a `system` and/or `display` key
answers briefly via `result` (any normal return shape) while
`system` (a string or string[]) appends as System messages right
after the tool result, and `display` (a string or string[]) is
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
      "description": "The bash command line to run (no cd or ln; every visible path argument must stay inside the working folder)"
    },
    "timeout": {
      "type": "integer",
      "description": "Requested milliseconds timeout (default: 120000; capped at 1200000)"
    },
    "env": {
      "type": "object",
      "description": "Extra environment variables for the command."
    }
  },
  "required": [
    "command"
  ]
}
```

### `edit`

Replace exact text in one file. Read the file first, then send oldText/newText pairs from its current content. Merge nearby or overlapping changes into one edit. Set matchAll: true to replace every occurrence of each oldText. To reverse an edit, pass the edit id returned after it as rollback.

Source: `tools/edit.js`; flags: trusted

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to edit (relative to the working folder)"
    },
    "edits": {
      "type": "array",
      "description": "The replacements to make. Match each oldText against the file as it is now, not against earlier edits in the same call. Never send overlapping or nested edits; merge them into one edit.",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "description": "The exact text to replace. Make it unique in the file and never overlap another edit’s oldText."
          },
          "newText": {
            "type": "string",
            "description": "The replacement text."
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
      "description": "Ask the user for permission, showing the offending lines, when a newText names a path outside the working folder. Omit it to refuse such edits outright."
    },
    "matchAll": {
      "type": "boolean",
      "description": "Replace every occurrence of each oldText. Omit it to require a unique match."
    },
    "rollback": {
      "type": "string",
      "description": "Reverse a recent edit by passing the edit id returned after it succeeded. Pass the same path the edit targeted. The file must still hold the replacement text at the edited positions; if it does not, read the file and make a new targeted edit instead."
    }
  },
  "anyOf": [
    {
      "required": [
        "path",
        "edits"
      ]
    },
    {
      "required": [
        "path",
        "rollback"
      ]
    }
  ]
}
```

### `job-schedule`

List, read, create, replace, or remove scheduled Markdown tasks in an operational project. Pause with enabled: false. New/changed tasks wait for a later scan; removal never cancels running work. Task-local schedules determine admission; the optional daemon is not required. Cannot initialize, enable, disable, repair, run, control a daemon, or access secrets. Unavailable to read-only Agents.

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
      "description": "Task operation. update replaces complete Markdown; remove leaves history and running work intact."
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
      "description": "Task schedule. Omitted on update to preserve it. Use once, every <duration>, or one structured at/every schedule with optional days.",
      "oneOf": [
        {
          "type": "string",
          "pattern": "^(once|every [1-9][0-9]*[mhdw])$"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "at": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "string",
                "pattern": "^(?:[01][0-9]|2[0-3]):[0-5][0-9](?: GMT)?$"
              }
            },
            "every": {
              "type": "string",
              "pattern": "^[1-9][0-9]*[mhdw]$"
            },
            "days": {
              "oneOf": [
                {
                  "type": "string",
                  "enum": [
                    "weekdays",
                    "weekends"
                  ]
                },
                {
                  "type": "array",
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
              ]
            }
          },
          "oneOf": [
            {
              "required": [
                "at"
              ]
            },
            {
              "required": [
                "every"
              ]
            }
          ]
        }
      ]
    }
  }
}
```

### `note`

Manage scratchpad notes (short-term memory). Actions: `set` creates or updates notes ({notes: {title: patch}} — missing notes are created; set a patch to null to delete its note), `get` reads notes ({notes: [title, ...]}; use ["*"] for every note and `only` to return specific fields), `list` shows open notes (done notes are omitted), `remove` deletes notes ({notes: [title, ...]}; ["*"] deletes all), `search` regex-searches titles and fields (case-insensitive; use `field` to search one field and `max` to cap matches). Pass `notes` as an array of titles for get/remove or as a title → patch map for set. Note fields are free JSON — content/summary/type are the convention; add any other fields you need.

Source: `tools/note.js`; flags: safe

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "set",
        "get",
        "list",
        "remove",
        "search"
      ],
      "description": "The operation to perform."
    },
    "notes": {
      "type": [
        "array",
        "object"
      ],
      "description": "set: a map of title → patch object. get/remove: an array of titles ([\"*\"] = every note).",
      "items": {
        "type": "string",
        "description": "A note title; applies when `notes` is an array."
      },
      "additionalProperties": {
        "description": "Patch for the note whose title is this key: fields you set are merged in (nested objects merge field-by-field, arrays and scalars replace), a null field deletes that field, and a null patch deletes the whole note.",
        "type": [
          "object",
          "null"
        ],
        "properties": {
          "content": {
            "type": [
              "string",
              "null"
            ],
            "description": "The full note body."
          },
          "summary": {
            "type": [
              "string",
              "null"
            ],
            "description": "A one-line gist of the note."
          },
          "type": {
            "type": [
              "string",
              "null"
            ],
            "description": "todo / active / done / info — pick the one that fits."
          }
        },
        "additionalProperties": true
      }
    },
    "only": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "get: return only these fields (default: every field)."
    },
    "pattern": {
      "type": "string",
      "description": "search: a regular expression (case-insensitive)."
    },
    "field": {
      "type": "string",
      "description": "search: limit the search to one field (default: the title and all fields)."
    },
    "max": {
      "type": "number",
      "description": "search: maximum matches to return (default 20, cap 50)."
    }
  },
  "required": [
    "action"
  ]
}
```

### `question`

Ask structured user questions with selectable options and custom answers.

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
                  "description": "Optional focused preview: a plain string, or typed text/code with optional title and language.",
                  "oneOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "text",
                            "code"
                          ]
                        },
                        "content": {
                          "type": "string"
                        },
                        "language": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "type",
                        "content"
                      ]
                    }
                  ]
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

Read files (cat/head/tail), list/filter folders (ls/find), or search literal text OR regex with context. Ignore rules are opt-in; direct files always bypass them. Negative range indexes count from end. Bounded execution reports skips/incompleteness separately.

Source: `tools/read.js`; flags: safe

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path"
  ],
  "description": "Read query. Null/empty/wrong-type scalar fillers are absent; meaningful booleans, zero offsets/limits and negative range indexes are preserved. Unknown fields fail.",
  "properties": {
    "path": {
      "type": "string",
      "maxLength": 4096,
      "description": "Relative file/folder path within the project. Empty string means current folder. Explicit files bypass ignore rules."
    },
    "recursive": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Descend into subfolders for listings/searches. Default false; valid true/false are preserved."
    },
    "ignore": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Opt into .gitignore then .ignore and system-file exclusions; never disables security guards. Git exclusion is not a relevance verdict. Default false; valid true/false are preserved."
    },
    "glob": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 4096
            },
            {
              "type": "array",
              "maxItems": 128,
              "items": {
                "type": "string",
                "maxLength": 4096
              }
            }
          ]
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Include filenames/relative paths matching any glob, e.g. *.md or src/**/*.js. Slashless patterns match basenames. Filters files, not traversal directories."
    },
    "exclude": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 4096
            },
            {
              "type": "array",
              "maxItems": 128,
              "items": {
                "type": "string",
                "maxLength": 4096
              }
            }
          ]
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Exclude matching paths/subtrees; exclusions win over glob. Supports *, ?, ** and {a,b}."
    },
    "lines": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "from": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "First line; negative indexes count from end (-1 is last)."
            },
            "to": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Last line, inclusive; negative indexes count from end."
            },
            "last": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Select last N lines (tail); excludes from/to. Zero selects nothing."
            }
          }
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "File lines: positive indexes are 1-based inclusive; zero is absent. Negative indexes count from end. Applies before characters/search."
    },
    "characters": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "from": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "First character; negative indexes count from end (-1 is last)."
            },
            "to": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Last character offset, exclusive; negative indexes count from end."
            }
          }
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Unicode code-point slice within selected lines: 0-based, exclusive to. Zero is meaningful."
    },
    "bytes": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "from": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "First byte; negative indexes count from end (-1 is last)."
            },
            "to": {
              "anyOf": [
                {
                  "type": "integer"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Last byte offset, exclusive; negative indexes count from end."
            }
          }
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Positioned byte slice with binary:true: 0-based, exclusive to. Zero is meaningful."
    },
    "search": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "text": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 4096
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Literal substring, ORed with regex if both supplied. Empty is absent."
            },
            "regex": {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 4096
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "JavaScript global multiline regular expression; isolated execution has a hard time budget."
            },
            "ignoreCase": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Case-insensitive literal and regex matching. Default false; valid true/false are preserved."
            },
            "invert": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Select lines matched by neither condition. Default false; valid true/false are preserved."
            },
            "before": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1000
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Context lines before selected lines, 0–1000; overlapping context merges."
            },
            "after": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 1000
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Context lines after selected lines, 0–1000; overlapping context merges."
            }
          }
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Search selected text or raw bytes (binary:true); OR conditions select unique source lines. No effective expression means no search."
    },
    "limit": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Maximum listing entries/selected search lines (matching paths in info), default 100. Context is additional but budgeted. Zero intentionally selects nothing; -1 is absent."
    },
    "offset": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Skip listing entries/selected search lines (matching paths in info), default 0. Zero is meaningful; -1 is absent."
    },
    "info": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Return contextual metadata/counts: file totals, listing counts, or matching paths and per-file selected-line counts. Scans are bounded; incomplete counts are labeled. Default false; valid true/false are preserved."
    },
    "annotate": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Decorate payload with MIME/ranges/locations/sizes. False returns plain selected text or newline-separated paths. Execution status stays separate. Default true; valid true/false are preserved."
    },
    "binary": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Select raw bytes using bytes; without search return binary content, with search return a text report. Default false; valid true/false are preserved."
    },
    "base64": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "integer",
          "enum": [
            0,
            -1
          ]
        }
      ],
      "description": "Encode selected payload as base64 text, including when saved by write.read. Excludes info. Default false; valid true/false are preserved."
    }
  }
}
```

### `skill`

List skills or atomically activate named skills. Already active skills succeed without reloading; disk edits apply next session.

Source: `tools/skill.js`; flags: safe

```json
{
  "type": "object",
  "properties": {
    "names": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ],
      "description": "One skill name or an array; trim surrounding whitespace, preserve internal spaces, deduplicate. Omit/empty lists the catalog."
    }
  }
}
```

### `skill-resource`

List available skill resources when only name is given; supply path to read a resource (last matching layer wins), or target to save its exact bytes to a new project file. No activation/execution. Safe mode refuses saving.

Source: `tools/skill-resource.js`; flags: safe, trusted

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Skill name; surrounding whitespace is trimmed."
    },
    "path": {
      "type": "string",
      "description": "Optional skill-relative forward-slash filename, such as examples/build.js. Omit to list available resource identifiers. Unlisted resources can still be read. No traversal or symlinks."
    },
    "target": {
      "type": "string",
      "description": "Optional project filename/path to save exact bytes (up to 16 MiB); creates parents, refuses existing files. Omit to read UTF-8 text up to 128 KiB."
    }
  },
  "required": [
    "name"
  ]
}
```

### `web-fetch`

Fetch one HTTP(S) URL as bounded Markdown, text, or JSON text.

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

Search the internet and return bounded Markdown results.

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
      "description": "Result count; default/max 40, zero means 40, negatives use absolute value"
    }
  },
  "required": [
    "query"
  ]
}
```

### `worker-close`

Close named workers, /regex/ matches, or all with ["*"]. Busy workers receive /handoff first and finish queued work before closing.

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

Create named workers and send the same self-contained first prompt to each. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive automatically as attributed messages; finish your turn rather than waiting.

Source: `tools/worker-create.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "prompt",
    "workers"
  ],
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "Self-contained first prompt sent unchanged to each worker."
    },
    "workers": {
      "type": "array",
      "minItems": 1,
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
            "description": "Unique worker name."
          },
          "model": {
            "type": "string",
            "description": "Endpoint/model; omit to use your model."
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
            "description": "Thinking level; omit for model default."
          },
          "description": {
            "type": "string",
            "description": "Worker's role description."
          },
          "safe": {
            "type": "boolean",
            "description": "Restrict worker to read-only tools."
          }
        }
      }
    }
  }
}
```

### `worker-message`

Send one prompt to named workers, /regex/ matches, or all with ["*"]. Replies arrive automatically as attributed messages; finish your turn rather than waiting.

Source: `tools/worker-message.js`; flags: trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "workers",
    "prompt"
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
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "Message sent unchanged to every selected worker; /handoff requests a handoff."
    }
  }
}
```

### `worker-status`

Show workers grouped by busy/idle and available models. Omit flags for both; request a specific section with workers or models.

Source: `tools/worker-status.js`; flags: safe, trusted

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workers": {
      "type": "boolean",
      "description": "Include workers and their models, grouped by busy/idle."
    },
    "models": {
      "type": "boolean",
      "description": "Include models and available capacity for new work."
    }
  }
}
```

### `write`

Create or overwrite a project file atomically. Supply content OR read (shared read query), never both. read saves selected text/report or raw binary without a model round-trip; incomplete/budget-failed output leaves destination unchanged.

Source: `tools/write.js`; flags: trusted

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
      "description": "Destination path relative to the working folder, inside the project."
    },
    "content": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "integer",
          "enum": [
            -1,
            0
          ]
        },
        {
          "type": "array",
          "maxItems": 0
        }
      ],
      "description": "Text to save, including empty string. Exactly one effective content or read; wrong-type model fillers are absent."
    },
    "read": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "path"
          ],
          "description": "Read query. Null/empty/wrong-type scalar fillers are absent; meaningful booleans, zero offsets/limits and negative range indexes are preserved. Unknown fields fail.",
          "properties": {
            "path": {
              "type": "string",
              "maxLength": 4096,
              "description": "Relative file/folder path within the project. Empty string means current folder. Explicit files bypass ignore rules."
            },
            "recursive": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Descend into subfolders for listings/searches. Default false; valid true/false are preserved."
            },
            "ignore": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Opt into .gitignore then .ignore and system-file exclusions; never disables security guards. Git exclusion is not a relevance verdict. Default false; valid true/false are preserved."
            },
            "glob": {
              "anyOf": [
                {
                  "anyOf": [
                    {
                      "type": "string",
                      "maxLength": 4096
                    },
                    {
                      "type": "array",
                      "maxItems": 128,
                      "items": {
                        "type": "string",
                        "maxLength": 4096
                      }
                    }
                  ]
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Include filenames/relative paths matching any glob, e.g. *.md or src/**/*.js. Slashless patterns match basenames. Filters files, not traversal directories."
            },
            "exclude": {
              "anyOf": [
                {
                  "anyOf": [
                    {
                      "type": "string",
                      "maxLength": 4096
                    },
                    {
                      "type": "array",
                      "maxItems": 128,
                      "items": {
                        "type": "string",
                        "maxLength": 4096
                      }
                    }
                  ]
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Exclude matching paths/subtrees; exclusions win over glob. Supports *, ?, ** and {a,b}."
            },
            "lines": {
              "anyOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "from": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "First line; negative indexes count from end (-1 is last)."
                    },
                    "to": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Last line, inclusive; negative indexes count from end."
                    },
                    "last": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Select last N lines (tail); excludes from/to. Zero selects nothing."
                    }
                  }
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "File lines: positive indexes are 1-based inclusive; zero is absent. Negative indexes count from end. Applies before characters/search."
            },
            "characters": {
              "anyOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "from": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "First character; negative indexes count from end (-1 is last)."
                    },
                    "to": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Last character offset, exclusive; negative indexes count from end."
                    }
                  }
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Unicode code-point slice within selected lines: 0-based, exclusive to. Zero is meaningful."
            },
            "bytes": {
              "anyOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "from": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "First byte; negative indexes count from end (-1 is last)."
                    },
                    "to": {
                      "anyOf": [
                        {
                          "type": "integer"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Last byte offset, exclusive; negative indexes count from end."
                    }
                  }
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Positioned byte slice with binary:true: 0-based, exclusive to. Zero is meaningful."
            },
            "search": {
              "anyOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "text": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 4096
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Literal substring, ORed with regex if both supplied. Empty is absent."
                    },
                    "regex": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 4096
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "JavaScript global multiline regular expression; isolated execution has a hard time budget."
                    },
                    "ignoreCase": {
                      "anyOf": [
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Case-insensitive literal and regex matching. Default false; valid true/false are preserved."
                    },
                    "invert": {
                      "anyOf": [
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Select lines matched by neither condition. Default false; valid true/false are preserved."
                    },
                    "before": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 1000
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Context lines before selected lines, 0–1000; overlapping context merges."
                    },
                    "after": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 1000
                        },
                        {
                          "type": "null"
                        },
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "const": ""
                        },
                        {
                          "type": "array",
                          "maxItems": 0
                        },
                        {
                          "type": "integer",
                          "enum": [
                            0,
                            -1
                          ]
                        }
                      ],
                      "description": "Context lines after selected lines, 0–1000; overlapping context merges."
                    }
                  }
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Search selected text or raw bytes (binary:true); OR conditions select unique source lines. No effective expression means no search."
            },
            "limit": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Maximum listing entries/selected search lines (matching paths in info), default 100. Context is additional but budgeted. Zero intentionally selects nothing; -1 is absent."
            },
            "offset": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Skip listing entries/selected search lines (matching paths in info), default 0. Zero is meaningful; -1 is absent."
            },
            "info": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Return contextual metadata/counts: file totals, listing counts, or matching paths and per-file selected-line counts. Scans are bounded; incomplete counts are labeled. Default false; valid true/false are preserved."
            },
            "annotate": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Decorate payload with MIME/ranges/locations/sizes. False returns plain selected text or newline-separated paths. Execution status stays separate. Default true; valid true/false are preserved."
            },
            "binary": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Select raw bytes using bytes; without search return binary content, with search return a text report. Default false; valid true/false are preserved."
            },
            "base64": {
              "anyOf": [
                {
                  "type": "boolean"
                },
                {
                  "type": "null"
                },
                {
                  "type": "boolean"
                },
                {
                  "type": "string",
                  "const": ""
                },
                {
                  "type": "array",
                  "maxItems": 0
                },
                {
                  "type": "integer",
                  "enum": [
                    0,
                    -1
                  ]
                }
              ],
              "description": "Encode selected payload as base64 text, including when saved by write.read. Excludes info. Default false; valid true/false are preserved."
            }
          }
        },
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "integer",
          "enum": [
            -1,
            0
          ]
        },
        {
          "type": "array",
          "maxItems": 0
        },
        {
          "type": "string",
          "const": ""
        }
      ],
      "description": "Shared read query. Without an effective search, annotate is forced false even if supplied true; searches honor annotate (default true). Save payload, not status/preview blocks. Binary saves bytes; base64 saves encoded text. Explicit selection limits are honored; execution-incomplete output is refused."
    },
    "ask": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "integer",
          "enum": [
            -1,
            0
          ]
        },
        {
          "type": "array",
          "maxItems": 0
        }
      ],
      "description": "Request permission when saved text references an existing path outside the project. Wrong-type model fillers are absent."
    }
  }
}
```
## Agent

### `class Agent`

The agent: the ordered context, the provider/model selection, the
tool loop, the pending queue and the session persistence, behind one
headless object.

### `Agent.get busy()`

Whether an agent run is currently in progress. @returns {boolean}

### `Agent.cancel()`

Cancel active IO and every pending tool dispatch; queued calls never start.
Dispatch owns sandbox teardown. Resolves after active dispatch resources
are released; repeated cancellation is safe and needs no escalation.

### `Agent.childCreate(options = {…})`

Construct one direct child through the environment factory. The parent
relationship is authoritative for ownership and delegation denial.

- `[options]` (object)

Returns `Agent`

### `Agent.get children()`

Snapshot of directly owned workers.

### `Agent.close()`

Refuse new messages immediately; finish the current turn before releasing
resources, or release them now when idle. This does not interrupt IO or
tools; call cancel() first to interrupt. CLOSE_MARKED precedes CLOSED;
repeated calls are no-ops. Listener exceptions cannot prevent cleanup;
CLOSED follows deregistration and context release. Cleanup failures are
aggregated after all releases have been attempted.

Returns `boolean` — true only when this call marks the agent

### `Agent.get closed()`

Whether close cleanup has completed.

### `Agent.get closeMarked()`

Whether close has been requested, including while a turn finishes.

### `Agent.compact(focus = "")`

Compact: ask the model to summarize the conversation
(a structured, self-contained prompt), then replace the context
with the surviving SYSTEM messages plus one ASSISTANT message
holding the marked summary (lib/agent/compact.js). Compact is an
ordinary turn observed through Agent events; a no-op (context
untouched) when the model's turn returns no usable summary text.

- `[focus]` (string) — optional user guidance appended to the summary prompt

Returns `Promise<{ok: boolean, before: number, summaryText?: string}>`

### `Agent.constructor({ env, model, url, timeout, settings, context, tools, parent, name, description, contextId, contextSave = true, createIO, toolCall, safe, spawnPermission, question, ...options } = {…})`

Build an agent over an environment; wires the session store (a
named file session, a resumed one, an injected store, or none) and
takes ownership of the seed context — a NEW (non-resumed) context
starts with the seeded system prompt as its FIRST message(s).

- `[options]` (Object)
- `[options.env]` (Env) — the sole registry surface
- `[options.model]` (string) — default `<endpoint>/<model>` selector (per-request override via run options)
- `[options.url]` (string)
- `[options.timeout]` (number|string) — overall provider-request timeout
- `[options.settings]` (object) — per-invocation provider overrides
- `[options.context]` (Array|Context) — seed messages (deep-copied into the owned Context), or a ready Context used as is (then no `session`) (the seeded system prompt lands AHEAD of it)
- `[options.tools]` (string[]) — availability selection (omitted/["*"]=all, []=none)
- `[options.parent]` (Agent) — creating Agent, or unset for non-Agents
- `[options.name]` (string) — display name (default: `agent-<counter>`)
- `[options.description]` (string) — display description (empty allowed)
- `[options.spawnPermission]` (*) — generic permission for delegation tools to create another Agent: false denies, true allows, and any other value asks through the tool's own user-interaction policy
- `[options.safe]` (boolean) — SAFE MODE: publish and execute ONLY read-only tools (schemas with `safe: true`) — exploration and planning without mutation. Unsafe calls are refused with a tool-result error, never executed (defense in depth: the filtered catalog alone is not the enforcement). FORCED on when no supported OS sandbox is available (Sandbox.osAvailable()) — there is no opt-out: mutation tools run only under an active OS sandbox
- `[options.contextId]` (string|false) — names the context: an existing id (in env.settings.sessions) is resumed; an absent id creates it. `false` (or omitted, or an anonymous spelling "0"/"false"/"anon") gives a memory-only context that is not logged — (agent.context.save = true) starts logging it at any time.
- `[options.contextSave=true]` (boolean) — whether a context named by `contextId` is logged to disk
- `[options.createIO]` ((opts:object)=>object) — IO factory (tests inject fakes)

### `Agent.context`

This Agent's owned conversation store.

Returns `Context` — This Agent's owned conversation store.

### `Agent.Context`

Public Context namespace member; see its owning module for the contract.

### `Agent.contextFork(id)`

Fork the context into a NEW context id: the conversation continues
in a fresh Context (flushed immediately when logged); the old file
stays behind as a snapshot. The fork keeps the logging setting; an
anonymous spelling (false/"0"/"false"/"anon") forks into one that is
not logged.

- `[id]` (string|false)

Returns `{id: string, file: string, save: boolean}`

### `Agent.contextNew(id)`

Start a NEW, EMPTY context (re-seeded with the system prompt): the
old one is closed (its flushed content stays on disk — contextFork()
first to keep a snapshot). With no id a random UUID is chosen. The
new context keeps the logging setting (one not logged stays not
logged); an anonymous spelling (false/"0"/"false"/"anon") always
starts one that is not logged.

- `[id]` (string|false)

Returns `{id: string, file: string, save: boolean}`

### `Agent.contextResume(id)`

Resume a LOGGED context by id (from env.settings.sessions): it replaces the
current one, which is closed (its flushed content stays on disk); its
recorded settings and origin folder apply (lib/agent/context-lifecycle.js).

- `id` (string) — context id (Context.latest finds the newest)

Returns `{id: string, file: string, cwd: string|undefined, originMissing: boolean}`

### `Agent.get contextUsage()`

The context-window readout for the status surface (most exact
first: the provider's own report, the last provider-reported
envelope, the word-count estimate marked `approximate`).

Returns `{used: number, total: number|null, approximate: boolean}`

### `Agent.get description()`

Human-friendly Agent description; an empty string is valid.

### `Agent.set description(value)`

Describe the agent (recorded into a logged context's settings).

- `value` (string)

Returns `void` — Assignment records the new description.

### `Agent.env`

The shared live environment owned by the host.

Returns `Env` — The shared live environment owned by the host.

### `Agent.Env`

Public Env namespace member; see its owning module for the contract.

### `Agent.EVENT`

The numeric event vocabulary for Agent.onEvent — events about THIS
agent only (Env reports membership: AGENT_ADDED/AGENT_REMOVED):
REQUEST_START, TEXT_START, TEXT_DELTA, TEXT_END, THINKING_START,
THINKING_DELTA, THINKING_END, TOOL_CALL_START, TOOL_CALL_DELTA,
TOOL_CALL_END, REQUEST_DONE, REQUEST_ERROR,
MESSAGE_COMMITTED, LOG, TOOL_EXECUTE, TOOL_DATA, TOOL_RESULT,
CLOSE_MARKED, CLOSED, SENT_MESSAGE — see Agent.onEvent's
documentation for each value's meaning and payload.

### `Agent.EVENT_CALLBACKS`

The [responseCallbackName, Agent.EVENT] pairs: every EVENT value's
corresponding option-callback name ("onTextDelta" for
Agent.EVENT.TEXT_DELTA, …), for hosts that prefer per-event
callbacks over one onEvent listener.

### `Agent.finishAdd(fn, { process: proc = process } = {…})`

Register `fn` for synchronous execution on the configured process's `exit` event.

- `fn` (() => void) — Cleanup callback; must be synchronous and may run more than once.
- `[options]` (Object) — Registration options.
- `[options.process=process]` (NodeJS.Process) — Process to attach the exit hook to.

Returns `() => void` — Idempotent function that unregisters `fn` from the shared cleanup set.

### `Agent.finishRun()`

Invoke a snapshot of all registered cleanups synchronously; swallow callback errors.

Returns `void`

### `Agent.finishSignalsArm({ process: proc = process, signals = ["SIGINT", "SIGTERM", "SIGHUP"], } = {…})`

Attach handlers that run cleanups and re-raise a termination signal after removing those handlers.
If already armed, returns the existing disarm function without applying new options.

- `[options]` (Object) — Signal-arming options.
- `[options.process=process]` (NodeJS.Process) — Process on which to install handlers and call `kill`.
- `[options.signals=["SIGINT", "SIGTERM", "SIGHUP"]` (string[]) — ] Signals to handle.

Returns `() => void` — Idempotent function that removes these signal handlers and clears the armed state.

### `Agent.set folder(folder)`

Narrow this agent's tool working folder to an existing folder inside
its environment project. `undefined` restores the environment root.

- `folder` (string|undefined|null) — absolute or env.cwd-relative

Returns `void` — Read folder afterwards for the resolved root.

### `Agent.get folder()`

The agent-local root used for file tools and their OS sandbox.

### `Agent.IO`

Public IO namespace member; see its owning module for the contract.

### `Agent.get ioState()`

The connection/work state for the TUI's status indicator:
"working" (a run is in flight), "disconnected" (the last turn
failed connection-class), "idle" (otherwise).

Returns `"idle"|"working"|"disconnected"`

### `Agent.set model(selector)`

Select an exact, configured endpoint/model pair for subsequent turns.
Validation happens before the live model changes, so a failed attempt
leaves the current selection intact.

- `selector` (string|undefined) — `<endpoint>/<model>`; undefined clears the selection

Returns `void` — Assign the selector; read model for the current value.

### `Agent.get model()`

The current qualified model selector. Assign to validate and record a whole model-state change; an active request finishes on its already-open IO.

Returns `string|undefined` — The current qualified model selector. Assign to validate and record a whole model-state change; an active request finishes on its already-open IO.

### `Agent.get name()`

Human-friendly Agent name.

### `Agent.set name(value)`

Rename the agent (recorded into a logged context's settings).

- `value` (string)

Returns `void` — Assignment records the new name; read name for the current value.

### `Agent.NAMES`

Public NAMES namespace member; see its owning module for the contract.

### `Agent.offEvent(handle)`

Remove one registration; returns false when it is absent.

### `Agent.onEvent(event, callback)`

Register a synchronous listener for one numeric Agent.EVENT value.
Response payloads deliberately omit IO's string `type`. Indexed
payloads carry `contentIndex` plus `content`, the assembled block
after that IO event was consumed. End-event `text`, when present,
is the provider-normalized authoritative full block snapshot.
MESSAGE_COMMITTED receives the stored message after persistence.
SENT_MESSAGE receives a queued user message as it enters context.
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
- `Agent.EVENT.SENT_MESSAGE` — a queued user message entered context
- `Agent.EVENT.THROTTLED` — a delayed continuation was scheduled; {until} is epoch ms

- `event` (number) — one Agent.EVENT constant (see the list above)
- `callback` ((payload: object) => void)

Returns `number` — opaque random registration handle (offEvent removes it)

### `Agent.get parent()`

The creating Agent, or undefined when none was supplied.

### `Agent.pathInfo(path, options = {…})`

Inspect a path using the Agent's file-security boundary.

- `path` (string)

Returns `Promise<{path:string,isFolder:boolean,mimetype?:string}>`

### `Agent.get pending()`

Unsent messages queued while busy (array copy; message objects are shared).
 An error leaves them pending until a later run or pendingPop().

### `Agent.pendingPop()`

Remove ALL unsent pending messages, returning them (the TUI's Option+↑
recall: the queued messages go back into the input area, merged,
for editing).

Returns `Array` — the drained messages

### `Agent.get planUsage()`

The provider-reported PLAN/QUOTA readout of the current endpoint
(`{label?, quotas}`; in-memory, last-known). null until a request
reports one.

Returns `{label?: string, quotas: Object}|null`

### `Agent.get policy()`

The settings this Agent runs by, resolved from env.settings when it
was created, re-resolved only when it selects another model
(lib/agent/policy.js): context {cap, turn, autocompact} (the runaway
guard and the auto-compaction threshold; global, then endpoint, then
model overrides), retry {attempts, base, max},
tools {timeout, timeoutLimit, concurrency}.

Returns `Readonly<object>`

### `Agent.promptCatalog(prompts, options)`

The `# Prompt Catalog` text of env.prompts().

- `prompts` (Map<string, object>)

Returns `string`

### `Agent.set question(callbacks)`

Set (or replace) the QUESTION BRIDGE at runtime — the binding's
rendering engine wires it once its overlays exist (the TUI hands
its questionnaire overlay to the Agent after construction; see
the constructor's `question` option for the contract). Applies to
the next tool call.

Returns `void`

### `Agent.get question()`

The live question bridge; a trusted host capability, never provider data.

Returns `object|null` — The live question bridge; a trusted host capability, never provider data.

### `Agent.questionInstall(bridge)`

Install a question bridge and return an idempotent disposer that restores the previous bridge only while this installation still owns it. @param {object} bridge Question callbacks. @returns {() => void} Restore this installation.

### `Agent.questionTimeoutReset()`

Renew the active tool's inactivity deadline; no-op outside a tool call. @returns {void}

### `Agent.reseat(agent, { id } = {…})`

Build the FRESH Agent that replaces `agent` for a new session.

- `agent` (object) — the agent being replaced (the TUI's viewed one)
- `[options={}]` (Object) — session creation options
- `[options.id]` (string|false) — the new session id; an anonymous spelling (false/"0"/"false"/"anon") disables logging, and otherwise the fresh session keeps the old one's logging setting

Returns `object` — the fresh Agent, seated in the old one's group

### `Agent.run(options = {…})`

Run the tool loop until done/error (lib/agent/run.js).

- `[options]` (Object)
- `[options.timeout]` (number|string) — per-request provider-request timeout
- `[options.after]` (number) — non-negative delay in ms before running; an immediate run cancels a pending delayed continuation
- `[options.contextGuard]` (boolean) — false only for internal compaction, which must run above the normal 90% ceiling

Returns `Promise<object|null>` — terminal done/error, or null if a delayed run is superseded

### `Agent.get safe()`

safe mode: only read-only (`safe`) tools publish and execute

Returns `boolean` — safe mode: only read-only (`safe`) tools publish and execute

### `Agent.set safe(value)`

Switch safe mode at runtime (the /safe command, the ^X menu).
Applies from the NEXT request: idle cached provider connections
are dropped (their tool selection was fixed at construction); an
in-flight request finishes with the old catalog.

- `value` (boolean)

Returns `void` — Read safe afterwards for the effective, possibly enforced mode.

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

- `message` (object)

Returns `Promise<object>` — the active run's terminal done/error event. Awaiting a busy send waits for that run, not a distinct reply to this message; on failure the queued message remains pending for a later run.

### `Agent.sendFile(fileName)`

Read an existing file as a binary user message and deliver it.
The path is resolved inside the Agent folder; missing files, folders,
and paths outside that folder fail before any message is queued.

- `fileName` (string) — Agent-folder-relative file path

Returns `Promise<object>` — the run's terminal done/error event

### `Agent.settings`

Live invocation-only provider settings overrides.

Returns `object|undefined` — Live invocation-only provider settings overrides.

### `Agent.skillCatalog(skills, options)`

The `# Skill Catalog` text of env.skills() (the skill tool's answer,
the skills CLI).

- `skills` (Map<string, object>)

Returns `string`

### `Agent.skillSection(skill)`

One skill's full content as the model reads it:
`<skill name="...">\n<body>\n</skill>`.

Returns `string`

### `Agent.get spawnPermission()`

Generic delegation permission. A child Agent may never delegate further,
regardless of its stored host/user policy. Tools decide how to ask when
an independent Agent's permission is unset; Agent performs no spawning.

Returns `*`

### `Agent.set spawnPermission(value)`

Set generic delegation permission; non-booleans restore tool-owned asking.

- `value` (*) — Permission value

Returns `void` — Read spawnPermission afterwards for the effective permission.

### `Agent.get thinking()`

the current thinking level (undefined = provider default)

Returns `string|undefined` — the current thinking level (undefined = provider default)

### `Agent.set thinking(level)`

Set the thinking level for subsequent requests (THINKING_LEVELS;
each provider translates it to the nearest symbol the model accepts).
Applies to already-open provider connections too.

- `[level]` (string) — none/low/medium/high/xhigh/max (undefined: the model's default)

### `Agent.get throttledUntil()`

Epoch-ms deadline of a pending continuation, or null.

### `Agent.timeout`

Invocation-only request timeout.

Returns `number|string|undefined` — Invocation-only request timeout.

### `Agent.TOOL_TIMEOUT_DEFAULT`

Default Agent-enforced cap for one tool call, in milliseconds (two minutes).

### `Agent.toolMessages()`

tools with a live sticky message

Returns `Array<{name: string, text: string}>` — tools with a live sticky message

### `Agent.toolMessagesDetect()`

Re-detect tool-provided display information from the current context.

Returns `Promise<Array<{name: string, text: string}>>` — the messages after detection

### `Agent.toolMessageSet(name, text)`

Set (or clear) a tool's sticky MESSAGE on THIS agent — a compact
live text the TUI renders above the input area (collected from
the VIEWED agent; lib/agent/tool-messages.js).

- `name` (string) — the tool's display name
- `[text]` (string|null) — the message; null/undefined/"" clears

Returns `string|null` — the tool's current message

### `Agent.get tools()`

Current model-facing tools: `const tools = await agent.tools`;
`tools.get(name)` returns a provider-neutral descriptor with its schema.
Uses IO's publication filter: dynamic availability, effective safety,
configured selection, hidden-tool exclusion and the model's provider tools.
Provider dialect conversion remains IO/provider-owned; this is the current
catalog, not a capture of an earlier request's wire payload.

Returns `Promise<Map<string, object>>` — Fresh map/descriptors, no callables or execution metadata. Nested schemas are shared registry data.

### `Agent.toolStorage(toolname)`

Return this agent's mutable, transient storage object for one tool.

- `toolname` (string)

Returns `object`

### `Agent.toolStorageClear(toolname)`

Clear one tool's transient storage, or every tool store when omitted.

- `[toolname]` (string)

Returns `void`

### `Agent.url`

Invocation-only provider URL override.

Returns `string|undefined` — Invocation-only provider URL override.

### `Agent.get usage()`

Cumulative usage across every request THIS Agent has made — every
IO terminal event's usage envelope, summed in memory. Never
persisted: a fresh Agent starts at zero.

Returns `{inputTokens: number, outputTokens: number, cost: number}`

### `Agent.EVENT_CALLBACKS = Object.freeze([…]`

IO callback property paired directly with its numeric Agent event.

### `Agent.TOOL_TIMEOUT_DEFAULT = 120_000`

Default Agent-enforced cap for one tool call, in milliseconds (two minutes).

### `Agent.finishAdd(fn, { process: proc = process } = {…})`

Register `fn` for synchronous execution on the configured process's `exit` event.

- `fn` (() => void) — Cleanup callback; must be synchronous and may run more than once.
- `[options]` (Object) — Registration options.
- `[options.process=process]` (NodeJS.Process) — Process to attach the exit hook to.

Returns `() => void` — Idempotent function that unregisters `fn` from the shared cleanup set.

### `Agent.finishRun()`

Invoke a snapshot of all registered cleanups synchronously; swallow callback errors.

Returns `void`

### `Agent.finishSignalsArm({ process: proc = process, signals = ["SIGINT", "SIGTERM", "SIGHUP"], } = {…})`

Attach handlers that run cleanups and re-raise a termination signal after removing those handlers.
If already armed, returns the existing disarm function without applying new options.

- `[options]` (Object) — Signal-arming options.
- `[options.process=process]` (NodeJS.Process) — Process on which to install handlers and call `kill`.
- `[options.signals=["SIGINT", "SIGTERM", "SIGHUP"]` (string[]) — ] Signals to handle.

Returns `() => void` — Idempotent function that removes these signal handlers and clears the armed state.

### `Agent.reseat(agent, { id } = {…})`

Build the FRESH Agent that replaces `agent` for a new session.

- `agent` (object) — the agent being replaced (the TUI's viewed one)
- `[options={}]` (Object) — session creation options
- `[options.id]` (string|false) — the new session id; an anonymous spelling (false/"0"/"false"/"anon") disables logging, and otherwise the fresh session keeps the old one's logging setting

Returns `object` — the fresh Agent, seated in the old one's group

## App

### `class App`

Static namespace for the application front ends. The class has no instance
methods; its exported static properties are attached immediately after its
declaration. Constructing an instance has no application side effects.

### `App.GTUI`

Public GTUI namespace member; see its owning module for the contract.

### `App.Markdown`

Public Markdown namespace member; see its owning module for the contract.

### `App.TUI`

Public TUI namespace member; see its owning module for the contract.

### `App.Web`

Public Web namespace member; see its owning module for the contract.

## CLI

### `class CLI`

Static namespace exposing every named CLI helper and `execute`.

### `CLI.adoptResumeOrigin({ resume, anonymous = false, dir } = {…})`

Move the process to the recorded origin folder for an explicit session resume.
Skips cwd changes for anonymous, absent, `"true"`, and `"latest"` resume values.
Resolves the session origin (using `dir` or the configured sessions folder),
verifies that folder exists, then changes `process.cwd()` before environment setup.

- `[options={}]` (Object) — Resume selection and session lookup options.
- `[options.resume]` (string) — The `--resume` value; values other than `"true"` and `"latest"` are treated as explicit session IDs.
- `[options.anonymous=false]` (boolean) — Whether this is an anonymous session.
- `[options.dir]` (string) — Session directory passed to origin lookup; defaults to `new Env().settings.sessions` when omitted or nullish.

Returns `string|null` — The origin folder after changing cwd, or `null` when no explicit origin should be adopted.

### `CLI.armCancelSignals({ onCancel, process: proc = process })`

Arm SIGINT/SIGTERM cancellation for a CLI binding.

- `options` (Object) — configuration object
- `options.onCancel` ((signal: string) => void) — invoked once, with "SIGINT" or "SIGTERM", on the first caught signal
- `[options.process=process]` (NodeJS.Process) — process-like signal emitter; defaults to the global Node.js `process` and can be injected for tests

Returns `() => void` — disarm function; removes both listeners, and is safe to call repeatedly

### `CLI.close({ env, agent } = {…})`

Close a command-line library runtime. This is the sole public housekeeping
boundary: agents are cancelled, sessions are flushed/closed, and tool-owned
background resources are released. Repeated calls are safe.

Returns `{agent?: object, session: {id: string, file?: string}|null}` — The explicit agent and its context's id/file when present, otherwise a null session. Starts background-resource teardown without awaiting it.

### `CLI.completeOAuthPaste(input)`

Feed pasted authorization input (a redirect URL, `code#state`, or code) to the current authorization-code flow.

- `input` (string) — User-pasted authorization input passed to the waiting flow for parsing.

Returns `boolean` — `true` if a flow was waiting and was resumed, otherwise `false`.

### `CLI.defaultUrl(provider)`

Return the built-in setup URL for a provider; runtime endpoint discovery
remains owned by the environment.

- `provider` (string) — Provider protocol identifier.

Returns `string` — The provider's default URL, or an empty string if none is known.

### `CLI.execute(command)`

Execute one normalized administrative command.
Argument parsing and flag names remain the executable's concern. This
function creates an environment and closes it in a `finally` block, even if
command handling fails.

Returns — {Promise< {type: "login", name: string, endpoint: object, auth?: object, scope: string, verified?: *} | {type: "logout", name: string, dynamic: boolean} | {type: "initialize", file: string} | {type: "listModels", endpoints: Array<{name: string, models: string[]}>} >} A promise for the result corresponding to `command.type`.

### `CLI.EXIT`

Exit codes shared by the command-line tools.

### `CLI.exitCodeFor(terminal)`

Map a terminal done/error event (or an error-shaped `{kind}`) to the
process exit code.

Returns `number` — The mapped process exit code; this function is synchronous and has no side effects.

### `CLI.formatToolResult(result)`

Convert a result to printable text, preserving strings and pretty-printing
other values as JSON; values without a JSON representation are string-coerced.

- `result` (*) — Value to format; there is no default.

Returns `string` — The original string, indented JSON text, or string coercion when JSON serialization yields `undefined`.

### `CLI.listEndpointModels(env)`

Build menu entries for published endpoints and their published model ids.
`loginRequired` is set for endpoints whose credentials failed (see Agent).

- `env` (object) — Env providing the optionally available published model catalog.

Returns `{name: string, models: string[], loginRequired?: boolean}[]` — Endpoint entries in catalog order.

### `CLI.listEndpoints(env)`

List every endpoint known to the catalog, including secret entries, for logout choices.

- `env` (object) — Env providing the optionally available full model catalog.

Returns `string[]` — Unique endpoint ids in first-seen order.

### `CLI.listModelCandidates(env)`

List published endpoint, model, and endpoint/model completion candidates.

- `env` (object) — Env providing the optionally available model catalog.

Returns `string[]` — Unique candidate strings in first-seen order.

### `CLI.listModels(env)`

Return every published endpoint's model ids after background collection
completes; provider failure can leave a cached/static catalog.

- `env` (object) — Env with a `modelsReady` promise and model catalog.

Returns `Promise<{name: string, models: string[]}[]>` — Endpoint names and their published model ids.

### `CLI.loginEndpoint(env, { name, provider, url, token, auth, scope = "package", } = {…})`

Configure and log in to one endpoint via `Env.login`. The provider shapes
credentials (or uses supplied `auth`, such as browser-OAuth tokens), then
verifies the connection and fetches its models; failed login leaves nothing
behind.

- `env` (object) — Environment that owns the login operation.
- `options` (object) — Login options; defaults to `{}`.
- `options.name` (string) — Endpoint name.
- `options.provider` (string) — Provider protocol identifier.
- `options.url` (string) — Endpoint URL.
- `[options.token]` (string) — Optional API token.
- `[options.auth]` (object) — Optional pre-seeded authentication data.
- `[options.scope="package"]` (string) — Endpoint scope.

Returns `Promise<*>` — Resolves with the result of `env.login`.

### `CLI.logoutEndpoint(env, name)`

Remove an endpoint using the `Env.logout` contract. Persisted configuration
and auth files are removed; an environment-detected endpoint is cleared
only in memory and will be rediscovered while the environment provides it.

- `env` (object) — Environment whose endpoint to log out.
- `name` (string) — Endpoint name.

Returns `{name: string, dynamic: boolean}` — Logout result from `env.logout`.

### `CLI.oauthPasteOnly(descriptor)`

Determine whether a flow is paste-only: an authorization-code flow with
a non-loopback redirect URI, where the provider-hosted callback displays
the code instead of delivering it to a local listener.

- `descriptor` (object) — The endpoint preset's `oauth` block.

Returns `boolean` — `true` when there is no string device-authorization URL and the string redirect URI is not loopback.

### `CLI.parseAuthorizationInput(input)`

Parse pasted authorization input: a full redirect URL
(`...?code=…&state=…`), `code#state`, or a bare code.

- `input` (string) — Pasted full redirect URL, `code#state`, or bare code; nullish values are treated as empty text.

Returns `{code?: string, state?: string}` — Parsed non-empty code and/or state; empty input yields an empty object.

### `CLI.parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] })`

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
- `[spec.numbers=["max-turns", "max-tool-calls"]` (string[]) — ] - Value-taking flag names converted to finite, positive numbers when present.

Returns `Object` — Parsed options; values are strings except converted duration/number values, boolean flags (`true`), or `{help: true}`.

### `CLI.readContextFromStdin()`

Read standard input through EOF and parse its UTF-8 contents as messages.

Returns `Promise<Array<object>>` — The parsed context/message array.

### `CLI.readLastCombo(env)`

Return the published endpoint/model pair with the newest last-used timestamp.

- `env` (object) — Env whose model catalog is inspected.

Returns `string|null` — The newest qualified selector, or null when no model has been used.

### `CLI.readStdin()`

Read and buffer all bytes from standard input until the stream reaches EOF,
then decode the concatenated bytes as UTF-8.

Returns `Promise<string>` — The complete stdin contents as a UTF-8 string.

### `CLI.refreshOAuthTokens(descriptor, refresh, { signal } = {…})`

Refresh stored OAuth credentials without repeating browser or device authorization.
The response may omit `refresh_token`; callers can preserve the prior value when mapping it with `tokensToAuth`.

- `descriptor` (object) — OAuth descriptor containing a string `tokenUrl` and the client ID.
- `refresh` (string) — Non-empty stored refresh token.

Returns `Promise<object>` — Resolves with the parsed token response.

### `CLI.renderSettingsTemplate(env)`

Render the project settings template from the settings schema exposed by `env`.
Emits one commented-out line per known key in sorted order, using its default
as the placeholder (`null` if undefined) and its description as a trailing comment.

Returns `string` — Complete JSONC template text, ending with a newline.

### `CLI.resolveCliToolArgs(argv, entry)`

Resolve CLI arguments from JSON or shell-friendly shorthand. A single
argument is first tried as JSON; otherwise a colon in the first argument
selects key/value object form, and arguments without that colon become a
string-array shorthand for the tool's first schema property.

- `argv` (string[]) — CLI argument strings; an empty array defaults to no arguments (`{}`).

Returns `object` — The resolved argument object.

### `CLI.resolveModelCombo(value, env)`

Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model.
An endpoint alone selects its first published model once background
collection has answered (`env.modelsReady`).

- `value` (string) — Selector to resolve; must be a non-empty string.
- `env` (object) — Env providing model catalog, validation, and readiness.

Returns `Promise<string|undefined>` — Qualified selector, or undefined when no endpoint/model resolves.

### `CLI.resolveToolArgs(raw, entry)`

Parse raw JSON arguments, passing a JSON object through or wrapping a bare
JSON value in the tool's first schema property.

- `raw` (string|undefined) — JSON text; omitted or empty text defaults to no arguments (`{}`).

Returns `object` — The parsed argument object or shorthand wrapper.

### `CLI.runLoginWizard(env, { input = process.stdin, output = process.stderr, } = {…})`

Run the cooked-terminal wizard used by `--login`. Lists known endpoints
from `Env.loginPresets` alongside a manual URL option, then prompts for
endpoint details and credentials or browser OAuth where available. Closes
its readline interface on completion or failure.

- `env` (object) — Environment providing presets and endpoint login.
- `[options={}]` (object) — I/O options; defaults to `{}`.
- `[options.input=process.stdin]` (import("node:stream").Readable) — Prompt input stream.
- `[options.output=process.stderr]` (import("node:stream").Writable) — Wizard and OAuth output stream.

Returns `Promise<*>` — Resolves with the result of the selected endpoint login.

### `CLI.runOAuthFlow(descriptor, options = {…})`

Run one OAuth sign-in, selecting device authorization when the descriptor
has a string `deviceAuthorizationUrl`, otherwise authorization code + PKCE.

- `descriptor` (object) — The endpoint preset's `oauth` block for the selected grant.
- `[options={}]` (object) — Flow options forwarded to the selected implementation.
- `[options.onAuthUrl]` ((url: string) => void) — Called with the URL the user must visit; browser opening is attempted separately.
- `[options.onLog]` ((line: string) => void) — Called with progress messages; defaults to a no-op.
- `[options.signal]` (AbortSignal) — Signal used to cancel the sign-in where supported.
- `[options.open]` ((url: string) => boolean) — Browser-opening function; defaults to `openInBrowser`.

Returns `Promise<object>` — Resolves with the provider's token response.

### `CLI.selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {…})`

Select a qualified model from CLI input or the last-used published model.

- `env` (object) — Environment providing model resolution and login.
- `args` (object) — CLI arguments: model selector and optional invocation-only URL.
- `[options={}]` (object) — Selection options.
- `[options.lastUsed=false]` (boolean) — Consider the newest available last-used model when no explicit model is supplied.
- `[options.log=()=>{}]` (Function) — Log the selected last-used qualified model.

Returns `Promise<string|undefined>` — Qualified `<endpoint>/<model>`, or undefined if unresolved.

### `CLI.tokensToAuth(tokens, previous = {…})`

Map a provider token response to the stored OAuth auth payload. `token` mirrors
`access` so bearer-auth wire code needs no OAuth awareness.

- `tokens` (object) — Provider response; requires a non-empty string `access_token`, with optional `refresh_token` and finite `expires_in`.
- `[previous={}]` (object) — Prior auth payload; its non-empty string `refresh` is retained if the response omits a usable refresh token.

Returns `{type: string, access: string, token: string, refresh?: string, expires?: number}` — Auth payload; `expires` is the current time plus `expires_in` seconds when finite.

### `CLI.unwrapToolResult(value)`

Unwrap a tool return envelope into its result and side-channel arrays. An
object with a `system` or `display` property is treated as an envelope;
any other value is returned as `result` with empty side channels.

- `value` (*) — Tool return value; there is no default.

Returns `{result: *, system: string[], display: string[]}` — The result plus normalized `system` and `display` arrays (missing/falsy channels become empty arrays, and scalar channels become one-element arrays).

### `CLI.usageSummary(usage)`

Format usage as a one-line human-readable summary for host diagnostics.
Missing/falsy usage returns `usage: unknown`; a finite cost is included to
four decimal places. Does not mutate the supplied usage object.

- `usage` (object) — usage envelope with inputTokens, outputTokens, source, and optional cost

Returns `string` — formatted usage summary

### `CLI.writeSettingsTemplate(env, { force = false } = {…})`

Write a namespaced settings template to the project settings path under `env.cwd`.
Refuses to replace an existing file unless `options.force` is true.

Returns `string` — Path of the written settings file.

### `CLI.EXIT = Object.freeze({…})`

Exit codes shared by the command-line tools.

### `CLI.adoptResumeOrigin({ resume, anonymous = false, dir } = {…})`

Move the process to the recorded origin folder for an explicit session resume.
Skips cwd changes for anonymous, absent, `"true"`, and `"latest"` resume values.
Resolves the session origin (using `dir` or the configured sessions folder),
verifies that folder exists, then changes `process.cwd()` before environment setup.

- `[options={}]` (Object) — Resume selection and session lookup options.
- `[options.resume]` (string) — The `--resume` value; values other than `"true"` and `"latest"` are treated as explicit session IDs.
- `[options.anonymous=false]` (boolean) — Whether this is an anonymous session.
- `[options.dir]` (string) — Session directory passed to origin lookup; defaults to `new Env().settings.sessions` when omitted or nullish.

Returns `string|null` — The origin folder after changing cwd, or `null` when no explicit origin should be adopted.

### `CLI.armCancelSignals({ onCancel, process: proc = process })`

Arm SIGINT/SIGTERM cancellation for a CLI binding.

- `options` (Object) — configuration object
- `options.onCancel` ((signal: string) => void) — invoked once, with "SIGINT" or "SIGTERM", on the first caught signal
- `[options.process=process]` (NodeJS.Process) — process-like signal emitter; defaults to the global Node.js `process` and can be injected for tests

Returns `() => void` — disarm function; removes both listeners, and is safe to call repeatedly

### `CLI.close({ env, agent } = {…})`

Close a command-line library runtime. This is the sole public housekeeping
boundary: agents are cancelled, sessions are flushed/closed, and tool-owned
background resources are released. Repeated calls are safe.

Returns `{agent?: object, session: {id: string, file?: string}|null}` — The explicit agent and its context's id/file when present, otherwise a null session. Starts background-resource teardown without awaiting it.

### `CLI.completeOAuthPaste(input)`

Feed pasted authorization input (a redirect URL, `code#state`, or code) to the current authorization-code flow.

- `input` (string) — User-pasted authorization input passed to the waiting flow for parsing.

Returns `boolean` — `true` if a flow was waiting and was resumed, otherwise `false`.

### `CLI.defaultUrl(provider)`

Return the built-in setup URL for a provider; runtime endpoint discovery
remains owned by the environment.

- `provider` (string) — Provider protocol identifier.

Returns `string` — The provider's default URL, or an empty string if none is known.

### `async CLI.execute(command)`

Execute one normalized administrative command.
Argument parsing and flag names remain the executable's concern. This
function creates an environment and closes it in a `finally` block, even if
command handling fails.

Returns — {Promise< {type: "login", name: string, endpoint: object, auth?: object, scope: string, verified?: *} | {type: "logout", name: string, dynamic: boolean} | {type: "initialize", file: string} | {type: "listModels", endpoints: Array<{name: string, models: string[]}>} >} A promise for the result corresponding to `command.type`.

### `CLI.exitCodeFor(terminal)`

Map a terminal done/error event (or an error-shaped `{kind}`) to the
process exit code.

Returns `number` — The mapped process exit code; this function is synchronous and has no side effects.

### `CLI.formatToolResult(result)`

Convert a result to printable text, preserving strings and pretty-printing
other values as JSON; values without a JSON representation are string-coerced.

- `result` (*) — Value to format; there is no default.

Returns `string` — The original string, indented JSON text, or string coercion when JSON serialization yields `undefined`.

### `CLI.listEndpointModels(env)`

Build menu entries for published endpoints and their published model ids.
`loginRequired` is set for endpoints whose credentials failed (see Agent).

- `env` (object) — Env providing the optionally available published model catalog.

Returns `{name: string, models: string[], loginRequired?: boolean}[]` — Endpoint entries in catalog order.

### `CLI.listEndpoints(env)`

List every endpoint known to the catalog, including secret entries, for logout choices.

- `env` (object) — Env providing the optionally available full model catalog.

Returns `string[]` — Unique endpoint ids in first-seen order.

### `CLI.listModelCandidates(env)`

List published endpoint, model, and endpoint/model completion candidates.

- `env` (object) — Env providing the optionally available model catalog.

Returns `string[]` — Unique candidate strings in first-seen order.

### `async CLI.listModels(env)`

Return every published endpoint's model ids after background collection
completes; provider failure can leave a cached/static catalog.

- `env` (object) — Env with a `modelsReady` promise and model catalog.

Returns `Promise<{name: string, models: string[]}[]>` — Endpoint names and their published model ids.

### `async CLI.loginEndpoint(env, { name, provider, url, token, auth, scope = "package", } = {…})`

Configure and log in to one endpoint via `Env.login`. The provider shapes
credentials (or uses supplied `auth`, such as browser-OAuth tokens), then
verifies the connection and fetches its models; failed login leaves nothing
behind.

- `env` (object) — Environment that owns the login operation.
- `options` (object) — Login options; defaults to `{}`.
- `options.name` (string) — Endpoint name.
- `options.provider` (string) — Provider protocol identifier.
- `options.url` (string) — Endpoint URL.
- `[options.token]` (string) — Optional API token.
- `[options.auth]` (object) — Optional pre-seeded authentication data.
- `[options.scope="package"]` (string) — Endpoint scope.

Returns `Promise<*>` — Resolves with the result of `env.login`.

### `CLI.logoutEndpoint(env, name)`

Remove an endpoint using the `Env.logout` contract. Persisted configuration
and auth files are removed; an environment-detected endpoint is cleared
only in memory and will be rediscovered while the environment provides it.

- `env` (object) — Environment whose endpoint to log out.
- `name` (string) — Endpoint name.

Returns `{name: string, dynamic: boolean}` — Logout result from `env.logout`.

### `CLI.oauthPasteOnly(descriptor)`

Determine whether a flow is paste-only: an authorization-code flow with
a non-loopback redirect URI, where the provider-hosted callback displays
the code instead of delivering it to a local listener.

- `descriptor` (object) — The endpoint preset's `oauth` block.

Returns `boolean` — `true` when there is no string device-authorization URL and the string redirect URI is not loopback.

### `CLI.parseAuthorizationInput(input)`

Parse pasted authorization input: a full redirect URL
(`...?code=…&state=…`), `code#state`, or a bare code.

- `input` (string) — Pasted full redirect URL, `code#state`, or bare code; nullish values are treated as empty text.

Returns `{code?: string, state?: string}` — Parsed non-empty code and/or state; empty input yields an empty object.

### `CLI.parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] })`

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
- `[spec.numbers=["max-turns", "max-tool-calls"]` (string[]) — ] - Value-taking flag names converted to finite, positive numbers when present.

Returns `Object` — Parsed options; values are strings except converted duration/number values, boolean flags (`true`), or `{help: true}`.

### `async CLI.readContextFromStdin()`

Read standard input through EOF and parse its UTF-8 contents as messages.

Returns `Promise<Array<object>>` — The parsed context/message array.

### `CLI.readLastCombo(env)`

Return the published endpoint/model pair with the newest last-used timestamp.

- `env` (object) — Env whose model catalog is inspected.

Returns `string|null` — The newest qualified selector, or null when no model has been used.

### `async CLI.readStdin()`

Read and buffer all bytes from standard input until the stream reaches EOF,
then decode the concatenated bytes as UTF-8.

Returns `Promise<string>` — The complete stdin contents as a UTF-8 string.

### `async CLI.refreshOAuthTokens(descriptor, refresh, { signal } = {…})`

Refresh stored OAuth credentials without repeating browser or device authorization.
The response may omit `refresh_token`; callers can preserve the prior value when mapping it with `tokensToAuth`.

- `descriptor` (object) — OAuth descriptor containing a string `tokenUrl` and the client ID.
- `refresh` (string) — Non-empty stored refresh token.

Returns `Promise<object>` — Resolves with the parsed token response.

### `CLI.renderSettingsTemplate(env)`

Render the project settings template from the settings schema exposed by `env`.
Emits one commented-out line per known key in sorted order, using its default
as the placeholder (`null` if undefined) and its description as a trailing comment.

Returns `string` — Complete JSONC template text, ending with a newline.

### `CLI.resolveCliToolArgs(argv, entry)`

Resolve CLI arguments from JSON or shell-friendly shorthand. A single
argument is first tried as JSON; otherwise a colon in the first argument
selects key/value object form, and arguments without that colon become a
string-array shorthand for the tool's first schema property.

- `argv` (string[]) — CLI argument strings; an empty array defaults to no arguments (`{}`).

Returns `object` — The resolved argument object.

### `async CLI.resolveModelCombo(value, env)`

Resolve `<endpoint>/<model>`, a model id, an endpoint, or a bare model.
An endpoint alone selects its first published model once background
collection has answered (`env.modelsReady`).

- `value` (string) — Selector to resolve; must be a non-empty string.
- `env` (object) — Env providing model catalog, validation, and readiness.

Returns `Promise<string|undefined>` — Qualified selector, or undefined when no endpoint/model resolves.

### `CLI.resolveToolArgs(raw, entry)`

Parse raw JSON arguments, passing a JSON object through or wrapping a bare
JSON value in the tool's first schema property.

- `raw` (string|undefined) — JSON text; omitted or empty text defaults to no arguments (`{}`).

Returns `object` — The parsed argument object or shorthand wrapper.

### `async CLI.runLoginWizard(env, { input = process.stdin, output = process.stderr, } = {…})`

Run the cooked-terminal wizard used by `--login`. Lists known endpoints
from `Env.loginPresets` alongside a manual URL option, then prompts for
endpoint details and credentials or browser OAuth where available. Closes
its readline interface on completion or failure.

- `env` (object) — Environment providing presets and endpoint login.
- `[options={}]` (object) — I/O options; defaults to `{}`.
- `[options.input=process.stdin]` (import("node:stream").Readable) — Prompt input stream.
- `[options.output=process.stderr]` (import("node:stream").Writable) — Wizard and OAuth output stream.

Returns `Promise<*>` — Resolves with the result of the selected endpoint login.

### `async CLI.runOAuthFlow(descriptor, options = {…})`

Run one OAuth sign-in, selecting device authorization when the descriptor
has a string `deviceAuthorizationUrl`, otherwise authorization code + PKCE.

- `descriptor` (object) — The endpoint preset's `oauth` block for the selected grant.
- `[options={}]` (object) — Flow options forwarded to the selected implementation.
- `[options.onAuthUrl]` ((url: string) => void) — Called with the URL the user must visit; browser opening is attempted separately.
- `[options.onLog]` ((line: string) => void) — Called with progress messages; defaults to a no-op.
- `[options.signal]` (AbortSignal) — Signal used to cancel the sign-in where supported.
- `[options.open]` ((url: string) => boolean) — Browser-opening function; defaults to `openInBrowser`.

Returns `Promise<object>` — Resolves with the provider's token response.

### `async CLI.selectEndpointModel(env, args, { lastUsed = false, log = () => {} } = {…})`

Select a qualified model from CLI input or the last-used published model.

- `env` (object) — Environment providing model resolution and login.
- `args` (object) — CLI arguments: model selector and optional invocation-only URL.
- `[options={}]` (object) — Selection options.
- `[options.lastUsed=false]` (boolean) — Consider the newest available last-used model when no explicit model is supplied.
- `[options.log=()=>{}]` (Function) — Log the selected last-used qualified model.

Returns `Promise<string|undefined>` — Qualified `<endpoint>/<model>`, or undefined if unresolved.

### `CLI.tokensToAuth(tokens, previous = {…})`

Map a provider token response to the stored OAuth auth payload. `token` mirrors
`access` so bearer-auth wire code needs no OAuth awareness.

- `tokens` (object) — Provider response; requires a non-empty string `access_token`, with optional `refresh_token` and finite `expires_in`.
- `[previous={}]` (object) — Prior auth payload; its non-empty string `refresh` is retained if the response omits a usable refresh token.

Returns `{type: string, access: string, token: string, refresh?: string, expires?: number}` — Auth payload; `expires` is the current time plus `expires_in` seconds when finite.

### `CLI.unwrapToolResult(value)`

Unwrap a tool return envelope into its result and side-channel arrays. An
object with a `system` or `display` property is treated as an envelope;
any other value is returned as `result` with empty side channels.

- `value` (*) — Tool return value; there is no default.

Returns `{result: *, system: string[], display: string[]}` — The result plus normalized `system` and `display` arrays (missing/falsy channels become empty arrays, and scalar channels become one-element arrays).

### `CLI.usageSummary(usage)`

Format usage as a one-line human-readable summary for host diagnostics.
Missing/falsy usage returns `usage: unknown`; a finite cost is included to
four decimal places. Does not mutate the supplied usage object.

- `usage` (object) — usage envelope with inputTokens, outputTokens, source, and optional cost

Returns `string` — formatted usage summary

### `CLI.writeSettingsTemplate(env, { force = false } = {…})`

Write a namespaced settings template to the project settings path under `env.cwd`.
Refuses to replace an existing file unless `options.force` is true.

Returns `string` — Path of the written settings file.

## Context

### `Context.ContentType = Object.freeze({…})`

Content block discriminators.

### `class Context`

The conversation context: an ordered message list (a private array —
read it through length/at/messages()/iteration, change it through the
methods below), optionally NAMED (`id`/`name`) and LOGGED to a
session file in `dir` (`save`). Crash safety is the owner's: an Agent
flushes its context from a process-finish hook.

### `Context.append(message, options)`

Append a message, MERGING with the last one when possible
(consecutive same-type messages / same-sub-type blocks fold —
Context.appendMessage); `{merge: false}` keeps a boundary.

- `message` (object)

Returns `object` — the stored message

### `Context.assemblerCallbacks(assembler)`

Build the camelCase callback set used by Context to feed response events to
an assembler. Includes callbacks for start, text/thinking block events,
tool-call events, done, and error.

- `assembler` (ReturnType<typeof createAssembler>) — Assembler receiving the events; no default is provided.

Returns `Object<string, function(object): void>` — Callbacks keyed by names such as `onStart`, `onTextDelta`, `onDone`, and `onError`.

### `Context.assemblerCreate()`

Create an assembler that folds normalized response events into one
assistant message. Events mutate the in-progress message; valid message
snapshots on `start`, `done`, or `error` replace it. Unknown event types are
ignored, and malformed tool-call JSON is retained as raw text. The returned
message remains partial until completion and is exposed by reference.

Returns `{consume: (event: object) => void, message: () => object}` — The event consumer and accessor for the current message.

### `Context.at(i)`

The message at index `i` (negative counts from the end).

- `i` (number)

Returns `object|undefined`

### `Context.blockAt(i, j)`

Block `j` of message `i` (RangeError when either index is out of range).

- `i` (number)
- `j` (number)

Returns `object`

### `Context.callbacksNormalize(callbacks = {…}, binding = {…})`

Build the full callback set for a binding.

- `[callbacks={}]` (Object) — consumer-supplied callbacks, keyed by camelCase callback name. A function is used as-is; explicit `false` or `null` selects a no-op; an omitted or `undefined` callback gets the binding default.
- `[binding={}]` (Object) — binding-appropriate default handlers.
- `[binding.onData]` ((event:object)=>void) — receives every event whose callback was omitted (stdout replacement)
- `[binding.onLog]` ((line:string)=>void) — receives error reports (stderr replacement)
- `[binding.onTerminal]` ((event:object)=>void|false|null) — completes the binding; called for `done` and `error` even when the consumer supplied its own terminal callback. `false` or `null` disables this additional call.

Returns `Object` — Complete callback set keyed by camelCase names.

### `Context.close()`

Flush and close; subsequent mutations fail. Flush errors propagate and
leave the context open.

Returns `void`

### `Context.constructor({ id, dir, messages = [], origin, uuid, name, settings, save = dir !== undefined } = {…})`

Create a context, optionally named and logged (the file is created
on the first flush of a started conversation).

- `[options]` (Object)
- `[options.id]` (string) — session id (default: random UUID)
- `[options.dir]` (string) — the sessions folder (env.settings.sessions); required to log
- `[options.messages]` (Array) — initial messages, deep-copied into this context; no objects are shared with another context
- `[options.origin]` (string) — the folder the session RUNS in (default: process.cwd()) — recorded in the file's metadata line; resume's scans list only sessions of the current folder
- `[options.uuid]` (string) — carry an existing sessionUUID forward (Context.resume() only — a fresh session always gets a new one)
- `[options.name]` (string) — carry an existing stored NAME forward (Context.resume() only — see the module doc)
- `[options.settings]` (object) — the session-owned agent settings snapshot (Agent-managed; see the settings setter)
- `[options.save]` (boolean) — whether the context is logged to disk (default: whenever a `dir` is given); false keeps it in memory

### `Context.contentBinary(path, buffer)`

Build a canonical base64 binary Context block without exposing the source path.

- `path` (string) — Non-empty local path; only its basename is retained.
- `buffer` (Uint8Array) — Binary data to encode.

Returns `{type: "binary", mimetype: string, filename: string, content: string}` — A block containing the basename, detected media type, and base64 data.

### `Context.contentIndexer()`

Create a per-request content-block indexer for a provider translator. `of`
reuses an index for a previously seen wire-item key, while `next` always
reserves a fresh index; indexes are dense and follow first appearance.

Returns `{of: (key: *) => number, next: () => number}` — Indexing operations.

### `Context.contentText(text)`

Wrap a value's string representation in a text content block.

- `text` (*) — Value converted with `String()`.

Returns `TextContent` — A block with `type: ContentType.Text` and the converted text.

### `Context.ContentType`

Content block discriminators.

### `Context.created`

Creation timestamp in ISO form.

Returns `string` — Creation timestamp in ISO form.

### `Context.deleteAll({ dir } = {…})`

Delete EVERY session file in the folder (the /sessions-delete-all!
contract — the user confirmed; foreign files stay untouched).

- `[options]` (Object)
- `[options.dir]` (string)

Returns `{deleted: number}`

### `Context.deleteById({ id, dir } = {…})`

Permanently delete a STORED session by id: every session file whose
metadata carries that id (a leftover duplicate goes with it). A store
still holding it open would re-persist it — close it first.

- `options` (Object)
- `options.id` (string)
- `[options.dir]` (string)

Returns `{deleted: number}`

### `Context.dir`

Session logging directory.

Returns `string|undefined` — Session logging directory.

### `Context.edit(i, message)`

Replace message `i` (rebuilt from recognized fields; stale provider
identifiers dropped).

- `i` (number)
- `message` (object)

Returns `object` — the stored message

### `Context.editBlock(i, j, block)`

Replace block `j` of message `i` (the message is rebuilt).

- `i` (number)
- `j` (number)
- `block` (object)

Returns `object` — the stored block

### `Context.errorPop()`

Retract a trailing FAILED RESPONSE before the context is submitted
again: an assistant message carrying `error` that is still the last
message was not responded to — the user continued as it stands — so
it goes and the request is re-attempted. Anything added after it (a
user reply) keeps it: then it is part of the conversation.

Returns `object|undefined` — the removed message

### `Context.eventCallbackName(eventName)`

Map an event name to its camelCase callback name.
"text_delta" -> "onTextDelta"; "tool_call_start" -> "onToolCallStart".

- `eventName` (string) — normalized event name to convert.

Returns `string` — The corresponding camelCase callback name.

### `Context.eventDispatch(set, event)`

Dispatch one event through a normalized callback set. Validates the event
before invoking its matching callback; callback errors propagate to the caller.

- `set` (Object) — callback set returned by `normalizeCallbacks`.
- `event` (object) — normalized response event to dispatch.

Returns `void`

### `Context.EventType`

The full normalized event vocabulary.

### `Context.eventValid(event)`

Is this a well-formed normalized response event (a known `type`;
indexed events carry a non-negative integer `contentIndex`)?

- `event` (*) — value to check.

Returns `boolean` — `true` for an object with a known event type and, for indexed events, a non-negative integer `contentIndex`; otherwise `false`.

### `Context.eventValidate(event)`

Validate a normalized response event (used by IO to check connector
output). Returns the same object; throws on violation.

- `event` (*) — value to validate.

Returns `object` — The same event object when it is valid.

### `Context.FALLBACK_CONTEXT_WINDOWS`

Curated context windows for the CURRENT OpenAI tier, from the models
docs (developers.openai.com/api/docs/models, reviewed 2026-09-28 —
the gpt-6 family lists 1.05M; o-series 200K). OpenAI's API-key
surface publishes NO window anywhere (/models, /models/{id}, and the
response envelope are all bare — probed with
ai-tmp/probe-openai-models.js), so the status gauge reads this table
while a lazy registry lookup (lib/env/model-windows.js) fills the
endpoint's model cache. Any provider-published or looked-up value
outranks it. Review when a new tier ships.

### `Context.fallbackContextWindow(model)`

The curated fallback window for one model id, or null: an exact key,
then the longest table prefix the id starts with ("gpt-6-sol" ->
"gpt-6", "o3-2025-04-16" -> "o3").

- `model` (*) — bare model id; non-string or empty values are rejected

Returns `number|null` — matching fallback token window, or `null` when none

### `Context.file`

Backing session file, when a logging directory exists.

Returns `string|undefined` — Backing session file, when a logging directory exists.

### `Context.fileOf({ id, dir } = {…})`

The session file holding `id` in `dir` (a metadata-line scan), or
undefined.

Returns `string|undefined`

### `Context.flush()`

Synchronously make the CURRENT context durable (see _planFlush for
the remove/none/append/full decision). Idempotent; a no-op when
nothing changed since the last flush. Filesystem errors propagate.

Returns `void`

### `Context.flushAsync()`

Async counterpart for a live loop (Agent's request/tool turns); the
synchronous flush() remains the crash/exit contract.
"remove"/"append" plans are tiny and interleave-free, so they commit
synchronously; only a "full" rewrite yields, snapshotting one version
so a mutation while I/O is pending remains dirty for the following
flush rather than being lost. I/O errors reject the returned promise.

Returns `Promise<void>`

### `Context.id`

Stable context identifier; use rename() to update logged identity.

Returns `string` — Stable context identifier; use rename() to update logged identity.

### `Context.idAnonymous(id)`

Does `id` spell an ANONYMOUS (memory-only, never logged) context:
false, "0", "false" or "anon"?

- `id` (*)

Returns `boolean`

### `Context.latest({ dir, cwd } = {…})`

The id of the most recently modified session in the folder (of
the `cwd` origin when given), or undefined when the folder has none.

- `[options]` (Object)
- `[options.dir]` (string)
- `[options.cwd]` (string) — only sessions of THIS origin folder

Returns `string|undefined`

### `Context.get length()`

the message count

Returns `number` — the message count

### `Context.list({ dir, cwd, limit = 50 } = {…})`

Every session in the folder, LATEST FIRST (one entry per id), each
with a small preview: the first meaningful line of the first user
message (see meaningfulLine; whitespace-folded, capped) and `agent`,
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

### `Context.listAsync({ dir, cwd, limit = 50 } = {…})`

Nonblocking counterpart of list(). It deliberately has its own async
folder identity rather than calling sameFolder(), whose realpathSync
would stall the interactive loop.

Returns `Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>`

### `Context.messageAppend(context, message, { merge = true } = {…})`

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

Returns `object` — The stored message (the previous message when merged, otherwise the appended value).

### `Context.messageAssistant(content = [])`

Create an assistant message using the supplied content blocks.

- `[content=[]` (Content[]) — ] - Ordered content blocks; defaults to an empty array.

Returns `Message` — An assistant message whose content is the supplied array; no validation or copying is performed.

### `Context.messageErrorText(msg)`

Get the presentation text of a normalized assistant failure; tool-result
boolean errors are distinct and produce an empty string.

- `msg` (*) — Value whose error field is inspected.

Returns `string` — The error string, `error.message`, or an empty string.

### `Context.messageFile(path, buffer)`

Wrap one local file's bytes in the canonical user-message content structure.

- `path` (string) — Non-empty local file path passed to {@link binaryContent}.
- `buffer` (Uint8Array) — File bytes passed to {@link binaryContent}.

Returns `{type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>}` — A user message containing a single binary content block.

### `Context.messageHasContent(msg)`

Has this message any CONTENT a provider can consume? A block with
no payload — a text/thinking block whose text is empty, a block
reduced to its discriminator alone — is not content; an empty
content array is not content either. Chat-completions dialects
serialize an empty assistant message as `content: null` and
providers 400 the whole request over it (corrupted sessions), so
emptiness is a hard contract, not a style point.

- `msg` (*) — Value whose `content` blocks are inspected.

Returns `boolean` — True if at least one block carries provider-consumable content.

### `Context.messageHasError(msg)`

Does this message report a FAILED RESPONSE? A provider or transport
failure is normalized as the response message carrying `error` — a
text string or {message, retry} for timed rate limits — beside whatever content arrived before it (possibly
none: the error is then its whole payload). A tool result's boolean
`error: true` is not one: that is the tool's own (answered) failure.

- `msg` (*) — Value whose normalized response error is inspected.

Returns `boolean` — True for a nonempty error string or nonempty `error.message`.

### `Context.messageIsRecord(msg)`

Test whether a value is a metadata record: a non-array object with a
string `type` (not a numeric message type). Records may share context and
session files with messages; they are not messages and are skipped by
message validators. Other components pass them through unmerged or filter
them from provider-bound contexts as appropriate.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` carries a string `type`.

### `Context.messageRebuild(msg)`

Rebuild a message from recognized schema fields only — the stale
provider/cache identifier cleanup. See the module header for the
field policy.

- `msg` (object) — Message to validate and rebuild.

Returns `object` — A new message containing recognized fields only.

### `Context.messages()`

A new array of LIVE message objects. Mutating a message changes this context only, without marking it dirty; use edit/update for persistence bookkeeping. Construction deep-copies seeds, so forks never share message objects.

Returns `object[]` — A new array of LIVE message objects. Mutating a message changes this context only, without marking it dirty; use edit/update for persistence bookkeeping. Construction deep-copies seeds, so forks never share message objects.

### `Context.messagesParse(input)`

Parse buffered CLI input into a context array using the shared grammar.
First, the entire input is parsed as JSON; if that is an array, it is
returned unchanged. Otherwise, each nonblank line is parsed independently:
message objects and valid messages in arrays are included, while other
values become user text messages containing the original line.

- `input` (string) — Complete stdin text after EOF; there is no default.

Returns `Array<object>` — The resulting context array. This is synchronous and returns no Promise.

### `Context.messagesValid(ctx)`

Test whether a value is a context array containing only core-shaped
messages and/or metadata records.

- `ctx` (*) — Value to test.

Returns `boolean` — True when `ctx` is such an array; an empty array passes.

### `Context.messagesValidate(ctx)`

Validate a context array, allowing metadata records and validating every
other entry as a message. Returns the same array reference without mutation.

- `ctx` (*) — Value to validate as a context.

Returns `Array` — The same `ctx` array, unchanged.

### `Context.messageSystem(text)`

Create a system message containing one text block made from the given value.

- `text` (*) — Value converted to a string for the text block.

Returns `Message` — A system message with one text content block.

### `Context.MessageType`

Numeric message types. 0 is reserved.

### `Context.messageUser(text, metadata = undefined)`

Create a user message from plain text or an existing ordered block array.
Non-array input is converted to a text block; array input is used as-is.
If supplied, metadata is spread over the message and can override its fields.

- `text` (string|Content[]|*) — Plain-text value to convert, or an array of content blocks to preserve.
- `[metadata=undefined]` (*) — Optional value whose enumerable own properties are spread last onto the message.

Returns `Message` — The resulting user message.

### `Context.messageValid(msg)`

Test whether a value has the core message shape: a non-array object with
a numeric `type` and an array `content`.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` has the core message shape.

### `Context.messageValidate(msg, at = "message")`

Validate a message's CORE SHAPE, throwing on a violation.
Returns the SAME object reference — metadata is never copied,
stripped, or reordered. Emptiness is deliberately NOT part of the
shape: appendMessage REFUSES (drops) an empty incoming message,
and IO DROPS empty messages from every provider-bound context
(no dialect can carry one), while a merge that consumed an
incoming message's whole payload into the previous message may
legitimately leave it empty inside the live array.

- `msg` (*) — Value to validate.
- `[at="message"]` (string) — Address hint for error messages (e.g. "context[2]").

Returns `object` — The same `msg` reference, unchanged.

### `Context.MIME_BY_EXTENSION`

Context-owned media-type map and byte detection for content blocks.

### `Context.mimeDetect({ path, buffer } = {…})`

Determine a media type from a filename extension, then recognized leading bytes.

Returns `string` — The matching media type, or `application/octet-stream` when neither input identifies a supported type.

### `Context.mimeOf(block)`

Return a content block's media type, preferring its non-empty `mimetype`
field and then its non-empty `mime` field.

- `block` (Object|null|undefined) — Block to inspect; nullish values are allowed.

Returns `string|undefined` — The selected media type, or `undefined` when neither field is a non-empty string.

### `Context.name`

Stored or automatically derived session label.

Returns `string|undefined` — Stored or automatically derived session label.

### `Context.origin`

Origin project folder recorded in metadata.

Returns `string` — Origin project folder recorded in metadata.

### `Context.originOf({ id, dir } = {…})`

The ORIGIN FOLDER recorded in a session file's metadata line (the
cwd the session ran in), or undefined (no such session). The
resume-anywhere contract: an explicit --resume <id> makes this
folder the process cwd.

- `options` (Object)
- `options.id` (string)
- `[options.dir]` (string)

Returns `string|undefined`

### `Context.pop()`

the removed last message

Returns `object|undefined` — the removed last message

### `Context.prepend(messages)`

Insert messages at the FRONT — e.g. an Agent's seeded system
prompt, always the first message(s) of a fresh context.

- `messages` (object[])

### `Context.remove(indexes)`

Remove the messages at `indexes`.

- `indexes` (number[])

Returns `object[]` — the removed messages

### `Context.rename(newId)`

Rename the session: BOTH the stable `id` and the file's NAME
segment become `newId` (the same session — the date/uuid8 prefix
carries over unchanged) and the old file is gone. Refuses to
clobber an EXISTING other session (a directory scan by `id`, the
file name no longer being a direct function of it).

- `newId` (string)

Returns `{id: string, file: string}`

### `Context.renameById({ id, name, dir } = {…})`

Rename a STORED session by id (the sidebar/menu path for a session
no store holds open — a live one renames through its store): loads
it, renames it (see rename()) and closes it again.

- `options` (Object)
- `options.id` (string)
- `options.name` (string) — the new id/name
- `[options.dir]` (string)

Returns `{id: string, file: string}`

### `Context.resume({ id, dir, save = true } = {…})`

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

### `Context.rollback(i)`

Remove every message at index >= i (RangeError unless i is an
existing index).

- `i` (number)

Returns `object[]` — the removed messages

### `Context.get save()`

whether this context is logged to disk

Returns `boolean` — whether this context is logged to disk

### `Context.set save(value)`

Enable or disable persistence without replacing the live context. Enabling
saving makes the complete current context eligible for the next flush.

- `value` (boolean)

Returns `void` — Read save after assignment for the logging state.

### `Context.get settings()`

the owner's settings snapshot riding the
 session file (undefined: none recorded — resume keeps the caller's
 configuration)

Returns `object|undefined` — the owner's settings snapshot riding the session file (undefined: none recorded — resume keeps the caller's configuration)

### `Context.set settings(value)`

Record the owner's SETTINGS snapshot (an Agent's (safe, thinking,
  endpoint/model, name, … — Agent writes it; the store only persists
  it; a default `agent-N` name never rides the file). Only JSON-typed
  values ride the file; undefined entries are
  dropped. Marks the store dirty (the next flush is a FULL rewrite:
  the metadata line changes).

- `value` (object)

### `Context.get summary()`

one line for status/command output:
 `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise

Returns `string` — one line for status/command output: `<id> — <file>` while logging, `<id> — not logged (memory only)` otherwise

### `Context.toJSON()`

JSON form: the message array.

### `Context.TOKENS_PER_WORD`

tokens ≈ words × 4/3 (token-per-word likelihood ratio)

### `Context.tokensEstimate(text)`

Estimate a token count for text, rounding the heuristic up to a whole token.
Non-string inputs produce zero.

- `text` (*) — value to estimate when it is a string

Returns `number` — estimated whole-token count

### `Context.tokensEstimateMessages(context = [])`

Estimated token count of a whole context (the input side of a
request — also the live "window consumption" readout when no
provider-reported count exists yet). Counts words per block: the
historical one-giant-string + word-array version allocated several
full copies of the context per call, per frame. Updates the internal
per-message memo cache as needed.

- `[context=[]` (Array) — ] - context messages; each message's supported content-block text and arguments are counted

Returns `number` — estimated input tokens, rounded up to a whole token

### `Context.update(fn)`

A batch in-place change (a repair pass): `fn` receives the live
message array and returns true when it changed anything — the
context then logs a full rewrite. Stored messages are replaced,
never mutated.

- `fn` ((messages: object[]) => boolean)

Returns `boolean` — whether anything changed

### `Context.usageEstimate(context = [], message)`

Estimate usage from the request context and the assembled response.

- `[context=[]` (Array) — ] - request messages used for input estimation
- `[message=undefined]` (object) — assembled assistant message used for output estimation; its content text/arguments are concatenated before estimating

Returns `{inputTokens:number, outputTokens:number, source:"estimate"}` — estimated usage

### `Context.usageFinalize(reported, context, message)`

Normalize provider-reported usage, or fall back to estimation.
Provider numbers win per-field only as a whole: a partial/invalid
report is treated as absent (honest fallback, no mixed sources).

- `reported` (*) — connector-extracted usage; accepted only when both inputTokens and outputTokens are finite numbers, with finite cost copied through when present
- `[context=undefined]` (Array) — request context for fallback input estimation; when omitted, the estimator's empty-array default applies
- `[message=undefined]` (object) — assembled message for fallback output estimation

Returns `{inputTokens:number, outputTokens:number, source:string, cost?:number}` — provider usage or estimated fallback

### `Context.usageSummary(usage)`

Format usage as a one-line human-readable summary for host diagnostics.
Missing/falsy usage returns `usage: unknown`; a finite cost is included to
four decimal places. Does not mutate the supplied usage object.

- `usage` (object) — usage envelope with inputTokens, outputTokens, source, and optional cost

Returns `string` — formatted usage summary

### `Context.uuid`

Persistent session UUID.

Returns `string` — Persistent session UUID.

### `Context.wordCount(text)`

Count runs of non-whitespace characters without allocating a split array.
Non-string and empty inputs produce zero.

- `text` (*) — value to count when it is a string

Returns `number` — number of whitespace-separated words

### `Context.EventType = Object.freeze({…})`

The full normalized event vocabulary.

### `Context.FALLBACK_CONTEXT_WINDOWS = Object.freeze({…})`

Curated context windows for the CURRENT OpenAI tier, from the models
docs (developers.openai.com/api/docs/models, reviewed 2026-09-28 —
the gpt-6 family lists 1.05M; o-series 200K). OpenAI's API-key
surface publishes NO window anywhere (/models, /models/{id}, and the
response envelope are all bare — probed with
ai-tmp/probe-openai-models.js), so the status gauge reads this table
while a lazy registry lookup (lib/env/model-windows.js) fills the
endpoint's model cache. Any provider-published or looked-up value
outranks it. Review when a new tier ships.

### `Context.MessageType = Object.freeze({…})`

Numeric message types. 0 is reserved.

### `Context.MIME_BY_EXTENSION = Object.freeze({…})`

Context-owned media-type map and byte detection for content blocks.

### `Context.TOKENS_PER_WORD = 4 / 3`

tokens ≈ words × 4/3 (token-per-word likelihood ratio)

### `Context.assemblerCallbacks(assembler)`

Build the camelCase callback set used by Context to feed response events to
an assembler. Includes callbacks for start, text/thinking block events,
tool-call events, done, and error.

- `assembler` (ReturnType<typeof createAssembler>) — Assembler receiving the events; no default is provided.

Returns `Object<string, function(object): void>` — Callbacks keyed by names such as `onStart`, `onTextDelta`, `onDone`, and `onError`.

### `Context.assemblerCreate()`

Create an assembler that folds normalized response events into one
assistant message. Events mutate the in-progress message; valid message
snapshots on `start`, `done`, or `error` replace it. Unknown event types are
ignored, and malformed tool-call JSON is retained as raw text. The returned
message remains partial until completion and is exposed by reference.

Returns `{consume: (event: object) => void, message: () => object}` — The event consumer and accessor for the current message.

### `Context.callbacksNormalize(callbacks = {…}, binding = {…})`

Build the full callback set for a binding.

- `[callbacks={}]` (Object) — consumer-supplied callbacks, keyed by camelCase callback name. A function is used as-is; explicit `false` or `null` selects a no-op; an omitted or `undefined` callback gets the binding default.
- `[binding={}]` (Object) — binding-appropriate default handlers.
- `[binding.onData]` ((event:object)=>void) — receives every event whose callback was omitted (stdout replacement)
- `[binding.onLog]` ((line:string)=>void) — receives error reports (stderr replacement)
- `[binding.onTerminal]` ((event:object)=>void|false|null) — completes the binding; called for `done` and `error` even when the consumer supplied its own terminal callback. `false` or `null` disables this additional call.

Returns `Object` — Complete callback set keyed by camelCase names.

### `Context.contentBinary(path, buffer)`

Build a canonical base64 binary Context block without exposing the source path.

- `path` (string) — Non-empty local path; only its basename is retained.
- `buffer` (Uint8Array) — Binary data to encode.

Returns `{type: "binary", mimetype: string, filename: string, content: string}` — A block containing the basename, detected media type, and base64 data.

### `Context.contentIndexer()`

Create a per-request content-block indexer for a provider translator. `of`
reuses an index for a previously seen wire-item key, while `next` always
reserves a fresh index; indexes are dense and follow first appearance.

Returns `{of: (key: *) => number, next: () => number}` — Indexing operations.

### `Context.contentText(text)`

Wrap a value's string representation in a text content block.

- `text` (*) — Value converted with `String()`.

Returns `TextContent` — A block with `type: ContentType.Text` and the converted text.

### `Context.eventCallbackName(eventName)`

Map an event name to its camelCase callback name.
"text_delta" -> "onTextDelta"; "tool_call_start" -> "onToolCallStart".

- `eventName` (string) — normalized event name to convert.

Returns `string` — The corresponding camelCase callback name.

### `Context.eventDispatch(set, event)`

Dispatch one event through a normalized callback set. Validates the event
before invoking its matching callback; callback errors propagate to the caller.

- `set` (Object) — callback set returned by `normalizeCallbacks`.
- `event` (object) — normalized response event to dispatch.

Returns `void`

### `Context.eventValid(event)`

Is this a well-formed normalized response event (a known `type`;
indexed events carry a non-negative integer `contentIndex`)?

- `event` (*) — value to check.

Returns `boolean` — `true` for an object with a known event type and, for indexed events, a non-negative integer `contentIndex`; otherwise `false`.

### `Context.eventValidate(event)`

Validate a normalized response event (used by IO to check connector
output). Returns the same object; throws on violation.

- `event` (*) — value to validate.

Returns `object` — The same event object when it is valid.

### `Context.fallbackContextWindow(model)`

The curated fallback window for one model id, or null: an exact key,
then the longest table prefix the id starts with ("gpt-6-sol" ->
"gpt-6", "o3-2025-04-16" -> "o3").

- `model` (*) — bare model id; non-string or empty values are rejected

Returns `number|null` — matching fallback token window, or `null` when none

### `Context.messageAppend(context, message, { merge = true } = {…})`

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

Returns `object` — The stored message (the previous message when merged, otherwise the appended value).

### `Context.messageAssistant(content = [])`

Create an assistant message using the supplied content blocks.

- `[content=[]` (Content[]) — ] - Ordered content blocks; defaults to an empty array.

Returns `Message` — An assistant message whose content is the supplied array; no validation or copying is performed.

### `Context.messageErrorText(msg)`

Get the presentation text of a normalized assistant failure; tool-result
boolean errors are distinct and produce an empty string.

- `msg` (*) — Value whose error field is inspected.

Returns `string` — The error string, `error.message`, or an empty string.

### `Context.messageFile(path, buffer)`

Wrap one local file's bytes in the canonical user-message content structure.

- `path` (string) — Non-empty local file path passed to {@link binaryContent}.
- `buffer` (Uint8Array) — File bytes passed to {@link binaryContent}.

Returns `{type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>}` — A user message containing a single binary content block.

### `Context.messageHasContent(msg)`

Has this message any CONTENT a provider can consume? A block with
no payload — a text/thinking block whose text is empty, a block
reduced to its discriminator alone — is not content; an empty
content array is not content either. Chat-completions dialects
serialize an empty assistant message as `content: null` and
providers 400 the whole request over it (corrupted sessions), so
emptiness is a hard contract, not a style point.

- `msg` (*) — Value whose `content` blocks are inspected.

Returns `boolean` — True if at least one block carries provider-consumable content.

### `Context.messageHasError(msg)`

Does this message report a FAILED RESPONSE? A provider or transport
failure is normalized as the response message carrying `error` — a
text string or {message, retry} for timed rate limits — beside whatever content arrived before it (possibly
none: the error is then its whole payload). A tool result's boolean
`error: true` is not one: that is the tool's own (answered) failure.

- `msg` (*) — Value whose normalized response error is inspected.

Returns `boolean` — True for a nonempty error string or nonempty `error.message`.

### `Context.messageIsRecord(msg)`

Test whether a value is a metadata record: a non-array object with a
string `type` (not a numeric message type). Records may share context and
session files with messages; they are not messages and are skipped by
message validators. Other components pass them through unmerged or filter
them from provider-bound contexts as appropriate.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` carries a string `type`.

### `Context.messageRebuild(msg)`

Rebuild a message from recognized schema fields only — the stale
provider/cache identifier cleanup. See the module header for the
field policy.

- `msg` (object) — Message to validate and rebuild.

Returns `object` — A new message containing recognized fields only.

### `Context.messagesParse(input)`

Parse buffered CLI input into a context array using the shared grammar.
First, the entire input is parsed as JSON; if that is an array, it is
returned unchanged. Otherwise, each nonblank line is parsed independently:
message objects and valid messages in arrays are included, while other
values become user text messages containing the original line.

- `input` (string) — Complete stdin text after EOF; there is no default.

Returns `Array<object>` — The resulting context array. This is synchronous and returns no Promise.

### `Context.messagesValid(ctx)`

Test whether a value is a context array containing only core-shaped
messages and/or metadata records.

- `ctx` (*) — Value to test.

Returns `boolean` — True when `ctx` is such an array; an empty array passes.

### `Context.messagesValidate(ctx)`

Validate a context array, allowing metadata records and validating every
other entry as a message. Returns the same array reference without mutation.

- `ctx` (*) — Value to validate as a context.

Returns `Array` — The same `ctx` array, unchanged.

### `Context.messageSystem(text)`

Create a system message containing one text block made from the given value.

- `text` (*) — Value converted to a string for the text block.

Returns `Message` — A system message with one text content block.

### `Context.messageUser(text, metadata = undefined)`

Create a user message from plain text or an existing ordered block array.
Non-array input is converted to a text block; array input is used as-is.
If supplied, metadata is spread over the message and can override its fields.

- `text` (string|Content[]|*) — Plain-text value to convert, or an array of content blocks to preserve.
- `[metadata=undefined]` (*) — Optional value whose enumerable own properties are spread last onto the message.

Returns `Message` — The resulting user message.

### `Context.messageValid(msg)`

Test whether a value has the core message shape: a non-array object with
a numeric `type` and an array `content`.

- `msg` (*) — Value to test.

Returns `boolean` — True when `msg` has the core message shape.

### `Context.messageValidate(msg, at = "message")`

Validate a message's CORE SHAPE, throwing on a violation.
Returns the SAME object reference — metadata is never copied,
stripped, or reordered. Emptiness is deliberately NOT part of the
shape: appendMessage REFUSES (drops) an empty incoming message,
and IO DROPS empty messages from every provider-bound context
(no dialect can carry one), while a merge that consumed an
incoming message's whole payload into the previous message may
legitimately leave it empty inside the live array.

- `msg` (*) — Value to validate.
- `[at="message"]` (string) — Address hint for error messages (e.g. "context[2]").

Returns `object` — The same `msg` reference, unchanged.

### `Context.mimeDetect({ path, buffer } = {…})`

Determine a media type from a filename extension, then recognized leading bytes.

Returns `string` — The matching media type, or `application/octet-stream` when neither input identifies a supported type.

### `Context.mimeOf(block)`

Return a content block's media type, preferring its non-empty `mimetype`
field and then its non-empty `mime` field.

- `block` (Object|null|undefined) — Block to inspect; nullish values are allowed.

Returns `string|undefined` — The selected media type, or `undefined` when neither field is a non-empty string.

### `Context.tokensEstimate(text)`

Estimate a token count for text, rounding the heuristic up to a whole token.
Non-string inputs produce zero.

- `text` (*) — value to estimate when it is a string

Returns `number` — estimated whole-token count

### `Context.tokensEstimateMessages(context = [])`

Estimated token count of a whole context (the input side of a
request — also the live "window consumption" readout when no
provider-reported count exists yet). Counts words per block: the
historical one-giant-string + word-array version allocated several
full copies of the context per call, per frame. Updates the internal
per-message memo cache as needed.

- `[context=[]` (Array) — ] - context messages; each message's supported content-block text and arguments are counted

Returns `number` — estimated input tokens, rounded up to a whole token

### `Context.usageEstimate(context = [], message)`

Estimate usage from the request context and the assembled response.

- `[context=[]` (Array) — ] - request messages used for input estimation
- `[message=undefined]` (object) — assembled assistant message used for output estimation; its content text/arguments are concatenated before estimating

Returns `{inputTokens:number, outputTokens:number, source:"estimate"}` — estimated usage

### `Context.usageFinalize(reported, context, message)`

Normalize provider-reported usage, or fall back to estimation.
Provider numbers win per-field only as a whole: a partial/invalid
report is treated as absent (honest fallback, no mixed sources).

- `reported` (*) — connector-extracted usage; accepted only when both inputTokens and outputTokens are finite numbers, with finite cost copied through when present
- `[context=undefined]` (Array) — request context for fallback input estimation; when omitted, the estimator's empty-array default applies
- `[message=undefined]` (object) — assembled message for fallback output estimation

Returns `{inputTokens:number, outputTokens:number, source:string, cost?:number}` — provider usage or estimated fallback

### `Context.usageSummary(usage)`

Format usage as a one-line human-readable summary for host diagnostics.
Missing/falsy usage returns `usage: unknown`; a finite cost is included to
four decimal places. Does not mutate the supplied usage object.

- `usage` (object) — usage envelope with inputTokens, outputTokens, source, and optional cost

Returns `string` — formatted usage summary

### `Context.wordCount(text)`

Count runs of non-whitespace characters without allocating a split array.
Non-string and empty inputs produce zero.

- `text` (*) — value to count when it is a string

Returns `number` — number of whitespace-separated words

## Env

### `class Env`

The sole global environment object: settings, auth, providers,
tools, and the titled folder surface.

### `Env.agentAdd(agent)`

Register an active Agent (Agent construction owns this call); it
stays until `Agent.close()` removes it.

- `agent` (object)

Returns `object` — the registered agent

### `Env.agentCreate(options = {…})`

Create an Agent over this env (`env` is always this env).

- `[options]` (object) — Agent constructor options

Returns `object` — the new, registered Agent

### `Env.agentRemove(agent)`

Remove an active Agent (`Agent.close()` owns normal use).

- `agent` (object)

Returns `boolean` — whether the agent was registered

### `Env.agents()`

Snapshot the active Agents in registration order. Closing an Agent
removes it synchronously; inactivity and garbage collection never
change this lifecycle registry.

Returns `object[]`

### `Env.close()`

Release what this Env runs in the background: pending model-list
retries stop, every MCP server it started is killed, and held
settings writes reach disk. Idempotent; never throws. A closed Env
stays readable (and an MCP call reconnects).

### `Env.connection(selector, { remember = true } = {…})`

IO's handle on one pair: {endpoint, model, Protocol, url, settings,
authSet(data), authReload(current)} (lib/env/models.js). An unknown
endpoint, or a model its non-empty catalog lacks, throws.

- `selector` (string) — `<endpoint>/<model>`

Returns `object`

### `Env.constructor({ dir = PACKAGE_DIR, settingsDir, cwd = process.cwd(), settings, sessionsDir, providers, toolDirs, skillDirs, promptDirs, themes = false, auth = true } = {…})`

Build the environment: scan and merge the layered settings (the
package folder, user settings folder, and namespaced project
files — see lib/env/load.js), seed the titled folder surface,
register the built-in tools. Providers and tools load afterwards
(loadProviders/loadTools).

- `[options]` (Object)
- `[options.dir]` (string) — package folder to scan (default: this package's root)
- `[options.settingsDir]` (string|null) — the USER SETTINGS folder (default: the namespace setting or namespace home folder, created when missing) — scanned after the package folder and the target of every dynamic settings write; null disables the layer (embedded/test hosts)
- `[options.cwd]` (string) — the PROJECT folder (default: process.cwd()) — separate from `dir` so a test (or an embedding host) can isolate both independently; consumed by the folder surface below and by the system prompt's project-local AGENTS.md layer (env.systemPrompt())
- `[options.settings]` (Object) — explicit settings, merged LAST (override)
- `[options.sessionsDir]` (string) — ephemeral session log folder for this Env only; relative to cwd, overrides configured sessions without writing settings. Must be a non-empty path.
- `[options.providers]` (Object<string, Function>) — extra provider classes by name (embedders, tests); they take precedence over a scanned class of the same name
- `[options.toolDirs]` (string[]) — the tool roots Env.create scans instead of the default ones (embedders, tests)
- `[options.skillDirs]` (string[]) — the skill roots read instead of the accumulated default layers (embedders, tests)
- `[options.promptDirs]` (string[]) — the prompt roots, likewise
- `[options.themes=false]` (boolean) — scan trusted theme roots; application hosts opt in without mutating shared constructor state
- `[options.auth=true]` (boolean) — retain credentials from settings layers; false strips all nested auth fields for reduced tool-worker environments (not filesystem read confinement)

### `Env.create(options, initOptions = {…})`

Create a ready-to-use environment. Construction loads synchronous
settings first; this factory then loads the asynchronous provider and
tool registries, so callers never receive a half-initialized Env, and
starts the BACKGROUND model collection (context windows, live model
lists): models() answers grow as data arrives, each change emits
Env.EVENT.MODELS_CHANGED, and env.modelsReady settles after the first
pass. Short-lived hosts that never read models pass `models: false`.

- `[options]` (ConstructorParameters<typeof Env>[0])

Returns `Promise<Env>`

### `Env.cwd`

The current project folder; assigning changes the project-facing folder/read surface.

Returns `string` — The current project folder; assigning changes the project-facing folder/read surface.

### `Env.EVENT`

The Env event vocabulary: Symbol constants for onEvent/offEvent.
Env events report what EXISTS in this environment: the native
MODELS_CHANGED (models() answers differently — re-read it) and the
membership events plugins install (Agent's AGENT_ADDED/AGENT_REMOVED);
what an object does is that object's own events.

### `Env.extend(plugin)`

Install a higher layer's Env members after the fact (a plugin):
`methods`/`getters` land on Env.prototype and run on the env they
were reached through (the safe view included); `events` add Symbol
keys to Env.EVENT; `settings` add the layer's settings keys to the
defaults schema. An existing name throws — plugins extend Env,
never override it (lib/env/extend.js).

Returns `{EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void}` — the plugin's own event symbols and its (sole) way to emit them

### `Env.get folders()`

The folders that matter to a session, computed from current state
(the project folder follows `cwd`): exactly one `project` and one
`harness` (the package folder in use), the user `settings` folder
unless disabled, then each tool root.

Returns `ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>`

### `Env.login(name, config, options)`

Log an endpoint in — one transaction (lib/env/login.js): credentials
(`auth`, else the provider shapes `token`), then with a `scope` the
endpoint persists, is verified (the provider's connection test, then
`verify(models)` over its new catalog entries) and its models are
fetched — any failure rolls memory and files back. Without a scope
the registration is in-memory only (an invocation-only endpoint);
its models arrive in the background.

- `name` (string) — the endpoint name

Returns `Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>`

### `Env.loginPresets()`

The login presets every non-secret provider publishes ({name, label,
url, provider, oauth?, note?, ...}).

Returns `object[]`

### `Env.logout(name)`

Remove an endpoint (the /logout contract): its configuration and auth
files go with every in-memory trace; an environment-detected endpoint
clears in memory only.

- `name` (string)

Returns `{name: string, dynamic: boolean}`

### `Env.models(secret = false)`

The model catalog: every known endpoint/model pair with its state
already computed (lib/env/models.js ModelInfo — caps, secret,
loginRequired, lastUsed, plugin capacity fields). The Map and outer
records are snapshots, but nested capability values may reference shared
environment/provider state. Mutate deliberately; this is not a defensive
deep copy. Re-read on Env.EVENT.MODELS_CHANGED.

- `[secret=false]` (boolean) — include hidden pairs (flagged `secret`)

Returns `Map<string, object>` — `endpoint/model` -> ModelInfo

### `Env.get modelsReady()`

Settles when the background collection's first pass has answered
(one-shot hosts: list models, resolve an endpoint-only selector) —
including the lists of in-memory logins, fetched now on demand.
Resolved at once when no collection runs.

Returns `Promise<void>`

### `Env.offEvent(handle)`

Remove the listener registered with {@link onEvent}.

- `handle` (number) — opaque handle returned by onEvent

Returns `boolean` — true if a listener was removed; otherwise false

### `Env.onEvent(event, callback)`

Subscribe to an Env event (distinct from Agent.onEvent's numeric
events — these are Symbols). Env events report MEMBERSHIP only; each
is an Env.EVENT key a plugin installed (Env.extend) — Agent's
AGENT_ADDED/AGENT_REMOVED ({agent}).

- `event` (symbol) — one Env.EVENT constant
- `callback` ((payload: object) => void)

Returns `number` — opaque handle (offEvent removes it)

### `Env.prompts()`

The merged prompts (same layers; a later same-named prompt
replaces an earlier one), read fresh from disk — same entry shape.

Returns `Map<string, {name: string, description: string, file: string, source: string, body: string}>`

### `Env.get settings()`

The LIVE settings view (lib/env/settings-view.js): reads apply the
defaults schema and derived values (`settings.sessions` is the
resolved sessions folder); assigning or deleting a key persists
only that change, coalesced per tick, to the layer file that owns it
(never the package folder). Nested data is live shared state. Arrays must
currently be replaced to trigger persistence/events; their in-place
mutation semantics remain under consideration.

Returns `Object`

### `Env.settingsSchema()`

The DEFAULTS SCHEMA: every top-level settings key Env (or a
loaded tool — see the tools.js module contract's `settingsSchema()`)
understands, its default and a one-line description. Discovery
only (`ai init`, API.md) — an unknown settings key is never
rejected either way.

Returns `Object} key -> {default, description`

### `Env.skillResource(name, path)`

List available skill-relative identifiers when path is omitted, or read
an existing resource (last existing layer wins). Metadata listings are not
required for reads. No activation, writes, or execution. Listings exclude
SKILL.md, observed symlinks, and installation paths. The caller owns returned
bytes. Reads are fresh, bounded to 16 MiB, O(catalog scan + layers + file bytes),
and retry-safe.

- `name` (string) — Skill name; surrounding whitespace is trimmed.
- `[path]` (string) — Forward-slash relative resource filename; omit to list.

Returns `Promise<Buffer|string[]>` — Exact file bytes or sorted identifiers.

### `Env.skills()`

Effective skills, read fresh from package/settings/configured/environment/
project layers. Later bodies override; {{name}} and {{name[L1-L2]}}
explicitly compose bodies (self references use the previous definition).
Line ranges are 1-based/inclusive over expanded bodies, excluding metadata.
Unknown placeholders remain literal; cycles/invalid known ranges throw.

Returns `Map<string, {name: string, description: string, file: string, source: string, body: string}>`

### `Env.systemPrompt()`

The system-prompt text(s) seeded into a FRESH context, read from
disk on every call (package, user settings, then project
AGENTS.md — or `settings.system`), with `{{skill}}` prefill.

Returns `string[]` — zero to three texts, in layering order

### `Env.toolAdd(name, fn, schema, { builtin = false, file } = {…})`

Register a tool into the flattened callable lookup
(lib/env/tool-registry.js — the safe/interactive schema metadata
contract lives there).

- `name` (string) — flattened tool name
- `fn` (Function) — the callable
- `schema` (object) — MCP-like {description, inputSchema, safe?, interactive?, sandbox?, onTimeout?, readOnly?}; readOnly(args) classifies optional mutating invocations as sequential barriers.

Returns `Function` — fn

### `Env.toolCall(name, args, context)`

Invoke one tool (lib/env/tool-registry.js). The context is handed to
the tool as its second argument; Env reads: `safe` (refuse a tool
that is not read-only), `selector` + `io` (the pair's provider tool
serves first; undefined falls through to the global tool), `signal`
and `deadline`, and adds `statusSet(info)` — the tool's own live
status. Missing names are ordinary errors, never a crash.

- `name` (string)
- `args` (object)
- `[context]` (object)

Returns `Promise<*>` — the tool's return value

### `Env.tools(safe = false, selector)`

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

## GTUI

### `GTUI.effect = freeze({…})`

Immutable constructors for host, task, timer, theme, and lifecycle effects.

### `GTUI.effect.after(ms, message)`

Describe delayed message delivery.

- `ms` (number) — delay in milliseconds
- `message` (object) — message to dispatch

Returns `object` — frozen timer effect

### `GTUI.effect.cancel(key)`

Describe cancellation of a keyed task.

- `key` (*) — task identity

Returns `object` — frozen cancellation effect

### `GTUI.effect.copy(text, id)`

Request host-mediated text copying.

- `text` (string) — text to copy
- `[id]` (*) — optional correlation identifier

Returns `object` — frozen copy effect

### `GTUI.effect.notify(text)`

Request a host notification.

- `text` (string) — notification text

Returns `object` — frozen notification effect

### `GTUI.effect.open(url)`

Request host-mediated URL opening.

- `url` (string) — URL to open

Returns `object` — frozen open effect

### `GTUI.effect.quit(code = 0)`

Request application shutdown.

- `[code=0]` (number) — completion status code

Returns `object` — frozen quit effect

### `GTUI.effect.refresh()`

Request a render without changing the model.

Returns `object` — frozen refresh effect

### `GTUI.effect.task(key, run)`

Describe an abortable asynchronous task.

- `key` (*) — task identity
- `run` (Function) — async task receiving signal and send

Returns `object` — frozen task effect

### `GTUI.effect.theme(tokens)`

Replace theme tokens at runtime.

- `tokens` (object) — theme token mapping

Returns `object` — frozen theme effect

### `GTUI.event = freeze({…})`

Immutable constructors for messages delivered to an application update function.

### `GTUI.event.copyDone(payload)`

Create a completed-copy event.

- `payload` (object) — event fields

Returns `object` — frozen copy-done event

### `GTUI.event.focus(payload)`

Create a focus event.

- `payload` (object) — event fields

Returns `object` — frozen focus event

### `GTUI.event.inputChange(payload)`

Create an input-change event.

- `payload` (object) — event fields

Returns `object` — frozen input-change event

### `GTUI.event.inputSubmit(payload)`

Create an input-submit event.

- `payload` (object) — event fields

Returns `object` — frozen input-submit event

### `GTUI.event.key(payload)`

Create a key event.

- `payload` (object) — event fields

Returns `object` — frozen key event

### `GTUI.event.linkOpen(payload)`

Create a link-open event.

- `payload` (object) — event fields

Returns `object` — frozen link-open event

### `GTUI.event.menuCancel(payload = {…})`

Create a menu-cancel event.

- `[payload={}]` (object) — event fields

Returns `object` — frozen menu-cancel event

### `GTUI.event.menuSelect(payload)`

Create a menu-selection event.

- `payload` (object) — event fields

Returns `object` — frozen menu-selection event

### `GTUI.event.paste(payload)`

Create a paste event.

- `payload` (object) — event fields

Returns `object` — frozen paste event

### `GTUI.event.pointer(payload)`

Create a pointer event.

- `payload` (object) — event fields

Returns `object` — frozen pointer event

### `GTUI.event.resize(payload)`

Create a resize event.

- `payload` (object) — event fields

Returns `object` — frozen resize event

### `GTUI.event.selectionCopy(payload)`

Create a selection-copy event.

- `payload` (object) — event fields

Returns `object` — frozen selection-copy event

### `GTUI.event.taskDone(payload)`

Create a completed-task event.

- `payload` (object) — event fields

Returns `object` — frozen task-done event

### `GTUI.event.taskFailed(payload)`

Create a failed-task event.

- `payload` (object) — event fields

Returns `object` — frozen task-failed event

### `class GTUI`

Run a synchronous application against a GTUI host.
The application supplies init, update, view, and optional bindings/dispose;
update transitions may return effects. GTUI applies messages, renders views,
and manages host/task/timer cleanup.

### `GTUI.constructor({ host, theme = {…} } = {…})`

Create a runtime for a host.

Returns `GTUI` — configured runtime

### `GTUI.dispatch(message)`

Deliver one message immediately to the running application.

- `message` (object) — application message

Returns `void`

### `GTUI.run(app)`

Start an application and return its eventual completion result.

Returns `Promise<{reason: string, code: number}>` — completion promise; rejects on runtime failure

### `GTUI.stop(reason = "stop", code = 0)`

Stop the application, canceling tasks and timers and restoring the host.

- `[reason="stop"]` (string) — completion reason
- `[code=0]` (number) — completion code

Returns `void`

### `GTUI.host = freeze({…})`

Host constructors for tests and terminal execution.

### `GTUI.host.memory(...)`

Create a memory host for deterministic application tests.

### `GTUI.host.terminal(...)`

Create a terminal host for interactive execution.

### `GTUI.view = freeze({…})`

Immutable constructors for renderable view nodes.

### `GTUI.view.button(props = {…}, label = "")`

Create a button node; activation emits `action.select {id, action}`.
`pressed` styles an on toggle and `tone` adds a role.

- `[props={}]` (object) — button properties
- `[label=""]` (*) — label converted to a string

Returns `object` — frozen button node

### `GTUI.view.column(...)`

Create an immutable vertical container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen column node

### `GTUI.view.feed(props = {…})`

Create an immutable feed control.

- `[props={}]` (object) — feed properties

Returns `object` — frozen feed node

### `GTUI.view.footer(props = {…}, items = [])`

Build a one-line footer of app-pushed notification items, aligned start/end;
tight rows drop lowest priority first. Empty items yield null.

- `[props={}]` (object) — row properties
- `[items=[]` (Array<object>) — ] items with text and optional role, priority, align, action

Returns `object|null` — frozen footer row, or null when empty

### `GTUI.view.grid(...)`

Create an immutable grid container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen grid node

### `GTUI.view.input(props = {…})`

Create an immutable text input control.

- `[props={}]` (object) — input properties

Returns `object` — frozen input node

### `GTUI.view.menu(props = {…})`

Create an immutable menu control.

- `[props={}]` (object) — menu properties

Returns `object` — frozen menu node

### `GTUI.view.overlay(...)`

Create an immutable overlay container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen overlay node

### `GTUI.view.panel(...)`

Create an immutable bordered panel.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen panel node

### `GTUI.view.row(...)`

Create an immutable horizontal container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen row node

### `GTUI.view.scroll(...)`

Create an immutable scroll container.

- `[props={}]` (object) — node properties
- `[children=[]` (Array|*) — ] child nodes

Returns `object` — frozen scroll node

### `GTUI.view.table(props = {…}, rows = [])`

Create an immutable table with frozen rows and cells.

- `[props={}]` (object) — table properties
- `[rows=[]` (object[]) — ] rows; each row's cells are copied and frozen

Returns `object` — frozen table node

### `GTUI.view.text(props = {…}, content = "")`

Create immutable text content.

- `[props={}]` (object) — text-node properties
- `[content=""]` (*) — text content

Returns `object` — frozen text node

### `GTUI.view.toolbar(...)`

Create a horizontal toolbar container with host-owned roving focus.
Children use `{id, focus, gap?, align?: "end"}`; while focused, navigation
keys move focus and Enter/Space activate; other keys bubble.

- `[props={}]` (object) — toolbar properties
- `[children=[]` (Array|*) — ] button children

Returns `object` — frozen toolbar node

### `GTUI.memory({ width = 80, height = 24, scrollBar } = {…})`

Create an in-memory host for application tests. It records rendered
semantics and effects; it never emits terminal bytes.

Returns `object` — in-memory host implementing the GTUI host protocol

### `GTUI.memory._effect(value, send)`

Record an effect and acknowledge copy effects asynchronously.

- `value` (object) — effect descriptor
- `[send]` (Function) — callback receiving the copy acknowledgement

Returns `void`

### `GTUI.memory._render(next)`

Render a view through the in-memory layout engine.

- `next` (object) — view tree

Returns `void`

### `GTUI.memory._restore()`

Clear runtime callbacks and record host restoration.

Returns `void`

### `GTUI.memory._setTheme(theme)`

Install the resolved theme for subsequent layouts.

- `theme` (object) — resolved theme

Returns `void`

### `GTUI.memory._start(listener, binding)`

Start the runtime-to-host message protocol.

- `listener` (Function) — callback for incoming messages
- `binding` (Function) — predicate for bound key messages

Returns `void`

### `GTUI.memory.get effects()`

Recorded effects, copied so callers cannot mutate host state.

Returns `object[]` — shallow copy of recorded effects

### `GTUI.memory.flush()`

Finish pending host output; memory hosts have nothing to flush.

Returns `void`

### `GTUI.memory.get restoreCount()`

Number of completed host restoration cycles.

Returns `number` — restoration count

### `GTUI.memory.send(message)`

Send a host input message to the mounted application.

- `message` (object) — input message

Returns `void`

### `GTUI.memory.snapshot()`

Return the current rendered scene in semantic, testable form.

Returns `object` — scene snapshot with current dimensions

### `GTUI.scrollGlyph(value, fallback)`

Validate a one-cell grapheme for use as a scroll indicator.

- `value` (*) — candidate glyph
- `fallback` (*) — result when candidate is invalid

Returns `*` — candidate when it is a one-cell grapheme, otherwise fallback

### `GTUI.terminal(options = {…})`

Construct a terminal host that owns input decoding and terminal rendering,
or return `options.host` unchanged.

- `[options={}]` (object) — terminal streams, mode, dimensions, and policies

Returns `object` — supplied or newly-created GTUI host

## index

### `default namespace`

Primary headless library namespace. Exports are explicit so private Agent
statics and future implementation details cannot leak through the barrel.

### `default.Agent`

Public Agent namespace member; see its owning module for the contract.

### `default.Context`

Public Context namespace member; see its owning module for the contract.

### `default.Env`

Public Env namespace member; see its owning module for the contract.

### `default.EVENT`

Public EVENT namespace member; see its owning module for the contract.

### `default.EVENT_CALLBACKS`

Public EVENT_CALLBACKS namespace member; see its owning module for the contract.

### `default.finishAdd`

Public finishAdd namespace member; see its owning module for the contract.

### `default.finishRun`

Public finishRun namespace member; see its owning module for the contract.

### `default.finishSignalsArm`

Public finishSignalsArm namespace member; see its owning module for the contract.

### `default.IO`

Public IO namespace member; see its owning module for the contract.

### `default.Jobs`

Public Jobs namespace member; see its owning module for the contract.

### `default.NAMES`

Public NAMES namespace member; see its owning module for the contract.

### `default.reseat`

Public reseat namespace member; see its owning module for the contract.

### `default.TOOL_TIMEOUT_DEFAULT`

Public TOOL_TIMEOUT_DEFAULT namespace member; see its owning module for the contract.

## index_app

### `default namespace`

Full application entry point. The Agent module owns the headless core tree
(`{ Context, Env, IO, Agent }`). This opt-in layer adds presentation and
application concerns: CLI and App (App.Markdown, App.TUI, App.Web, App.GTUI).
Jobs remains in the primary library entry because tools and
non-application hosts use it.

### `default.Agent`

Public Agent namespace member; see its owning module for the contract.

### `default.App`

Public App namespace member; see its owning module for the contract.

### `default.CLI`

Public CLI namespace member; see its owning module for the contract.

### `default.Context`

Public Context namespace member; see its owning module for the contract.

### `default.Env`

Public Env namespace member; see its owning module for the contract.

### `default.EVENT`

Public EVENT namespace member; see its owning module for the contract.

### `default.EVENT_CALLBACKS`

Public EVENT_CALLBACKS namespace member; see its owning module for the contract.

### `default.finishAdd`

Public finishAdd namespace member; see its owning module for the contract.

### `default.finishRun`

Public finishRun namespace member; see its owning module for the contract.

### `default.finishSignalsArm`

Public finishSignalsArm namespace member; see its owning module for the contract.

### `default.IO`

Public IO namespace member; see its owning module for the contract.

### `default.Jobs`

Public Jobs namespace member; see its owning module for the contract.

### `default.NAMES`

Public NAMES namespace member; see its owning module for the contract.

### `default.reseat`

Public reseat namespace member; see its owning module for the contract.

### `default.TOOL_TIMEOUT_DEFAULT`

Public TOOL_TIMEOUT_DEFAULT namespace member; see its owning module for the contract.

## IO

### `IO.Context`

The Context namespace for validating every provider-bound request.

### `IO.Env`

The global environment constructor used by IO and provider authors.

### `class IO`

One provider IO session: context in, normalized response events out.

### `IO.authSet(auth, options)`

Route auth persistence to the endpoint's namespace and refresh the
live settings view.

- `auth` (object) — Authentication data to persist.

Returns `object` — The persisted endpoint section returned by the Env connection.

### `IO.close()`

Cancel the active request (terminal partial emitted by the in-flight
write), close the connection, permanently disconnect the instance.

Returns `Promise<void>` — Resolves after request finalization and connection teardown; repeated calls after closure resolve immediately.

### `IO.connectionCreate({ signal, onBytes } = {…})`

A fresh provider connection over this endpoint/model for a
provider tool's one-off request (context2msg/send/read/close);
the caller closes it.

- `[options={}]` (object) — Connection options.
- `[options.signal]` (AbortSignal) — Signal assigned to abort its transport.
- `[options.onBytes]` ((bytes: Uint8Array) => void) — Raw response-byte progress callback.

Returns `object` — A newly constructed provider connection; caller owns and must close it.

### `IO.connectTimeout`

Connection watchdog in milliseconds.

Returns `number` — Connection watchdog in milliseconds.

### `IO.constructor({ env, model, url, timeout, connectTimeout, stuckTimeout, settings, tools, safe = false, onData, onLog, remember = true, ...options } = {…})`

Configure one provider IO session. Resolves the registered endpoint and
provider, then selects URL and timeouts from explicit options, live
provider settings, provider metadata, and defaults, in that order.

- `[options={}]` (Object) — Constructor options.
- `options.env` (object) — Env registry; required.
- `options.model` (string) — Registered `<endpoint>/<model>` selector.
- `[options.url]` (string) — URL override; otherwise use the resolved endpoint URL.
- `[options.timeout]` (number|string) — Overall request cap; otherwise settings/metadata or 1048575 ms.
- `[options.connectTimeout]` (number|string) — Connection timeout; otherwise settings/metadata or 30000 ms.
- `[options.stuckTimeout]` (number|string) — Reading watchdog; otherwise settings/metadata or 120000 ms.
- `[options.settings={}]` (object) — Per-invocation settings merged over the live provider namespace; not persisted.
- `[options.tools]` (string[]) — Tool selection: omitted or ["*"] means all, [] none, otherwise the named subset.
- `[options.safe=false]` (boolean) — Whether to publish read-only tools only.
- `[options.onData]` ((event:object)=>void) — Optional default data callback.
- `[options.onLog]` ((line:string)=>void) — Optional default log callback.
- `[options.remember=true]` (boolean) — Whether Env.connection records this pair as last used.

Returns `IO` — The initialized provider IO session.

### `IO.Context`

The Context namespace for validating every provider-bound request.

### `IO.get contextUsage()`

The provider-reported context readout of the CURRENT/last request:
`{used, total}` in tokens, each undefined when the provider hasn't
reported it. Providers update it during a request via
contextUsage() (e.g. from a usage frame or model metadata);
IO itself fills `used` from the terminal usage envelope when the
provider left it unset. Consumers (Agent) read it after write()
resolves; missing data is their cue to approximate.

Returns `{used: number|undefined, total: number|undefined}` — A defensive copy of the current/last request report.

### `IO.set contextUsage({ used, total } = {…})`

Report actual context consumption and/or the model's available
context window (provider → IO channel; connectors call this from
their translators/metadata surfaces). Finite numbers merge over the
current report; anything else is ignored.

Returns `void` — Read contextUsage after assignment for the merged report.

### `IO.env`

The shared live environment.

Returns `Env` — The shared live environment.

### `IO.Env`

The global environment constructor used by IO and provider authors.

### `IO.fetch(url, init = {…}, { deadline, connectTimeout } = {…})`

fetch bounded by a wall-clock deadline and a fast connect fail-fast
(provider tools' plain HTTP requests).

- `url` (string|URL) — Request URL.
- `[init={}]` (object) — Fetch initialization; any supplied signal is honored.

Returns `Promise<Response>` — Resolves to the fetch response.

### `IO.get model()`

Qualified endpoint/model selector; assignment changes the model only while idle and on this connection's endpoint.

Returns `string` — Qualified endpoint/model selector; assignment changes the model only while idle and on this connection's endpoint.

### `IO.set model(selector)`

Select a model on the same endpoint. Validation precedes mutation; busy/closed IO refuses selection. @param {string} selector Qualified model. @throws {TypeError|ProviderError} Invalid, cross-endpoint, busy, or closed selection.

### `IO.get modelCurrent()`

Get the effective model, preferring the current request override.

Returns `string` — Qualified request model override, or the qualified instance model.

### `IO.name`

Connection endpoint name.

Returns `string` — Connection endpoint name.

### `IO.get planUsage()`

The provider-reported PLAN/QUOTA readout (rate limits, subscription
allowances): `{label?, quotas}` where each quota entry is
`{total?, remaining?, used?, reset?}` — whatever the provider
publishes, nothing invented. null until the provider reports.
Unlike contextUsage it is LAST-KNOWN (never reset per request — a
quota snapshot stays meaningful between requests).

Returns `{label?: string, quotas: Object}|null` — A defensive copy of the last complete report, or null before any report.

### `IO.set planUsage({ label, quotas } = {…})`

Report plan/quota usage (provider → IO channel; connectors call
this from their reportPlanUsage hook or metadata surfaces). Each
call is ONE COMPLETE SNAPSHOT of what one response publishes: the
last-known report is REPLACED, never merged — a quota a response
stops publishing is gone (merged leftovers would keep showing a
previous endpoint's plan after an endpoint switch — see
lib/agent/run.js, which hands the report straight to the agent).
Tolerant reader: only finite numbers and non-empty strings are
kept.

Returns `void` — Read planUsage after assignment for the stored report.

### `IO.protocol`

Provider protocol registry name.

Returns `string` — Provider protocol registry name.

### `IO.Provider`

Wire-completed provider constructor for trusted host/provider code.

Returns `Function` — Wire-completed provider constructor for trusted host/provider code.

### `IO.provider`

Live provider metadata; never serialize wholesale to a model.

Returns `object` — Live provider metadata; never serialize wholesale to a model.

### `IO.ProviderError`

The stable provider failure class (auth/network/provider/malformed).

### `IO.get requestSignal()`

Get the active request's abort signal for the HTTP backend.

Returns `AbortSignal|undefined` — The signal, or undefined when no controller exists.

### `IO.get settings()`

Build the live provider-namespaced settings view with per-instance
overrides applied. The returned `think` is the model's native mode,
mapped from the library level and narrowed by model/provider capabilities.

Returns `object` — A fresh merged settings object; undefined native thinking means provider default.

### `IO.settingsSet(key, value)`

Set/clear a per-invocation settings override AFTER construction
(e.g. Agent's /agent-thinking toggling `think` on a live connection).

- `key` (string)
- `value` (*) — Value to override; `undefined` clears the override.

Returns `void`

### `IO.get state()`

Read the request state machine's current state.

Returns `"idle"|"sending"|"reading"|"closed"` — Current lifecycle state.

### `IO.stuckTimeout`

Reading watchdog in milliseconds.

Returns `number` — Reading watchdog in milliseconds.

### `IO.THINKING_LEVELS`

Selectable thinking levels, weakest -> strongest (IO maps them to native modes).

### `IO.timeout`

Overall request timeout in milliseconds.

Returns `number` — Overall request timeout in milliseconds.

### `IO.timeoutsResolve({ env, model, timeout, settings } = {…})`

Resolve effective per-request timeout values using IO's precedence and defaults.

### `IO.tools()`

Return this request's publishable tool catalog, filtered by availability,
safe mode, configured selection, and the endpoint's provider tools.

Returns `Array<{name: string, ...Object}>` — Fresh tool descriptors; secret tools are excluded.

### `IO.url`

Effective request URL.

Returns `string` — Effective request URL.

### `IO.write(context, callbacks = {…}, options = {…})`

Run one provider request over a complete context.

- `context` (Array) — Complete context; metadata records and empty messages are filtered before validation/provider conversion.
- `[callbacks={}]` (Object) — CamelCase response callbacks for this request.
- `[options={}]` (Object) — Per-request overrides.
- `[options.model]` (string) — Qualified `<endpoint>/<model>` override on the same endpoint. Construct another IO to switch endpoints.
- `[options.timeout]` (number|string) — Overall request cap override.
- `[options.connectTimeout]` (number|string) — Connection timeout override.
- `[options.stuckTimeout]` (number|string) — Reading watchdog override.

Returns `Promise<object>` — Resolves with the terminal done/error event. Rejects TypeError for split, invalid, or cross-endpoint model overrides without reserving the instance; rejects ProviderError for a closed/busy instance or malformed context.

### `class ProviderError extends Error`

The stable provider failure class (auth/network/provider/malformed).

### `IO.ProviderError.constructor(kind, message, detail = {…})`

Build a classified error, assigning the supplied detail fields onto it.

- `kind` ("auth"|"network"|"provider"|"malformed") — failure class; not validated by this constructor
- `message` (string) — error message passed to {@link Error}
- `[detail={}]` (object) — enumerable metadata fields to copy onto the error; may override existing fields

Returns `ProviderError` — The constructed error instance.

### `IO.THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"]`

Selectable thinking levels, weakest -> strongest (IO maps them to native modes).

### `IO.timeoutsResolve({ env, model, timeout, settings } = {…})`

Resolve effective per-request timeout values using IO's precedence and defaults.

## Jobs

### `class Jobs`

Frozen static namespace for the folder-only Jobs operations exported by this
module. Instances have no API; use the static methods/properties instead.

- `...args` (never) — No constructor arguments are accepted.

Returns `Jobs` — A Jobs namespace instance (normally unused; use static members).

### `Jobs.daemonRun(projectRoot, options = {…})`

Run a foreground best-effort daemon bound to the project root.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Daemon options; supports `signal`, `state`, `execution`, `scan`, and `delay`.

Returns `Promise<void>` — Resolves when stopped or Jobs becomes unusable; rejects on initial validation or daemon errors.

### `Jobs.disable(projectRoot, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

### `Jobs.init(projectRoot, settings = {…}, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

### `Jobs.JobsError`

Error type used for actionable Jobs failures.

### `Jobs.run(projectRoot, options = {…})`

Dispatch one best-effort serial scan of due Jobs.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Scan options, including injected clock, filesystem, validation, executor, and execution settings.

Returns `Promise<object>` — Frozen scan result containing outcomes, errors, warnings, and optional error-log path.

### `Jobs.schedule(root, command, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

### `Jobs.status(projectRoot, options = {…})`

Read a non-mutating projection of Jobs eligibility, tasks, schedule, attempts, and last scan.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Options such as clock, defaults, and validation context.

Returns `Promise<object>` — Status projection with diagnostics; does not create folders or start a daemon.

### `Jobs.validate(root, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

### `class JobsError extends Error`

Error type used for actionable Jobs failures.

### `Jobs.JobsError.constructor(code, message, details = {…})`

Create a coded jobs-domain error.

- `code` (string) — Stable error code identifying the failure.
- `message` (string) — Human-readable error message passed to `Error`.
- `[details={}]` (object) — Optional contextual data, such as a task filename or underlying cause.

Returns `JobsError` — The initialized error instance.

### `async Jobs.daemonRun(projectRoot, options = {…})`

Run a foreground best-effort daemon bound to the project root.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Daemon options; supports `signal`, `state`, `execution`, `scan`, and `delay`.

Returns `Promise<void>` — Resolves when stopped or Jobs becomes unusable; rejects on initial validation or daemon errors.

### `async Jobs.disable(projectRoot, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

### `async Jobs.init(projectRoot, settings = {…}, options = {…})`

Initialize or restore folder-only Jobs.

- `projectRoot` (string) — Project root directory.
- `[settings={}]` (object) — Settings argument retained by the lifecycle API.
- `[options={}]` (object) — Options; `fs` may inject filesystem operations.

Returns `Promise<{enabled: boolean}>` — Enabled status.

### `async Jobs.run(projectRoot, options = {…})`

Dispatch one best-effort serial scan of due Jobs.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Scan options, including injected clock, filesystem, validation, executor, and execution settings.

Returns `Promise<object>` — Frozen scan result containing outcomes, errors, warnings, and optional error-log path.

### `async Jobs.schedule(root, command, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

### `async Jobs.status(projectRoot, options = {…})`

Read a non-mutating projection of Jobs eligibility, tasks, schedule, attempts, and last scan.

- `projectRoot` (string) — Project root directory.
- `[options={}]` (object) — Options such as clock, defaults, and validation context.

Returns `Promise<object>` — Status projection with diagnostics; does not create folders or start a daemon.

### `async Jobs.validate(root, options = {…})`

Apply a task list/read/create/update/remove command.

- `root` (string) — Project root directory.
- `command` (object) — Command with action; non-list actions require a filename, and create/update require Markdown `source`.
- `[options={}]` (object) — Options including `readOnly`, folder validation context, and settings.

Returns `Promise<object>` — Task listing, task source/read result, or mutation result.

## Markdown

### `class BashSanitizer`

Streaming sanitizer — one instance PER LIVE TOOL CALL (typically one
bash command). Holds the look-back buffer that catches escape sequences
split across chunks, so concurrent calls must never share an instance.

### `Markdown.BashSanitizer.constructor({ markdown = false } = {…})`

Create one sanitizer for one live tool call.

Returns `BashSanitizer` — A new streaming sanitizer instance.

### `Markdown.BashSanitizer.end()`

Flush held bytes when the call ends, dropping any unfinished escape and balancing streamed emphasis.
Resets the pending buffer and emphasis state for this instance.

Returns `string` — Sanitized text remaining in the buffer, plus any needed closing Markdown markers.

### `Markdown.BashSanitizer.push(chunk)`

Sanitize the next raw chunk. A trailing INCOMPLETE escape is held
back (not emitted) until the following chunk completes it — or end().

- `chunk` (string) — Raw chunk, coerced with `String(chunk ?? "")`.

Returns `string` — Display-safe portion of the stream; any incomplete trailing escape is withheld. Coercion exceptions from the supplied chunk propagate to the caller.

### `class Markdown`

Canonical markdown module namespace. Static-only by design.

### `Markdown.BashSanitizer`

Streaming sanitizer — one instance PER LIVE TOOL CALL (typically one
bash command). Holds the look-back buffer that catches escape sequences
split across chunks, so concurrent calls must never share an instance.

### `Markdown.classifyLine(line, state = {…})`

Classify one complete Markdown source line into its block kind.
Fence markers are recognized against and update the supplied fence
state; while inside a fence, non-closing lines are classified as code.
Outside fences, block markers are checked in horizontal-rule, heading,
list, and quote order; unmatched lines are plain text.

- `line` (string) — One source line, without a trailing `\n`.

Returns `{kind: "fence", lang: string, raw: string` — | {kind: "code", raw: string} | {kind: "hr", width: number, raw: string} | {kind: "heading", depth: number, text: string, raw: string} | {kind: "list", indent: string, marker: string, ordered: boolean, text: string, raw: string} | {kind: "quote", text: string, raw: string} | {kind: "text", text: string, raw: string}} Classification object. `raw` is always the source line; where present, `text` is content with the block marker stripped. List `marker` preserves the source marker (for example, `-`, `*`, or `2.`); normalization is left to the renderer.

### `Markdown.lexMarkdown(text)`

Tokenize complete markdown text. A unified Git diff is detected first
and returned as its own single token (see parseGitDiff); otherwise
`marked`'s lexer (gfm, breaks) runs when available without math
delimiters; otherwise the builtin lexer handles math. Same token shapes for walkTokens.

- `text` (string) — Complete markdown source; nullish values are coerced to an empty string at runtime.

Returns `Promise<Array<object>>` — Resolves to marked-shaped block tokens; recognized unified Git diffs are returned as a single token.

### `Markdown.markdownEngine()`

Determine which engine whole-text rendering routes through, lazily loading and caching optional-engine availability.

Returns `Promise<"marked"|"builtin">` — Resolves to `"marked"` when the optional package is available, or `"builtin"` otherwise; import failure selects `"builtin"`.

### `Markdown.mathBlockAt(lines, start)`

Find a complete, line-delimited display-math block; an unclosed block is not consumed.

- `lines` (string[]) — Source lines.
- `start` (number) — Candidate opening-line index.

Returns `{end: number, text: string, source: string, tree: object}|null` — Block data and parsed AST, or null.

### `Markdown.mathText(node)`

Convert a math AST node to a plain-text fallback representation.

- `node` (object|null|undefined) — Math AST node; nullish input produces an empty string.

Returns `string` — Plain-text rendering; recursively visits child nodes.

### `Markdown.parseGitDiff(text)`

Parse one complete unified Git diff synchronously, with exact source-line spans.

- `text` (string) — Source text; coerced to a string by the parser.

Returns `object|null` — The Git-diff token, or `null` when the text is not a complete recognized diff.

### `Markdown.parseInline(text)`

Tokenize inline markdown into flat, non-nested spans, choosing the earliest recognized markup.
Code spans, links, math, strong, and emphasis are recognized; unrecognized content remains text.

- `text` (string|null|undefined) — one line/fragment; nullish values are treated as empty, otherwise converted with String

Returns `Array<{type: string, text: string, href?: string, source?: string, tree?: object}>` — Ordered spans; math spans also contain source and parsed tree

### `Markdown.parseMath(source)`

Parse a bounded TeX subset into presentation-independent nodes; unknown commands remain literal.

- `source` (*) — Input converted to a string (nullish values become empty).

Returns `{type: string, [key: string]: any}` — AST node; over-limit input is returned as one literal symbol.

### `Markdown.renderInline(text, renderer = {…})`

Render one fragment of inline markdown through a renderer's inline
callbacks, synchronously, via the builtin tokenizer (engine routing
needs whole text — inline fragments don't have it). This is the
primitive incremental renderers style complete lines with.

- `text` (string) — Inline markdown (no block structure).
- `[renderer={}]` (object) — Inline callbacks; missing callbacks default to plain text.

Returns `string` — The synchronously rendered inline fragment.

### `Markdown.renderMarkdown(text, renderer = {…})`

Render complete markdown text through a renderer's callbacks,
engine-routed (see lexMarkdown). Rendered tokens join with one
"\n"; source blank lines are space tokens, so one blank line remains
one blank line in the output.

- `text` (string) — Complete markdown source passed to {@link lexMarkdown}.
- `[renderer={}]` (object) — Marked-style callbacks; missing callbacks default to plain text.

Returns `Promise<string>` — Resolves to rendered output with tokens joined by newlines.

### `Markdown.sanitizeText(text, { markdown = false, state = null, open = false } = {…})`

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

### `Markdown.walkTokens(tokens, renderer = {…})`

Render marked-shaped block tokens, completing missing renderer callbacks
with plain-text defaults. Nested block and inline content is rendered
recursively; top-level block results are joined with one newline.
List and table callbacks receive normalized item/cell metadata, and gitdiff
callbacks receive per-line classifications before the enclosing callback.

- `tokens` (Array<object>|null|undefined) — block tokens; nullish input is treated as empty
- `[renderer={}]` (object) — renderer callbacks; missing callbacks use plain-text defaults

Returns `string` — rendered block output

### `Markdown.classifyLine(line, state = {…})`

Classify one complete Markdown source line into its block kind.
Fence markers are recognized against and update the supplied fence
state; while inside a fence, non-closing lines are classified as code.
Outside fences, block markers are checked in horizontal-rule, heading,
list, and quote order; unmatched lines are plain text.

- `line` (string) — One source line, without a trailing `\n`.

Returns `{kind: "fence", lang: string, raw: string` — | {kind: "code", raw: string} | {kind: "hr", width: number, raw: string} | {kind: "heading", depth: number, text: string, raw: string} | {kind: "list", indent: string, marker: string, ordered: boolean, text: string, raw: string} | {kind: "quote", text: string, raw: string} | {kind: "text", text: string, raw: string}} Classification object. `raw` is always the source line; where present, `text` is content with the block marker stripped. List `marker` preserves the source marker (for example, `-`, `*`, or `2.`); normalization is left to the renderer.

### `async Markdown.lexMarkdown(text)`

Tokenize complete markdown text. A unified Git diff is detected first
and returned as its own single token (see parseGitDiff); otherwise
`marked`'s lexer (gfm, breaks) runs when available without math
delimiters; otherwise the builtin lexer handles math. Same token shapes for walkTokens.

- `text` (string) — Complete markdown source; nullish values are coerced to an empty string at runtime.

Returns `Promise<Array<object>>` — Resolves to marked-shaped block tokens; recognized unified Git diffs are returned as a single token.

### `async Markdown.markdownEngine()`

Determine which engine whole-text rendering routes through, lazily loading and caching optional-engine availability.

Returns `Promise<"marked"|"builtin">` — Resolves to `"marked"` when the optional package is available, or `"builtin"` otherwise; import failure selects `"builtin"`.

### `Markdown.mathBlockAt(lines, start)`

Find a complete, line-delimited display-math block; an unclosed block is not consumed.

- `lines` (string[]) — Source lines.
- `start` (number) — Candidate opening-line index.

Returns `{end: number, text: string, source: string, tree: object}|null` — Block data and parsed AST, or null.

### `Markdown.mathText(node)`

Convert a math AST node to a plain-text fallback representation.

- `node` (object|null|undefined) — Math AST node; nullish input produces an empty string.

Returns `string` — Plain-text rendering; recursively visits child nodes.

### `Markdown.parseGitDiff(text)`

Parse one complete unified Git diff synchronously, with exact source-line spans.

- `text` (string) — Source text; coerced to a string by the parser.

Returns `object|null` — The Git-diff token, or `null` when the text is not a complete recognized diff.

### `Markdown.parseInline(text)`

Tokenize inline markdown into flat, non-nested spans, choosing the earliest recognized markup.
Code spans, links, math, strong, and emphasis are recognized; unrecognized content remains text.

- `text` (string|null|undefined) — one line/fragment; nullish values are treated as empty, otherwise converted with String

Returns `Array<{type: string, text: string, href?: string, source?: string, tree?: object}>` — Ordered spans; math spans also contain source and parsed tree

### `Markdown.parseMath(source)`

Parse a bounded TeX subset into presentation-independent nodes; unknown commands remain literal.

- `source` (*) — Input converted to a string (nullish values become empty).

Returns `{type: string, [key: string]: any}` — AST node; over-limit input is returned as one literal symbol.

### `Markdown.renderInline(text, renderer = {…})`

Render one fragment of inline markdown through a renderer's inline
callbacks, synchronously, via the builtin tokenizer (engine routing
needs whole text — inline fragments don't have it). This is the
primitive incremental renderers style complete lines with.

- `text` (string) — Inline markdown (no block structure).
- `[renderer={}]` (object) — Inline callbacks; missing callbacks default to plain text.

Returns `string` — The synchronously rendered inline fragment.

### `async Markdown.renderMarkdown(text, renderer = {…})`

Render complete markdown text through a renderer's callbacks,
engine-routed (see lexMarkdown). Rendered tokens join with one
"\n"; source blank lines are space tokens, so one blank line remains
one blank line in the output.

- `text` (string) — Complete markdown source passed to {@link lexMarkdown}.
- `[renderer={}]` (object) — Marked-style callbacks; missing callbacks default to plain text.

Returns `Promise<string>` — Resolves to rendered output with tokens joined by newlines.

### `Markdown.sanitizeText(text, { markdown = false, state = null, open = false } = {…})`

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

### `Markdown.walkTokens(tokens, renderer = {…})`

Render marked-shaped block tokens, completing missing renderer callbacks
with plain-text defaults. Nested block and inline content is rendered
recursively; top-level block results are joined with one newline.
List and table callbacks receive normalized item/cell metadata, and gitdiff
callbacks receive per-line classifications before the enclosing callback.

- `tokens` (Array<object>|null|undefined) — block tokens; nullish input is treated as empty
- `[renderer={}]` (object) — renderer callbacks; missing callbacks use plain-text defaults

Returns `string` — rendered block output

## Sandbox

### `class Sandbox`

Sandbox façade for scoped child processes; dispatch owns teardown.

### `Sandbox.osAvailable()`

Is OS write-sandbox enforcement in effect (own mechanism or a
detected outer jail)? Probed once per process; no opt-out.

Returns `boolean` — Whether this process or an enclosing jail enforces write restrictions.

### `Sandbox.osKind()`

The OS write-sandbox mechanism in effect: "seatbelt", "bwrap",
"delegated" (an outer jail already confines this process; the wrap
is a passthrough), or null (no enforcement; Agent forces safe mode).

Returns `"seatbelt"|"bwrap"|"delegated"|null` — The active mechanism, or null if unavailable.

### `Sandbox.osWrap(file, args, cwd, workingDirectory)`

Wrap a program invocation in the OS write sandbox: the [file, argv]
to spawn (unchanged when no mechanism applies).

- `file` (string) — Program executable to run.
- `[args=[]` (string[]) — ] - Arguments passed to the program.
- `[cwd=process.cwd()]` (string) — Project folder whose writes are permitted.
- `[workingDirectory=cwd]` (string) — Working directory for the wrapped process.

Returns `[string, string[]]` — Executable and argument vector to pass to spawn.

### `Sandbox.processStop(child, options)`

Stop a child process or its owned process group and wait for it to close.
Repeated calls are safe and share the same completion promise. Sends
SIGKILL; if group termination fails, it falls back to killing the child.

- `child` (import("node:child_process").ChildProcess) — Process to stop.

Returns `Promise<void>` — Resolves when the child closes or emits an error.

### `Sandbox.scope()`

Create a process scope owned and closed by one tool dispatch.

Returns `ProcessScope` — A scope for spawning, tracking, and stopping child processes.

### `Sandbox.spawn(file, args, options)`

Spawn a child process using the sandbox's process-group ownership policy.
On non-Windows hosts outside a tool-worker process, the child is detached
so its process group can be stopped together. Spawn errors are reported on
the returned child process using Node.js child-process events.

- `file` (string) — Executable to run.
- `args` (string[]) — Arguments passed to the executable.
- `[options={}]` (import("node:child_process").SpawnOptions) — Node.js spawn options.

Returns `import("node:child_process").ChildProcess` — The spawned child process.

## TUI

### `class TUI`

Empty namespace class for the TUI module, published as `App.TUI` by
`lib/app.js`; static API members are assigned below.

### `TUI.close(runtime)`

Close TUI-owned agents, sessions, and background resources by delegating to
the CLI cleanup routine. Controllers returned by `createRepl` and
`createLineRepl` also expose an idempotent `close()` method.

Returns `{agent?: object, session?: {id: string, file?: string}|null}` — Cleanup result returned by the CLI routine.

### `TUI.createApp`

Public createApp namespace member; see its owning module for the contract.

### `TUI.createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit })`

Create the piped, cooked-mode front end, which reads one input message per
line. Re-exported from `./line-repl.js`; this module does not wrap it.

Returns `object` — The line-oriented REPL controller.

### `TUI.createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows })`

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

### `TUI.run(state)`

Run the complete TUI application from normalized declarative state.
Executables own argument parsing and process-exit policy; the runner
creates the environment and Agent, selects the mode, and performs cleanup.

- `[state]` (object) — Normalized application state; optional and forwarded unchanged, with no default applied here.

Returns `Promise<{code: number, agent: object, session: object|null}>` — Promise resolving to the application exit code, Agent, and session result.

### `TUI.TUI_ENGINES`

The rendering modes accepted by {@link createRepl} (currently `inline` and `alt`).

### `TUI.TUI_ENGINES = TUI_MODES`

The rendering modes accepted by {@link createRepl} (currently `inline` and `alt`).

### `TUI.close(runtime)`

Close TUI-owned agents, sessions, and background resources by delegating to
the CLI cleanup routine. Controllers returned by `createRepl` and
`createLineRepl` also expose an idempotent `close()` method.

Returns `{agent?: object, session?: {id: string, file?: string}|null}` — Cleanup result returned by the CLI routine.

### `TUI.createLineRepl({ agent, input, writeOut, log, ansi = true, signals = true, onExit })`

Create the piped, cooked-mode front end, which reads one input message per
line. Re-exported from `./line-repl.js`; this module does not wrap it.

Returns `object` — The line-oriented REPL controller.

### `TUI.createRepl({ agent, env, engine, input, write, output, resizeEmitter, log, onExit, cwd, signals, columns, rows })`

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

### `TUI.run(state)`

Run the complete TUI application from normalized declarative state.
Executables own argument parsing and process-exit policy; the runner
creates the environment and Agent, selects the mode, and performs cleanup.

- `[state]` (object) — Normalized application state; optional and forwarded unchanged, with no default applied here.

Returns `Promise<{code: number, agent: object, session: object|null}>` — Promise resolving to the application exit code, Agent, and session result.

## Web

### `class Web`

Static namespace for the Web front end (published as App.Web by lib/app.js).

### `Web.AgentSession`

Public AgentSession namespace member; see its owning module for the contract.

### `Web.createWebServer`

Public createWebServer namespace member; see its owning module for the contract.

### `Web.MAX_WS_PAYLOAD_LENGTH`

Public MAX_WS_PAYLOAD_LENGTH namespace member; see its owning module for the contract.

### `Web.parseClientMessage`

Public parseClientMessage namespace member; see its owning module for the contract.

### `Web.serve`

Public serve namespace member; see its owning module for the contract.
