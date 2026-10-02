/**
 * lib/io/openai.js — the OpenAI Responses wire defaults (private to IO).
 * IO completes a provider class's missing instance methods from this
 * module (lib/io/provider.js): request conversion, stream translation,
 * the HTTP transport with its one-shot reasoning correction, and the
 * plan/quota reporting dialects. Model listing and verification are
 * Env's static catalog defaults (lib/env/openai-models.js).
 */

import Context from "../context.js";
const { ContentType, MessageType, mimeOf } = Context;
import { defaultSend, defaultRead, defaultClose } from "./http.js";
import { retryAfterMs } from "./retry-after.js";
import { thinkingNative, thinkingSort, thinkingFromError } from "./thinking.js";
import { openaiAccountId, openaiCodexBackend } from "../util.js";

/**
 * Test whether a connection targets the ChatGPT Codex backend.
 * @param {object|null|undefined} connection Connection to inspect.
 * @returns {boolean} Whether its URL/settings identify the Codex backend.
 */
const codexBackend = (connection) => openaiCodexBackend(connection?.baseUrl, connection?.aiio?.settings);

/**
 * Fill missing REST connection fields after a plugin constructor.
 * @param {object} connection Connection object to initialize (mutated).
 * @param {string|null|undefined} url Base URL; defaults to `https://api.openai.com/v1`.
 * @param {object} aiio IO instance assigned when `connection.aiio` is absent.
 * @returns {void}
 */
export function initializeOpenAI(connection, url, aiio) {
  connection.aiio ??= aiio;
  connection.baseUrl ??= String(url ?? "https://api.openai.com/v1").replace(/\/$/, "");
  connection.url ??= `${connection.baseUrl}/responses`;
}

/**
 * Convert normalized conversation context into an OpenAI Responses request.
 * @param {Array<object>} context Messages to convert.
 * @param {object} [aiio=this.aiio] IO instance providing settings, model, and tools.
 * @returns {[Record<string,string>, object]} Request headers and JSON body.
 * @throws May propagate errors while reading tools or serializing tool arguments.
 */
export function context2msg(context, aiio = this.aiio) {
  const token = aiio?.settings?.auth?.token;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const accountId = openaiAccountId(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const instructions = context
    .filter((message) => message?.type === MessageType.System)
    .map(textOf)
    .filter(Boolean)
    .join("\n\n");
  const input = [];
  for (const message of context) input.push(...toInputItems(message));
  const body = {
    model: aiio?.modelCurrent?.slice(aiio.modelCurrent.indexOf("/") + 1),
    input,
    stream: true,
  };
  if (instructions) body.instructions = instructions;
  if (codexBackend(this)) {
    headers["OpenAI-Beta"] = "responses=experimental";
    body.store = false;
    body.instructions ??= "";
  }
  const tools = aiio?.tools?.() ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }
  const reasoning = reasoningOptions(aiio?.settings ?? {}, body.model);
  if (reasoning) body.reasoning = reasoning;
  return [headers, body];
}

/**
 * Build supported reasoning options for the selected model and return the
 * Responses `reasoning` object. `settings.think` is already the native
 * effort (IO maps it); undefined leaves effort to the model default. Summary
 * is `auto` unless model metadata disables it; without summary, no thinking
 * block reaches the normalized pipeline. `thinking: []` omits reasoning.
 * @param {object} settings IO settings; `think` and `models` are optional.
 * @param {string} model Model identifier used to find model metadata.
 * @returns {object|undefined} Reasoning options, or `undefined` when none apply.
 */
