/**
 * providers/anthropic.js — Anthropic MESSAGES protocol plugin (POST
 * {url}/messages, SSE events). Transport (send/read/close) rides the
 * completed OpenAI defaults — the line reader already strips SSE
 * framing; this plugin owns the two translators, model listing (GET
 * /models is Anthropic-shaped: display_name + max_input_tokens), the
 * login-time verification, the anthropic-ratelimit-* plan report, the
 * metadata surface, and environment detection.
 *
 * Wire mapping (context -> /messages):
 *   system       -> the top-level `system` string (all joined)
 *   user         -> {role:"user", content:[text | image | document]} —
 *                  a PDF rides inline as a base64 document source, a
 *                  text-like binary decodes and rides as a `text`
 *                  document source (both send inline, no Files API
 *                  round trip — the Files API buys file_id REUSE
 *                  across requests, which this stateless per-turn
 *                  context2msg never does anyway); any other binary
 *                  media type is refused (document blocks accept only
 *                  PDF/plain-text — see providers/anthropic.js's
 *                  toMessage)
 *   assistant    -> {role:"assistant", content:[thinking (SIGNED only —
 *                  an unsigned replay is a 400), text, tool_use]}
 *   tool result  -> {role:"user", content:[tool_result]} — consecutive
 *                  same-role messages MERGE (parallel tool results must
 *                  land in ONE user message)
 * Tools: {name, description, input_schema}. `max_tokens` is the
 * model's known output cap (else 64K, the streaming default).
 * Thinking (settings.think, already the native mode IO mapped):
 * undefined = the model's default (omit); low..max = adaptive
 * (summarized display, that effort); "none" = disabled (a 400 on
 * always-thinking models).
 *
 * Wire mapping (events -> response events): content_block_start/
 * delta/stop drive text/thinking/toolcall by NATIVE index (signature
 * deltas ride the state mirror); message_start reports the measured
 * context (input + cache reads/creation); message_delta carries the
 * stop reason + output tokens; message_stop terminates with a `done`
 * whose `message` is the MIRROR (the assembler cannot carry thinking
 * signatures — the mirror can, so replays stay valid).
 *
 * Auth: API keys ride `x-api-key`; environment bearer tokens ride
 * `authorization: Bearer`. Claude subscription OAuth belongs to the
 * separate providers/claude.js dialect.
 */

import Context from "../lib/context.js";
const { MessageType, ContentType, mimeOf, contentIndexer } = Context;

const ANTHROPIC_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const REGISTRY_URL = "https://models.dev/api.json";
/** A week: how long a registry snapshot stays fresh (process memory). */
const REGISTRY_TTL = 7 * 24 * 3600 * 1000;
/** One-shot catalog request: no parked keep-alive socket holds the process open. */
const ONE_SHOT = { connection: "close" };
/** The streaming default output cap when the model's own is unknown. */
const DEFAULT_MAX_TOKENS = 64000;
/** Native thinking modes, least -> max: "none" disables, the rest are efforts. */
const THINKING_MODES = ["none", "low", "medium", "high", "xhigh", "max"];

/** The static OFFLINE fallback for the Anthropic preset (the live
 *  /models list and the models.dev registry both refresh over it). */
