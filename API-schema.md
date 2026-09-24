# API schema

### `Env.settings`

```schema
{
  "contextGuardCap": "unknown",
  "contextGuardTurnCap": "unknown",
  "env-allow": "unknown",
  "env-refuse": "unknown",
  "maxActive": "unknown",
  "maxAttempts": "unknown",
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
  "modelAccess": "unknown",
  "prompts": "unknown",
  "providerPaths": "unknown",
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
  "retryBase": "unknown",
  "retryMax": "unknown",
  "skills": "unknown",
  "tools": "unknown",
  "toolTimeout": "unknown",
  "toolTimeoutLimit": "unknown",
  "tui": "unknown",
  "web": "unknown",
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

### `Env.toolDescription.mcp.inputSchema`

```schema
{
  "action": ["servers", "tools", "call"],
  "arguments?": "object",
  "server?": "string",
  "tool?": "string",
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

### `Env.toolDescription.worker.inputSchema`

```schema
{
  "close?": "boolean",
  "description?": "string",
  "info?": "boolean",
  "list?": "boolean",
  "model?": "string",
  "name?": "string",
  "prompt?": "string",
  "reset?": "boolean",
  "safe?": "boolean",
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
export const _resetFinish: () => unknown;
export const armFinishSignals: (options?: Object) => () => void;
export const callToolSandboxed: (options?: Object) => Promise<{ok: true, value: any} | {ok: false, error: string}>;
export const DEFAULT_TOOL_TIMEOUT: unknown;
export const findSessionFile: (folder: string, id: string) => string|undefined;
export const isAnonymousId: unknown;
export const loadMessages: (data: string|Array) => Array<object>;
export const onFinish: (fn: () => void, { process: proc?: unknown) => () => void;
export const pathInfo: (path: unknown, { folder?: unknown, requireExists?: unknown) => Promise<{path:string,isFolder:boolean,mimetype?:string}>;
export const rejectAgentSymlinks: (resolved: unknown, { folder?: unknown) => unknown;
export const reseatAgent: (agent: object, { id }?: unknown) => object;
export const resolveAgentPath: (path: unknown, { folder?: unknown, boundary?: unknown) => unknown;
export const RESPONSE_CALLBACK_EVENTS: unknown;
export const resultContent: (value: *) => Array<object>;
export const runFinish: () => unknown;
export const sameFolder: (a: unknown, b: unknown) => unknown;
export const sessionDir: () => unknown;
export const thinkValue: (level: unknown) => unknown;
```

### `Agent`

```ts
export class Agent {
  append: (message: unknown) => unknown;
  busy: unknown;
  callProviderCapability: (name: unknown, args: unknown, options: unknown) => unknown;
  canCallTool: (name: unknown) => unknown;
  cancel: () => unknown;
  childAdd: (child: unknown) => unknown;
  childRemove: (child: unknown) => unknown;
  children: unknown;
  close: () => boolean;
  closed: unknown;
  closeMarked: unknown;
  compact: () => Promise<{ok: boolean, before: number, summaryText?: string}>;
  constructor(options?: Object);
  contextUsage: {used: number, total: number|null, approximate: boolean};
  createChild: (options?: object) => Agent;
  description: unknown;
  description: (value: unknown) => unknown;
  detectToolMessages: () => unknown;
  drainPending: () => Array;
  edit: (i: number, message: object) => object;
  editBlock: (i: number, j: number, block: object) => object;
  endRequested: unknown;
  enqueue: (message: object) => object|null;
  enqueueFile: (fileName: string) => Promise<object>;
  static EVENT: unknown;
  folder: unknown;
  fork: (id: string) => {id: string|null, file?: string, anonymous?: boolean};
  ioState: "idle"|"working"|"disconnected";
  latestSessionId: () => string|undefined;
  listSessions: () => Array<{id: string, file: string, mtime: number, messages: number, preview: string}>;
  listSessionsAsync: () => Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string}>>;
  name: unknown;
  name: (value: unknown) => unknown;
  newSession: (id: string) => {id: string|null, file?: string, anonymous?: boolean};
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: number, callback: (payload: object) => void) => number;
  parent: unknown;
  pathInfo: (path: string, options?: unknown) => Promise<{path:string,isFolder:boolean,mimetype?:string}>;
  pending: Array;
  planUsage: {label?: string, quotas: Object}|null;
  pop: () => object|undefined;
  removeMessages: (indexes: unknown) => unknown;
  renameSession: (name: string) => {id: string, file: string};
  requestEnd: () => true;
  static RESPONSE_CALLBACK_EVENTS: unknown;
  resumeSession: (id: string) => {id: string, file: string, cwd: string|undefined, originMissing: boolean};
  rollback: (i: number) => Array;
  run: (options?: Object) => Promise<object>;
  safe: boolean;
  sessionSave: boolean|undefined;
  sessionSaveSet: (value: boolean) => boolean;
  setFolder: (folder: string|undefined|null) => string;
  setModel: (selector: string) => {endpoint: string, model: string};
  setQuestion: (callbacks: unknown) => unknown;
  setSafe: (value: boolean) => boolean;
  setSpawnPermission: (value: unknown) => unknown;
  setThinking: (level: string) => unknown;
  spawnPermission: *;
  thinking: string|undefined;
  static toolContext: (options?: object) => {question: object|null, env: object, call: object|undefined, agent: object|undefined, storage: object|undefined, resetTimeout: Function};
  toolMessages: () => Array<{name: string, text: string}>;
  toolStorage: (toolname: string) => object;
  toolStorageClear: (toolname: string) => void;
  updateToolMessage: (name: string, text: string|null) => string|null;
  usage: {inputTokens: number, outputTokens: number, cost: number};
}
```

### `SessionStore`

```ts
export class SessionStore {
  append: (message: unknown, options: unknown) => unknown;
  close: () => unknown;
  constructor(options?: Object);
  static deleteAll: (options?: Object) => {deleted: number};
  edit: (i: unknown, message: unknown) => unknown;
  editBlock: (i: unknown, j: unknown, block: unknown) => unknown;
  flush: () => unknown;
  static latest: (options?: Object) => string|undefined;
  static list: (options?: Object) => Array<{id: string, file: string, mtime: number, messages: number, preview: string}>;
  static listAsync: (options?: object) => Promise<Array<{id: string, file: string, mtime: number, messages: number, preview: string}>>;
  static originOf: (options?: Object) => string|undefined;
  pop: () => unknown;
  prepend: (messages: unknown) => unknown;
  removeMessages: (indexes: unknown) => unknown;
  rename: (newId: string) => {id: string, file: string};
  static resume: (options?: Object) => SessionStore;
  rollback: (i: unknown) => unknown;
  save: boolean;
  saveSet: (value: boolean) => boolean;
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
export const listEndpointModels: (env: unknown, { access?: unknown) => unknown;
export const listModelCandidates: (env: unknown, { access?: unknown) => unknown;
export const listModels: (env: unknown, { access?: unknown) => unknown;
export const loginEndpoint: (env: unknown, { name: unknown, provider: unknown, url: unknown, token: unknown, auth: unknown, scope?: unknown, }?: unknown) => unknown;
export const logoutEndpoint: (env: object, name: string) => {name: string, dynamic: boolean};
export const oauthPasteOnly: (descriptor: unknown) => unknown;
export const parseAuthorizationInput: (input: string) => {code?: string, state?: string};
export const parseFlags: (argv: string[], { flags: unknown, bools?: unknown, durations?: unknown, numbers?: unknown, "max-tool-calls"] }: unknown) => Object} the parsed options (`{help: true;
export const readContextFromStdin: () => Promise<Array<object>>;
export const readLastCombo: (env: unknown) => {endpoint?: string, model: string}|null;
export const readStdin: () => Promise<string>;
export const refreshOAuthTokens: (descriptor: unknown, refresh: unknown, { signal }?: unknown) => unknown;
export const renderSettingsTemplate: (env: object) => string;
export const resolveCliToolArgs: (argv: string[], entry: unknown) => object;
export const resolveModelCombo: (value: unknown, env: unknown, { url }?: unknown) => unknown;
export const resolveToolArgs: (raw: string|undefined, entry: unknown) => object;
export const runLoginWizard: (env: unknown, { input?: unknown, output?: unknown, }?: unknown) => unknown;
export const runOAuthFlow: (descriptor: object, options?: Object) => Promise<object>;
export const selectEndpointModel: (env: unknown, args: unknown, { lastUsed?: unknown, log?: unknown) => unknown;
export const tokensToAuth: (tokens: object, previous?: unknown) => {type: string, access: string, token: string, refresh?: string, expires?: number};
export const unwrapToolResult: (value: *) => {result: *, system: string[], display: string[]};
export const usageSummary: (usage: unknown) => unknown;
export const writeLastCombo: (env: unknown, { endpoint: unknown, model }?: unknown) => unknown;
export const writeSettingsTemplate: (env: object, { force?: unknown) => string;
```

### `CLI`

```ts
export class CLI {

}
```

### `Context module`

```ts
export const appendMessage: (context: Array, message: object, { merge?: unknown) => object;
export const assemblyCallbacks: (assembler: ReturnType<typeof createAssembler>) => Object;
export const assistantMessage: (content?: unknown) => Message;
export const at: (context: Array, i: number) => object;
export const binaryContent: (path: unknown, buffer: unknown) => unknown;
export const blockAt: (context: Array, i: number, j: number) => object;
export const callbackName: (eventName: string) => string;
export const ContentType: unknown;
export const createAssembler: () => {consume: (event: object) => void, message: () => object};
export const detectMime: (options?: object) => unknown;
export const dispatch: (set: Object, event: object) => unknown;
export const editBlock: (context: Array, i: number, j: number, newBlock: object) => object;
export const editMessage: (context: Array, i: number, newMessage: object) => object;
export const estimateContextTokens: (context?: Array) => number;
export const estimateTokens: (text: string) => unknown;
export const estimateUsage: (context?: Array, message: object) => {inputTokens:number, outputTokens:number, source:"estimate"};
export const EventType: unknown;
export const fileMessage: (path: unknown, buffer: unknown) => unknown;
export const finalizeUsage: (reported: *, context: Array, message: object) => {inputTokens:number, outputTokens:number, source:string};
export const foldContent: (content: Array) => Array;
export const hasContent: (msg: *) => boolean;
export const isContext: (ctx: *) => boolean;
export const isMessage: (msg: *) => boolean;
export const isRecord: (msg: *) => boolean;
export const isResponseEvent: (event: *) => boolean;
export const mergeableMessages: (a: object, b: object) => boolean;
export const MessageType: unknown;
export const MIME_BY_EXTENSION: unknown;
export const mimetypeOf: (block: unknown) => unknown;
export const normalizeCallbacks: (callbacks?: Object, binding?: Object) => Object;
export const parseContext: (input: string) => Array<object>;
export const parseInput: (input: unknown) => unknown;
export const pop: (context: Array) => object|undefined;
export const rebuildBlock: (block: *) => object;
export const rebuildMessage: (msg: object) => object;
export const removeMessages: (context: unknown, indexes: unknown) => unknown;
export const rollbackTo: (context: Array, i: number) => Array;
export const systemMessage: (text: unknown) => Message;
export const textContent: (text: unknown) => unknown;
export const TOKENS_PER_WORD: unknown;
export const usageSummary: (usage: unknown) => unknown;
export const userMessage: (text: unknown, metadata?: unknown) => Message;
export const validateContext: (ctx: *) => Array;
export const validateMessage: (msg: *, at?: string) => object;
export const validateResponseEvent: (event: *) => object;
export const wordCount: (text: string) => unknown;
```

### `Context`

```ts
export class Context {

}
```

### `Env module`

```ts
export const awaitTimeout: (ms: number, wait: (signal: AbortSignal) => Promise<unknown>) => Promise<boolean>;
export const classifyError: (err: unknown, providerName: unknown) => unknown;
export const deepMerge: (a: *, b: *) => *;
export const DEFAULT_CONTEXT_GUARD_CAP: unknown;
export const DEFAULT_CONTEXT_GUARD_TURN_CAP: unknown;
export const DEFAULT_THINKING: unknown;
export const DEFAULT_TOOL_TIMEOUT: unknown;
export const DEFAULT_TOOL_TIMEOUT_LIMIT: unknown;
export const defaultClose: (connection: unknown) => unknown;
export const defaultConnect: (url: unknown, aiio: unknown) => {url: string, aiio: object};
export const defaultRead: (connection: unknown) => Promise<object|null>;
export const defaultSend: (connection: unknown, msg: unknown) => unknown;
export const defaultSendBody: (connection: unknown, body: unknown) => unknown;
export const defaultSendHeaders: (connection: object, headers: unknown) => unknown;
export const defaultSessionsDir: () => unknown;
export const defaultSettingsDir: () => string;
export const defineProvider: (Protocol: Function, { name }?: unknown) => Function;
export const depletionError: (classified: object) => boolean;
export const ENV_EVENT: unknown;
export const isToolModuleFile: (name: string) => boolean;
export const mergeAuthUpdate: (existing: unknown, data: unknown) => unknown;
export const openaiWebSearch: (options?: object) => unknown;
export const osSandboxAvailable: () => boolean;
export const osSandboxKind: () => "seatbelt"|"bwrap"|"delegated"|null;
export const osSandboxWrap: (file: string, args?: string[], cwd?: string, workingDirectory?: string) => [string, string[]];
export const parseDuration: (value: number|string|undefined|null) => number|undefined;
export const registryEffortLevels: (entry: object) => string[]|undefined;
export const resolveEffort: (think: boolean|string|undefined, { levels: unknown, defaultLevel }?: unknown) => string;
export const RETRYABLE_KINDS: unknown;
export const retryDelay: (settings: object, attempt: number) => number;
export const scanToolRoots: (roots: string[], env: object, { trustedRoots?: unknown) => Promise<{tools: Map<string, {fn: Function, schema: object, file: string, safe?: true, trusted?: true}>, settingsSchema: Object}>;
export const singleShot: (init?: object) => object;
export const sortEfforts: (levels: string[]) => string[];
export const supportedValues: (message: string) => string[]|undefined;
export const THINKING_LEVELS: unknown;
export const TOOL_ON_TIMEOUT_LIMIT: unknown;
export const tryDuration: (value: unknown) => unknown;
export const writeJsonAtomic: (file: string, value: *) => unknown;
```

### `Env`

```ts
export class Env {
  agentEndpointAvailable: (endpoint: unknown, model: unknown) => unknown;
  agents: () => object[];
  agentsAt: (endpoint: unknown, model: unknown) => unknown;
  agentsEndpointLimit: (endpoint: unknown, model: unknown) => unknown;
  agentsEndpointLimitSet: (options: unknown) => unknown;
  authSet: (endpoint: string, data: object, { scope }?: unknown) => object;
  batch: (fn: Function) => Promise<*>;
  callTool: (name: string, args: object, context: object) => Promise<*>;
  constructor(options?: Object);
  contextConsumption: (context: Array, lastUsage: object) => number;
  contextGuardCap: number;
  contextGuardTurnCap: number;
  contextWindow: (endpoint: string, model: string) => number|null;
  static create: (options: ConstructorParameters<typeof Env>[0], initOptions?: unknown) => Promise<Env>;
  createAgent: (options?: object) => Agent;
  defaultPromptRoots: () => string[];
  defaultProviderRoots: () => unknown;
  defaultSkillRoots: () => string[];
  defaultsSchema: () => Object} key -> {default, description;
  defaultToolRoots: () => string[];
  detectEndpoints: (options?: Object) => Promise<string[]>;
  endpoint: (name: unknown) => Object|undefined;
  endpointLocal: (name: string) => boolean;
  endpointModels: (name: string, { refresh?: unknown, url: unknown, signal }?: unknown) => Promise<Object>} the model map ({;
  endpointNames: (options?: object) => unknown;
  endpointScope: (name: string) => "package"|"local";
  endpointSettings: (endpoint: unknown) => unknown;
  flushSettings: () => unknown;
  hasTool: (name: string) => unknown;
  isDynamic: (name: string) => boolean;
  knownEndpoints: () => Array<{name: string, label: string, url: string, provider: string, oauth?: object}>;
  lastModel: () => unknown;
  loadProviders: (options?: object) => unknown;
  loadTools: (options?: Object) => Promise<string[]>;
  local: unknown;
  maxAttempts: number;
  offEvent: (handle: unknown) => unknown;
  onEvent: (event: symbol, callback: (payload: object) => void) => number;
  static osSandboxAvailable: () => boolean;
  static osSandboxKind: () => "seatbelt"|"bwrap"|"delegated"|null;
  static osSandboxWrap: (file: string, args: string[], cwd: string) => [string, string[]];
  promptBody: (name: string, { roots }?: unknown) => string|null;
  promptCatalog: (options?: object) => string;
  promptNames: (options?: object) => string[];
  promptNamesAsync: (options?: object) => Promise<string[]>;
  provider: (name: unknown) => Function|undefined;
  providerNames: () => string[];
  refreshEndpointSettings: (endpoint: string) => Object|undefined;
  refreshModels: (options?: Object) => Promise<string[]>;
  refreshToolAvailability: () => Promise<string[]>;
  refreshTools: () => Promise<string[]>;
  registerAgent: (agent: object) => object;
  registerProvider: (name: unknown, ProviderClass: unknown) => unknown;
  registerTool: (name: string, fn: Function, schema: object, { builtin?: unknown, file }?: unknown) => Function;
  remote: unknown;
  removeAgent: (agent: object) => boolean;
  removeEndpoint: (name: string) => {name: string, dynamic: boolean};
  resolveSystemPrompt: () => string[];
  retryDelay: (attempt: number) => number;
  safe: Env;
  safeToolNames: () => string[];
  saveEndpoint: (name: unknown, endpoint: unknown, { scope?: unknown) => unknown;
  saveTheme: (name: unknown) => unknown;
  skillBodies: (names: string[], { roots }?: unknown) => {text: string, unknown: string[]};
  skillCatalog: (options?: Object) => string;
  toolEntry: (name: string) => object|undefined;
  toolNames: () => string[];
  toolSchemas: (names: string[], options: unknown) => Array} [{name, ...schema;
  toolStatus: () => Array<{name: string, status: Object}>;
  toolTimeout: number;
  toolTimeoutLimit: number;
  static toolTimestamp: () => number;
  updateToolStatus: (name: string, info: Object) => Object;
}
```

### `HttpStatusError`

```ts
export class HttpStatusError {
  constructor(status: number, statusText: string, body: string);
}
```

### `ProviderError`

```ts
export class ProviderError {
  constructor(kind: "auth"|"network"|"provider"|"malformed", message: string, detail?: object);
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
export const bodyBytes: (body: *) => number;
export const classifyError: (err: unknown, providerName: unknown) => unknown;
export const connectBudget: (baseMs: number, bytes: number) => number;
export const Context: unknown;
export const defaultClose: (connection: unknown) => unknown;
export const defaultConnect: (url: unknown, aiio: unknown) => {url: string, aiio: object};
export const defaultRead: (connection: unknown) => Promise<object|null>;
export const defaultSend: (connection: unknown, msg: unknown) => unknown;
export const defaultSendBody: (connection: unknown, body: unknown) => unknown;
export const defaultSendHeaders: (connection: object, headers: unknown) => unknown;
export const defineProvider: (Protocol: Function, { name }?: unknown) => Function;
export const Env: unknown;
export const resolveTimeout: (options?: Object) => number;
export const sanitizeRequest: (msg: *) => [object, *];
```

### `IO`

```ts
export class IO {
  authSet: (auth: object, options: unknown) => object;
  constructor(options?: Object);
  contextUsage: {used: number|undefined, total: number|undefined};
  currentModel: string|undefined;
  kill: () => unknown;
  planUsage: {label?: string, quotas: Object}|null;
  requestSignal: AbortSignal|undefined;
  setContextUsage: (options?: object) => {used: number|undefined, total: number|undefined};
  setOption: (key: string, value: *) => unknown;
  setPlanUsage: (options?: object) => {label?: string, quotas: Object}|null;
  settings: object;
  state: unknown;
  tools: () => Array;
  write: (context: Array, callbacks?: Object, options?: Object) => Promise<object>;
}
```

### `Jobs module`

```ts
export const admitOccurrence: (state: unknown, task: unknown, now: unknown) => unknown;
export const allocateArchive: (projectRoot: unknown, localDate: unknown, sourceFilename: unknown, io?: unknown) => unknown;
export const archiveExists: (path: unknown, io?: unknown) => unknown;
export const canonicalProjectRoot: (projectRoot: unknown, io?: unknown) => unknown;
export const createTaskState: (task: unknown) => unknown;
export const cycleRecord: (at: unknown) => unknown;
export const disableJobs: (projectRoot: unknown, options?: unknown) => unknown;
export const dispatchJobs: (projectRoot: unknown, options?: unknown) => unknown;
export const ensureJobsLayout: (projectRoot: unknown, io?: unknown) => unknown;
export const finalizeAttempt: (state: unknown, occurrenceId: unknown, attemptId: unknown, outcome: unknown, archivePresent: unknown, session?: unknown) => unknown;
export const foregroundJobsDaemon: (projectRoot: unknown, options?: unknown) => unknown;
export const initializeJobs: (projectRoot: unknown, settings?: unknown, options?: unknown) => unknown;
export const JOBS_DATA_DIRECTORY: unknown;
export const JOBS_DISABLED_DIRECTORY: unknown;
export const JOBS_PATH_NAMES: unknown;
export const JOBS_STATE_VERSION: unknown;
export const jobsPaths: (projectRoot: unknown) => unknown;
export const jobsStatus: (projectRoot: unknown, options?: unknown) => unknown;
export const loadAllTaskStates: (projectRoot: unknown, io?: unknown) => unknown;
export const loadTasks: (projectRoot: unknown, entries: unknown, io: unknown) => unknown;
export const loadTaskState: (projectRoot: unknown, task: unknown, io?: unknown) => unknown;
export const moveToArchive: (source: unknown, archive: unknown, io?: unknown) => unknown;
export const newAttemptId: (occurrence: unknown, sequence?: unknown) => unknown;
export const normalizeDays: (value: unknown, code?: unknown) => unknown;
export const parseTask: (filename: unknown, source: unknown) => unknown;
export const parseTasks: (tasks: unknown) => unknown;
export const readTaskEntries: (root: unknown) => unknown;
export const reconcileAttempt: (state: unknown, occurrenceId: unknown, attemptId: unknown, archivePresent: unknown) => unknown;
export const recordAttempt: (state: unknown, occurrenceId: unknown, attempt: unknown) => unknown;
export const reportTaskDiagnostic: (projectRoot: unknown, diagnostic: unknown, io?: unknown) => unknown;
export const resolveArchiveReference: (projectRoot: unknown, reference: unknown) => unknown;
export const runJobAgent: (task: unknown, options?: unknown) => unknown;
export const saveTaskState: (projectRoot: unknown, state: unknown, io?: unknown) => unknown;
export const scheduleJobs: (root: unknown, command: unknown, options?: unknown) => unknown;
export const snapshotAndArchive: (source: unknown, archive: unknown, io?: unknown) => unknown;
export const statePath: (projectRoot: unknown, taskId: unknown) => unknown;
export const taskDiagnosticKey: (diagnostic: unknown) => unknown;
export const taskFilename: (value: unknown) => unknown;
export const taskId: (filename: unknown) => unknown;
export const taskStateKey: (id: unknown) => unknown;
export const validateArchiveReference: (value: unknown) => unknown;
export const validateJobsActivation: (projectRoot: unknown, settings?: unknown, options?: unknown) => unknown;
export const validateJobsLayout: (root: unknown) => unknown;
export const validateJobsOperational: (root: unknown, options?: unknown) => unknown;
export const validateTaskState: (value: unknown, taskId: unknown) => unknown;
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
export const parseGitDiff: (text: unknown) => unknown;
export const parseInline: (text: string) => Array<{type: string, text: string, href?: string}>;
export const renderInline: (text: string, renderer?: object) => string;
export const renderMarkdown: (text: string, renderer?: object) => Promise<string>;
export const walkTokens: (tokens: Array<object>, renderer?: object) => string;
```

### `Markdown`

```ts
export class Markdown {

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