function reasoningOptions(settings, model) {
  const meta = settings.models?.[model];
  if (Array.isArray(meta?.thinking) && meta.thinking.length === 0) return undefined;
  const reasoning = {};
  if (typeof settings.think === "string") reasoning.effort = settings.think;
  if (meta?.reasoningSummary !== false) reasoning.summary = "auto";
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

/**
 * Convert one normalized message into Responses input items.
 * @param {object} message Message with type/content and any tool-call metadata.
 * @returns {Array<object>} Wire-format input items (system messages yield none).
 */
function toInputItems(message) {
  if (message?.type === MessageType.System) return [];
  if (message?.type === MessageType.ToolResult) {
    return [{
      type: "function_call_output",
      call_id: message.callId,
      output: textOf(message),
    }];
  }
  if (message?.type === MessageType.Assistant) {
    const items = [];
    const text = textOf(message);
    if (text) {
      items.push({
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }
    for (const block of message.content ?? []) {
      if (block?.type !== ContentType.ToolCall) continue;
      items.push({
        type: "function_call",
        call_id: block.callId,
        name: block.name,
        arguments: typeof block.arguments === "string"
          ? block.arguments
          : JSON.stringify(block.arguments ?? {}),
      });
    }
    return items;
  }
  const content = [];
  // Do not collect text separately: block order is the user's ordering.
  for (const block of message?.content ?? []) {
    const mimetype = mimeOf(block);
    if (block?.type === ContentType.Text && block.text) {
      content.push({ type: "input_text", text: String(block.text) });
    } else if (block?.type === ContentType.Image ||
        (block?.type === ContentType.Binary && String(mimetype ?? "").startsWith("image/"))) {
      content.push({
        type: "input_image",
        image_url: `data:${mimetype ?? "image/png"};base64,${block.content ?? ""}`,
      });
    } else if (block?.type === ContentType.Binary && mimetype) {
      content.push({
        type: "input_file",
        file_data: `data:${mimetype};base64,${block.content ?? ""}`,
        filename: typeof block.filename === "string" && block.filename !== "" ? block.filename : `attachment.${mimetype.split("/")[1] ?? "bin"}`,
      });
    }
  }
  return [{ role: "user", content }];
}

/**
 * Concatenate text blocks from a message.
 * @param {object|null|undefined} message Message whose content may contain text blocks.
 * @returns {string} Joined text, or an empty string when no text blocks exist.
 */
function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === ContentType.Text)
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Convert one OpenAI Responses stream event to normalized events.
 * @param {object} message Native Responses event.
 * @param {object} [state={}] Mutable per-stream indexing/open-block state.
 * @param {object} [aiio] IO instance for completed-response usage accounting; defaults to `this.aiio`.
 * @returns {Array<object>} Normalized events; unknown wire event types yield an empty array.
 * @effects May mutate `state` and record input-token usage on the IO instance.
 */
export function msg2events(message, state = {}, aiio) {
  const io = aiio ?? this?.aiio;
  const type = message?.type;
  if (type === "error" || type === "response.failed") {
    const error = message.error ?? message.response?.error ?? {};
    const retry = retryAfterMs(error);
    return [{ type: "error", error: String(error?.message ?? (typeof error === "string" ? error : "OpenAI response failed")),
      ...(retry ? { retryAfterMs: retry, status: 429, kind: "provider" } : {}), native: message }];
  }
  // cut short (max_output_tokens, content_filter): never a finished answer
  if (type === "response.incomplete") {
    const reason = message.response?.incomplete_details?.reason ?? "unknown reason";
    return [{ type: "error", error: `OpenAI response incomplete (${reason})`, native: message }];
  }
  if (type === "response.output_text.delta") {
    const index = allocate(state, `text:${message.output_index ?? 0}`, "text");
    const events = [];
    if (!state.textOpen?.has(index)) {
      state.textOpen ??= new Set();
      state.textOpen.add(index);
      events.push({ type: "text_start", contentIndex: index });
    }
    events.push({ type: "text_delta", contentIndex: index, text: message.delta ?? "" });
    return events;
  }
  if (type === "response.output_text.done") {
    const index = allocate(state, `text:${message.output_index ?? 0}`, "text");
    state.textOpen?.delete(index);
    return [{
      type: "text_end",
      contentIndex: index,
      ...(typeof message.text === "string" ? { text: message.text } : {}),
    }];
  }
  if (type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_text.delta") {
    const index = reasoningIndex(state, message);
    const events = [];
    if (!state.thinkingOpen?.has(index)) {
      state.thinkingOpen ??= new Set();
      state.thinkingOpen.add(index);
      events.push({ type: "thinking_start", contentIndex: index });
    }
    if (type === "response.reasoning_summary_text.delta") {
      events.push({ type: "thinking_delta", contentIndex: index, text: message.delta ?? "" });
    }
    return events;
  }
  // `reasoning_summary_text.done` finishes a text segment. The part remains
  // open until its own done event, which is the API's block boundary.
  if (type === "response.reasoning_summary_text.done") return [];
  if (type === "response.reasoning_summary_part.done") {
    const index = reasoningIndex(state, message);
    if (!state.thinkingOpen?.delete(index)) return [];
    return [{ type: "thinking_end", contentIndex: index }];
  }
  if (type === "response.output_item.added" && message.item?.type === "function_call") {
    const item = message.item;
    const index = allocate(state, `call:${message.output_index ?? item.call_id}`, "call");
    state.calls ??= new Map();
    state.calls.set(message.output_index ?? item.call_id, index);
    return [{
      type: "tool_call_start",
      contentIndex: index,
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments ?? "",
    }];
  }
  if (type === "response.function_call_arguments.delta") {
    const index = callIndex(state, message);
    return [{ type: "tool_call_delta", contentIndex: index, arguments: message.delta ?? "" }];
  }
  if (type === "response.function_call_arguments.done") {
    const index = callIndex(state, message);
    return [{ type: "tool_call_end", contentIndex: index, arguments: parseArguments(message.arguments) }];
  }
  if (type === "response.completed") {
    const usage = message.response?.usage;
    // the exact context consumption the endpoint measured for this request
    if (Number.isFinite(usage?.input_tokens)) {
      (io && (io.contextUsage = { used: usage.input_tokens }));
    }
    return [{
      type: "done",
      doneReason: message.response?.status,
      ...(usage ? { usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cost: usage.cost,
      } } : {}),
      native: message.response ? { id: message.response.id, status: message.response.status } : message,
    }];
  }
  return [];
}

/**
 * Allocate or retrieve the stable content index for a key using Context's contentIndexer.
 * @param {object} state Mutable stream state; stores the content indexer.
 * @param {string} key Stable identity for the output item.
 * @returns {number} Content index assigned by Context's indexer.
 */
function allocate(state, key) {
  state.index ??= Context.contentIndexer();
  return state.index.of(key);
}

/**
 * Resolve the stable content index for a reasoning summary event.
 * @param {object} state Mutable stream state.
 * @param {object} message Reasoning event with item/output and content indexes.
 * @returns {number} Content index for that reasoning block.
 */
function reasoningIndex(state, message) {
  const item = message.item_id ?? message.output_index ?? 0;
  return allocate(state, `thinking:${item}:${message.content_index ?? 0}`);
}

/**
 * Resolve the stable content index for a function-call event.
 * @param {object} state Mutable stream state.
 * @param {object} message Function-call event with output/item/call identity.
 * @returns {number} Content index for that call.
 */
function callIndex(state, message) {
  const key = message.output_index ?? message.item_id ?? message.call_id;
  return state.calls?.get(key) ?? allocate(state, `call:${key}`);
}

/**
 * Parse function-call arguments when they contain valid JSON.
 * @param {*} value Wire argument value, commonly a JSON string.
 * @returns {*} Existing object values or parsed JSON; malformed strings are returned unchanged.
 */
function parseArguments(value) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(value ?? "{}"); } catch { return value ?? ""; }
}