const ANTHROPIC_MODELS = {
  "claude-fable-5-1": { label: "Claude Fable 5.1", contextWindow: 1000000, maxTokens: 128000 },
  "claude-fable-5": { label: "Claude Fable 5", contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-5": { label: "Claude Opus 5", contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-8": { label: "Claude Opus 4.8", contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-7": { label: "Claude Opus 4.7", contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-6": { label: "Claude Opus 4.6", contextWindow: 1000000, maxTokens: 128000 },
  "claude-sonnet-5": { label: "Claude Sonnet 5", contextWindow: 1000000, maxTokens: 128000 },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", contextWindow: 1000000, maxTokens: 128000 },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 64000 },
};

/** Third-party services exposing an Anthropic-compatible /messages
 *  route (no GET /models: static lists, verified by a 1-token POST). */
const DEEPSEEK_MODELS = {
  "deepseek-chat": { label: "DeepSeek Chat", thinking: [], contextWindow: 131072, maxTokens: 8192 },
  "deepseek-reasoner": { label: "DeepSeek Reasoner", contextWindow: 131072, maxTokens: 65536 },
};
const ZAI_MODELS = {
  "glm-4.6": { label: "GLM 4.6", contextWindow: 204800, maxTokens: 131072 },
  "glm-4.5": { label: "GLM 4.5", contextWindow: 131072, maxTokens: 98304 },
};
const MINIMAX_MODELS = {
  "MiniMax-M2": { label: "MiniMax M2", contextWindow: 204800, maxTokens: 131072 },
};

/**
 * Environment auto-configuration (the Anthropic SDK's naming):
 * ANTHROPIC_API_KEY configures the endpoint with no login at all
 * (ANTHROPIC_BASE_URL overrides the base URL); ANTHROPIC_AUTH_TOKEN
 * is the bearer alternative. Every discovery is DYNAMIC: never
 * persisted, re-detected every startup.
 */
const ENV_KEY = "ANTHROPIC_API_KEY";
const ENV_BEARER = "ANTHROPIC_AUTH_TOKEN";
const ENV_URL = "ANTHROPIC_BASE_URL";
const ENV_WORKSPACE = "ANTHROPIC_WORKSPACE_ID";

/* -------------------------------------------------------------- auth */

/** Is the stored token a bearer (OAuth/subscription) token? */
function isBearer(auth) {
  return auth?.type === "oauth" || auth?.type === "bearer";
}

/** The request headers for one endpoint's credentials. */
function authHeaders(auth = {}) {
  const headers = { "anthropic-version": API_VERSION };
  if (/^wrkspc_/.test(auth.workspaceId ?? "")) {
    headers["anthropic-workspace-id"] = auth.workspaceId;
  }
  const token = auth.token;
  if (!token) return headers;
  if (isBearer(auth)) {
    headers.authorization = `Bearer ${token}`;
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

/* ------------------------------------------------ outgoing: context2msg */

/** Convert normalized context to a /messages request. */
function context2msg(context, aiio = this.aiio) {
  const settings = aiio?.settings ?? {};
  const model = aiio?.modelCurrent;
  const meta = settings.models?.[model] ?? presetOf(this.constructor, this.baseUrl)?.models?.[model];
  const headers = { "content-type": "application/json", ...authHeaders(settings.auth) };
  const body = {
    model,
    max_tokens: Number.isFinite(meta?.maxTokens)
      ? Math.min(DEFAULT_MAX_TOKENS, meta.maxTokens)
      : DEFAULT_MAX_TOKENS,
    stream: true,
    messages: [],
  };
  const system = context
    .filter((message) => message?.type === MessageType.System)
    .map(textOf)
    .filter(Boolean)
    .join("\n\n");
  if (system) body.system = system;
  for (const message of context) {
    const wire = toMessage(message);
    if (!wire) continue;
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === wire.role) last.content.push(...wire.content);
    else body.messages.push(wire);
  }
  const tools = aiio?.tools?.() ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema ? collapseAnyOf(tool.inputSchema) : { type: "object", properties: {} },
    }));
  }
  Object.assign(body, thinkingOptions(settings.think));
  return [headers, body];
}

/**
 * The Anthropic tool-schema endpoint rejects `anyOf` (unlike OpenAI's
 * function-calling schema, which tolerates it). A tool that expresses
 * "either this field set or that one" as `anyOf: [{required:[...]}, …]`
 * (e.g. the `edit` tool's rollback-or-edits shape) is collapsed instead:
 * the branches' `required` arrays are merged down to their INTERSECTION
 * (only a field required in every branch is unconditionally required)
 * and folded into the schema's own `required`, then `anyOf` is dropped.
 * Recurses into `properties`/`items` so nested object schemas are
 * covered too.
 */
function collapseAnyOf(schema) {
  if (Array.isArray(schema)) return schema.map(collapseAnyOf);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf") continue; // folded below, never copied verbatim
    out[key] = key === "properties" && value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, collapseAnyOf(v)]))
      : collapseAnyOf(value);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map(collapseAnyOf);
    const requiredSets = branches.map((b) => new Set(Array.isArray(b?.required) ? b.required : []));
    const shared = new Set(Array.isArray(out.required) ? out.required : []);
    if (requiredSets.length > 0) {
      for (const field of requiredSets[0]) {
        if (requiredSets.every((set) => set.has(field))) shared.add(field);
      }
    }
    if (shared.size > 0) out.required = [...shared];
  }
  return out;
}

/**
 * The thinking request options for one native mode: undefined omits
 * (the model's default — always-on on the Fable tier), "none"
 * disables, an effort turns adaptive thinking on with a summarized
 * display (the TUI shows it) at that effort.
 */
function thinkingOptions(think) {
  if (typeof think !== "string") return {};
  if (think === "none") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: think } };
}

