# API schema

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
  "modelAccess": "string",
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
    "grepFileSizeLimit": "number",
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

### `Env.toolContext`

```schema
{
  "agent": "Agent | undefined",
  "call": "ToolCallContent | undefined",
  "env": "Env",
  "question": "{ ask(questions): Promise<answers> } | null",
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
  "inputSchema": "JSON Schema",
  "interactive?": "boolean",
  "onTimeout?": "function(args, context)",
  "safe?": "boolean",
  "sandbox?": "boolean",
  "secret?": "boolean",
}
```

### `Env.toolDescription.bash.inputSchema`

```schema
{
  "command": "string",
  "env?": "object",
  "timeout?": "integer",
}
```

### `Env.toolDescription.edit.inputSchema`

```schema
{
  "ask?": "boolean",
  "edits?": "array",
  "matchAll?": "boolean",
  "path?": "string",
  "rollback?": "string",
}
```

### `Env.toolDescription.job-schedule.inputSchema`

```schema
{
  "action": ["list", "read", "create", "update", "remove"],
  "enabled?": "boolean",
  "filename?": "string",
  "prompt?": "string",
  "schedule?": "unknown",
}
```

### `Env.toolDescription.note.inputSchema`

```schema
{
  "action": ["set", "get", "list", "remove", "search"],
  "field?": "string",
  "max?": "number",
  "notes?": ["array", "object"],
  "only?": "array",
  "pattern?": "string",
}
```

### `Env.toolDescription.question.inputSchema`

```schema
{
  "questions": "array",
}
```

### `Env.toolDescription.read.inputSchema`

```schema
{
  "base64?": "boolean",
  "binary?": "boolean",
  "endChar?": "integer",
  "endLine?": "integer",
  "glob?": "string",
  "ignoreCase?": "boolean",
  "info?": "boolean",
  "maxMatches?": "integer",
  "path": "string",
  "pattern?": "string",
  "recursive?": "boolean",
  "startChar?": "integer",
  "startLine?": "integer",
}
```

### `Env.toolDescription.skill.inputSchema`

```schema
{
  "names?": "array",
}
```

### `Env.toolDescription.web-fetch.inputSchema`

```schema
{
  "url": "string",
}
```

### `Env.toolDescription.web-search.inputSchema`

```schema
{
  "limit?": "integer",
  "query": "string",
}
```

### `Env.toolDescription.worker-close.inputSchema`

```schema
{
  "workers": "array",
}
```

### `Env.toolDescription.worker-create.inputSchema`

```schema
{
  "prompt": "string",
  "workers": "array",
}
```

### `Env.toolDescription.worker-message.inputSchema`

```schema
{
  "prompt": "string",
  "workers": "array",
}
```

### `Env.toolDescription.worker-status.inputSchema`