/**
 * Send through the default blocking transport. A 400 naming a `reasoning`
 * parameter is corrected once (nearest supported effort or rejected field
 * dropped), learned model limits are cached, and the request is resent.
 * @param {*} message Transport request payload (body or `[headers, body]`).
 * @returns {Promise<*>} Transport response.
 * @throws Propagates transport errors unless a recognized correction succeeds; retry errors propagate.
 * @effects May cache learned model reasoning limits and performs at most one corrective resend.
 */
export async function send(message) {
  try {
    return await defaultSend(this, message);
  } catch (err) {
    const corrected = correctReasoning(this, message, err);
    if (!corrected) throw err;
    return defaultSend(this, corrected);
  }
}

/**
 * Correct a request rejected for an unsupported reasoning option.
 * @param {object} connection Connection whose model metadata may be updated.
 * @param {*} message Request body or `[headers, body]` tuple.
 * @param {Error} err HTTP error with status/body fields.
 * @returns {Array| null} Corrected request tuple, or null when no safe correction applies.
 * @effects May persist discovered reasoning support limits through `authSet`.
 */
function correctReasoning(connection, message, err) {
  const [headers, body] = Array.isArray(message) ? message : [undefined, message];
  if (err?.status !== 400 || !body?.reasoning) return null;
  let error;
  try { error = JSON.parse(err.body ?? "")?.error; } catch { return null; }
  const param = String(error?.param ?? "");
  if (param !== "reasoning" && !param.startsWith("reasoning.")) return null;
  // the model accepts the parameter, not this value: its list is the truth
  if (error.code === "unsupported_value" && param === "reasoning.effort") {
    const levels = thinkingFromError(error.message);
    if (!levels) return null;
    const thinking = thinkingSort(levels);
    const effort = thinkingNative(body.reasoning.effort, thinking);
    if (effort === undefined || effort === body.reasoning.effort) return null;
    rememberModel(connection, body.model, { thinking });
    return [headers, { ...body, reasoning: { ...body.reasoning, effort } }];
  }
  if (error.code !== "unsupported_parameter") return null;
  if (param === "reasoning.summary") {
    rememberModel(connection, body.model, { reasoningSummary: false });
    const { summary, ...reasoning } = body.reasoning;
    return [headers, { ...body, reasoning }];
  }
  // the model does not reason at all (effort/reasoning rejected outright)
  rememberModel(connection, body.model, { thinking: [] });
  const { reasoning, ...rest } = body;
  return [headers, rest];
}