/** One context message -> one wire message (nil when nothing to send). */
function toMessage(message) {
  if (message?.type === MessageType.System) return null;
  if (message?.type === MessageType.ToolResult) {
    const block = { type: "tool_result", tool_use_id: message.callId, content: textOf(message) };
    if (message.isError === true || message.error === true) block.is_error = true;
    return { role: "user", content: [block] };
  }
  if (message?.type === MessageType.Assistant) {
    const content = [];
    for (const block of message.content ?? []) {
      if (block?.type === ContentType.Thinking) {
        // only a SIGNED thinking block replays (the signature binds it
        // to its conversation); a redacted block replays as its data
        if (typeof block.data === "string" && block.data !== "") {
          content.push({ type: "redacted_thinking", data: block.data });
        } else if (typeof block.signature === "string" && block.signature !== "") {
          content.push({ type: "thinking", thinking: block.text ?? "", signature: block.signature });
        }
      } else if (block?.type === ContentType.Text) {
        if (block.text) content.push({ type: "text", text: block.text });
      } else if (block?.type === ContentType.ToolCall) {
        content.push({
          type: "tool_use",
          id: block.callId,
          name: block.name,
          input: parseArguments(block.arguments),
        });
      }
    }
    return content.length > 0 ? { role: "assistant", content } : null;
  }
  // user (and anything unknown, degraded to user content)
  const content = [];
  for (const block of message?.content ?? []) {
    if (block?.type === ContentType.Text) {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block?.type === ContentType.Image ||
        (block?.type === ContentType.Binary && String(mimeOf(block) ?? "").startsWith("image/"))) {
      if (typeof block.content !== "string" || block.content === "") continue;
      content.push({
        type: "image",
        source: { type: "base64", media_type: mimeOf(block) ?? "image/png", data: block.content },
      });
    } else if (block?.type === ContentType.Binary && typeof block.content === "string" && block.content !== "") {
      const mimetype = mimeOf(block);
      if (mimetype === "application/pdf") {
        // PDF support rides inline base64 — no upload needed, no beta
        // header required (see providers/anthropic.js header comment).
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: block.content },
        });
      } else if (isTextLike(mimetype)) {
        // document blocks only recognize media_type "text/plain" for a
        // `text` source; the original subtype (markdown/csv/json/code/…)
        // is preserved only in the title, matching Anthropic's own
        // guidance for "other text-based formats".
        content.push({
          type: "document",
          source: { type: "text", media_type: "text/plain", data: Buffer.from(block.content, "base64").toString("utf-8") },
          title: filenameOf(block, mimetype),
        });
      } else {
        // document blocks accept only PDF or plain text (Claude's Files
        // API guide: "Binary formats such as .xlsx or .docx are not
        // supported ... must be converted to text or PDF first") — this
        // provider cannot do that conversion, so refuse clearly instead
        // of sending a request the endpoint will 400 on model-invisibly.
        throw Object.assign(new Error(
          `Claude's document blocks only accept PDF or plain-text files; convert "${filenameOf(block, mimetype)}" (${mimetype ?? "unknown type"}) to one of those first, or attach it as an image if it is one`,
        ), { kind: "provider" });
      }
    }
  }
  return content.length > 0 ? { role: "user", content } : null;
}

/** Media types that decode cleanly as plain text (Claude's `document`
 *  source type "text" only recognizes media_type "text/plain" itself,
 *  but any UTF-8 text file rides fine once decoded to a string). */
const TEXT_LIKE_MIMETYPES = new Set([
  "application/json", "application/x-ndjson", "application/xml", "application/yaml", "application/toml",
]);
function isTextLike(mimetype) {
  return String(mimetype ?? "").startsWith("text/") || TEXT_LIKE_MIMETYPES.has(mimetype);
}

function filenameOf(block, mimetype) {
  if (typeof block?.filename === "string" && block.filename !== "") return block.filename;
  const extension = String(mimetype ?? "application/octet-stream").split("/")[1] ?? "bin";
  return `attachment.${extension}`;
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === ContentType.Text)
    .map((block) => block.text ?? "")
    .join("");
}

function parseArguments(value) {
  if (value !== null && typeof value === "object") return value;
  if (value === undefined || value === "") return {};
  try { return JSON.parse(value); } catch { return {}; }
}

/* ------------------------------------------------ incoming: msg2events */

/**
 * @param {object} msg - one whole SSE JSON event from the default read
 * @param {object} state - per-request translator state (owned by IO)
 * @param {object} [aiio] - the IO instance (context-usage reporting)
 * @returns {Array<object>} normalized response events
 */
