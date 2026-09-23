/**
 * providers/kimi.js — Kimi (Moonshot AI) protocol plugin: the OpenAI
 * CHAT-COMPLETIONS dialect (POST {url}/chat/completions, SSE chunks)
 * — the Responses dialect (lib/env/openai.js defaults) does not apply
 * to Moonshot. Transport, model listing (/models is OpenAI-shaped),
 * login, and connection verification ride the completed OpenAI
 * defaults; this plugin owns the two translators, the metadata
 * surface, and environment detection.
 *
 * Wire mapping (context -> /chat/completions):
 *   system/user  -> {role, content} (text blocks joined; image blocks
 *                  ride user messages as image_url parts; other binary
 *                  blocks upload to /files with purpose=file-extract,
 *                  then GET /files/{id}/content and fold the extracted
 *                  text into the message as a text part — Moonshot's
 *                  chat API has no file/file_id content part at all)
 *   assistant    -> {role:"assistant", content, tool_calls?} — call
 *                  arguments are always the JSON STRING
 *   tool result  -> {role:"tool", tool_call_id, content}
 * Tools: {type:"function", function:{name, description, parameters}};
 * stream_options.include_usage asks for the trailing usage chunk.
 *
 * Wire mapping (chunks -> response events): delta.reasoning_content
 * streams thinking blocks (kimi-k2-thinking), delta.content streams
 * text, delta.tool_calls stream by `index` (id/name on the first
 * piece, argument fragments after — the assembler parses the
 * accumulated string at toolcall_end). The trailing usage chunk
 * (empty choices) maps prompt/completion tokens into the usage
 * envelope; a stream that ends without one gets a synthesized done.
 */

import Context from "../lib/context.js";
const { MessageType, ContentType, mimetypeOf } = Context;
import Env from "../lib/env.js";
const { ProviderError, HttpStatusError, classifyError, depletionError, singleShot, defaultSend } = Env;

/**
 * A 403 body that unmistakably names the CREDENTIAL itself, not a
 * quota/rate condition — the only case a Kimi 403 still classifies
 * "auth". Everything else (the common case: a temporary usage/rate
 * limit hit) classifies "provider" instead, so it never wipes the
 * cached models or forces a re-login (see lib/agent/run.js) over
 * what is really "try again shortly" — a perfectly live token.
 */
const BAD_CREDENTIAL_403 = /invalid[_ ]?api[_ ]?key|unauthorized|authentication/i;

const KIMI_URL = "https://api.moonshot.ai/v1";
const KIMI_CN_URL = "https://api.moonshot.cn/v1";
const KIMI_CODING_URL = "https://api.kimi.com/coding/v1";
const REGISTRY_URL = "https://models.dev/api.json";
/** A week: how long a registry snapshot stays fresh. */
const REGISTRY_TTL = 7 * 24 * 3600 * 1000;

/** The static OFFLINE fallback for the platform presets (the live
 *  /models list and the models.dev registry both refresh over it). */
