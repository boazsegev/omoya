# API schema

Compact contract notation, not executable TypeScript or a validation schema. Accessors share one published property with separate read and write contracts. The full API reference contains their effects and ownership rules.

### `Env.settings`

```schema
{
  "context": {
    "autocompact": "boolean | number (default 0.4; true = 0.4; fractions < 1 or percentages > 1; false/0/1/100 disable)",
    "autocompactMax": "nonnegative safe integer (tokens; default 200000; 0 disables)",
    "cap": "number",
    "turn": "number",
  },
  "env": {
    "<NAME>": "false | true | string",
  },
  "extensions": {
    "<package-or-folder>": "boolean",
  },
  "maxActive": "number",
  "mcp": {
    "<server>": {
      "args": "string[]",
      "command": "string",
      "description": "string",
      "env": "object",
      "safe": "boolean",
      "timeout": "number",
    },
  },
  "projects": {
    "<absolute folder or name alias>": {
      "description?": "string",
      "folder": "absolute folder",
      "groups?": "<group> -> boolean",
      "models?": "<endpoint>/<model> -> ISO timestamp",
      "name": "shortest unique folder suffix",
    },
  },
  "prompts": {
    "<path>": "boolean",
  },
  "providers": {
    "<endpoint>": {
      "contextWindow": "number",
      "model": "string",
      "models": "object",
      "provider": "string",
      "timeout": "number",
      "url": "string",
    },
    "tools": {
      "<tool>": "boolean",
    },
  },
  "read": {
    "artifactBytes": "number",
    "entries": "number",
    "fileBytes": "number",
    "files": "number",
    "grepFileSizeLimit": "number",
    "outputBytes": "number",
    "regexMs": "number",
    "scanBytes": "number",
    "timeoutMs": "number",
  },
  "retry": {
    "attempts": "number",
    "base": "number",
    "max": "number",
  },
  "sessions": "string",
  "skills": {
    "<path>": "boolean",
  },
  "themes": {
    "<theme>": {
      "<role>": {
        "bg": "color | {dark, light, default}",
        "bold": "boolean",
        "dim": "boolean",
        "fg": "color | {dark, light, default}",
        "italic": "boolean",
        "reverse": "boolean",
        "strike": "boolean",
        "underline": "boolean",
      },
      "message.thinking.preview": {
        "maxRows": "positive integer",
      },
      "parent": "theme name | default",
      "tool.preview": {
        "maxRows": "positive integer",
      },
    },
  },
  "tools": {
    "concurrency": "number",
    "folders": {
      "<path>": "boolean",
    },
    "timeout": "number",
    "timeoutLimit": "number",
  },
  "tui": {
    "alt": "boolean",
    "cursor": {
      "blink": "number",
      "shape": "string",
    },
    "keys": {
      "<key>": "key binding",
    },
    "osc52": "boolean",
    "scroll": {
      "show": "boolean",
      "thumb": "string",
      "track": "string",
    },
    "theme": "string",
  },
  "web": {
    "autocomplete": "boolean",
    "collapse": {
      "thinking": "boolean",
      "tools": "boolean",
    },
    "limit": {
      "calls": "number",
      "windowMs": "number",
    },
    "theme": "string",
    "throttle": {
      "startAt": "number",
      "step": "number",
      "stepMs": "number",
    },
  },
}
```

### `Agent.Context.BinaryContent`

```schema
{
  "[filename]": "string",
  "[mimetype]": "string",
  "content": "string",
  "type": "\"binary\"",
}
```

### `Agent.Context.Content`

```schema
"TextContent|ImageContent|BinaryContent|ThinkingContent|ToolCallContent|Object"
```

### `Agent.Context.Context`

```schema
"Message[]"
```

### `Agent.Context.ImageContent`

```schema
{
  "[mimetype]": "string",
  "content": "string",
  "type": "\"image\"",
}
```

### `Agent.Context.Message`

```schema
{
  "content": "Content[]",
  "type": "number",
}
```

### `Agent.Context.TextContent`

```schema
{
  "text": "string",
  "type": "\"text\"",
}
```

### `Agent.Context.ThinkingContent`

```schema
{
  "text": "string",
  "type": "\"thinking\"",
}
```

### `Agent.Context.ToolCallContent`

```schema
{
  "arguments": "*",
  "callId": "string",
  "name": "string",
  "type": "\"toolCall\"",
}
```

### `Agent.Context.ToolResultMessage`

```schema
{
  "[error]": "boolean",
  "[name]": "string",
  "callId": "string",
  "content": "Content[]",
  "type": "4",
}
```

## Tool contract — PUBLISHES / REQUIRES / RETURNS (add a tool by reading this)