/**
 * Merge learned capability limits into an existing cached model entry.
 * @param {object} connection Connection providing IO settings and optional `authSet`.
 * @param {string} model Model identifier.
 * @param {object} patch Capability fields to merge.
 * @returns {void}
 * @effects Updates persisted auth settings when the model entry and setter exist.
 */
function rememberModel(connection, model, patch) {
  const models = connection.aiio?.settings?.models;
  if (!models || typeof models !== "object" || Array.isArray(models) || !models[model]) return;
  connection.aiio?.authSet?.({ models: { ...models, [model]: { ...models[model], ...patch } } });
}
/**
 * Read the next response data using the default transport.
 * @returns {Promise<*>} Transport read result.
 * @throws Propagates errors from the default reader.
 */
export async function read() { return defaultRead(this); }

/**
 * Close the connection using the default transport.
 * @returns {Promise<*>} Transport close result.
 * @throws Propagates errors from the default closer.
 */
export async function close() { return defaultClose(this); }


/** Anthropic-subscription-style rolling-window header:
 *  `<vendor->ratelimit-unified-<window>-utilization` (a SPENT FRACTION,
 *  0–1 — no vendor prefix assumed, so a gateway using its own name
 *  still matches; see providers/anthropic.js for the fuller rationale,
 *  duplicated here as this default's second fallback dialect). */
const UNIFIED_WINDOW = /ratelimit-unified-([a-z0-9]+)-utilization$/i;

/** How often the Codex-backend usage endpoint (below) is re-fetched,
 *  per IO instance. In-memory only — usage changes with every turn,
 *  so persisting it to disk settings would go stale immediately — and
 *  throttled rather than fetched every turn: the Codex CLI itself has
 *  been flagged for hammering this same endpoint on every request. */
const CODEX_USAGE_TTL = 60 * 1000;

/**
 * Format a positive whole window duration as a compact unit label, e.g.
 * 18000 -> "5h", 604800 -> "7d", or 1800 -> "30m", using the largest
 * whole unit that divides evenly. Invalid lengths return null; account
 * window durations are not assumed.
 * @param {number} seconds Duration in seconds.
 * @returns {string|null} Largest evenly-dividing d/h/m/s label, or null for invalid input.
 */
function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  for (const [suffix, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (seconds % size === 0) return `${seconds / size}${suffix}`;
  }
  return null; // unreachable (size 1 always matches) — kept for clarity
}

