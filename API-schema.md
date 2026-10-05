# API schema

Compact contract notation, not executable TypeScript or a validation schema. Getters and setters are listed separately; the full API reference contains their effects and ownership rules.

### `Env.settings`

```schema
{
  "context": {
    "autocompact": "number",
    "cap": "number",
    "turn": "number",
  },
  "env-allow": "string[]",
  "env-refuse": "string[]",
  "extensions": "string[]",
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
  "projects": {},
  "prompts": "string | string[]",
  "providerPaths": "string | string[]",
  "providers": {
    "<endpoint>": {
      "contextWindow": "number",
      "model": "string",
      "models": "object",
      "provider": "string",
      "timeout": "number",
      "url": "string",
    },
  },
  "providerTools": {
    "<tool>": "boolean",
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
  "skills": "string | string[]",
  "tools": {
    "concurrency": "number",
    "folders": "string[]",
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

### `Context.BinaryContent`

```schema
{
  "[filename]": "string",
  "[mimetype]": "string",
  "content": "string",
  "type": "\"binary\"",
}
```

### `Context.Content`

```schema
"TextContent|ImageContent|BinaryContent|ThinkingContent|ToolCallContent|Object"
```

### `Context.Context`

```schema
"Message[]"
```

### `Context.ImageContent`

```schema
{
  "[mimetype]": "string",
  "content": "string",
  "type": "\"image\"",
}
```

### `Context.Message`

```schema
{
  "content": "Content[]",
  "type": "number",
}
```

### `Context.TextContent`

```schema
{
  "text": "string",
  "type": "\"text\"",
}
```

### `Context.ThinkingContent`

```schema
{
  "text": "string",
  "type": "\"thinking\"",
}
```

### `Context.ToolCallContent`

```schema
{
  "arguments": "*",
  "callId": "string",
  "name": "string",
  "type": "\"toolCall\"",
}
```

### `Context.ToolResultMessage`

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
- PUBLISHES — Agent-owned background commands: bash(background) and process(list/output/stop) — `tools/process.js`
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

List, read buffered output from, or stop this Agent's background Bash processes. Stop is unavailable in safe mode.

Source: `tools/process.js`; flags: safe

### `Env.toolDescription.process.inputSchema`

```schema
{
  "action": ["list", "output", "stop"],
  "from?": "integer",
  "id?": "string",
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

Access a skill's supporting files without loading or executing them. Supply name to list resources, add path to read one, or add path and target to save its exact bytes to a new file inside the Agent folder. Saving is available only if `write` is available.

Source: `tools/skill-resource.js`; flags: safe, trusted

### `Env.toolDescription.skill-resource.inputSchema`

```schema
{
  "name": "string",
  "path?": "string",
  "target?": "string",
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

Closes named workers, /regex/ matches, or all with ["*"]. Busy workers receive /handoff first and finish queued work before closing.

Source: `tools/worker-close.js`; flags: trusted

### `Env.toolDescription.worker-close.inputSchema`

```schema
{
  "workers": {
    "array": "string",
  },
}
```

Create named workers and optionally send the same self-contained first prompt to each. Omit or empty prompt creates idle workers. State role, task, context, constraints, deliverable, and acceptance checks. Replies arrive automatically as attributed messages; finish your turn rather than waiting.

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
      "subfolder?": "Existing project subfolder inside the leader folder; sets the worker write root. Reads may still access the project. Omit or use \"\", \".\", \"/\", \"./\", false, or null to inherit the leader folder (\"/\" never means the filesystem root). Absolute paths, parent traversal, and escaping symlinks are forbidden.",
      "thinking?": ["none", "low", "medium", "high", "xhigh", "max"],
    },
  },
}
```

Sends one prompt to named workers, /regex/ matches, or all with ["*"]. Replies arrive automatically as attributed messages; finish your turn rather than waiting.

Source: `tools/worker-message.js`; flags: trusted

### `Env.toolDescription.worker-message.inputSchema`

```schema
{
  "prompt": "string",
  "workers": {
    "array": "string",
  },
}
```

Shows workers grouped by busy/idle, available models, and the commands a worker accepts at the start of a message (/compact, /<prompt>). Omit flags for all; request sections with workers, models, or commands.

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

### `Agent module`

```ts
export const EVENT_CALLBACKS: unknown;
export const finishAdd: (fn: () => void, { process: proc?: unknown) => () => void;
export const finishRun: () => void;
export const finishSignalsArm: (options?: Object) => () => void;
export const reseat: (agent: object, { id }?: unknown) => object;
export const TOOL_TIMEOUT_DEFAULT: unknown;
```

### `Agent`

```ts
export class Agent {
  backgroundList: () => unknown;
  backgroundOutput: (id: unknown, from: unknown) => unknown;
  backgroundStart: (options: unknown) => unknown;
  backgroundStop: (id: unknown) => unknown;
  backgroundStopAll: () => unknown;
  get busy(): unknown;
  cancel: () => unknown;
  childCreate: (options?: object) => Agent;
  get children(): unknown;
  close: () => boolean;
  get closed(): unknown;
  get closeMarked(): unknown;
  compact: (focus?: string) => Promise<{ok: boolean, before: number, summaryText?: string}>;
  constructor(options?: Object);
  context: Context;
  static Context: unknown;
  contextFork: (id: string|false) => {id: string, file: string, save: boolean};
  contextNew: (id: string|false) => {id: string, file: string, save: boolean};
  contextResume: (id: string) => {id: string, file: string};
  get contextUsage(): {used: number, total: number|null, approximate: boolean};
  get description(): unknown;
  set description(value: string);
  env: Env;
  static Env: unknown;
  static EVENT: unknown;
  static EVENT_CALLBACKS: unknown;
  static finishAdd: (fn: () => void, { process: proc?: unknown) => () => void;
  static finishRun: () => void;
  static finishSignalsArm: (options?: Object) => () => void;
  set folder(folder: string|undefined|null);
  get folder(): unknown;
  static folderResolve: (env: Env, folder: string|undefined|null) => string;
  static IO: unknown;
  get ioState(): "idle"|"working"|"disconnected";
  set model(selector: string|undefined);
  get model(): string|undefined;
  get name(): unknown;
  set name(value: string);
  static NAMES: unknown;
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: number, callback: (payload: object) => void) => number;
  get parent(): unknown;
  pathInfo: (path: string, options?: unknown) => Promise<{path:string,isFolder:boolean,mimetype?:string}>;
  get pending(): unknown;
  pendingPop: () => Array;
  get planUsage(): {label?: string, quotas: Object}|null;
  get policy(): Readonly<object>;
  static promptCatalog: (prompts: Map<string, object>, options: unknown) => string;
  set question(callbacks: unknown);
  get question(): object|null;
  questionInstall: (bridge: unknown) => unknown;
  questionTimeoutReset: () => unknown;
  static reseat: (agent: object, { id }?: unknown) => object;
  run: (options?: Object) => Promise<object|null>;
  get safe(): boolean;
  set safe(value: boolean);
  send: (message: object) => Promise<object>;
  sendFile: (fileName: string) => Promise<object>;
  settings: object|undefined;
  static skillCatalog: (skills: Map<string, object>, options: unknown) => string;
  static skillSection: (skill: unknown) => string;
  get spawnPermission(): *;
  set spawnPermission(value: *);
  get thinking(): string|undefined;
  set thinking(level: string);
  get throttledUntil(): unknown;
  timeout: number|string|undefined;
  static TOOL_TIMEOUT_DEFAULT: unknown;
  toolMessages: () => Array<{name: string, text: string}>;
  toolMessagesDetect: () => Promise<Array<{name: string, text: string}>>;
  toolMessageSet: (name: string, text: string|null) => string|null;
  get tools(): Promise<Map<string, object>>;
  toolStorage: (toolname: string) => object;
  toolStorageClear: (toolname: string) => void;
  url: string|undefined;
  get usage(): {inputTokens: number, outputTokens: number, cost: number};
}
```

### `App`

```ts
export class App {
  static GTUI: unknown;
  static Markdown: unknown;
  static TUI: unknown;
  static Web: unknown;
}
```

### `CLI module`

```ts
export const adoptResumeOrigin: (options?: Object) => string|null;
export const armCancelSignals: (options?: Object) => () => void;
export const close: (options?: object) => {agent?: object, session: {id: string, file?: string}|null};
export const completeOAuthPaste: (input: string) => boolean;
export const defaultUrl: (provider: string) => string;
export const endpointPolicies: (env: object) => Array<{name: string, disabled: boolean, maxActive: number|false|undefined, effective: number|undefined, models: Array<{id: string, maxActive: number|false|undefined, effective: number|undefined}>}>;
export const endpointPolicySet: (env: object, selector: string, change: unknown) => void;
export const execute: (command: unknown) => unknown;
export const EXIT: unknown;
export const exitCodeFor: (terminal: unknown) => number;
export const formatToolResult: (result: *) => string;
export const listEndpointModels: (env: object) => {name: string, models: string[], loginRequired?: boolean}[];
export const listEndpoints: (env: object) => string[];
export const listModelCandidates: (env: object) => string[];
export const listModels: (env: object) => Promise<{name: string, models: string[]}[]>;
export const loginEndpoint: (env: object, { name: unknown, provider: unknown, url: unknown, token: unknown, auth: unknown, scope?: unknown, }?: unknown) => Promise<*>;
export const logoutEndpoint: (env: object, name: string) => {name: string, dynamic: boolean};
export const oauthPasteOnly: (descriptor: object) => boolean;
export const parseAuthorizationInput: (input: string) => {code?: string, state?: string};
export const parseFlags: (argv: string[], { flags: unknown, bools?: unknown, durations?: unknown, numbers?: unknown, "max-tool-calls"] }: unknown) => Object;
export const readContextFromStdin: () => Promise<Array<object>>;
export const readLastCombo: (env: object) => string|null;
export const readStdin: () => Promise<string>;
export const refreshOAuthTokens: (descriptor: object, refresh: string, { signal }?: unknown) => Promise<object>;
export const renderSettingsTemplate: (env: unknown) => string;
export const resolveCliToolArgs: (argv: string[], entry: unknown) => object;
export const resolveModelCombo: (value: string, env: object) => Promise<string|undefined>;
export const resolveToolArgs: (raw: string|undefined, entry: unknown) => object;
export const runLoginWizard: (env: object, { input?: unknown, output?: unknown, }?: unknown) => Promise<*>;
export const runMcpLogin: (env: object, name: string, { input?: unknown, output?: unknown) => Promise<{name: string}>;
export const runOAuthFlow: (descriptor: object, options?: object) => Promise<object>;
export const selectEndpointModel: (env: object, args: object, { lastUsed?: unknown, log?: unknown) => Promise<string|undefined>;
export const tokensToAuth: (tokens: object, previous?: object) => {type: string, access: string, token: string, refresh?: string, expires?: number};
export const unwrapToolResult: (value: *) => {result: *, system: string[], display: string[]};
export const usageSummary: (usage: object) => string;
export const writeSettingsTemplate: (env: unknown, { force?: unknown) => string;
```

### `CLI`

```ts
export class CLI {
  static adoptResumeOrigin: (options?: Object) => string|null;
  static armCancelSignals: (options?: Object) => () => void;
  static close: (options?: object) => {agent?: object, session: {id: string, file?: string}|null};
  static completeOAuthPaste: (input: string) => boolean;
  static defaultUrl: (provider: string) => string;
  static endpointPolicies: (env: object) => Array<{name: string, disabled: boolean, maxActive: number|false|undefined, effective: number|undefined, models: Array<{id: string, maxActive: number|false|undefined, effective: number|undefined}>}>;
  static endpointPolicySet: (env: object, selector: string, change: unknown) => void;
  static execute: (command: unknown) => unknown;
  static EXIT: unknown;
  static exitCodeFor: (terminal: unknown) => number;
  static formatToolResult: (result: *) => string;
  static listEndpointModels: (env: object) => {name: string, models: string[], loginRequired?: boolean}[];
  static listEndpoints: (env: object) => string[];
  static listModelCandidates: (env: object) => string[];
  static listModels: (env: object) => Promise<{name: string, models: string[]}[]>;
  static loginEndpoint: (env: object, { name: unknown, provider: unknown, url: unknown, token: unknown, auth: unknown, scope?: unknown, }?: unknown) => Promise<*>;
  static logoutEndpoint: (env: object, name: string) => {name: string, dynamic: boolean};
  static oauthPasteOnly: (descriptor: object) => boolean;
  static parseAuthorizationInput: (input: string) => {code?: string, state?: string};
  static parseFlags: (argv: string[], { flags: unknown, bools?: unknown, durations?: unknown, numbers?: unknown, "max-tool-calls"] }: unknown) => Object;
  static readContextFromStdin: () => Promise<Array<object>>;
  static readLastCombo: (env: object) => string|null;
  static readStdin: () => Promise<string>;
  static refreshOAuthTokens: (descriptor: object, refresh: string, { signal }?: unknown) => Promise<object>;
  static renderSettingsTemplate: (env: unknown) => string;
  static resolveCliToolArgs: (argv: string[], entry: unknown) => object;
  static resolveModelCombo: (value: string, env: object) => Promise<string|undefined>;
  static resolveToolArgs: (raw: string|undefined, entry: unknown) => object;
  static runLoginWizard: (env: object, { input?: unknown, output?: unknown, }?: unknown) => Promise<*>;
  static runMcpLogin: (env: object, name: string, { input?: unknown, output?: unknown) => Promise<{name: string}>;
  static runOAuthFlow: (descriptor: object, options?: object) => Promise<object>;
  static selectEndpointModel: (env: object, args: object, { lastUsed?: unknown, log?: unknown) => Promise<string|undefined>;
  static tokensToAuth: (tokens: object, previous?: object) => {type: string, access: string, token: string, refresh?: string, expires?: number};
  static unwrapToolResult: (value: *) => {result: *, system: string[], display: string[]};
  static usageSummary: (usage: object) => string;
  static writeSettingsTemplate: (env: unknown, { force?: unknown) => string;
}
```

### `Context module`

```ts
export const assemblerCallbacks: (assembler: ReturnType<typeof createAssembler>) => Object<string, function(object): void>;
export const assemblerCreate: () => {consume: (event: object) => void, message: () => object};
export const callbacksNormalize: (callbacks?: Object, binding?: Object) => Object;
export const contentBinary: (path: string, buffer: Uint8Array) => {type: "binary", mimetype: string, filename: string, content: string};
export const contentIndexer: () => {of: (key: *) => number, next: () => number};
export const contentText: (text: *) => TextContent;
export const ContentType: unknown;
export const eventCallbackName: (eventName: string) => string;
export const eventDispatch: (set: Object, event: object) => void;
export const EventType: unknown;
export const eventValid: (event: *) => boolean;
export const eventValidate: (event: *) => object;
export const FALLBACK_CONTEXT_WINDOWS: unknown;
export const fallbackContextWindow: (model: *) => number|null;
export const messageAppend: (context: Array<object>, message: object, { merge?: unknown) => object;
export const messageAssistant: (content?: Content[]) => Message;
export const messageErrorText: (msg: *) => string;
export const messageFile: (path: string, buffer: Uint8Array) => {type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>};
export const messageHasContent: (msg: *) => boolean;
export const messageHasError: (msg: *) => boolean;
export const messageIsRecord: (msg: *) => boolean;
export const messageRebuild: (msg: object) => object;
export const messagesParse: (input: string) => Array<object>;
export const messagesValid: (ctx: *) => boolean;
export const messagesValidate: (ctx: *) => Array;
export const messageSystem: (text: *) => Message;
export const MessageType: unknown;
export const messageUser: (text: string|Content[]|*, metadata?: *) => Message;
export const messageValid: (msg: *) => boolean;
export const messageValidate: (msg: *, at?: string) => object;
export const MIME_BY_EXTENSION: unknown;
export const mimeDetect: (options?: object) => string;
export const mimeOf: (block: Object|null|undefined) => string|undefined;
export const TOKENS_PER_WORD: unknown;
export const tokensEstimate: (text: *) => number;
export const tokensEstimateMessages: (context?: Array) => number;
export const usageEstimate: (context?: Array, message: object) => {inputTokens:number, outputTokens:number, source:"estimate"};
export const usageFinalize: (reported: *, context: Array, message: object) => {inputTokens:number, outputTokens:number, source:string, cost?:number};
export const usageSummary: (usage: object) => string;
export const wordCount: (text: *) => number;
```

### `Context`

```ts
export class Context {
  append: (message: object, options: unknown) => object;
  static assemblerCallbacks: (assembler: ReturnType<typeof createAssembler>) => Object<string, function(object): void>;
  static assemblerCreate: () => {consume: (event: object) => void, message: () => object};
  at: (i: number) => object|undefined;
  blockAt: (i: number, j: number) => object;
  static callbacksNormalize: (callbacks?: Object, binding?: Object) => Object;
  close: () => void;
  constructor(options?: Object);
  static contentBinary: (path: string, buffer: Uint8Array) => {type: "binary", mimetype: string, filename: string, content: string};
  static contentIndexer: () => {of: (key: *) => number, next: () => number};
  static contentText: (text: *) => TextContent;
  static ContentType: unknown;
  created: string;
  static deleteAll: (options?: Object) => {deleted: number};
  static deleteById: (options?: Object) => {deleted: number};
  dir: string|undefined;
  edit: (i: number, message: object) => object;
  editBlock: (i: number, j: number, block: object) => object;
  errorPop: () => object|undefined;
  static eventCallbackName: (eventName: string) => string;
  static eventDispatch: (set: Object, event: object) => void;
  static EventType: unknown;
  static eventValid: (event: *) => boolean;
  static eventValidate: (event: *) => object;
  static FALLBACK_CONTEXT_WINDOWS: unknown;
  static fallbackContextWindow: (model: *) => number|null;
  file: string|undefined;
  static fileOf: (options?: object) => string|undefined;
  flush: () => void;
  flushAsync: () => Promise<void>;
  id: string;
  static idAnonymous: (id: *) => boolean;
  static latest: (options?: Object) => string|undefined;
  get length(): number;
  static list: (options?: Object) => Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>;
  static listAsync: (options?: object) => Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>;
  static messageAppend: (context: Array<object>, message: object, { merge?: unknown) => object;
  static messageAssistant: (content?: Content[]) => Message;
  static messageErrorText: (msg: *) => string;
  static messageFile: (path: string, buffer: Uint8Array) => {type: 2, content: Array<{type: "binary", mimetype: string, filename: string, content: string}>};
  static messageHasContent: (msg: *) => boolean;
  static messageHasError: (msg: *) => boolean;
  static messageIsRecord: (msg: *) => boolean;
  static messageRebuild: (msg: object) => object;
  messages: () => object[];
  static messagesParse: (input: string) => Array<object>;
  static messagesValid: (ctx: *) => boolean;
  static messagesValidate: (ctx: *) => Array;
  static messageSystem: (text: *) => Message;
  static MessageType: unknown;
  static messageUser: (text: string|Content[]|*, metadata?: *) => Message;
  static messageValid: (msg: *) => boolean;
  static messageValidate: (msg: *, at?: string) => object;
  static MIME_BY_EXTENSION: unknown;
  static mimeDetect: (options?: object) => string;
  static mimeOf: (block: Object|null|undefined) => string|undefined;
  name: string|undefined;
  origin: string;
  static originOf: (options?: Object) => string|undefined;
  pop: () => object|undefined;
  prepend: (messages: object[]) => unknown;
  remove: (indexes: number[]) => object[];
  rename: (newId: string) => {id: string, file: string};
  static renameById: (options?: Object) => {id: string, file: string};
  static resume: (options?: Object) => Context;
  rollback: (i: number) => object[];
  get save(): boolean;
  set save(value: boolean);
  get settings(): object|undefined;
  set settings(value: object);
  get summary(): string;
  toJSON: () => unknown;
  static TOKENS_PER_WORD: unknown;
  static tokensEstimate: (text: *) => number;
  static tokensEstimateMessages: (context?: Array) => number;
  update: (fn: (messages: object[]) => boolean) => boolean;
  static usageEstimate: (context?: Array, message: object) => {inputTokens:number, outputTokens:number, source:"estimate"};
  static usageFinalize: (reported: *, context: Array, message: object) => {inputTokens:number, outputTokens:number, source:string, cost?:number};
  static usageSummary: (usage: object) => string;
  uuid: string;
  static wordCount: (text: *) => number;
}
```

### `Env`

```ts
export class Env {
  _attachHooks: (agent: unknown) => unknown;
  _detachHooks: (agent: unknown) => unknown;
  _hooksRefresh: () => unknown;
  agentAdd: (agent: object) => object;
  agentCreate: (options?: object) => object;
  agentRemove: (agent: object) => boolean;
  agents: () => object[];
  close: () => unknown;
  get closed(): boolean;
  connection: (selector: string, { remember?: unknown) => object;
  constructor(options?: Object);
  static create: (options: ConstructorParameters<typeof Env>[0], initOptions?: unknown) => Promise<Env>;
  get cwd(): string;
  static get envs(): Readonly<Object<string, Env>>;
  static EVENT: unknown;
  static extend: (plugin: unknown) => {EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void};
  get folders(): ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>;
  login: (name: string, config: unknown, options: unknown) => Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>;
  loginPresets: () => object[];
  logout: (name: string) => {name: string, dynamic: boolean};
  mcpLogin: (name: string, options: unknown) => Promise<{name: string}>;
  mcpPaste: (input: string) => boolean;
  mcpStatus: () => Array<{name: string, state: string}>;
  models: (secret?: boolean) => Map<string, object>;
  get modelsReady(): Promise<void>;
  get name(): string;
  offEvent: (handle: number) => boolean;
  onEvent: (event: symbol, callback: (payload: object) => void) => number;
  prompts: () => Map<string, {name: string, description: string, file: string, source: string, body: string}>;
  get settings(): Object;
  settingsSchema: () => Object} key -> {default, description;
  skillResource: (name: string, path: string) => Promise<Buffer|string[]>;
  skills: () => Map<string, {name: string, description: string, file: string, source: string, body: string}>;
  systemPrompt: () => string[];
  toolAdd: (name: string, fn: Function, schema: object, { builtin?: unknown, file }?: unknown) => Function;
  toolCall: (name: string, args: object, context: object) => Promise<*>;
  tools: (safe?: boolean, selector: string) => Promise<Map<string, object>>;
  static use: (cwd: string, fn: (env: Env) => T|Promise<T>) => Promise<T>;
}
```

### `GTUI module`

```ts
export const effect: unknown;
export const event: unknown;
export const host: unknown;
export const memory: (options?: object) => object;
export const scrollGlyph: (value: *, fallback: *) => *;
export const terminal: (options?: object) => object;
export const view: unknown;
```

### `GTUI.effect`

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

### `GTUI.event`

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

### `GTUI.host`

```ts
memory: (: unknown) => unknown;
terminal: (: unknown) => unknown;
```

### `GTUI.memory`

```ts
_effect: (value: object, send: Function) => void;
_render: (next: object) => void;
_restore: () => void;
_setTheme: (theme: object) => void;
_start: (listener: Function, binding: Function) => void;
get effects(): object[];
flush: () => void;
get restoreCount(): number;
send: (message: object) => void;
snapshot: () => object;
```

### `GTUI.view`

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

### `GTUI`

```ts
export class GTUI {
  constructor(options?: object);
  dispatch: (message: object) => void;
  run: (app: unknown) => Promise<{reason: string, code: number}>;
  stop: (reason?: string, code?: number) => void;
}
```

### `index module`

```ts
export const default: unknown;
```

### `index.default`

```ts
Agent: unknown;
Context: unknown;
Env: unknown;
EVENT: unknown;
EVENT_CALLBACKS: unknown;
finishAdd: unknown;
finishRun: unknown;
finishSignalsArm: unknown;
IO: unknown;
Jobs: unknown;
NAMES: unknown;
reseat: unknown;
TOOL_TIMEOUT_DEFAULT: unknown;
```

### `index_app module`

```ts
export const default: unknown;
```

### `index_app.default`

```ts
Agent: unknown;
App: unknown;
CLI: unknown;
Context: unknown;
Env: unknown;
EVENT: unknown;
EVENT_CALLBACKS: unknown;
finishAdd: unknown;
finishRun: unknown;
finishSignalsArm: unknown;
IO: unknown;
Jobs: unknown;
NAMES: unknown;
reseat: unknown;
TOOL_TIMEOUT_DEFAULT: unknown;
```

### `IO module`

```ts
export const Context: unknown;
export const Env: unknown;
export const THINKING_LEVELS: unknown;
export const timeoutsResolve: (options?: object) => unknown;
```

### `IO`

```ts
export class IO {
  authSet: (auth: object, options: unknown) => object;
  close: () => Promise<void>;
  connectionCreate: (options?: object) => object;
  connectTimeout: number;
  constructor(options?: Object);
  static Context: unknown;
  get contextUsage(): {used: number|undefined, total: number|undefined};
  set contextUsage(options?: object);
  env: Env;
  static Env: unknown;
  fetch: (url: string|URL, init?: object, { deadline: unknown, connectTimeout }?: unknown) => Promise<Response>;
  get model(): string;
  set model(selector: unknown);
  get modelCurrent(): string;
  name: string;
  get planUsage(): {label?: string, quotas: Object}|null;
  set planUsage(options?: object);
  protocol: string;
  Provider: Function;
  provider: object;
  static ProviderError: unknown;
  get requestSignal(): AbortSignal|undefined;
  get settings(): object;
  settingsSet: (key: string, value: *) => void;
  get state(): "idle"|"sending"|"reading"|"closed";
  stuckTimeout: number;
  static THINKING_LEVELS: unknown;
  timeout: number;
  static timeoutsResolve: (options?: object) => unknown;
  tools: () => Array<{name: string, ...Object}>;
  url: string;
  write: (context: Array, callbacks?: Object, options?: Object) => Promise<object>;
}
```

### `ProviderError`

```ts
export class ProviderError {
  constructor(kind: "auth"|"network"|"provider"|"malformed", message: string, detail?: object);
}
```

### `Jobs module`

```ts
export const daemonRun: (projectRoot: string, options?: object) => Promise<void>;
export const disable: (projectRoot: string, options?: object) => Promise<{enabled: boolean}>;
export const init: (projectRoot: string, settings?: object, options?: object) => Promise<{enabled: boolean}>;
export const run: (projectRoot: string, options?: object) => Promise<object>;
export const schedule: (root: string, command: object, options?: object) => Promise<object>;
export const status: (projectRoot: string, options?: object) => Promise<object>;
export const validate: (root: string, options?: object) => Promise<object>;
```

### `Jobs`

```ts
export class Jobs {
  static daemonRun: (projectRoot: string, options?: object) => Promise<void>;
  static disable: (projectRoot: string, options?: object) => Promise<{enabled: boolean}>;
  static init: (projectRoot: string, settings?: object, options?: object) => Promise<{enabled: boolean}>;
  static JobsError: unknown;
  static run: (projectRoot: string, options?: object) => Promise<object>;
  static schedule: (root: string, command: object, options?: object) => Promise<object>;
  static status: (projectRoot: string, options?: object) => Promise<object>;
  static validate: (root: string, options?: object) => Promise<object>;
}
```

### `JobsError`

```ts
export class JobsError {
  constructor(code: string, message: string, details?: object);
}
```

### `Markdown module`

```ts
export const classifyLine: (line: string, state?: unknown) => {kind: "fence", lang: string, raw: string;
export const lexMarkdown: (text: string) => Promise<Array<object>>;
export const markdownEngine: () => Promise<"marked"|"builtin">;
export const mathBlockAt: (lines: string[], start: number) => {end: number, text: string, source: string, tree: object}|null;
export const mathText: (node: object|null|undefined) => string;
export const parseGitDiff: (text: string) => object|null;
export const parseInline: (text: string|null|undefined) => Array<{type: string, text: string, href?: string, source?: string, tree?: object}>;
export const parseMath: (source: *) => {type: string, [key: string]: any};
export const renderInline: (text: string, renderer?: object) => string;
export const renderMarkdown: (text: string, renderer?: object) => Promise<string>;
export const sanitizeText: (text: string, { markdown?: unknown, state?: unknown, open?: unknown) => string;
export const walkTokens: (tokens: Array<object>|null|undefined, renderer?: object) => string;
```

### `BashSanitizer`

```ts
export class BashSanitizer {
  constructor(options?: object);
  end: () => string;
  push: (chunk: string) => string;
}
```

### `Markdown`

```ts
export class Markdown {
  static BashSanitizer: unknown;
  static classifyLine: (line: string, state?: unknown) => {kind: "fence", lang: string, raw: string;
  static lexMarkdown: (text: string) => Promise<Array<object>>;
  static markdownEngine: () => Promise<"marked"|"builtin">;
  static mathBlockAt: (lines: string[], start: number) => {end: number, text: string, source: string, tree: object}|null;
  static mathText: (node: object|null|undefined) => string;
  static parseGitDiff: (text: string) => object|null;
  static parseInline: (text: string|null|undefined) => Array<{type: string, text: string, href?: string, source?: string, tree?: object}>;
  static parseMath: (source: *) => {type: string, [key: string]: any};
  static renderInline: (text: string, renderer?: object) => string;
  static renderMarkdown: (text: string, renderer?: object) => Promise<string>;
  static sanitizeText: (text: string, { markdown?: unknown, state?: unknown, open?: unknown) => string;
  static walkTokens: (tokens: Array<object>|null|undefined, renderer?: object) => string;
}
```

### `Sandbox`

```ts
export class Sandbox {
  static backgroundList: (agent: unknown) => unknown;
  static backgroundOutput: (agent: unknown, id: unknown, from: unknown) => unknown;
  static backgroundStart: (agent: unknown, options: unknown) => unknown;
  static backgroundStop: (agent: unknown, id: unknown) => unknown;
  static backgroundStopAll: (agent: unknown) => unknown;
  static osAvailable: () => boolean;
  static osKind: () => "seatbelt"|"bwrap"|"delegated"|null;
  static osWrap: (file: string, args: string[], cwd: string, workingDirectory: string) => [string, string[]];
  static processStop: (child: import("node:child_process").ChildProcess, options: unknown) => Promise<void>;
  static scope: () => ProcessScope;
  static spawn: (file: string, args: string[], options: import("node:child_process").SpawnOptions) => import("node:child_process").ChildProcess;
}
```

### `TUI module`

```ts
export const close: (runtime: unknown) => {agent?: object, session?: {id: string, file?: string}|null};
export const createLineRepl: (options?: object) => object;
export const createRepl: (options?: Object) => {start: () => Promise<void>, close: () => void};
export const run: (state: object) => Promise<{code: number, agent: object, session: object|null}>;
export const TUI_ENGINES: unknown;
```

### `TUI`

```ts
export class TUI {
  static close: (runtime: unknown) => {agent?: object, session?: {id: string, file?: string}|null};
  static createApp: unknown;
  static createLineRepl: (options?: object) => object;
  static createRepl: (options?: Object) => {start: () => Promise<void>, close: () => void};
  static run: (state: object) => Promise<{code: number, agent: object, session: object|null}>;
  static TUI_ENGINES: unknown;
}
```

### `Web`

```ts
export class Web {
  static AgentSession: unknown;
  static createWebServer: unknown;
  static MAX_WS_PAYLOAD_LENGTH: unknown;
  static parseClientMessage: unknown;
  static serve: unknown;
}
```