- PUBLISHES — the module shape a tool file must export — `lib/env/tools.js`
- PUBLISHES — registration and the catalog (Env.tools(safe, selector) -> ToolInfo; provider tools shadow) — `lib/env/tool-registry.js`
- PUBLISHES — a worked example: the minimal wrapper shape (read-only, no ctx) — `tools/read.js`
- PUBLISHES — a worked example: sandboxed (`sandbox: true`, forked, write-jailed) — `tools/write.js`
- PUBLISHES — Agent-owned background commands: bash(background) and process-list/output/stop — `tools/process.js`
- PUBLISHES — Agent's current filtered model-facing descriptors — `lib/agent.js`
- REQUIRES — internal dispatch constructs every in-process call's (args, ctx); tools receive capabilities, hosts do not construct them — `lib/agent/tool-context.js`
- REQUIRES — dispatch: which tools fork (sandboxed worker, REDUCED ctx) vs stay in-process (full ctx) — `lib/agent/tool-exec.js`
- REQUIRES — a worked example: an interactive tool (`interactive: true`) using ctx.question.ask — `tools/question.js`
- REQUIRES — forked worker's serializable ctx: env, sandbox, deadline, onData, agent.folder; question bridge when enabled; no live Agent or IO — `lib/agent/tool-worker.js`
- RETURNS — every shape a tool's return value may take — `lib/agent/tool-exec.js`

### `Env.toolArguments`

```schema
{
  "args": "object matching the tool's inputSchema (parsed JSON)",
  "context": "Internal Agent dispatch context (in-process); serializable worker ctx with env, sandbox, deadline, onData, agent.folder and optional question bridge",
}
```

### `Tool execution context (not a public constructor)`

```schema
{
  "agent": "Agent | undefined",
  "call": "{callId: string, name: string} | undefined",
  "env": "Env",
  "io": "IO | undefined",
  "question": "{ ask(questions): Promise<answers> } | null",
  "resetTimeout": "() => void",
  "safe": "boolean",
  "selector": "string | undefined",
  "statusSet?": "(info: object) => void",
  "storage": "object | undefined",
  "trusted": "boolean",
}
```

### `Env.toolReturn`

```schema
{
  "display?": "string | string[]",
  "result": "string | Content[] | { content: Content[] } | JSON",
  "system?": "string | string[]",
}
```

### `Env.toolCallResult`

```schema
{
  "callId": "string",
  "content": "Content[]",
  "error?": "boolean",
  "name": "string",
  "type": 4,
}
```

### `Env.toolDescription`

```schema
{
  "description": "string",
  "fn?": "(args, context) => result | Promise<result>",
  "inputSchema": "JSON Schema",
  "interactive?": "boolean",
  "onTimeout?": "function(args, context)",
  "safe?": "boolean",
  "sandbox?": "boolean",
  "secret?": "boolean",
  "trusted?": "boolean",
}
```

## Core tool catalog (live schemas)

Run a Bash command in the working folder; return output and any exit code. Prefer read to inspect folders.

Source: `tools/bash.js`; flags: sandbox

### `Env.toolDescription.bash.inputSchema`

```schema
{
  "background?": "boolean",
  "command": "string",
  "env?": "object",
  "timeout?": "integer",
}
```

Replace exact text in one file. Read the file first, then send oldText/newText pairs from its current content. Merge nearby or overlapping changes into one edit. Set matchAll: true to replace every occurrence of each oldText. To reverse an edit, pass the edit id returned after it as rollback.

Source: `tools/edit.js`; flags: trusted

### `Env.toolDescription.edit.inputSchema`

```schema
{
  "ask?": "boolean",
  "edits?": {
    "array": {
      "newText": "string",
      "oldText": "string",
    },
  },
  "matchAll?": "boolean",
  "path": "string",
  "rollback?": "string",
}
```

Manage scheduled project tasks: list, read, create, update, or remove. Use enabled: false to pause a task. Updates preserve omitted fields and take effect on a later scan; removing a task does not stop a running job. This tool does not run tasks or configure the scheduler.

Source: `tools/job-schedule.js`; flags: trusted

### `Env.toolDescription.job-schedule.inputSchema`

```schema
{
  "action": ["list", "read", "create", "update", "remove"],
  "enabled?": "boolean",
  "filename?": "string",
  "prompt?": "string",
  "schedule?": {
    "fields": {
      "at?": {
        "array": "string",
      },
      "days?": "Restrict runs with the string weekdays/weekends, or an array of day abbreviations (sun, mon, tue, wed, thu, fri, sat).",
      "every?": "string",
    },
    "forms": "Task schedule: a string (once or every <duration>, e.g. every 1h), or an object with exactly one of at/every and optional days. Omit on update to preserve it.",
  },
}
```

Keep scratchpad notes for the current context. Use set with a title-to-patch map, get/remove with an array of titles, list for open notes, or search with a regex pattern. Use ["*"] to select all notes. Prefer content, summary, and type fields; add other JSON fields as needed. Null deletes a field or a whole note.