/**
 * Parse compact duration labels in Anthropic-style unified headers (e.g.
 * "5h", a name rather than raw seconds) into seconds. Invalid shapes return
 * undefined; values are never guessed. This private helper is duplicated in providers/anthropic.js.
 * @param {*} label Label in `<integer><d|h|m|s>` form.
 * @returns {number|undefined} Duration in seconds, or undefined for invalid labels.
 */
function parseWindowSeconds(label) {
  const match = /^(\d+)([dhms])$/i.exec(String(label ?? ""));
  if (!match) return undefined;
  const size = { d: 86400, h: 3600, m: 60, s: 1 }[match[2].toLowerCase()];
  return Number(match[1]) * size;
}

/**
 * Codex-backend plan/quota reporting: unlike every response-header
 * dialect this module otherwise tries, the ChatGPT Codex backend
 * (chatgpt.com/backend-api/codex) puts NOTHING rate-limit-shaped on
 * its own chat-response headers — usage instead lives behind a
 * separate `GET https://chatgpt.com/backend-api/wham/usage` call
 * (community-reverse-engineered — OpenAI does not publish this
 * endpoint — response shape: `rate_limit.primary_window` /
 * `.secondary_window`, each `{used_percent, limit_window_seconds,
 * reset_at}`). The window's actual length (`limit_window_seconds`) is
 * read from the response and turned into its quota key (see
 * windowLabel) — NOT assumed to be "5h"/"7d" the way earlier code
 * here did: those are today's OpenAI defaults, not a guarantee for
 * every plan or every future account. Falls back to the neutral
 * "primary"/"secondary" only if the endpoint omits the window length.
 * Cached per `aiio` for CODEX_USAGE_TTL. Best-effort throughout: a
 * missing token, a failed fetch, or an unrecognized response shape
 * all just mean nothing is reported this round.
 * @param {object} aiio IO instance; missing/falsy input is a no-op.
 * @returns {Promise<void>} Resolves after best-effort usage retrieval/reporting; failures are swallowed.
 * @effects Fetches the Codex usage endpoint at most once per TTL and may call `planUsage`.
 */
async function reportCodexUsage(aiio) {
  if (!aiio) return;
  const cache = aiio._codexUsage;
  if (cache && Date.now() - cache.fetchedAt < CODEX_USAGE_TTL) return;
  aiio._codexUsage = { fetchedAt: Date.now() }; // claim the slot before awaiting — one fetch in flight at a time
  const token = aiio.settings?.auth?.token;
  if (!token) return;
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
      signal: aiio.requestSignal,
    });
    if (!response.ok) return;
    const body = await response.json();
    const quotas = {};
    for (const [wire, fallbackKey] of [["primary_window", "primary"], ["secondary_window", "secondary"]]) {
      const window = body?.rate_limit?.[wire];
      const usedPct = Number(window?.used_percent);
      if (!Number.isFinite(usedPct)) continue;
      const rounded = Math.min(100, Math.max(0, Math.round(usedPct)));
      const windowSeconds = Number(window?.limit_window_seconds);
      const key = windowLabel(windowSeconds) ?? fallbackKey;
      quotas[key] = {
        total: 100, used: rounded, remaining: 100 - rounded,
        ...(typeof window.reset_at === "string" && window.reset_at !== "" ? { reset: window.reset_at } : {}),
        // the window's full cycle length, straight from the endpoint —
        // lets a consumer show elapsed time / a countdown too
        ...(Number.isFinite(windowSeconds) ? { windowSeconds } : {}),
      };
    }
    if (Object.keys(quotas).length > 0) {
      (aiio && (aiio.planUsage = {
        ...(typeof body?.plan_type === "string" && body.plan_type !== "" ? { label: body.plan_type } : {}),
        quotas,
      }));
    }
  } catch { /* best-effort — a failed usage fetch never breaks the turn */ }
}

