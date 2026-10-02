/**
 * providers/kimi.js — Kimi (Moonshot AI) protocol plugin: the OpenAI
 * CHAT-COMPLETIONS dialect (POST {url}/chat/completions, SSE chunks)
 * — the Responses dialect (IO's OpenAI defaults) does not apply to
 * Moonshot. The HTTP transport, login, and connection verification ride
 * the completed OpenAI defaults; this plugin owns the two translators,
 * the model catalog, the metadata surface, and environment detection.
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
 * accumulated string at tool_call_end). The trailing usage chunk
 * (empty choices) maps prompt/completion tokens into the usage
 * envelope; a stream that ends without one gets a synthesized done.
 */

import { createHash } from "node:crypto";
import Context from "../lib/context.js";
const { MessageType, ContentType, mimeOf, contentIndexer } = Context;

/** A plain classifiable error (IO maps `kind`/`status` onto its taxonomy). */
const failure = (kind, message) => Object.assign(new Error(message), { kind });

/** A failed HTTP response as a plain classifiable error (status and body ride along). */
async function statusError(response) {
  const body = await response.text().catch(() => "");
  return Object.assign(new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`),
    { status: response.status, body });
}

/** One-shot catalog request: no parked keep-alive socket holds the process open. */
const ONE_SHOT = { connection: "close" };

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
/** A week: how long a registry snapshot stays fresh (process memory). */
const REGISTRY_TTL = 7 * 24 * 3600 * 1000;

/** The static OFFLINE fallback for the platform presets (the live
 *  /models list and the models.dev registry both refresh over it). */
const PLATFORM_MODELS = {
  "kimi-k2-0905-preview": { label: "Kimi K2 (0905)", contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-0711-preview": { label: "Kimi K2 (0711)", contextWindow: 131072, maxTokens: 16384 },
  "kimi-k2-turbo-preview": { label: "Kimi K2 Turbo", contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-thinking": { label: "Kimi K2 Thinking", contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2-thinking-turbo": { label: "Kimi K2 Thinking Turbo", contextWindow: 262144, maxTokens: 262144 },
  "kimi-k2.5": { label: "Kimi K2.5", contextWindow: 262144, maxTokens: 262144 },
  "kimi-latest": { label: "Kimi Latest", contextWindow: 131072 },
  "moonshot-v1-8k": { label: "Moonshot v1 8K", contextWindow: 8192 },
  "moonshot-v1-32k": { label: "Moonshot v1 32K", contextWindow: 32768 },
  "moonshot-v1-128k": { label: "Moonshot v1 128K", contextWindow: 131072 },
};

/** The static OFFLINE fallback for the coding subscription endpoint. */
const CODING_MODELS = {
  "kimi-for-coding": { label: "Kimi for Coding", contextWindow: 262144, maxTokens: 32768 },
  "kimi-for-coding-highspeed": { label: "Kimi for Coding (highspeed)", contextWindow: 262144, maxTokens: 32768 },
  "k3": { label: "Kimi K3", contextWindow: 1048576, maxTokens: 131072 },
  "k3-256k": { label: "Kimi K3 (256K)", contextWindow: 262144, maxTokens: 131072 },
};

/**
 * Environment auto-configuration: both MOONSHOT_API_KEY and KIMI_API_KEY
 * are platform keys (Kimi Code subscription keys use a separate console).
 * MOONSHOT_BASE_URL overrides the MOONSHOT_API_KEY endpoint only.
 * Every discovery is DYNAMIC: never persisted, re-detected at startup.
 */
const ENV_ENDPOINTS = [
  { name: "moonshot", env: "MOONSHOT_API_KEY", url: KIMI_URL, urlEnv: "MOONSHOT_BASE_URL" },
  { name: "kimi", env: "KIMI_API_KEY", url: KIMI_URL },
];

/* ------------------------------------------------ outgoing: context2msg */

/** Convert normalized context to a chat-completions request. */
function context2msg(context, aiio = this.aiio) {
  const token = aiio?.settings?.auth?.token;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = {
    model: aiio?.modelCurrent?.slice(aiio.modelCurrent.indexOf("/") + 1),
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  };
  body.messages.push(...contextMessages(context));
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

/**
 * Translate context while keeping every multi-call answer window valid for
 * Kimi's strict chat API. Tool results can have System payloads attached by
 * their tools; Agent preserves those payloads directly after each result for
 * transcript semantics. Kimi instead requires all `tool` messages answering
 * one assistant `tool_calls` message to be contiguous, so emit the whole
 * result set before those payloads. This is a wire-only ordering change: the
 * stored context remains the authoritative transcript.
 */
function contextMessages(context) {
  const out = [];
  for (let i = 0; i < context.length; i++) {
    const message = context[i];
    out.push(...toMessages(message));
    if (message?.type !== MessageType.Assistant ||
        !(message.content ?? []).some((block) => block?.type === ContentType.ToolCall)) continue;

    const results = [];
    const payloads = [];
    let j = i + 1;
    for (; j < context.length; j++) {
      const next = context[j];
      if (next?.type === MessageType.User || next?.type === MessageType.Assistant) break;
      // A ToolResult is an answer to this assistant's call; every System
      // message in this window is its attached payload and must wait until
      // Kimi has received all of the answers.
      if (next?.type === MessageType.ToolResult) results.push(next);
      else payloads.push(next);
    }
    for (const result of results) out.push(...toMessages(result));
    for (const payload of payloads) out.push(...toMessages(payload));
    i = j - 1;
  }
  return out;
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
    const mimetype = mimeOf(block);
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
async function send(message, base) {
  const [headers, body] = Array.isArray(message) ? message : [undefined, message];
  if (!supportsFiles(this)) assertNoBinary(body, this);
  const prepared = await uploadFiles(this, headers ?? {}, body);
  return base([headers, prepared]);
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
      throw failure("provider",
        `the ${connection.baseUrl} endpoint cannot accept file attachments (its chat API rejects the "file" part type and exposes no file extraction); attach images, or use a Moonshot platform endpoint (api.moonshot.ai) for documents`);
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
      message.content[index] = await extractedPart(connection, headers, part.file);
    }
  }
  return body;
}

/** Extracted text per IO instance (one conversation), keyed by endpoint and
 *  file bytes. Every request re-sends the whole context, so without this each
 *  tool round re-uploaded every attachment in history (two sequential round
 *  trips per file) before the chat request could start. */
const extractedCache = new WeakMap();

async function extractedPart(connection, headers, file) {
  const owner = connection.aiio;
  if (owner === null || typeof owner !== "object") return uploadFile(connection, headers, file);
  let cache = extractedCache.get(owner);
  if (!cache) extractedCache.set(owner, cache = new Map());
  const key = `${connection.baseUrl}\0${file.mimetype}\0${file.filename}\0${createHash("sha256").update(file.data).digest("base64")}`;
  let part = cache.get(key);
  if (!part) cache.set(key, part = await uploadFile(connection, headers, file));
  return { ...part };
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
  if (!response.ok) throw await statusError(response);
  const result = await response.json();
  if (typeof result?.id !== "string" || result.id === "") {
    throw failure("malformed", "Kimi file upload returned no file id");
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
  if (!response.ok) throw await statusError(response);
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
  // a thinking/text segment that resumes after a tool call is a NEW block;
  // a tool call keeps one block across its chunks (keyed by stream index)
  const index = (state.index ??= contentIndexer());
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
    for (const block of state.openCalls?.values() ?? []) {
      events.push({ type: "tool_call_end", contentIndex: block }); // the assembler parses the accumulated string
    }
    state.openCalls = new Map(); // stream index -> contentIndex
  };

  const choice = msg?.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
    if (!state.thinkingOpen) {
      state.thinkIndex = index.next();
      state.thinkingOpen = true;
      events.push({ type: "thinking_start", contentIndex: state.thinkIndex });
    }
    events.push({ type: "thinking_delta", contentIndex: state.thinkIndex, text: delta.reasoning_content });
  }
  if (typeof delta?.content === "string" && delta.content !== "") {
    closeThinking();
    closeCalls();
    if (!state.textOpen) {
      state.textIndex = index.next();
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
      const block = index.of(`call:${key}`);
      state.openCalls ??= new Map();
      if (!state.openCalls.has(key)) {
        state.openCalls.set(key, block);
        events.push({
          type: "tool_call_start",
          contentIndex: block,
          callId: call.id ?? `kimi-${key}`,
          name: call.function?.name,
          arguments: "",
        });
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args !== "") {
        events.push({ type: "tool_call_delta", contentIndex: block, arguments: args });
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
      (io && (io.contextUsage = { used: msg.usage.prompt_tokens }));
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

/** The preset entry for one base URL (URL match on the class's knownEndpoints). */
function presetOf(Protocol, baseUrl) {
  return (Protocol?.knownEndpoints ?? []).find(
    (entry) => String(entry.url ?? "").replace(/\/$/, "") === baseUrl);
}

/** Registry snapshots per registry URL + provider (process lifetime, REGISTRY_TTL). */
const registryCache = new Map();

/**
 * The models.dev registry's model map for this endpoint's preset —
 * the AUTO-DETECTION channel for newly released models: the registry
 * updates independently of this code, so a model released tomorrow
 * arrives with its context window attached. A failed fetch falls back
 * to the last snapshot, then to {}.
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
      mapped[id] = {
        label: m.name ?? id,
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

/**
 * The live OpenAI-shaped /models IDs and metadata are authoritative.
 * Cached and static metadata fills only omissions for the same IDs;
 * the models.dev registry is consulted only if the live list fails.
 * Offline, registry, static and cached IDs form fallback candidates.
 * @this {Function} the registered provider class
 */
async function models({ url = KIMI_URL, auth, settings = {}, signal } = {}) {
  const baseUrl = String(url).replace(/\/$/, "");
  const preset = presetOf(this, baseUrl);
  const headers = { ...ONE_SHOT };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  let live = null;
  try {
    const response = await fetch(`${baseUrl}/models`, { headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error("malformed model catalog");
    live = {};
    for (const model of body.data) {
      if (typeof model?.id !== "string" || model.id === "") continue;
      live[model.id] = {
        ...(Number.isFinite(model.context_length) ? { contextWindow: model.context_length }
          : Number.isFinite(model.context_window) ? { contextWindow: model.context_window } : {}),
        ...(Number.isFinite(model.max_output_tokens) ? { maxTokens: model.max_output_tokens } : {}),
      };
    }
  } catch {
    live = null; // offline: registry + static + cached below
  }
  const registry = live === null ? await registryModels(preset, signal) : {};
  const staticModels = preset?.models ?? {};
  const cached = settings.models && typeof settings.models === "object" && !Array.isArray(settings.models)
    ? settings.models
    : {};
  const ids = live === null ? [...new Set([
    ...Object.keys(staticModels), ...Object.keys(registry), ...Object.keys(cached),
  ])] : Object.keys(live);
  const map = {};
  for (const id of ids) {
    const merged = { ...cached[id], ...staticModels[id], ...registry[id], ...(live === null ? null : live[id]) };
    map[id] = {
      label: id,
      ...(Number.isFinite(merged.contextWindow) ? { contextWindow: merged.contextWindow } : {}),
      ...(Number.isFinite(merged.maxTokens) ? { maxTokens: merged.maxTokens } : {}),
    };
  }
  return map;
}

/** How often the platform balance endpoint (below) is re-fetched, per
 *  aiio. In-memory only, throttled like every other separate-endpoint
 *  dialect here (Codex's usage fetch) — a wallet balance moves slowly
 *  relative to one turn's token cost, so there is no need to hit it
 *  every request. */
const KIMI_BALANCE_TTL = 60 * 1000;
/** Kimi Code's /usages subscription snapshot changes slowly relative to a turn. */
const KIMI_USAGE_TTL = 60 * 1000;

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
    const response = await fetch(`${connection.baseUrl}/users/me/balance`, {
      headers: { authorization: `Bearer ${token}`, ...ONE_SHOT },
      signal: aiio.requestSignal,
    });
    if (!response.ok) return;
    const body = await response.json();
    const balance = Number(body?.data?.available_balance);
    if (!Number.isFinite(balance)) return;
    const unit = String(connection.baseUrl ?? "").includes(".cn") ? "cny" : "usd";
    (aiio && (aiio.planUsage = { quotas: { balance: { remaining: balance, unit } } }));
  } catch { /* best-effort — a failed balance fetch never breaks the turn */ }
}

/**
 * Plan/quota reporting: Moonshot's rate-limit headers are a single
 * UNSUFFIXED family — `X-RateLimit-Limit` / `-Remaining` / `-Reset`
 * (confirmed on the platform's /v1/tools/search* endpoints; Moonshot
 * does not document a chat-completions-specific split the way OpenAI's
 * x-ratelimit-*-requests/-tokens pair does) — so the OpenAI default
 * this plugin would otherwise inherit (IO completion) never matches
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
async function reportSubscriptionUsage(connection, aiio) {
  if (!aiio) return;
  const cache = aiio._kimiUsage;
  if (cache && Date.now() - cache.fetchedAt < KIMI_USAGE_TTL) return;
  aiio._kimiUsage = { fetchedAt: Date.now() }; // claim before awaiting
  const token = aiio.settings?.auth?.token;
  if (!token) return;
  try {
    const response = await fetch(`${connection.baseUrl}/usages`, {
      headers: { authorization: `Bearer ${token}`, ...ONE_SHOT }, signal: aiio.requestSignal,
    });
    if (!response.ok) return;
    const body = await response.json();
    const quota = (value) => {
      const total = Number(value?.limit);
      const used = Number(value?.used);
      const remaining = Number(value?.remaining);
      const reset = value?.resetTime ?? value?.reset_time;
      const report = {
        ...(Number.isFinite(total) ? { total } : {}),
        ...(Number.isFinite(used) ? { used } : {}),
        ...(Number.isFinite(remaining) ? { remaining } : {}),
        ...(typeof reset === "string" && reset !== "" ? { reset } : {}),
      };
      return Object.keys(report).length > 0 ? report : null;
    };
    // The coding API publishes its weekly allowance as `usage`, and the
    // rolling allowance in `limits[]` with a duration. These are the two
    // actionable subscription limits; booster-wallet internals are money
    // ledger data, not a quota, so deliberately stay unpublished.
    const quotas = {};
    const weekly = quota(body?.usage);
    if (weekly) quotas["7d"] = weekly;
    for (const item of body?.limits ?? []) {
      const minutes = Number(item?.window?.duration);
      if (item?.window?.timeUnit !== "TIME_UNIT_MINUTE" || !Number.isFinite(minutes) || minutes <= 0) continue;
      const limit = quota(item.detail);
      if (limit) quotas[`${minutes / 60}h`] = limit;
    }
    if (Object.keys(quotas).length > 0) (aiio && (aiio.planUsage = { quotas }));
  } catch { /* best-effort — account usage never breaks a turn */ }
}

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
    (aiio && (aiio.planUsage = { quotas }));
    return;
  }
  if (supportsFiles(this)) return reportBalance(this, aiio);
  return reportSubscriptionUsage(this, aiio);
}

/* --------------------------------------------------- web capabilities */

/**
 * The platform endpoints (api.moonshot.ai / .cn) expose the direct Web Search
 * Basic API (POST {baseUrl}/tools/search; docs verified 2026-09-29). Arbitrary
 * OpenAI-compatible proxies have no such tool — unsupported endpoints answer
 * undefined (honest fall-through), never a request that could only 400/404.
 */
function webSearchHosted(aiio) {
  const base = String(aiio?.url ?? "").replace(/\/$/, "");
  return base === KIMI_URL || base === KIMI_CN_URL;
}

/**
 * The coding relay (api.kimi.com/coding, the Kimi Code subscription) exposes
 * its own dedicated search API: POST {baseUrl}/search with `{text_query}`
 * answers `{search_results: [{url, title, snippet}]}` under the same Bearer
 * credential (verified against the Kimi Code third-party docs and a live
 * integration, 2026). Same honesty rule: only this exact base URL takes the
 * relay path.
 */
function webSearchRelay(aiio) {
  return String(aiio?.url ?? "").replace(/\/$/, "") === KIMI_CODING_URL;
}

/**
 * Kimi provider web requests ride the shared deadline/connect discipline. Both
 * web paths are DIRECT REST lookups — the platform `/tools/search` + `/tools/fetch`
 * and the coding relay `/search` — but the server runs the actual
 * search/extraction before returning the head, which intermittently exceeds the
 * 3s default (proven live on both, ai-cache/2026-09-28 009/010). 3s + 1500ms,
 * passed only as an argument (shared code untouched).
 */
const WEB_TOOL_TTFB_MS = 4_500;

const webPost = (aiio, url, init, { signal, deadline }) =>
  aiio.fetch(url, { ...init, signal }, { deadline, connectTimeout: WEB_TOOL_TTFB_MS });

/** Render a `search_results` array to the bounded Markdown list (both paths share this). */
function renderSearchResults(results, source) {
  const markdown = results
    .map((item) => {
      const raw = typeof item?.url === "string" ? item.url.trim() : "";
      let url;
      try { url = new URL(raw); } catch { return null; }
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const title = typeof item?.title === "string" && item.title.trim() !== "" ? item.title.trim() : url.href;
      const snippet = typeof item?.snippet === "string" ? item.snippet.trim() : "";
      return snippet === "" ? `- [${title}](${url.href})` : `- [${title}](${url.href}) — ${snippet}`;
    })
    .filter(Boolean)
    .join("\n");
  if (markdown === "") throw failure("malformed", `Kimi ${source} returned no usable search results`);
  return markdown;
}

/**
 * One DIRECT web-search POST: `{text_query}` in, `{search_results: [{url,
 * title, snippet}]}` out, under the endpoint's Bearer credential. Used by BOTH
 * the platform endpoints (POST {baseUrl}/tools/search — Web Search Basic,
 * docs verified 2026-09-29) and the coding relay (POST {baseUrl}/search). No
 * LLM, no echo loop — this is the fast path that replaced the slow `$web_search`
 * chat-completions builtin. A rejected request (4xx/5xx) THROWS with the
 * status; an empty/unusable result THROWS — dispatch falls through, never fabricates.
 */
async function directWebSearch(aiio, path, query, { signal, deadline }) {
  const token = aiio?.settings?.auth?.token;
  const base = String(aiio.url).replace(/\/$/, "");
  const response = await webPost(aiio, `${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text_query: query }),
  }, { signal, deadline });
  if (!response.ok) throw await statusError(response);
  const body = await response.json();
  const results = Array.isArray(body?.search_results) ? body.search_results : null;
  if (results === null) throw failure("malformed", "Kimi web search returned no search_results array");
  return renderSearchResults(results, "web search");
}