Source: `tools/note.js`; flags: safe

### `Env.toolDescription.note.inputSchema`

```schema
{
  "action": ["set", "get", "list", "remove", "search"],
  "field?": "string",
  "max?": "integer",
  "notes?": "set: a map of title → patch object. get/remove: an array of titles ([\"*\"] = every note).",
  "only?": {
    "array": "string",
  },
  "pattern?": "string",
}
```

List this Agent's background Bash processes.

Source: `tools/process.js`; flags: safe

### `Env.toolDescription.process-list.inputSchema`

```schema
{}
```

Read buffered output from this Agent's background Bash process.

Source: `tools/process.js`; flags: safe

### `Env.toolDescription.process-output.inputSchema`

```schema
{
  "from?": "integer",
  "id": "string",
}
```

Stop this Agent's background Bash process group. Unavailable in safe mode.

Source: `tools/process.js`; flags: trusted

### `Env.toolDescription.process-stop.inputSchema`

```schema
{
  "id": "string",
}
```

Ask the user to resolve a decision or provide missing information. Send 1–4 clear questions with distinct options; users can also give custom answers.

Source: `tools/question.js`; flags: safe, sandbox

### `Env.toolDescription.question.inputSchema`

```schema
{
  "questions": {
    "array": {
      "details?": "string",
      "header": "string",
      "multiSelect?": "boolean",
      "options": {
        "array": {
          "description": "string",
          "label": "string",
          "preview?": {
            "fields": {
              "content?": "string",
              "language?": "string",
              "title?": "string",
              "type?": ["text", "code"],
            },
            "forms": "Optional focused preview: a plain string, or an object with type (text/code) and content. Add title or language when useful.",
          },
        },
      },
      "question": "string",
    },
  },
}
```

Read files, list folders, or search contents. Heed skip and incomplete notices before assuming full coverage.

Source: `tools/read.js`; flags: safe

### `Env.toolDescription.read.inputSchema`

```schema
{
  "annotate?": "boolean",
  "base64?": "boolean",
  "binary?": "boolean",
  "bytes?": {
    "from?": "integer",
    "to?": "integer",
  },
  "characters?": {
    "from?": "integer",
    "to?": "integer",
  },
  "exclude?": "Skip files or subtrees matching a glob string or array; overrides glob.",
  "glob?": "Only files matching a glob string or array, e.g. *.md, src/**/*.js, {a,b}. Slashless patterns match filenames.",
  "ignore?": "boolean",
  "info?": "boolean",
  "limit?": "integer",
  "lines?": {
    "from?": "integer",
    "last?": "integer",
    "to?": "integer",
  },
  "offset?": "integer",
  "path": "string",
  "recursive?": "boolean",
  "search?": {
    "after?": "integer",
    "before?": "integer",
    "ignoreCase?": "boolean",
    "invert?": "boolean",
    "regex?": "string",
    "text?": "string",
  },
  "target?": "string",
}
```

Exchange requests / replies with external agents (not your worker/parent). Use to collaborate on complex tasks that require a number of teams to complete, or to file bug reports or ask questions in other projects. Not for delegating tasks to workers. Not for copying resources from other projects (user `resource`). Start an agent with `to: "new:<role-name>@<project>"`; later use the <name>@<project> from the result or from a received request's label. The receiver may refuse. Replies arrive as messages; finish your turn to wait. Projects: this (your own project).

Source: `tools/request.js`; flags: trusted

### `Env.toolDescription.request.inputSchema`

```schema
{
  "model?": "string",
  "prompt": "string",
  "safe?": "boolean",
  "to": "string",
}
```

List, read or copy files of a skill or a project. A path missing from a skill is looked up in the project of the same name. Copies never overwrite: an existing destination is saved as "<name> 002.<ext>". Projects: this (your own project).

Source: `tools/resource.js`; flags: safe, trusted

### `Env.toolDescription.resource.inputSchema`

```schema
{
  "list?": "boolean",
  "name": "string",
  "path?": "string",
  "target?": "string",
}
```

Load relevant skills before starting a task and follow their instructions. Omit names to list available skills; pass an array of catalog names to load them.

Source: `tools/skill.js`; flags: safe

### `Env.toolDescription.skill.inputSchema`

```schema
{
  "names?": {
    "array": "string",
  },
}
```

Read one HTTP(S) page or API response as Markdown, text, or JSON text. Supply the direct URL; check truncation notices before assuming the response is complete.

Source: `tools/web.js`; flags: safe, trusted

### `Env.toolDescription.web-fetch.inputSchema`

```schema
{
  "url": "string",
}
```

Search the internet for relevant pages. Use a focused query and limit the number of results; use web-fetch to read a result's full page.

Source: `tools/web.js`; flags: safe, trusted

### `Env.toolDescription.web-search.inputSchema`

```schema
{
  "limit?": "integer",
  "query": "string",
}
```