function msg2events(msg, state = {}, aiio) {
  const io = aiio ?? this?.aiio;
  const type = msg?.type;
  if (type === "error" || msg?.error) {
    const error = msg.error?.message ?? msg.error ?? "Anthropic request failed";
    const text = String(error);
    const actionable = /not scoped to a workspace[\s\S]*anthropic-workspace-id/i.test(text) ||
      /anthropic-workspace-id is required when authenticating with an identity-linked API key/i.test(text)
      ? WORKSPACE_REQUIRED : text;
    return [{ type: "error", error: actionable, native: msg }];
  }
  state.blocks ??= new Map(); // native index -> mirror block
  state.index ??= contentIndexer(); // native content-block index -> contentIndex
  const alloc = (key) => state.index.of(key);

  if (type === "message_start") {
    const usage = msg.message?.usage ?? {};
    state.native = { id: msg.message?.id, model: msg.message?.model };
    state.inputTokens = countInput(usage);
    // the exact context consumption the endpoint measured (cache
    // reads and creation are context too — input_tokens excludes them)
    if (Number.isFinite(state.inputTokens)) io?.contextUsageSet?.({ used: state.inputTokens });
    return [];
  }
  if (type === "content_block_start") {
    const index = msg.index ?? state.blocks.size;
    const block = msg.content_block ?? {};
    if (block.type === "text") {
      state.blocks.set(index, { kind: "text", text: block.text ?? "" });
      return [{ type: "text_start", contentIndex: alloc(index) }];
    }
    if (block.type === "thinking") {
      state.blocks.set(index, { kind: "thinking", text: block.thinking ?? "", signature: block.signature ?? "" });
      return [{ type: "thinking_start", contentIndex: alloc(index) }];
    }
    if (block.type === "redacted_thinking") {
      state.blocks.set(index, { kind: "redacted", data: block.data ?? "" });
      return []; // nothing to show; the mirror replays it
    }
    if (block.type === "tool_use") {
      state.blocks.set(index, { kind: "tool_use", callId: block.id, name: block.name, json: "" });
      return [{
        type: "tool_call_start",
        contentIndex: alloc(index),
        callId: block.id ?? `anthropic-${index}`,
        name: block.name,
        arguments: "",
      }];
    }
    return []; // server-tool blocks and future types: tolerated
  }
  if (type === "content_block_delta") {
    const index = msg.index ?? 0;
    const mirror = state.blocks.get(index);
    const delta = msg.delta ?? {};
    if (!mirror) return [];
    if (delta.type === "text_delta" && mirror.kind === "text") {
      mirror.text += delta.text ?? "";
      return [{ type: "text_delta", contentIndex: alloc(index), text: delta.text ?? "" }];
    }
    if (delta.type === "thinking_delta" && mirror.kind === "thinking") {
      mirror.text += delta.thinking ?? "";
      return [{ type: "thinking_delta", contentIndex: alloc(index), text: delta.thinking ?? "" }];
    }
    if (delta.type === "signature_delta" && mirror.kind === "thinking") {
      mirror.signature += delta.signature ?? "";
      return [];
    }
    if (delta.type === "input_json_delta" && mirror.kind === "tool_use") {
      mirror.json += delta.partial_json ?? "";
      return [{ type: "tool_call_delta", contentIndex: alloc(index), arguments: delta.partial_json ?? "" }];
    }
    return [];
  }
  if (type === "content_block_stop") {
    const index = msg.index ?? 0;
    const mirror = state.blocks.get(index);
    if (!mirror) return [];
    if (mirror.kind === "text") return [{ type: "text_end", contentIndex: alloc(index) }];
    if (mirror.kind === "thinking") return [{ type: "thinking_end", contentIndex: alloc(index) }];
    if (mirror.kind === "tool_use") {
      mirror.input = parseArguments(mirror.json);
      return [{ type: "tool_call_end", contentIndex: alloc(index), arguments: mirror.input }];
    }
    return [];
  }
  if (type === "message_delta") {
    if (msg.delta?.stop_reason) state.stopReason = msg.delta.stop_reason;
    if (Number.isFinite(msg.usage?.output_tokens)) state.outputTokens = msg.usage.output_tokens;
    const input = countInput(msg.usage ?? {});
    if (Number.isFinite(input)) state.inputTokens = input;
    return [];
  }
  if (type === "message_stop") {
    return [{
      type: "done",
      doneReason: state.stopReason,
      message: mirrorMessage(state),
      usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
      native: state.native ?? {},
    }];
  }
  return []; // ping and unknown events
}

/** input + cache reads + cache creation, undefined when unreported. */
function countInput(usage) {
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    .filter(Number.isFinite);
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;
}

/** The assistant message the mirror assembled (signatures included). */
function mirrorMessage(state) {
  const content = [];
  for (const index of [...state.blocks.keys()].sort((a, b) => a - b)) {
    const block = state.blocks.get(index);
    if (block.kind === "text") content.push({ type: ContentType.Text, text: block.text });
    else if (block.kind === "thinking") {
      content.push({ type: ContentType.Thinking, text: block.text, ...(block.signature ? { signature: block.signature } : {}) });
    } else if (block.kind === "redacted") {
      content.push({ type: ContentType.Thinking, text: "", data: block.data, redacted: true });
    } else if (block.kind === "tool_use") {
      content.push({
        type: ContentType.ToolCall,
        callId: block.callId,
        name: block.name,
        arguments: block.input ?? parseArguments(block.json),
      });
    }
  }
  return { type: MessageType.Assistant, content };
}

/* ------------------------------------------------ models + verification */

/** The preset entry for one base URL (URL match on the class's knownEndpoints). */
function presetOf(Protocol, baseUrl) {
  return (Protocol?.knownEndpoints ?? []).find(
    (entry) => String(entry.url ?? "").replace(/\/$/, "") === baseUrl);
}

const baseUrlOf = (url) => String(url ?? ANTHROPIC_URL).replace(/\/$/, "");

/** Registry snapshots per registry URL + provider (process lifetime, REGISTRY_TTL). */
const registryCache = new Map();