/**
 * Default plan/quota reporting: only what the endpoint actually
 * publishes is reported (endpoints without rate-limit headers — local
 * servers — produce no report). A Protocol class overrides this for
 * its own quota dialect; this default instead ATTEMPTS EVERY KNOWN
 * DIALECT in turn, for generic/unrecognized OpenAI-compatible
 * endpoints that speak one of them without a dedicated plugin:
 *   0. The Codex backend's separate usage endpoint (see
 *      reportCodexUsage) — it has no relevant response headers at
 *      all, so the header dialects below never apply to it
 *   1. OpenAI's own `x-ratelimit-{limit,remaining,reset}-<family>`
 *      (requests, tokens, and — project-scoped keys — project-tokens;
 *      developers.openai.com/api/docs/guides/rate-limits)
 *   2. Anthropic-subscription-style unified rolling windows (see
 *      UNIFIED_WINDOW) — reported as {total: 100, used, remaining}
 *      percentage points, same shape as every other quota
 *   3. Kimi/Moonshot-style bare `x-ratelimit-{limit,remaining,reset}`
 *      (no requests/tokens split) — only when dialect 1 left
 *      "requests" unclaimed
 * May return a promise (dialect 0's own network call) — never
 * awaited by the caller (must not add latency to the turn); it never
 * rejects, so an unhandled rejection is not a risk.
 * @param {Headers} headers Response headers containing one of the recognized quota dialects.
 * @param {object} [aiio=this.aiio] IO instance receiving quota reports.
 * @returns {void|Promise<void>} Header dialects return void; Codex usage returns its best-effort promise.
 * @effects May report quotas via `planUsage`; Codex mode may perform a network request.
 * @throws Does not reject for Codex fetch/parse failures; synchronous caller-side errors may propagate.
 */
export function reportPlanUsage(headers, aiio = this?.aiio) {
  if (codexBackend(this)) return reportCodexUsage(aiio);
  const get = (name) => headers?.get?.(name) ?? undefined;
  const num = (name) => {
    const value = Number(get(name));
    return get(name) !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const quotas = {};

  // 1) OpenAI dialect.
  const families = [
    ["requests", "requests"], ["tokens", "tokens"], ["project-tokens", "projectTokens"],
  ];
  for (const [wire, key] of families) {
    const quota = {
      ...(num(`x-ratelimit-limit-${wire}`) !== undefined ? { total: num(`x-ratelimit-limit-${wire}`) } : {}),
      ...(num(`x-ratelimit-remaining-${wire}`) !== undefined ? { remaining: num(`x-ratelimit-remaining-${wire}`) } : {}),
      ...(get(`x-ratelimit-reset-${wire}`) ? { reset: get(`x-ratelimit-reset-${wire}`) } : {}),
    };
    if (Object.keys(quota).length > 0) quotas[key] = quota;
  }

  // 2) Anthropic-subscription dialect.
  if (typeof headers?.forEach === "function") {
    headers.forEach((value, name) => {
      const match = UNIFIED_WINDOW.exec(name);
      if (!match) return;
      const spent = Number(value);
      if (!Number.isFinite(spent)) return;
      const window = match[1].toLowerCase();
      if (quotas[window]) return; // an OpenAI-named family already claimed this key
      const usedPct = Math.min(100, Math.max(0, Math.round(spent * 100)));
      const reset = headers.get?.(name.replace(/utilization$/i, "reset"));
      const windowSeconds = parseWindowSeconds(window);
      quotas[window] = {
        total: 100, used: usedPct, remaining: 100 - usedPct,
        ...(reset ? { reset } : {}),
        ...(Number.isFinite(windowSeconds) ? { windowSeconds } : {}),
      };
    });
  }

  // 3) Kimi/Moonshot dialect — only if dialect 1 left "requests" unclaimed.
  if (!quotas.requests) {
    const bare = {
      ...(num("x-ratelimit-limit") !== undefined ? { total: num("x-ratelimit-limit") } : {}),
      ...(num("x-ratelimit-remaining") !== undefined ? { remaining: num("x-ratelimit-remaining") } : {}),
      ...(get("x-ratelimit-reset") ? { reset: get("x-ratelimit-reset") } : {}),
    };
    if (Object.keys(bare).length > 0) quotas.requests = bare;
  }

  if (Object.keys(quotas).length > 0) (aiio && (aiio.planUsage = { quotas }));
}