Close named workers, /regex/ matches, or all with ["*"]. Busy workers are asked to hand off their work first.

Source: `tools/worker-close.js`; flags: trusted

### `Env.toolDescription.worker-close.inputSchema`

```schema
{
  "workers": {
    "array": "string",
  },
}
```

Create named workers and optionally send the same self-contained first prompt to each. Omit or empty prompt creates idle workers. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive as messages; finish your turn rather than waiting.

Source: `tools/worker-create.js`; flags: trusted

### `Env.toolDescription.worker-create.inputSchema`

```schema
{
  "prompt?": "string",
  "workers": {
    "array": {
      "description?": "string",
      "model?": "string",
      "name": "string",
      "safe?": "boolean",
      "subfolder?": "string",
      "thinking?": ["none", "low", "medium", "high", "xhigh", "max"],
    },
  },
}
```

Send one prompt to named workers, /regex/ matches, or all with ["*"]. Replies arrive as messages; finish your turn rather than waiting.

Source: `tools/worker-message.js`; flags: trusted

### `Env.toolDescription.worker-message.inputSchema`

```schema
{
  "prompt": "string",
  "to": {
    "array": "string",
  },
}
```

Show workers (busy/idle), models with free capacity, and the commands a message may start with (/compact, /<prompt>). Omit flags for all sections. Not for worker polling / busy waiting (just finish your turn and they will update you when they're done).

Source: `tools/worker-status.js`; flags: safe, trusted

### `Env.toolDescription.worker-status.inputSchema`

```schema
{
  "commands?": "boolean",
  "models?": "boolean",
  "workers?": "boolean",
}
```

Create or overwrite a text file in the Agent folder. Use edit for targeted changes; use read with target to copy files or save read results.

Source: `tools/write.js`; flags: trusted

### `Env.toolDescription.write.inputSchema`

```schema
{
  "ask?": "boolean",
  "content": "string",
  "path": "string",
}
```

### `Agent`

```ts
export class Agent {
  static Context: typeof Agent.Context;
  static Env: typeof Agent.Env;
  static IO: typeof Agent.IO;
  static Jobs: typeof Agent.Jobs;
  static EVENT: unknown;
  static EVENT_CALLBACKS: unknown;
  static NAMES: unknown;
  busy: { read: unknown };
  can: {read: boolean, write: boolean, delegate: *, interact: boolean, [capability: string]: *};
  cancel: () => unknown;
  childCreate: (options?: object) => Promise<Agent>;
  children: { read: unknown };
  close: () => Promise<void>;
  closeMarked: { read: unknown };
  closed: { read: unknown };
  compact: (focus?: string) => Promise<{ok: boolean, before: number, summaryText?: string}>;
  constructor(options?: Object, construction: unknown);
  contacts: { read: string[] };
  context: { read: Context };
  contextUsage: { read: {used: number, total: number|null, approximate: boolean} };
  static create: (options?: object) => Promise<Agent>;
  description: { read: unknown; write: (value: string) => void };
  env: { read: Env };
  static finishAdd: (fn: () => void, { process: proc?: unknown) => () => void;
  static finishRun: () => void;
  folder: { read: unknown; write: (folder: string|undefined|null) => void };
  fork: (options?: object) => Promise<Agent>;
  io: { read: IO|undefined; write: (value: IO) => void };
  ioState: { read: "idle"|"working"|"disconnected" };
  model: { read: string|undefined; write: (selector: string|undefined) => void };
  name: { read: unknown; write: (value: string) => void };
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: symbol, callback: (payload: object) => void) => number;
  parent: { read: unknown };
  pending: { read: unknown };
  pendingPop: () => Array;
  question: { read: object|null; write: (callbacks: unknown) => void };
  request: (request: unknown) => Promise<string>;
  run: (options?: Object) => Promise<object|null>;
  send: (message: object|string) => Promise<object>;
  sendFile: (fileName: string) => Promise<object>;
  skillLoad: (names: string|string[]) => string;
  thinking: { read: string|undefined; write: (level: string) => void };
  throttledUntil: { read: unknown };
  toolMessages: () => Array<{name: string, text: string}>;
  tools: { read: Promise<Map<string, object>> };
  usage: { read: {inputTokens: number, outputTokens: number, cost: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cacheWrite5mTokens?: number, cacheWrite1hTokens?: number, uncachedInputTokens?: number, reasoningTokens?: number, serviceTier?: string, inferenceGeo?: string, details?: object} };
}
```

### `Agent.Context`

```ts
export class Context {
  append: (message: object, options: unknown) => object|undefined;
  at: (i: number) => object|undefined;
  blockAt: (i: number, j: number) => object;
  close: () => Promise<void>;
  constructor(options?: Object);
  contextUsage: { read: {used: number|undefined, total: number|undefined}; write: (options?: object) => void };
  contextUsageInvalidate: (options?: object) => void;
  created: { read: string };
  static deleteAll: (options?: Object) => {deleted: number};
  static deleteById: (options?: Object) => {deleted: number};
  dir: { read: string|undefined };
  dirty: { read: false|number };
  edit: (i: number, message: object) => object;
  editBlock: (i: number, j: number, block: object) => object;
  errorPop: () => object|undefined;
  file: { read: string|undefined };
  static fileOf: (options?: object) => string|undefined;
  flush: () => void;
  flushAsync: () => Promise<void>;
  id: { read: string|undefined };
  static latest: (options?: Object) => string|undefined;
  length: { read: number };
  static list: (options?: Object) => Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>;
  static listAsync: (options?: object) => Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>;
  messages: () => object[];
  name: string|undefined;
  origin: { read: string };
  static originOf: (options?: Object) => string|undefined;
  planUsage: { read: unknown; write: (report?: object) => void };
  pop: () => object|undefined;
  prepend: (messages: object[]) => unknown;
  remove: (indexes: number[]) => object[];
  rename: (newId: string) => {id: string, file: string};
  static renameById: (options?: Object) => {id: string, file: string};
  static resume: (options?: Object) => Context;
  rollback: (i: number) => object[];
  save: { read: boolean; write: (value: boolean) => void };
  settings: { read: object|undefined; write: (value: object) => void };
  summary: { read: string };
  toJSON: () => unknown;
  update: (fn: (messages: object[]) => boolean) => boolean;
  uuid: { read: string };
}
```

### `Agent.Context.ContentType`

```ts
export const ContentType: unknown;
```

### `Agent.Context.EventType`

```ts
export const EventType: unknown;
```

### `Agent.Context.FALLBACK_CONTEXT_WINDOWS`

```ts
export const FALLBACK_CONTEXT_WINDOWS: unknown;
```

### `Agent.Context.MIME_BY_EXTENSION`

```ts
export const MIME_BY_EXTENSION: unknown;
```

### `Agent.Context.MessageType`

```ts
export const MessageType: unknown;
```

### `Agent.Context.TOKENS_PER_WORD`

```ts
export const TOKENS_PER_WORD: unknown;
```

### `Agent.Context.assemblerCallbacks`

```ts
export const assemblerCallbacks: (assembler: ReturnType<typeof createAssembler>) => Object<string, function(object): void>;
```

### `Agent.Context.assemblerCreate`

```ts
export const assemblerCreate: () => {consume: (event: object) => void, message: () => object};
```

### `Agent.Context.callbacksNormalize`

```ts
export const callbacksNormalize: (callbacks?: Object, binding?: Object) => Object;
```

### `Agent.Context.contentBinary`

```ts
export const contentBinary: (path: string, buffer: Uint8Array) => {type: "binary", mimetype: string, filename: string, content: string};
```

### `Agent.Context.contentIndexer`

```ts
export const contentIndexer: () => {of: (key: *) => number, next: () => number};
```

### `Agent.Context.contentText`

```ts
export const contentText: (text: *) => TextContent;
```

### `Agent.Context.eventCallbackName`

```ts
export const eventCallbackName: (eventName: string) => string;
```

### `Agent.Context.eventDispatch`

```ts
export const eventDispatch: (set: Object, event: object) => void;
```

### `Agent.Context.eventValid`

```ts
export const eventValid: (event: *) => boolean;
```

### `Agent.Context.eventValidate`

```ts
export const eventValidate: (event: *) => object;
```

### `Agent.Context.fallbackContextWindow`

```ts
export const fallbackContextWindow: (model: *) => number|null;
```

### `Agent.Context.messageAppend`

```ts
export const messageAppend: (context: Array<object>, message: object, { merge?: unknown) => object|undefined;
```

### `Agent.Context.messageAssistant`

```ts
export const messageAssistant: (content?: Content[]) => Message;
```

### `Agent.Context.messageErrorText`

```ts
export const messageErrorText: (msg: *) => string;
```

### `Agent.Context.messageFile`

```ts
export const messageFile: (path: string, buffer: Uint8Array) => {type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>};
```

### `Agent.Context.messageHasContent`

```ts
export const messageHasContent: (msg: *) => boolean;
```

### `Agent.Context.messageHasError`

```ts
export const messageHasError: (msg: *) => boolean;
```

### `Agent.Context.messageIsRecord`

```ts
export const messageIsRecord: (msg: *) => boolean;
```

### `Agent.Context.messageRebuild`

```ts
export const messageRebuild: (msg: object) => object;
```

### `Agent.Context.messageSystem`

```ts
export const messageSystem: (text: *) => Message;
```

### `Agent.Context.messageUser`

```ts
export const messageUser: (text: string|Content[]|*, metadata?: *) => Message;
```

### `Agent.Context.messageValid`

```ts
export const messageValid: (msg: *) => boolean;
```

### `Agent.Context.messageValidate`

```ts
export const messageValidate: (msg: *, at?: string) => object;
```

### `Agent.Context.messagesParse`

```ts
export const messagesParse: (input: string) => Array<object>;
```

### `Agent.Context.messagesValid`

```ts
export const messagesValid: (ctx: *) => boolean;
```

### `Agent.Context.messagesValidate`

```ts
export const messagesValidate: (ctx: *) => Array;
```

### `Agent.Context.mimeDetect`

```ts
export const mimeDetect: (options?: object) => string;
```

### `Agent.Context.mimeOf`

```ts
export const mimeOf: (block: Object|null|undefined) => string|undefined;
```

### `Agent.Context.tokensEstimate`

```ts
export const tokensEstimate: (text: *) => number;
```

### `Agent.Context.tokensEstimateMessages`

```ts
export const tokensEstimateMessages: (context?: Array) => number;
```

### `Agent.Context.usageAdd`

```ts
export const usageAdd: (total: object, reported: *) => object;
```

### `Agent.Context.usageDetails`

```ts
export const usageDetails: (value: *) => *;
```

### `Agent.Context.usageEstimate`

```ts
export const usageEstimate: (context?: Array, message: object) => {inputTokens:number, outputTokens:number, source:"estimate"};
```

### `Agent.Context.usageFinalize`

```ts
export const usageFinalize: (reported: *, context: Array, message: object) => {inputTokens:number, outputTokens:number, totalTokens:number, source:string, cost?:number, [key: string]: *};
```

### `Agent.Context.usageHeaders`

```ts
export const usageHeaders: (headers: Headers|object, { exclude?: unknown) => Object<string, string>;
```

### `Agent.Context.usageNormalize`

```ts
export const usageNormalize: (reported: *) => object;
```

### `Agent.Context.wordCount`

```ts
export const wordCount: (text: *) => number;
```

### `Agent.Env`

```ts
export class Env {
  static EVENT: unknown;
  static SettingsStore: unknown;
  agentCreate: (options?: object) => Promise<Agent>;
  agents: () => object[];
  static close: () => Promise<void>;
  close: () => Promise<void>;
  closed: { read: boolean };
  connection: (selector: string, { remember?: unknown) => object;
  constructor(options?: Object, acquisition: unknown);
  static envs: { read: Readonly<Object<string, Env>> };
  static extend: (plugin: unknown) => {EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void};
  folder: { read: string };
  folders: { read: ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}> };
  login: (name: string, config: unknown, options: unknown) => Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>;
  loginPresets: () => object[];
  logout: (name: string) => {name: string, dynamic: boolean};
  mcpLogin: (name: string, options: unknown) => Promise<{name: string}>;
  mcpPaste: (input: string) => boolean;
  mcpStatus: () => Array<{name: string, state: string}>;
  models: (secret?: boolean) => Map<string, object>;
  modelsReady: { read: Promise<void> };
  name: { read: string };
  offEvent: (handle: number) => boolean;
  onEvent: (event: symbol, callback: (payload: object) => void) => number;
  static open: (path: string, options: object) => Promise<Env>;
  promptCatalog: (options?: unknown) => string;
  prompts: () => Map<string, {name: string, description: string, file: string, source: string, body: string}>;
  static ready: () => Promise<Object>;
  ready: () => Promise<Env>;
  static settings: { read: Object };
  settings: { read: Object };
  static settingsFlush: () => Promise<void>;
  settingsFlush: () => Promise<void>;
  settingsSchema: () => Object} key -> {default, description;
  skillCatalog: (options?: unknown) => string;
  skillLoad: (names: string|string[], { active?: unknown) => string|{result: string, system: string[]};
  skillSection: (skill: unknown) => string;
  skills: () => Map<string, {name: string, description: string, file: string, source: string, body: string, directories: string[]}>;
  systemPrompt: () => string[];
  toolAdd: (name: string, fn: Function, schema: object, { builtin?: unknown, file }?: unknown) => Function;
  toolCall: (name: string, args: object, context: object) => Promise<*>;
  tools: (safe?: boolean, selector: string) => Promise<Map<string, object>>;
}
```

### `Agent.IO`

```ts
export class IO {
  Provider: Function;
  authSet: (auth: object, options: unknown) => object;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
  connectTimeout: { read: number };
  connectionCreate: (options?: object) => object;
  constructor(options?: Object);
  context: ?Context;
  env: Env;
  fetch: (url: string|URL, init?: object, { deadline: unknown, connectTimeout }?: unknown) => Promise<Response>;
  model: { read: string; write: (selector: unknown) => void };
  name: string;
  protocol: string;
  provider: object;
  settings: { read: object };
  settingsSet: (key: string, value: *) => void;
  state: { read: "idle"|"sending"|"reading"|"cancelling"|"closing"|"closed" };
  stuckTimeout: { read: number };
  timeout: { read: number };
  tools: () => Array<{name: string, ...Object}>;
  url: { read: string };
  write: (context: Context, callbacks?: Object, options?: Object) => Promise<object>;
}
```

### `Agent.IO.ProviderError`

```ts
export class ProviderError {
  constructor(kind: "auth"|"network"|"provider"|"malformed", message: string, detail?: object);
}
```

### `Agent.IO.Context`

```ts
export const Context: unknown;
```

### `Agent.IO.Env`

```ts
export const Env: unknown;
```

### `Agent.IO.THINKING_LEVELS`

```ts
export const THINKING_LEVELS: unknown;
```

### `Agent.IO.timeoutsResolve`

```ts
export const timeoutsResolve: (options?: unknown) => unknown;
```

### `Agent.Jobs`

```ts
export class Jobs {

}
```

### `Agent.Jobs.JobsError`

```ts
export class JobsError {
  constructor(code: string, message: string, details?: object);
}
```

### `Agent.Jobs.daemonRun`

```ts
export const daemonRun: (projectRoot: string, options?: object) => Promise<void>;
```

### `Agent.Jobs.disable`

```ts
export const disable: (projectRoot: string, options?: object) => Promise<{enabled: boolean}>;
```

### `Agent.Jobs.init`

```ts
export const init: (projectRoot: string, settings?: object, options?: object) => Promise<{enabled: boolean}>;
```

### `Agent.Jobs.run`

```ts
export const run: (projectRoot: string, options?: object) => Promise<object>;
```

### `Agent.Jobs.schedule`

```ts
export const schedule: (root: string, command: object, options?: object) => Promise<object>;
```

### `Agent.Jobs.status`

```ts
export const status: (projectRoot: string, options?: object) => Promise<object>;
```

### `Agent.Jobs.validate`

```ts
export const validate: (root: string, options?: object) => Promise<object>;
```

### `App`

```ts
export class App {
  static CLI: typeof App.CLI;
  static GTUI: typeof App.GTUI;
  static Markdown: typeof App.Markdown;
  static TUI: typeof App.TUI;
  static Web: typeof App.Web;
}
```

### `App.CLI`

```ts
export class CLI {

}
```

### `App.CLI.EXIT`

```ts
export const EXIT: unknown;
```

### `App.CLI.adoptResumeOrigin`

```ts
export const adoptResumeOrigin: (options?: Object) => Promise<string|null>;
```

### `App.CLI.armCancelSignals`

```ts
export const armCancelSignals: (options?: Object) => () => void;
```

### `App.CLI.close`

```ts
export const close: (options?: object) => Promise<{agent?: object, session: {id: string, file?: string}|null}>;
```

### `App.CLI.exitCodeFor`

```ts
export const exitCodeFor: (terminal: unknown) => number;
```

### `App.CLI.finishSignalsArm`

```ts
export const finishSignalsArm: (options?: Object) => () => void;
```

### `App.CLI.parseFlags`

```ts
export const parseFlags: (argv: string[], { flags: unknown, bools?: unknown, durations?: unknown, numbers?: unknown) => Object;
```

### `App.CLI.readContextFromStdin`

```ts
export const readContextFromStdin: () => Promise<Array<object>>;
```

### `App.CLI.readStdin`

```ts
export const readStdin: () => Promise<string>;
```

### `App.CLI.runLoginWizard`

```ts
export const runLoginWizard: (env: object, { input?: unknown, output?: unknown, }?: unknown) => Promise<*>;
```

### `App.CLI.runMcpLogin`

```ts
export const runMcpLogin: (env: object, name: string, { input?: unknown, output?: unknown) => Promise<{name: string}>;
```

### `App.CLI.selectEndpointModel`

```ts
export const selectEndpointModel: (env: object, args: object, { lastUsed?: unknown, log?: unknown) => Promise<string|undefined>;
```

### `App.CLI.usageSummary`

```ts
export const usageSummary: (usage: unknown) => string;
```

### `App.CLI.writeSettingsTemplate`

```ts
export const writeSettingsTemplate: (env: unknown, { force?: unknown) => string;
```

### `App.GTUI`

```ts
export class GTUI {
  constructor(options?: object);
  dispatch: (message: object) => void;
  run: (app: unknown) => Promise<{reason: string, code: number}>;
  stop: (reason?: string, code?: number) => void;
}
```

### `App.GTUI.effect`

```ts
export const effect: unknown;
```

### `App.GTUI.effect members`

```ts
after: (ms: number, message: object) => object;
cancel: (key: *) => object;
copy: (text: string, id: *) => object;
notify: (text: string) => object;
open: (url: string) => object;
quit: (code?: number) => object;
refresh: () => object;
task: (key: *, run: Function) => object;
theme: (tokens: object) => object;
```

### `App.GTUI.event`

```ts
export const event: unknown;
```

### `App.GTUI.event members`

```ts
copyDone: (payload: object) => object;
focus: (payload: object) => object;
inputChange: (payload: object) => object;
inputSubmit: (payload: object) => object;
key: (payload: object) => object;
linkOpen: (payload: object) => object;
menuCancel: (payload?: object) => object;
menuSelect: (payload: object) => object;
paste: (payload: object) => object;
pointer: (payload: object) => object;
resize: (payload: object) => object;
selectionCopy: (payload: object) => object;
taskDone: (payload: object) => object;
taskFailed: (payload: object) => object;
```

### `App.GTUI.host`

```ts
export const host: unknown;
```

### `App.GTUI.host members`

```ts
memory: (: unknown) => unknown;
terminal: (: unknown) => unknown;
```

### `App.GTUI.memory`

```ts
export const memory: (options?: object) => object;
```

### `App.GTUI.memory members`

```ts
effects: { read: object[] };
flush: () => void;
restoreCount: { read: number };
send: (message: object) => void;
snapshot: () => object;
```

### `App.GTUI.scrollGlyph`

```ts
export const scrollGlyph: (value: *, fallback: *) => *;
```

### `App.GTUI.terminal`

```ts
export const terminal: (options?: object) => object;
```

### `App.GTUI.view`

```ts
export const view: unknown;
```

### `App.GTUI.view members`

```ts
button: (props?: object, label?: *) => object;
column: (: unknown) => object;
feed: (props?: object) => object;
footer: (props?: object, items?: Array<object>) => object|null;
grid: (: unknown) => object;
input: (props?: object) => object;
menu: (props?: object) => object;
overlay: (: unknown) => object;
panel: (: unknown) => object;
row: (: unknown) => object;
scroll: (: unknown) => object;
table: (props?: object, rows?: object[]) => object;
text: (props?: object, content?: *) => object;
toolbar: (: unknown) => object;
```

### `App.Markdown.BashSanitizer`

```ts
export class BashSanitizer {
  constructor(options?: object);
  end: () => string;
  push: (chunk: string) => string;
}
```

### `App.Markdown`

```ts
export class Markdown {

}
```

### `App.Markdown.classifyLine`

```ts
export const classifyLine: (line: string, state?: unknown) => {kind: "fence", lang: string, raw: string;
```

### `App.Markdown.lexMarkdown`

```ts
export const lexMarkdown: (text: string) => Promise<Array<object>>;
```

### `App.Markdown.markdownEngine`

```ts
export const markdownEngine: () => Promise<"marked"|"builtin">;
```

### `App.Markdown.mathBlockAt`

```ts
export const mathBlockAt: (lines: string[], start: number) => {end: number, text: string, source: string, tree: object}|null;
```

### `App.Markdown.mathText`

```ts
export const mathText: (node: object|null|undefined) => string;
```

### `App.Markdown.parseGitDiff`

```ts
export const parseGitDiff: (text: string) => object|null;
```

### `App.Markdown.parseInline`

```ts
export const parseInline: (text: string|null|undefined) => Array<{type: string, text: string, href?: string, source?: string, tree?: object}>;
```

### `App.Markdown.parseMath`

```ts
export const parseMath: (source: *) => {type: string, [key: string]: any};
```

### `App.Markdown.renderInline`

```ts
export const renderInline: (text: string, renderer?: object) => string;
```

### `App.Markdown.renderMarkdown`

```ts
export const renderMarkdown: (text: string, renderer?: object) => Promise<string>;
```

### `App.Markdown.sanitizeText`

```ts
export const sanitizeText: (text: string, { markdown?: unknown, state?: unknown, open?: unknown) => string;
```

### `App.Markdown.walkTokens`

```ts
export const walkTokens: (tokens: Array<object>|null|undefined, renderer?: object) => string;
```

### `App.TUI`

```ts
export class TUI {
  static createApp: (agent: object, { env?: unknown, cwd?: unknown, sources: unknown, completionIO: unknown, log: unknown, open: unknown, columns: unknown, rows }?: unknown) => {init: Function, update: Function, view: Function, bindings: Function};
}
```

### `App.TUI.TUI_ENGINES`

```ts
export const TUI_ENGINES: unknown;
```

### `App.TUI.close`

```ts
export const close: (runtime: unknown) => Promise<{agent?: object, session?: {id: string, file?: string}|null}>;
```

### `App.TUI.createLineRepl`

```ts
export const createLineRepl: (options?: object) => object;
```

### `App.TUI.createRepl`

```ts
export const createRepl: (options?: Object) => {start: () => Promise<void>, close: () => void};
```

### `App.TUI.run`

```ts
export const run: (state: object) => Promise<{code: number, agent: object, session: object|null}>;
```

### `App.Web`

```ts
export class Web {
  static serve: (state?: unknown) => unknown;
}
```