/** A registry entry's native thinking modes: [] for a non-reasoning model,
 *  "none" + its declared efforts, or undefined (every mode). */
function registryThinking(entry) {
  if (entry?.reasoning !== true) return [];
  const efforts = (Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [])
    .filter((option) => option?.type === "effort" && Array.isArray(option.values))
    .flatMap((option) => option.values);
  const modes = THINKING_MODES.filter((mode) => mode === "none" || efforts.includes(mode));
  return modes.length > 1 ? modes : undefined;
}

/** The in-memory registry snapshot for a preset (no download), or {}. */
function registrySnapshot(preset) {
  const registry = preset?.registry;
  return registryCache.get(`${registry?.url} ${registry?.provider}`)?.models ?? {};
}

/**
 * The models.dev registry's model map for this endpoint's preset —
 * the AUTO-DETECTION channel for newly released models (the registry
 * updates independently of this code). A failed fetch falls back to
 * the last snapshot, then to {}.
 */
async function registryModels(preset, signal) {
  const registry = preset?.registry;
  if (!registry?.url || !registry?.provider) return {};
  const key = `${registry.url} ${registry.provider}`;
  const cache = registryCache.get(key);
  if (cache && Date.now() - cache.fetchedAt < REGISTRY_TTL) return cache.models;
  try {
    const response = await fetch(registry.url, { headers: ONE_SHOT, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = body?.[registry.provider]?.models;
    if (!models || typeof models !== "object") throw new Error("provider absent from registry");
    const mapped = {};
    for (const [id, m] of Object.entries(models)) {
      if (!m || typeof m !== "object") continue;
      const thinking = registryThinking(m);
      mapped[id] = {
        label: m.name ?? id,
        ...(thinking ? { thinking } : {}),
        ...(Number.isFinite(m.limit?.context) ? { contextWindow: m.limit.context } : {}),
        ...(Number.isFinite(m.limit?.output) ? { maxTokens: m.limit.output } : {}),
      };
    }
    if (Object.keys(mapped).length === 0) throw new Error("registry held no models");
    registryCache.set(key, { fetchedAt: Date.now(), models: mapped });
    return mapped;
  } catch {
    return cache?.models ?? {};
  }
}

/** Does the endpoint verify by a 1-token POST (no GET /models route)? */
function verifiesByMessage(preset, settings) {
  return (settings?.verify ?? preset?.verify) === "messages";
}

/** One Anthropic /models entry -> the model map value. */
function mapLiveModel(model) {
  const thinking = model.capabilities?.thinking;
  const reasoning = thinking && typeof thinking === "object"
    ? Object.values(thinking.types ?? thinking).some((t) => t?.supported === true) ||
      thinking.supported === true
    : true; // every current Claude model thinks
  return {
    label: model.display_name ?? model.id,
    ...(reasoning ? {} : { thinking: [] }),
    ...(Number.isFinite(model.max_input_tokens) ? { contextWindow: model.max_input_tokens } : {}),
    ...(Number.isFinite(model.max_tokens) ? { maxTokens: model.max_tokens } : {}),
  };
}

const WORKSPACE_REQUIRED = "This API key works across workspaces; set ANTHROPIC_WORKSPACE_ID to a wrkspc_… ID from Console → Settings → Workspaces (or log in with a workspace ID).";

function errorText(error) {
  return String(error?.body ?? error?.message ?? "");
}

function workspaceRequired(error) {
  return error?.status === 400 && (
    /not scoped to a workspace[\s\S]*anthropic-workspace-id/i.test(errorText(error)) ||
    /anthropic-workspace-id is required when authenticating with an identity-linked API key/i.test(errorText(error))
  );
}

function workspaceInvalid(error) {
  return error?.status === 400 && /anthropic-workspace-id header must be a valid workspace ID/i.test(errorText(error));
}

/** Classify this credential with exactly one GET /models request. */
async function workspaceMode(baseUrl, auth = {}, signal) {
  const configured = auth.workspaceId;
  if (configured !== undefined && !/^wrkspc_/.test(configured)) {
    throw new Error("ANTHROPIC_WORKSPACE_ID must be a wrkspc_… workspace ID");
  }
  const response = await fetch(`${baseUrl}/models?limit=1000`, { headers: { ...authHeaders(auth), ...ONE_SHOT }, signal });
  if (!response.ok) {
    const error = await statusError(response);
    if (configured && workspaceInvalid(error)) {
      throw new Error("ANTHROPIC_WORKSPACE_ID is not a valid workspace for this key");
    }
    if (!configured && workspaceRequired(error)) throw new Error(WORKSPACE_REQUIRED);
    throw error;
  }
  const body = await response.json();
  if (!Array.isArray(body.data)) throw new Error("malformed model catalog");
  const models = {};
  for (const model of body.data) {
    if (typeof model?.id === "string" && model.id !== "") models[model.id] = mapLiveModel(model);
  }
  return { mode: configured ? "configured" : "scoped", models };
}

/**
 * Live Anthropic-shaped /models IDs and metadata take precedence;
 * static and cached metadata fill only missing fields for those IDs.
 * On failure, registry/static/cache provide the fallback.
 * Message-verified presets have no list route: static + registry +
 * cache only.
 * @this {Function} the registered provider class
 */
async function models({ url, auth, settings = {}, signal } = {}) {
  const baseUrl = baseUrlOf(url);
  const preset = presetOf(this, baseUrl);
  const byMessage = verifiesByMessage(preset, settings);
  let live = null;
  if (!byMessage) {
    try { live = (await workspaceMode(baseUrl, auth, signal)).models; }
    catch { live = null; }
  }
  // A failed live request returns to the static catalog plus any
  // registry snapshot already in memory — never another blocking download.
  const registry = byMessage ? await registryModels(preset, signal)
    : live === null ? registrySnapshot(preset) : {};
  const staticModels = preset?.models ?? {};
  const cached = settings.models && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models : {};
  const ids = live
    ? Object.keys(live)
    : [...new Set([...Object.keys(staticModels), ...Object.keys(registry), ...Object.keys(cached)])];
  const map = {};
  for (const id of ids) {
    const merged = { ...cached[id], ...staticModels[id], ...registry[id], ...live?.[id] };
    map[id] = {
      label: live?.[id]?.label ?? registry[id]?.label ?? staticModels[id]?.label ?? cached[id]?.label ?? id,
      ...(Array.isArray(merged.thinking) ? { thinking: merged.thinking } : {}),
      ...(Number.isFinite(merged.contextWindow) ? { contextWindow: merged.contextWindow } : {}),
      ...(Number.isFinite(merged.maxTokens) ? { maxTokens: merged.maxTokens } : {}),
    };
  }
  return map;
}

/** A non-2xx response as a classifiable error (status rides along). */
async function statusError(response) {
  const text = await response.text().catch(() => "");
  const error = new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  error.status = response.status;
  error.body = text;
  return error;
}

/**
 * Strict login-time verification: THROW on any failure. The Anthropic
 * API lists models (GET /models — a dead key is a 401 here); a
 * message-verified preset (third-party /messages routes without a
 * list) sends a 1-token request to its first known model instead.
 * @this {Function} the registered provider class
 * @returns {Promise<{models: number}>}
 */
async function testConnection({ url, auth, settings = {}, signal } = {}) {
  const baseUrl = baseUrlOf(url);
  const preset = presetOf(this, baseUrl);
  if (verifiesByMessage(preset, settings)) {
    const known = { ...preset?.models, ...settings.models };
    const model = Object.keys(known)[0];
    if (!model) throw new Error("no model to verify with: the endpoint declares none");
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(auth) },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    try {
      if (!response.ok) throw await statusError(response);
    } finally {
      response.body?.cancel?.().catch?.(() => {});
    }
    return { models: Object.keys(known).length };
  }
  const classified = await workspaceMode(baseUrl, auth, signal);
  return { models: Object.keys(classified.models).length };
}

/** `anthropic-ratelimit-unified-<window>-utilization` — one per Claude
 *  subscription (OAuth) rate-limit window ("5h", "7d", ...): the ONLY
 *  family a subscription request publishes (the plain per-key families
 *  above are API-key metering and are absent on OAuth responses,
 *  which is why a Claude Pro/Max login previously reported no plan
 *  quotas at all). Unlike those, this reports a SPENT FRACTION
 *  (0–1, e.g. 0.42 for 42% used) with no token total to divide by —
 *  converted to {total: 100, used, remaining} (percentage points) so
 *  it fits the same quota shape every consumer (tui-app/web-app)
 *  already renders, with no format-specific handling needed. */
const UNIFIED_WINDOW = /^anthropic-ratelimit-unified-([a-z0-9]+)-utilization$/i;

/** The window NAME is the only place its length is published (there is
 *  no separate numeric header) — "5h" -> 18000, "7d" -> 604800.
 *  undefined for anything not a clean <n><unit> shape: never guessed,
 *  just left out (a consumer can still show the name; it just can't
 *  compute a window-relative countdown or progress from it). */
function parseWindowSeconds(label) {
  const match = /^(\d+)([dhms])$/i.exec(String(label ?? ""));
  if (!match) return undefined;
  const size = { d: 86400, h: 3600, m: 60, s: 1 }[match[2].toLowerCase()];
  return Number(match[1]) * size;
}

function unifiedWindowQuotas(headers) {
  const quotas = {};
  if (typeof headers?.forEach !== "function") return quotas;
  headers.forEach((value, name) => {
    const match = UNIFIED_WINDOW.exec(name);
    if (!match) return;
    const windowSeconds = parseWindowSeconds(match[1]);
    // Only named durations are subscription allowances. Other unified
    // values (for example `overage`) are account-policy metadata, not a
    // user-actionable time window, and would make the plan a third detail.
    if (!Number.isFinite(windowSeconds)) return;
    const spent = Number(value);
    if (!Number.isFinite(spent)) return;
    const usedPct = Math.min(100, Math.max(0, Math.round(spent * 100)));
    const reset = headers.get?.(`anthropic-ratelimit-unified-${match[1]}-reset`);
    quotas[match[1]] = {
      total: 100, used: usedPct, remaining: 100 - usedPct,
      ...(reset ? { reset } : {}),
      // the window's full cycle length — lets a consumer show elapsed
      // time / a countdown alongside the usage percentage above
      windowSeconds,
    };
  });
  return quotas;
}

/**
 * Plan/quota reporting: the `anthropic-ratelimit-*` response headers
 * (requests, total tokens, input tokens, output tokens — each with limit /
 * remaining / reset — API-key metering) plus the subscription-session
 * `anthropic-ratelimit-unified-*` windows (see unifiedWindowQuotas)
 * into the plan-usage channel. The plan readout deliberately has two
 * details: API keys retain requests + total tokens (input/output are subsets);
 * OAuth retains duration-named allowance windows (normally 5h + 7d).
 */
function reportPlanUsage(headers, aiio = this?.aiio) {
  const get = (name) => headers?.get?.(name) ?? undefined;
  const num = (name) => {
    const value = Number(get(name));
    return get(name) !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const quotas = unifiedWindowQuotas(headers);
  const families = [
    ["requests", "requests"], ["tokens", "tokens"],
  ];
  for (const [wire, key] of families) {
    const quota = {
      ...(num(`anthropic-ratelimit-${wire}-limit`) !== undefined ? { total: num(`anthropic-ratelimit-${wire}-limit`) } : {}),
      ...(num(`anthropic-ratelimit-${wire}-remaining`) !== undefined ? { remaining: num(`anthropic-ratelimit-${wire}-remaining`) } : {}),
      ...(get(`anthropic-ratelimit-${wire}-reset`) ? { reset: get(`anthropic-ratelimit-${wire}-reset`) } : {}),
    };
    if (Object.keys(quota).length > 0) quotas[key] = quota;
  }
  if (Object.keys(quotas).length > 0) aiio?.planUsageSet?.({ quotas });
}

/** The auth record an Anthropic API-key login stores. */
function login(input = {}, { settings } = {}) {
  const token = input.token ?? settings?.auth?.token;
  if (!token) {
    const error = new Error("Anthropic login requires an API key");
    error.kind = "auth";
    throw error;
  }
  if (/^sk-ant-oat/.test(token)) throw new Error("Claude subscription OAuth tokens require the claude provider");
  const workspaceId = input.workspaceId ?? settings?.auth?.workspaceId;
  if (workspaceId !== undefined && !/^wrkspc_/.test(workspaceId)) {
    throw new Error("Anthropic workspace ID must start with wrkspc_");
  }
  return { type: "api_key", token, ...(workspaceId ? { workspaceId } : {}) };
}

/* --------------------------------------------------- web capabilities */

/**
 * Anthropic hosts the server tools ONLY on its own API. Third-party
 * /messages routes (DeepSeek, Z.ai, MiniMax) have no web_search /
 * web_fetch server blocks — an unsupported endpoint answers undefined
 * (honest fall-through), never a request that could only 400. The
 * handler receives the IO instance: its `url` IS the endpoint's base
 * URL (the /messages suffix lives on the provider CONNECTION, which
 * the capability contract does not pass).
 */
function anthropicHosted(aiio) {
  return String(aiio?.url ?? "").replace(/\/$/, "") === ANTHROPIC_URL;
}

/** API-key/bearer wire for server-tool requests: plain auth headers,
 *  body unchanged. Dialects with other auth (claude OAuth) pass their own. */
function apiWire(aiio, body) {
  return [{ "content-type": "application/json", ...authHeaders(aiio?.settings?.auth) }, body];
}

/**
 * One server-tool request against POST {baseUrl}/messages: a single
 * tight user prompt plus the documented tool block, non-streaming.
 * `wire(aiio, body) -> [headers, body]` applies the dialect's auth and
 * required framing. The returned Markdown is the concatenation of the
 * response's text content blocks. A rejected request (4xx/5xx) THROWS
 * with the status — the Agent wraps it as a failure and dispatch falls
 * through; the result is never fabricated.
 */
async function serverToolRequest(aiio, wire, tool, prompt, { signal, deadline }) {
  const [headers, payload] = wire(aiio, {
    model: aiio.modelCurrent,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    tools: [{ ...tool }],
  });
  // Shared deadline/connect discipline: raced deadline + 3s connect fail-fast.
  const response = await aiio.fetch(`${String(aiio.url).replace(/\/$/, "")}/messages`, {
    method: "POST", headers, signal, body: JSON.stringify(payload),
  }, { deadline });
  if (!response.ok) throw await statusError(response);
  const body = await response.json();
  return (body?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** The documented web_search server tool (docs.claude.com, verified
 *  2026-09-22): type "web_search_20250305", name "web_search",
 *  max_uses caps the server's searches per request. */
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
/** The documented web_fetch server tool: type "web_fetch_20250910",
 *  name "web_fetch", max_uses caps the server's fetches. */
const WEB_FETCH_TOOL = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 };

/**
 * The provider tools `web-search` / `web-fetch` (they shadow the
 * package tools of the same names), bound to a dialect's server-tool
 * wire. Undefined = unsupported here → the package tool's MCP/local path.
 * @param {(aiio: object, body: object) => [object, object]} [wire]
 */
function webTools(wire = apiWire) {
  return {
    "web-search": { function: async ({ aiio, args, signal, deadline }) => {
      if (!anthropicHosted(aiio)) return undefined;
      const query = String(args?.query ?? "").trim();
      if (query === "") return undefined;
      return serverToolRequest(aiio, wire, WEB_SEARCH_TOOL,
        `Search the web for "${query}" and answer with the top results as a Markdown list: each result one bullet with its title, URL, and a one-or-two-sentence snippet from the page.`,
        { signal, deadline });
    } },
    "web-fetch": { function: async ({ aiio, args, signal, deadline }) => {
      if (!anthropicHosted(aiio)) return undefined;
      const url = String(args?.url ?? "").trim();
      if (url === "") return undefined;
      return serverToolRequest(aiio, wire, WEB_FETCH_TOOL,
        `Fetch ${url} and answer with the page's main content as clean Markdown, preserving its headings and links.`,
        { signal, deadline });
    } },
  };
}

/** Anthropic Messages protocol. */
export default class AnthropicProvider {
  static provider = {
    label: "Anthropic (Claude)",
    capabilities: {
      streaming: true,
      thinking: THINKING_MODES,
      tools: webTools(),
    },
  };

  /** Endpoints speaking this dialect (login wizard presets). The
   *  Anthropic preset lists live (/models) and auto-detects new
   *  models through the models.dev registry; the third-party presets
   *  expose an Anthropic-compatible /messages route with no list —
   *  their static maps are the catalog and a 1-token message verifies
   *  the login (`verify: "messages"` persists with the endpoint). */
  static knownEndpoints = [
    {
      name: "anthropic",
      label: "Anthropic (Claude)",
      url: ANTHROPIC_URL,
      registry: { url: REGISTRY_URL, provider: "anthropic" },
      models: ANTHROPIC_MODELS,
    },
    {
      name: "deepseek-anthropic",
      label: "DeepSeek (Anthropic API)",
      url: "https://api.deepseek.com/anthropic",
      verify: "messages",
      models: DEEPSEEK_MODELS,
    },
    {
      name: "zai-anthropic",
      label: "Z.ai GLM (Anthropic API)",
      url: "https://api.z.ai/api/anthropic",
      verify: "messages",
      models: ZAI_MODELS,
    },
    {
      name: "minimax-anthropic",
      label: "MiniMax (Anthropic API)",
      url: "https://api.minimax.io/anthropic",
      verify: "messages",
      models: MINIMAX_MODELS,
    },
  ];

  /** Create Anthropic-hosted web tool handlers with dialect-specific request framing. */
  static webTools(wire) { return webTools(wire); }

  static async detect({ endpoints = {} } = {}) {
    const found = {};
    if (endpoints.anthropic) return found;
    const key = process.env[ENV_KEY];
    const bearer = process.env[ENV_BEARER];
    const workspaceId = process.env[ENV_WORKSPACE];
    const url = process.env[ENV_URL] || ANTHROPIC_URL;
    let auth;
    if (typeof key === "string" && key !== "") auth = { type: "api_key", token: key };
    else if (typeof bearer === "string" && bearer !== "") auth = { type: "bearer", token: bearer };
    if (!auth) return found;
    if (typeof workspaceId === "string" && workspaceId !== "") auth.workspaceId = workspaceId;
    found.anthropic = {
      provider: "anthropic", url, dynamic: true, auth, models: ANTHROPIC_MODELS,
    };
    return found;
  }

  static async models(options) { return models.call(this, options); }
  static async testConnection(options) { return testConnection.call(this, options); }
  static login(input, context) { return login(input, context); }

  constructor(url = ANTHROPIC_URL, aiio) {
    this.baseUrl = String(url).replace(/\/$/, "");
    this.url = `${this.baseUrl}/messages`;
    this.aiio = aiio;
  }

  context2msg(context, aiio = this.aiio) { return context2msg.call(this, context, aiio); }
  msg2events(message, state, aiio = this.aiio) { return msg2events.call(this, message, state, aiio); }
  reportPlanUsage(headers, aiio = this.aiio) { return reportPlanUsage.call(this, headers, aiio); }
}