```schema
{
  "models?": "boolean",
  "workers?": "boolean",
}
```

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
export const finishRun: () => unknown;
export const finishSignalsArm: (options?: Object) => () => void;
export const reseat: (agent: object, { id }?: unknown) => object;
export const TOOL_TIMEOUT_DEFAULT: unknown;
```

### `Agent`

```ts
export class Agent {
  busy: unknown;
  cancel: () => unknown;
  childCreate: (options?: object) => Agent;
  children: unknown;
  close: () => boolean;
  closed: unknown;
  closeMarked: unknown;
  compact: (focus?: string) => Promise<{ok: boolean, before: number, summaryText?: string}>;
  constructor(options?: Object);
  contextFork: (id: string|false) => {id: string, file: string, save: boolean};
  contextNew: (id: string|false) => {id: string, file: string, save: boolean};
  contextResume: (id: string) => {id: string, file: string, cwd: string|undefined, originMissing: boolean};
  contextUsage: {used: number, total: number|null, approximate: boolean};
  description: unknown;
  descriptionSet: (value: string) => string;
  static EVENT: unknown;
  static EVENT_CALLBACKS: unknown;
  folder: unknown;
  folderSet: (folder: string|undefined|null) => string;
  ioState: "idle"|"working"|"disconnected";
  modelSet: (selector: string) => {endpoint: string, model: string};
  name: unknown;
  nameSet: (value: string) => string;
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: number, callback: (payload: object) => void) => number;
  parent: unknown;
  pathInfo: (path: string, options?: unknown) => Promise<{path:string,isFolder:boolean,mimetype?:string}>;
  pending: unknown;
  pendingPop: () => Array;
  planUsage: {label?: string, quotas: Object}|null;
  policy: Readonly<object>;
  static promptCatalog: (prompts: Map<string, object>, options: unknown) => string;
  questionSet: (callbacks: unknown) => unknown;
  run: (options?: Object) => Promise<object|null>;
  safe: boolean;
  safeSet: (value: boolean) => boolean;
  send: (message: object) => Promise<object>;
  sendFile: (fileName: string) => Promise<object>;
  static skillCatalog: (skills: Map<string, object>, options: unknown) => string;
  static skillSection: (skill: unknown) => string;
  spawnPermission: *;
  spawnPermissionSet: (value: unknown) => unknown;
  thinking: string|undefined;
  thinkingSet: (level: string) => unknown;
  throttledUntil: unknown;
  toolCallable: (name: string) => Promise<boolean>;
  static toolContext: (options?: object) => {question: object|null, env: object, safe: boolean, selector: string|undefined, io: object|undefined, call: object|undefined, agent: object|undefined, storage: object|undefined, resetTimeout: Function};
  toolMessages: () => Array<{name: string, text: string}>;
  toolMessagesDetect: () => Promise<Array<{name: string, text: string}>>;
  toolMessageSet: (name: string, text: string|null) => string|null;
  toolStorage: (toolname: string) => object;
  toolStorageClear: (toolname: string) => void;
  usage: {inputTokens: number, outputTokens: number, cost: number};
}
```

### `App`

```ts
export class App {

}
```

### `CLI module`

```ts
export const adoptResumeOrigin: (options?: Object) => string|null;
export const armCancelSignals: (options?: Object) => () => void;
export const close: (options?: object) => {agent?: object, session?: {id: string, file?: string}|null};
export const completeOAuthPaste: (input: string) => boolean;
export const defaultUrl: (provider: unknown) => unknown;
export const execute: (command: unknown) => unknown;
export const EXIT: unknown;
export const exitCodeFor: (terminal: unknown) => number;
export const formatToolResult: (result: unknown) => unknown;
export const listEndpointModels: (env: unknown) => unknown;
export const listEndpoints: (env: unknown) => unknown;
export const listModelCandidates: (env: unknown) => unknown;
export const listModels: (env: unknown) => unknown;
export const loginEndpoint: (env: unknown, { name: unknown, provider: unknown, url: unknown, token: unknown, auth: unknown, scope?: unknown, }?: unknown) => unknown;
export const logoutEndpoint: (env: object, name: string) => {name: string, dynamic: boolean};
export const oauthPasteOnly: (descriptor: unknown) => unknown;
export const parseAuthorizationInput: (input: string) => {code?: string, state?: string};
export const parseFlags: (argv: string[], { flags: unknown, bools?: unknown, durations?: unknown, numbers?: unknown, "max-tool-calls"] }: unknown) => Object} the parsed options (`{help: true;
export const readContextFromStdin: () => Promise<Array<object>>;
export const readLastCombo: (env: unknown) => {endpoint: string, model: string}|null;
export const readStdin: () => Promise<string>;
export const refreshOAuthTokens: (descriptor: unknown, refresh: unknown, { signal }?: unknown) => unknown;
export const renderSettingsTemplate: (env: object) => string;
export const resolveCliToolArgs: (argv: string[], entry: unknown) => object;
export const resolveModelCombo: (value: unknown, env: unknown) => unknown;
export const resolveToolArgs: (raw: string|undefined, entry: unknown) => object;
export const runLoginWizard: (env: unknown, { input?: unknown, output?: unknown, }?: unknown) => unknown;
export const runOAuthFlow: (descriptor: object, options?: Object) => Promise<object>;
export const selectEndpointModel: (env: unknown, args: unknown, { lastUsed?: unknown, log?: unknown) => unknown;
export const tokensToAuth: (tokens: object, previous?: unknown) => {type: string, access: string, token: string, refresh?: string, expires?: number};
export const unwrapToolResult: (value: *) => {result: *, system: string[], display: string[]};
export const usageSummary: (usage: unknown) => unknown;
export const writeSettingsTemplate: (env: object, { force?: unknown) => string;
```

### `CLI`

```ts
export class CLI {

}
```

### `Context module`

```ts
export const assemblerCallbacks: (assembler: ReturnType<typeof createAssembler>) => Object;
export const assemblerCreate: () => {consume: (event: object) => void, message: () => object};
export const callbacksNormalize: (callbacks?: Object, binding?: Object) => Object;
export const contentBinary: (path: unknown, buffer: unknown) => unknown;
export const contentIndexer: () => {of: (key: *) => number, next: () => number};
export const contentText: (text: unknown) => unknown;
export const ContentType: unknown;
export const eventCallbackName: (eventName: string) => string;
export const eventDispatch: (set: Object, event: object) => unknown;
export const EventType: unknown;
export const eventValid: (event: *) => boolean;
export const eventValidate: (event: *) => object;
export const FALLBACK_CONTEXT_WINDOWS: unknown;
export const fallbackContextWindow: (model: string) => number|null;
export const messageAppend: (context: Array, message: object, { merge?: unknown) => object;
export const messageAssistant: (content?: unknown) => Message;
export const messageErrorText: (msg: unknown) => unknown;
export const messageFile: (path: unknown, buffer: unknown) => unknown;
export const messageHasContent: (msg: *) => boolean;
export const messageHasError: (msg: *) => boolean;
export const messageIsRecord: (msg: *) => boolean;
export const messageRebuild: (msg: object) => object;
export const messagesParse: (input: string) => Array<object>;
export const messagesValid: (ctx: *) => boolean;
export const messagesValidate: (ctx: *) => Array;
export const messageSystem: (text: unknown) => Message;
export const MessageType: unknown;
export const messageUser: (text: unknown, metadata?: unknown) => Message;
export const messageValid: (msg: *) => boolean;
export const messageValidate: (msg: *, at?: string) => object;
export const MIME_BY_EXTENSION: unknown;
export const mimeDetect: (options?: object) => unknown;
export const mimeOf: (block: unknown) => unknown;
export const TOKENS_PER_WORD: unknown;
export const tokensEstimate: (text: string) => unknown;
export const tokensEstimateMessages: (context?: Array) => number;
export const usageEstimate: (context?: Array, message: object) => {inputTokens:number, outputTokens:number, source:"estimate"};
export const usageFinalize: (reported: *, context: Array, message: object) => {inputTokens:number, outputTokens:number, source:string};
export const usageSummary: (usage: unknown) => unknown;
export const wordCount: (text: string) => unknown;
```

### `Context`

```ts
export class Context {
  append: (message: object, options: unknown) => object;
  at: (i: number) => object|undefined;
  blockAt: (i: number, j: number) => object;
  close: () => unknown;
  constructor(options?: Object);
  static deleteAll: (options?: Object) => {deleted: number};
  static deleteById: (options?: Object) => {deleted: number};
  edit: (i: number, message: object) => object;
  editBlock: (i: number, j: number, block: object) => object;
  errorPop: () => object|undefined;
  static fileOf: (options?: object) => string|undefined;
  flush: () => unknown;
  flushAsync: () => unknown;
  static idAnonymous: (id: *) => boolean;
  static latest: (options?: Object) => string|undefined;
  length: number;
  static list: (options?: Object) => Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>;
  static listAsync: (options?: object) => Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string, agent?: string}>>;
  messages: () => object[];
  static originOf: (options?: Object) => string|undefined;
  pop: () => object|undefined;
  prepend: (messages: object[]) => unknown;
  remove: (indexes: number[]) => object[];
  rename: (newId: string) => {id: string, file: string};
  static renameById: (options?: Object) => {id: string, file: string};
  static resume: (options?: Object) => Context;
  rollback: (i: number) => object[];
  save: boolean;
  saveSet: (value: boolean) => boolean;
  settings: object|undefined;
  settingsSet: (value: object) => unknown;
  summary: string;
  toJSON: () => unknown;
  update: (fn: (messages: object[]) => boolean) => boolean;
}
```

### `Env`

```ts
export class Env {
  agentAdd: (agent: object) => object;
  agentCreate: (options?: object) => object;
  agentRemove: (agent: object) => boolean;
  agents: () => object[];
  close: () => unknown;
  connection: (selector: string, { remember?: unknown) => object;
  constructor(options?: Object);
  static create: (options: ConstructorParameters<typeof Env>[0], initOptions?: unknown) => Promise<Env>;
  static EVENT: unknown;
  static extend: (plugin: unknown) => {EVENT: Object<string, symbol>, emit: (env: object, event: symbol, payload: object) => void};
  folders: ReadonlyArray<{kind: "project"|"harness"|"settings"|"tools", title: string, path: string}>;
  login: (name: string, config: unknown, options: unknown) => Promise<{name: string, endpoint: object, auth: object|undefined, scope: string|undefined, verified: *}>;
  loginPresets: () => object[];
  logout: (name: string) => {name: string, dynamic: boolean};
  models: (secret?: boolean) => Map<string, object>;
  modelsReady: Promise<void>;
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: symbol, callback: (payload: object) => void) => number;
  prompts: () => Map<string, {name: string, description: string, file: string, source: string, body: string}>;
  settingsSchema: () => Object} key -> {default, description;
  skills: () => Map<string, {name: string, description: string, file: string, source: string, body: string}>;
  systemPrompt: () => string[];
  toolAdd: (name: string, fn: Function, schema: object, { builtin?: unknown, file }?: unknown) => Function;
  toolCall: (name: string, args: object, context: object) => Promise<*>;
  tools: (safe?: boolean, selector: string) => Promise<Map<string, object>>;
}
```

### `GTUI module`

```ts
export const effect: unknown;
export const event: unknown;
export const host: unknown;
export const memory: (options?: object) => object;
export const scrollGlyph: (value: unknown, fallback: unknown) => unknown;
export const terminal: (options?: object) => object;
export const view: unknown;
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

### `IO module`

```ts
export const Context: unknown;
export const Env: unknown;
export const THINKING_LEVELS: unknown;
export const timeoutsResolve: (options?: Object) => number;
```

### `IO`

```ts
export class IO {
  authSet: (auth: object, options: unknown) => object;
  close: () => unknown;
  connectionCreate: (options?: Object) => object;
  constructor(options?: Object);
  contextUsage: {used: number|undefined, total: number|undefined};
  contextUsageSet: (options?: object) => {used: number|undefined, total: number|undefined};
  fetch: (url: string|URL, init?: object, { deadline: unknown, connectTimeout }?: unknown) => Promise<Response>;
  modelCurrent: string|undefined;
  planUsage: {label?: string, quotas: Object}|null;
  planUsageSet: (options?: object) => {label?: string, quotas: Object}|null;
  requestSignal: AbortSignal|undefined;
  settings: object;
  settingsSet: (key: string, value: *) => unknown;
  state: unknown;
  tools: () => Array} the request's publishable tool catalog ([{name, ...schema;
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
export const daemonRun: (projectRoot: string, options?: unknown) => unknown;
export const disable: (projectRoot: unknown, options?: unknown) => unknown;
export const init: (projectRoot: unknown, settings?: unknown, options?: unknown) => unknown;
export const run: (projectRoot: unknown, options?: unknown) => Promise<{outcomes: {id: string, outcome: string}[], errors: object[], warnings: object[], log?: string}>;
export const schedule: (root: unknown, command: unknown, options?: unknown) => unknown;
export const status: (projectRoot: unknown, options?: unknown) => unknown;
export const validate: (root: unknown, options?: unknown) => unknown;
```

### `Jobs`

```ts
export class Jobs {

}
```

### `JobsError`

```ts
export class JobsError {
  constructor(code: unknown, message: unknown, details?: unknown);
}
```

### `Markdown module`

```ts
export const classifyLine: (line: string, state?: unknown) => {kind: "fence", lang: string, raw: string;
export const lexMarkdown: (text: string) => Promise<Array<object>>;
export const markdownEngine: () => Promise<"marked"|"builtin">;
export const mathBlockAt: (lines: unknown, start: unknown) => unknown;
export const mathText: (node: unknown) => unknown;
export const parseGitDiff: (text: unknown) => unknown;
export const parseInline: (text: string) => Array<{type: string, text: string, href?: string}>;
export const parseMath: (source: unknown) => unknown;
export const renderInline: (text: string, renderer?: object) => string;
export const renderMarkdown: (text: string, renderer?: object) => Promise<string>;
export const sanitizeText: (text: string, { markdown?: unknown, state?: unknown, open?: unknown) => string;
export const walkTokens: (tokens: Array<object>, renderer?: object) => string;
```

### `BashSanitizer`

```ts
export class BashSanitizer {
  constructor(options?: object);
  end: () => unknown;
  push: (chunk: string) => string;
}
```

### `Markdown`

```ts
export class Markdown {

}
```

### `Sandbox`

```ts
export class Sandbox {
  static osAvailable: () => boolean;
  static osKind: () => "seatbelt"|"bwrap"|"delegated"|null;
  static osWrap: (file: string, args: string[], cwd: string, workingDirectory: string) => [string, string[]];
  static processStop: (child: unknown, options: unknown) => unknown;
  static scope: () => unknown;
  static spawn: (file: unknown, args: unknown, options: unknown) => unknown;
}
```

### `TUI module`

```ts
export const close: (runtime: unknown) => {agent?: object, session?: {id: string, file?: string}|null};
export const createLineRepl: (options?: object) => unknown;
export const createRepl: (options?: Object) => {start: () => Promise<void>, close: () => void};
export const run: (state: object) => Promise<{code: number, agent: object, session: object|null}>;
export const TUI_ENGINES: unknown;
```

### `TUI`

```ts
export class TUI {

}
```

### `Web`

```ts
export class Web {

}
```