/**
 * One DIRECT web-fetch POST: `{url}` in, `{url, title, markdown}` out, under
 * the endpoint's Bearer credential. Used by BOTH the platform endpoints (POST
 * {baseUrl}/tools/fetch — URL Fetch, docs verified 2026-09-29) and the coding
 * relay (POST {baseUrl}/fetch — verified live 2026-09-29). No LLM — direct
 * content extraction. A rejected request (4xx/5xx — including the documented
 * security_risk 403 and markdown_not_found 404) THROWS with the status; an
 * empty extraction THROWS — dispatch falls through, never fabricates.
 *
 * KNOWN LIMITATION (accepted, 2026-09-29): the service's `markdown` is a
 * text+IMAGES extraction — per the docs, "text and images appear in page
 * order, images as `![imageN](url)` placeholders". Inline hyperlinks are NOT
 * part of the output and the `{url}`-only request schema offers no toggle, so
 * the stripped links are SERVER-side and not recoverable through this API.
 * Callers needing a page's links should use web-search (whose results carry
 * URLs) or opt out via `web.provider.fetch: false` to take the local extractor.
 */
async function directWebFetch(aiio, path, url, { signal, deadline }) {
  const token = aiio?.settings?.auth?.token;
  const base = String(aiio.url).replace(/\/$/, "");
  const response = await webPost(aiio, `${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  }, { signal, deadline });
  if (!response.ok) throw await statusError(response);
  const body = await response.json();
  const markdown = typeof body?.markdown === "string" ? body.markdown.trim() : "";
  if (markdown === "") throw failure("malformed", "Kimi web fetch returned no usable content");
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  return title === "" ? markdown : `# ${title}\n\n${markdown}`;
}

/** Kimi (Moonshot AI) chat-completions protocol. */
export default class KimiProvider {
  static provider = {
    label: "Kimi (Moonshot AI)",
    capabilities: {
      streaming: true,
      thinking: [],
      tools: {
        "web-search": { function: async ({ aiio, args, signal, deadline }) => {
          const query = String(args?.query ?? "").trim();
          if (query === "") return undefined;
          // Two DIRECT provider paths, no LLM generation: the platform
          // endpoints' /tools/search (Web Search Basic) and the coding relay's
          // /search API. (The old `$web_search` chat-completions builtin was the
          // slow multi-round LLM echo loop — replaced.)
          if (webSearchHosted(aiio)) return directWebSearch(aiio, "/tools/search", query, { signal, deadline });
          if (webSearchRelay(aiio)) return directWebSearch(aiio, "/search", query, { signal, deadline });
          return undefined;
        } },
        "web-fetch": { function: async ({ aiio, args, signal, deadline }) => {
          const url = String(args?.url ?? "").trim();
          if (url === "") return undefined;
          // Two DIRECT fetch paths, no LLM: the platform endpoints' /tools/fetch
          // and the coding relay's /fetch (both answer {url, title, markdown};
          // relay path verified live 2026-09-29, ai-cache/2026-09-28 011).
          if (webSearchHosted(aiio)) return directWebFetch(aiio, "/tools/fetch", url, { signal, deadline });
          if (webSearchRelay(aiio)) return directWebFetch(aiio, "/fetch", url, { signal, deadline });
          return undefined;
        } },
      },
    },
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

  static async detect({ endpoints = {} } = {}) {
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

  static async models(options) { return models.call(this, options); }

  constructor(url = KIMI_URL, aiio) {
    this.baseUrl = String(url).replace(/\/$/, "");
    this.url = `${this.baseUrl}/chat/completions`;
    this.aiio = aiio;
  }

  context2msg(context, aiio = this.aiio) { return context2msg(context, aiio); }
  async send(message, base) { return send.call(this, message, base); }
  msg2events(message, state, aiio = this.aiio) { return msg2events(message, state, aiio); }
  reportPlanUsage(headers, aiio = this.aiio) { return reportPlanUsage.call(this, headers, aiio); }

  /**
   * Refine the shared taxonomy for ONE status code: a 403 is a
   * TEMPORARY usage/rate limit far more often than a dead credential
   * (401 already covers that) — see BAD_CREDENTIAL_403.
   * @param {*} err - the raw error (status/body ride along)
   * @param {object} base - the shared verdict
   * @returns {object}
   */
  classifyError(err, base) {
    if (err?.status === 403 && !BAD_CREDENTIAL_403.test(String(err.body ?? err.message ?? ""))) {
      base.kind = "provider";
      base.message += " (likely a temporary usage/rate limit, not an invalid credential)";
    }
    return base;
  }

  /**
   * Kimi's TOKEN-DEPLETION dialect: its usage/rate limits answer a 403
   * whose body names the limit (see classifyError — that same 403
   * classifies "provider" precisely BECAUSE it is a quota, not a
   * credential) — so a Kimi 403 that is not a dead credential IS the
   * budget signal. Every other failure keeps the shared verdict.
   * @param {object} classified
   * @param {boolean} base - the shared verdict
   * @returns {boolean}
   */
  depletionError(classified, base) {
    return (classified?.status === 403 && classified?.kind === "provider" &&
      !BAD_CREDENTIAL_403.test(String(classified?.message ?? ""))) || base;
  }
}