const PLATFORM_MODELS = {
  "kimi-k2-0905-preview": { label: "Kimi K2 (0905)", reasoning: false, contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-0711-preview": { label: "Kimi K2 (0711)", reasoning: false, contextWindow: 131072, maxTokens: 16384 },
  "kimi-k2-turbo-preview": { label: "Kimi K2 Turbo", reasoning: false, contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-thinking": { label: "Kimi K2 Thinking", reasoning: true, contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-thinking-turbo": { label: "Kimi K2 Thinking Turbo", reasoning: true, contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2.5": { label: "Kimi K2.5", reasoning: true, contextWindow: 262144, maxTokens: 262144 },
  "kimi-latest": { label: "Kimi Latest", reasoning: false, contextWindow: 131072 },
  "moonshot-v1-8k": { label: "Moonshot v1 8K", reasoning: false, contextWindow: 8192 },
  "moonshot-v1-32k": { label: "Moonshot v1 32K", reasoning: false, contextWindow: 32768 },
  "moonshot-v1-128k": { label: "Moonshot v1 128K", reasoning: false, contextWindow: 131072 },
};

/** The static OFFLINE fallback for the coding subscription endpoint. */
const CODING_MODELS = {
  "kimi-for-coding": { label: "Kimi for Coding", reasoning: true, contextWindow: 262144, maxTokens: 32768 },
  "kimi-for-coding-highspeed": { label: "Kimi for Coding (highspeed)", reasoning: true, contextWindow: 262144, maxTokens: 32768 },
  "k3": { label: "Kimi K3", reasoning: true, contextWindow: 1048576, maxTokens: 131072 },
  "k3-256k": { label: "Kimi K3 (256K)", reasoning: true, contextWindow: 262144, maxTokens: 131072 },
};

/**
 * Environment auto-configuration (pi's naming): MOONSHOT_API_KEY
 * configures the platform endpoint, KIMI_API_KEY the coding endpoint,
 * with no login at all; MOONSHOT_BASE_URL overrides the platform base
 * URL. Every discovery is DYNAMIC: never persisted, re-detected
 * every startup.
 */
const ENV_ENDPOINTS = [
  { name: "kimi", env: "MOONSHOT_API_KEY", url: KIMI_URL, urlEnv: "MOONSHOT_BASE_URL" },
  { name: "kimi-coding", env: "KIMI_API_KEY", url: KIMI_CODING_URL },
];

/* ------------------------------------------------ outgoing: context2msg */

/** Convert normalized context to a chat-completions request. */
function context2msg(context, aiio = this.aiio) {
  const token = aiio?.settings?.auth?.token;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = {
    model: aiio?.currentModel,
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  };
  for (const message of context) body.messages.push(...toMessages(message));
  const tools = aiio?.tools?.() ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }
  return [headers, body];
}

function toMessages(message) {
  if (message?.type === MessageType.System) {
    return [{ role: "system", content: textOf(message) }];
  }
  if (message?.type === MessageType.ToolResult) {
    return [{ role: "tool", tool_call_id: message.callId, content: textOf(message) }];
  }
  if (message?.type === MessageType.Assistant) {
    const out = { role: "assistant", content: textOf(message) || null };
    const calls = (message.content ?? []).filter((b) => b?.type === ContentType.ToolCall);
    if (calls.length > 0) {
      out.tool_calls = calls.map((b) => ({
        id: b.callId,
        type: "function",
        function: {
          name: b.name,
          arguments: typeof b.arguments === "string"
            ? b.arguments
            : JSON.stringify(b.arguments ?? {}),
        },
      }));
    }
    return [out];
  }
  // User block order is semantic. Non-image binaries are private upload
  // descriptors until send() replaces them with Kimi file references.
  const content = [];
  for (const block of message?.content ?? []) {
    const mimetype = mimetypeOf(block);
    if (block?.type === ContentType.Text && block.text) {
      content.push({ type: "text", text: String(block.text) });
    } else if ((block?.type === ContentType.Image ||
        (block?.type === ContentType.Binary && String(mimetype ?? "").startsWith("image/"))) &&
        typeof block.content === "string" && block.content !== "") {
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimetype ?? "image/png"};base64,${block.content}` },
      });
    } else if (block?.type === ContentType.Binary && typeof block.content === "string" && block.content !== "") {
      content.push({
        type: "file",
        file: {
          data: block.content,
          mimetype: mimetype ?? "application/octet-stream",
          filename: filenameOf(block, mimetype),
        },
      });
    }
  }
  return [{ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content }];
}

function filenameOf(block, mimetype) {
  if (typeof block?.filename === "string" && block.filename !== "") return block.filename;
  const extension = String(mimetype ?? "application/octet-stream").split("/")[1] ?? "bin";
  return `attachment.${extension}`;
}

/** Upload binary descriptors and replace them with their server-extracted
 *  text. Moonshot's chat-completions API has no `file`/file_id content
 *  part (only text/image_url/video_url exist on the wire) — the documented
 *  flow is upload -> GET /files/{id}/content -> fold the extracted text
 *  into the message. Only the platform endpoints expose /files at all;
 *  the coding subscription endpoint has no file API (probed live 2026-09:
 *  every /chat/completions shape carrying a file part 400s, and
 *  /files/{id}[/content] 404s). A non-image binary there gets a clear
 *  endpoint-named refusal instead of a cryptic provider error; images
 *  still ride as image_url. */
async function send(message) {
  const [headers, body] = Array.isArray(message) ? message : [undefined, message];
  if (!supportsFiles(this)) assertNoBinary(body, this);
  const prepared = await uploadFiles(this, headers ?? {}, body);
  return defaultSend(this, [headers, prepared]);
}

/** True for the platform endpoints (file upload + extraction); false for the
 *  minimal coding relay. Endpoint identity is the base URL (custom/proxied
 *  URLs default to the capable platform behavior — forwards-only, a proxy
 *  speaking the platform dialect keeps working). */
function supportsFiles(connection) {
  return !String(connection?.baseUrl ?? "").startsWith(KIMI_CODING_URL);
}

/** Refuse a non-image binary part the endpoint cannot carry. */
function assertNoBinary(body, connection) {
  if (!Array.isArray(body?.messages)) return;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "file" || !part.file?.data) continue;
      throw new ProviderError(
        "provider",
        `the ${connection.baseUrl} endpoint cannot accept file attachments (its chat API rejects the "file" part type and exposes no file extraction); attach images, or use a Moonshot platform endpoint (api.moonshot.ai) for documents`,
      );
    }
  }
}

async function uploadFiles(connection, headers, body) {
  if (!Array.isArray(body?.messages)) return body;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const part = message.content[index];
      if (part?.type !== "file" || !part.file?.data) continue;
      message.content[index] = await uploadFile(connection, headers, part.file);
    }
  }
  return body;
}

async function uploadFile(connection, headers, file) {
  const form = new FormData();
  form.append("purpose", "file-extract");
  const bytes = Buffer.from(file.data, "base64");
  form.append("file", new Blob([bytes], { type: file.mimetype }), file.filename);
  const uploadHeaders = { ...headers };
  delete uploadHeaders["content-type"];
  const response = await fetch(`${connection.baseUrl}/files`, {
    method: "POST",
    headers: uploadHeaders,
    body: form,
    signal: connection.aiio?.requestSignal,
  });
  if (!response.ok) throw new HttpStatusError(response.status, response.statusText, await response.text());
  const result = await response.json();
  if (typeof result?.id !== "string" || result.id === "") {
    throw new ProviderError("malformed", "Kimi file upload returned no file id");
  }
  const extracted = await fetchExtractedContent(connection, uploadHeaders, result.id);
  return { type: "text", text: `[${file.filename}]\n${extracted}` };
}

/** GET the server-extracted text for a file-extract upload. There is no
 *  file/file_id content part on the wire — the extracted text itself is
 *  what rides in the message (see uploadFile). */
async function fetchExtractedContent(connection, headers, fileId) {
  const response = await fetch(`${connection.baseUrl}/files/${fileId}/content`, {
    headers,
    signal: connection.aiio?.requestSignal,
  });
  if (!response.ok) throw new HttpStatusError(response.status, response.statusText, await response.text());
  return response.text();
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === ContentType.Text)
    .map((block) => block.text ?? "")
    .join("");
}

/* ------------------------------------------------ incoming: msg2events */

/**
 * @param {object} msg - one whole SSE JSON chunk from the default read
 * @param {object} state - per-request translator state (owned by IO)
 * @param {object} [aiio] - the IO instance (context-usage reporting)
 * @returns {Array<object>} normalized response events
 */
function msg2events(msg, state = {}, aiio) {
  const io = aiio ?? this?.aiio;
  if (msg?.error) {
    return [{ type: "error", error: String(msg.error.message ?? msg.error), native: msg }];
  }
  const events = [];
  const alloc = (key) => {
    state.indexes ??= new Map();
    if (!state.indexes.has(key)) {
      state.indexes.set(key, state.nextIndex ?? 0);
      state.nextIndex = (state.nextIndex ?? 0) + 1;
    }
    return state.indexes.get(key);
  };
  const closeThinking = () => {
    if (state.thinkingOpen) {
      events.push({ type: "thinking_end", contentIndex: state.thinkIndex });
      state.thinkingOpen = false;
    }
  };
  const closeText = () => {
    if (state.textOpen) {
      events.push({ type: "text_end", contentIndex: state.textIndex });
      state.textOpen = false;
    }
  };
  // tool calls have no explicit end chunk: a call closes when the next
  // one starts, when content follows, or at finish_reason
  const closeCalls = () => {
    for (const index of state.openCalls ?? []) {
      events.push({ type: "toolcall_end", contentIndex: index }); // the assembler parses the accumulated string
    }
    state.openCalls = new Set();
  };

  const choice = msg?.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
    if (!state.thinkingOpen) {
      state.thinkIndex = alloc("thinking");
      state.thinkingOpen = true;
      events.push({ type: "thinking_start", contentIndex: state.thinkIndex });
    }
    events.push({ type: "thinking_delta", contentIndex: state.thinkIndex, text: delta.reasoning_content });
  }
  if (typeof delta?.content === "string" && delta.content !== "") {
    closeThinking();
    closeCalls();
    if (!state.textOpen) {
      state.textIndex = alloc("text");
      state.textOpen = true;
      events.push({ type: "text_start", contentIndex: state.textIndex });
    }
    events.push({ type: "text_delta", contentIndex: state.textIndex, text: delta.content });
  }
  if (Array.isArray(delta?.tool_calls)) {
    closeThinking();
    closeText();
    for (const call of delta.tool_calls) {
      const key = call.index ?? 0;
      state.openCalls ??= new Set();
      if (!state.openCalls.has(key)) {
        state.openCalls.add(key);
        const index = alloc(`call:${key}`);
        state.callIndexes ??= new Map();
        state.callIndexes.set(key, index);
        events.push({
          type: "toolcall_start",
          contentIndex: index,
          callId: call.id ?? `kimi-${key}`,
          name: call.function?.name,
          arguments: "",
        });
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args !== "") {
        events.push({ type: "toolcall_delta", contentIndex: state.callIndexes.get(key), arguments: args });
      }
    }
  }
  if (choice?.finish_reason) {
    closeThinking();
    closeText();
    closeCalls();
    state.finishReason = choice.finish_reason;
  }
  // the trailing usage chunk (stream_options.include_usage): empty
  // choices + the token counts — the request's terminal event
  if (msg?.usage) {
    closeThinking();
    closeText();
    closeCalls();
    // the exact context consumption the endpoint measured
    if (Number.isFinite(msg.usage.prompt_tokens)) {
      io?.setContextUsage?.({ used: msg.usage.prompt_tokens });
    }
    events.push({
      type: "done",
      doneReason: state.finishReason,
      usage: {
        inputTokens: msg.usage.prompt_tokens,
        outputTokens: msg.usage.completion_tokens,
      },
      native: { id: msg.id, model: msg.model },
    });
  }
  return events;
}

/** The endpoint's own preset entry (URL match on knownEndpoints). */
function endpointPreset(connection) {
  return (connection?.constructor.knownEndpoints ?? []).find(
    (entry) => String(entry.url ?? "").replace(/\/$/, "") === connection.baseUrl);
}

/**
 * The models.dev registry's model map for this endpoint's preset —
 * the AUTO-DETECTION channel for newly released models: the registry
 * updates independently of this code, so a model released tomorrow
 * arrives with its context window and reasoning flag attached.
 * Snapshots cache in the endpoint's auth namespace for REGISTRY_TTL;
 * a failed fetch falls back to the cached snapshot, then to {}.
 */
async function registryModels(connection) {
  const registry = endpointPreset(connection)?.registry;
  if (!registry?.url || !registry?.provider) return {};
  const settings = connection.aiio?.settings ?? {};
  const cache = settings.registry;
  if (cache && typeof cache === "object" && cache.models &&
      Date.now() - (cache.fetchedAt ?? 0) < REGISTRY_TTL) {
    return cache.models;
  }
  try {
    const response = await fetch(registry.url, singleShot({ signal: connection.aiio?.requestSignal }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = body?.[registry.provider]?.models;
    if (!models || typeof models !== "object") throw new Error("provider absent from registry");
    const mapped = {};
    for (const [id, m] of Object.entries(models)) {
      if (!m || typeof m !== "object") continue;
      mapped[id] = {
        label: m.name ?? id,
        reasoning: m.reasoning === true,
        ...(Number.isFinite(m.limit?.context) ? { contextWindow: m.limit.context } : {}),
        ...(Number.isFinite(m.limit?.output) ? { maxTokens: m.limit.output } : {}),
      };
    }
    if (Object.keys(mapped).length === 0) throw new Error("registry held no models");
    connection.aiio?.authSet?.({ registry: { fetchedAt: Date.now(), models: mapped } });
    return mapped;
  } catch {
    return cache?.models && typeof cache.models === "object" ? cache.models : {};
  }
}

/**
 * The endpoint's model MAP, three sources merged (freshest wins):
 * the LIVE /models list (existing models auto-detected — Moonshot's
 * is OpenAI-shaped), the models.dev REGISTRY (newly released models
 * arrive with metadata, code-update-free), the preset's static list
 * and the cached map (offline fallbacks). A successful merge
 * refreshes the auth cache.
 */
async function models() {
  const settings = this.aiio?.settings ?? {};
  const headers = {};
  if (settings.auth?.token) headers.authorization = `Bearer ${settings.auth.token}`;
  let live = null;
  try {
    const response = await fetch(`${this.baseUrl}/models`, singleShot({
      headers,
      signal: this.aiio?.requestSignal,
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    live = (body.data ?? [])
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id !== "");
  } catch {
    live = null; // offline: registry + static + cached below
  }
  const registry = await registryModels(this);
  const staticModels = endpointPreset(this)?.models ?? {};
  const cached = settings.models && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models
    : {};
  const ids = live ?? [...new Set([
    ...Object.keys(staticModels), ...Object.keys(registry), ...Object.keys(cached),
  ])];
  const map = {};
  for (const id of ids) {
    const merged = { ...cached[id], ...staticModels[id], ...registry[id] };
    map[id] = {
      label: registry[id]?.label ?? staticModels[id]?.label ?? cached[id]?.label ?? id,
      reasoning: merged.reasoning === true,
      ...(Number.isFinite(merged.contextWindow) ? { contextWindow: merged.contextWindow } : {}),
      ...(Number.isFinite(merged.maxTokens) ? { maxTokens: merged.maxTokens } : {}),
    };
  }
  if (live !== null || Object.keys(registry).length > 0) {
    this.aiio?.authSet?.({ models: map });
  }
  return map;
}

/** How often the platform balance endpoint (below) is re-fetched, per
 *  aiio. In-memory only, throttled like every other separate-endpoint
 *  dialect here (Codex's usage fetch) — a wallet balance moves slowly
 *  relative to one turn's token cost, so there is no need to hit it
 *  every request. */
const KIMI_BALANCE_TTL = 60 * 1000;

/**
 * Platform-endpoint balance reporting: the one confirmed source of
 * account standing Moonshot actually publishes. Its rate-limit
 * headers (X-RateLimit-*, see reportPlanUsage below) are documented
 * only for the /tools/search* endpoints — nothing is documented for
 * /chat/completions, and in practice it publishes none — so this is
 * the fallback that makes plan reporting possible here at all: `GET
 * {baseUrl}/users/me/balance` returns `{data: {available_balance,
 * voucher_balance, cash_balance}}`, in USD on api.moonshot.ai and CNY
 * on api.moonshot.cn. Reported as a remaining-only "balance" quota —
 * a prepaid wallet has no fixed total to divide by — carrying a
 * `unit` so a display renders it as currency, not a token count. Only
 * the platform endpoints have this account model (supportsFiles is
 * the same platform/coding split used for file uploads); the coding
 * subscription has no usage endpoint this codebase could confirm, so
 * it gets no report from here (only whatever reportPlanUsage's own
 * header dialects find, same as any other endpoint).
 * @param {object} connection - the Provider instance (for baseUrl)
 * @param {object} aiio
 */
async function reportBalance(connection, aiio) {
  if (!aiio) return;
  const cache = aiio._kimiBalance;
  if (cache && Date.now() - cache.fetchedAt < KIMI_BALANCE_TTL) return;
  aiio._kimiBalance = { fetchedAt: Date.now() }; // claim the slot before awaiting — one fetch in flight at a time
  const token = aiio.settings?.auth?.token;
  if (!token) return;
  try {
    const response = await fetch(`${connection.baseUrl}/users/me/balance`, singleShot({
      headers: { authorization: `Bearer ${token}` },
      signal: aiio.requestSignal,
    }));
    if (!response.ok) return;
    const body = await response.json();
    const balance = Number(body?.data?.available_balance);
    if (!Number.isFinite(balance)) return;
    const unit = String(connection.baseUrl ?? "").includes(".cn") ? "cny" : "usd";
    aiio.setPlanUsage?.({ quotas: { balance: { remaining: balance, unit } } });
  } catch { /* best-effort — a failed balance fetch never breaks the turn */ }
}

/**
 * Plan/quota reporting: Moonshot's rate-limit headers are a single
 * UNSUFFIXED family — `X-RateLimit-Limit` / `-Remaining` / `-Reset`
 * (confirmed on the platform's /v1/tools/search* endpoints; Moonshot
 * does not document a chat-completions-specific split the way OpenAI's
 * x-ratelimit-*-requests/-tokens pair does) — so the OpenAI default
 * this plugin would otherwise inherit (defineProvider) never matches
 * anything real here. Reported as "requests" (the header names a
 * single rate dimension with no token/request distinction, and Kimi's
 * own docs describe its recharge/tier limits in request-rate terms).
 * A response instead using the OpenAI-suffixed convention (some
 * OpenAI-compatible proxies mirror it) is honored too, taking
 * precedence when both are present. Header lookups are
 * case-insensitive (Headers.get()); only what's published is reported.
 * When the headers published NOTHING (the common case in practice —
 * see reportBalance), a platform connection falls back to the balance
 * endpoint instead, so a Kimi login still reports SOMETHING rather
 * than silently nothing. May therefore return a promise; see
 * lib/io/request.js's call site (never awaited, a late rejection
 * can't escape unhandled — not that this one ever rejects).
 */
function reportPlanUsage(headers, aiio = this?.aiio) {
  const get = (name) => headers?.get?.(name) ?? undefined;
  const num = (name) => {
    const value = Number(get(name));
    return get(name) !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const suffixed = (suffix) => ({
    ...(num(`x-ratelimit-limit-${suffix}`) !== undefined ? { total: num(`x-ratelimit-limit-${suffix}`) } : {}),
    ...(num(`x-ratelimit-remaining-${suffix}`) !== undefined ? { remaining: num(`x-ratelimit-remaining-${suffix}`) } : {}),
    ...(get(`x-ratelimit-reset-${suffix}`) ? { reset: get(`x-ratelimit-reset-${suffix}`) } : {}),
  });
  const quotas = {};
  const requests = suffixed("requests");
  if (Object.keys(requests).length > 0) quotas.requests = requests;
  const tokens = suffixed("tokens");
  if (Object.keys(tokens).length > 0) quotas.tokens = tokens;
  if (!quotas.requests) {
    const bare = {
      ...(num("x-ratelimit-limit") !== undefined ? { total: num("x-ratelimit-limit") } : {}),
      ...(num("x-ratelimit-remaining") !== undefined ? { remaining: num("x-ratelimit-remaining") } : {}),
      ...(get("x-ratelimit-reset") ? { reset: get("x-ratelimit-reset") } : {}),
    };
    if (Object.keys(bare).length > 0) quotas.requests = bare;
  }
  if (Object.keys(quotas).length > 0) {
    aiio?.setPlanUsage?.({ quotas });
    return;
  }
  if (supportsFiles(this)) return reportBalance(this, aiio);
}

/** Kimi (Moonshot AI) chat-completions protocol. */
export default class KimiProvider {
  static provider = {
    label: "Kimi (Moonshot AI)",
    capabilities: { tools: true, thinking: true, streaming: true },
  };

  /** Endpoints speaking this dialect (login wizard presets). The
   *  static model maps are the OFFLINE fallback — models() merges the
   *  live /models list with the preset's models.dev registry, so
   *  existing AND newly released models auto-detect. The coding
   *  endpoint signs in with its OAuth DEVICE flow (subscription). */
  static knownEndpoints = [
    {
      name: "kimi",
      label: "Kimi (Moonshot AI)",
      url: KIMI_URL,
      registry: { url: REGISTRY_URL, provider: "moonshotai" },
      models: PLATFORM_MODELS,
    },
    {
      name: "kimi-cn",
      label: "Kimi (Moonshot AI, China)",
      url: KIMI_CN_URL,
      registry: { url: REGISTRY_URL, provider: "moonshotai-cn" },
      models: PLATFORM_MODELS,
    },
    {
      name: "kimi-coding",
      label: "Kimi for Coding (subscription)",
      url: KIMI_CODING_URL,
      registry: { url: REGISTRY_URL, provider: "kimi-for-coding" },
      models: CODING_MODELS,
      // the Kimi Code subscription sign-in: an RFC 8628 DEVICE flow
      // against auth.kimi.com (lib/cli/oauth.js grant shape B) — the
      // browser shows the verification page, the token URL is polled
      oauth: {
        label: "Kimi Code (subscription)",
        clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
        deviceAuthorizationUrl: "https://auth.kimi.com/api/oauth/device_authorization",
        tokenUrl: "https://auth.kimi.com/api/oauth/token",
      },
    },
  ];

  static async detectEndpoints({ endpoints = {} } = {}) {
    const found = {};
    for (const { name, env, url, urlEnv } of ENV_ENDPOINTS) {
      if (endpoints[name]) continue;
      const key = process.env[env];
      if (typeof key !== "string" || key === "") continue;
      found[name] = {
        provider: "kimi",
        url: process.env[urlEnv] || url,
        dynamic: true,
        auth: { type: "api_key", token: key },
      };
    }
    return found;
  }

  constructor(url = KIMI_URL, aiio) {
    this.baseUrl = String(url).replace(/\/$/, "");
    this.url = `${this.baseUrl}/chat/completions`;
    this.aiio = aiio;
  }

  context2msg(context, aiio = this.aiio) { return context2msg(context, aiio); }
  async send(message) { return send.call(this, message); }
  msg2events(message, state, aiio = this.aiio) { return msg2events(message, state, aiio); }
  async models() { return models.call(this); }
  reportPlanUsage(headers, aiio = this.aiio) { return reportPlanUsage.call(this, headers, aiio); }

  /**
   * Refine the shared taxonomy for ONE status code: a 403 is a
   * TEMPORARY usage/rate limit far more often than a dead credential
   * (401 already covers that) — see BAD_CREDENTIAL_403.
   * @param {*} err - the raw error (HttpStatusError carries status/body)
   * @returns {ProviderError}
   */
  classifyError(err) {
    if (typeof err?.status === "number" && err.status === 403) {
      const body = String(err.body ?? err.message ?? "");
      if (!BAD_CREDENTIAL_403.test(body)) {
        return new ProviderError(
          "provider",
          `${err.message} [${this.aiio?.name}] (likely a temporary usage/rate limit, not an invalid credential)`,
          { status: err.status, cause: err },
        );
      }
    }
    return classifyError(err, this.aiio?.name);
  }

  /**
   * Kimi's TOKEN-DEPLETION dialect: its usage/rate limits answer a
   * 403 whose body names the limit (see classifyError — that same
   * 403 classifies "provider" precisely BECAUSE it is a quota, not
   * a credential) — so a Kimi 403 that is not a dead credential IS
   * the budget signal. Every other failure defers to the shared
   * exact predicate (429/402, quota-named bodies).
   * @param {object} classified
   * @returns {boolean}
   */
  depletionError(classified) {
    if (classified?.status === 403 && classified?.kind === "provider" &&
        !BAD_CREDENTIAL_403.test(String(classified?.message ?? ""))) {
      return true;
    }
    return depletionError(classified);
  }
}
