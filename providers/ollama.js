/**
 * lib/providers/ollama.js — Ollama connector (first target; proves the
 * provider contract and the metadata/models()/login() shape together).
 *
 * Direct HTTP to the Ollama local server (never the `ollama` CLI):
 *   POST {url}/api/chat   — NDJSON streaming chat
 *   GET  {url}/api/tags   — local model listing
 *
 * Uses the default HTTP backend wholesale (connect/send/read/close) —
 * Ollama's NDJSON stream is line-delimited JSON, which the default
 * blocking-await read already speaks. Only the two translators plus the
 * pi-pattern metadata surface live here.
 *
 * Wire mapping (context format -> /api/chat):
 *   system/user  -> {role, content} (text blocks joined)
 *   assistant    -> {role:"assistant", content, tool_calls?} — thinking
 *                   blocks are local-only and never hit the wire
 *   tool result  -> {role:"tool", name, content} — name resolved from
 *                   the message's `name`, else the matching toolCall block
 *   image and generic binary blocks ride Ollama's sole documented `images`
 *   channel (base64) on user and tool-result messages. The selected local
 *   model decides which binary formats it can consume; Ollama exposes no
 *   separate generic-file field in /api/chat.
 * Tools: Env catalog entries -> {type:"function", function:{name,
 * description, parameters}}; omitted when the catalog is empty.
 *
 * Wire mapping (/api/chat NDJSON -> response events): content strings
 * stream as text_start/text_delta/text_end at contentIndex 0; tool_calls
 * become toolcall_start/toolcall_end pairs (Ollama supplies no call ids
 * — local `ollama-N` ids are generated for context linkage); the
 * done:true frame maps prompt_eval_count/eval_count into the usage
 * envelope. Native frames ride along as event metadata where useful.
 *
 * Errors: HTTP statuses and stream-level {error} frames surface through
 * IO's auth/network/provider/malformed taxonomy; login() is a trivial
 * no-auth procedure; models() refreshes the cached list in the provider
 * namespace on every access and falls back to the cache offline.
 */

import Context from "../lib/context.js";
const { MessageType, ContentType, mimetypeOf } = Context;
import Env from "../lib/env.js";
const { resolveEffort, singleShot } = Env;

/** The `think` levels Ollama's /api/chat defines. */
const OLLAMA_EFFORTS = ["low", "medium", "high"];

const metadata = {
  label: "Ollama",
  capabilities: { tools: true, thinking: true, streaming: true },
};

const DEFAULT_URL = "http://localhost:11434";

/* ------------------------------------------------ outgoing: context2msg */

/** Convert normalized context to an Ollama `/api/chat` request. */
function context2msg(context, aiio) {
  const headers = { "content-type": "application/json" };
  const token = aiio?.settings?.auth?.token;
  if (token) headers.authorization = `Bearer ${token}`;

  const body = {
    model: aiio?.currentModel,
    messages: context.map((msg, i) => toOllamaMessage(msg, context, i)),
    stream: true,
  };
  // Thinking control: Agent's /agent-thinking command (or a settings
  // override) sets `think` — false/true for on-off models, a level for
  // models with levels (e.g. gpt-oss), clamped to the low/medium/high
  // Ollama defines. Undefined: server default.
  const think = aiio?.settings?.think;
  if (typeof think === "string") body.think = resolveEffort(think, { levels: OLLAMA_EFFORTS });
  else if (think !== undefined) body.think = think;
  const tools = aiio?.tools?.() ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }
  return [headers, body];
}

function toOllamaMessage(msg, context, i) {
  switch (msg.type) {
    case MessageType.System:
      return { role: "system", content: textOf(msg) };
    case MessageType.User:
      return withAttachments({ role: "user", content: textOf(msg) }, msg);
    case MessageType.Assistant: {
      const out = { role: "assistant", content: textOf(msg) };
      const calls = msg.content.filter((b) => b?.type === ContentType.ToolCall);
      if (calls.length > 0) {
        out.tool_calls = calls.map((b) => ({
          function: { name: b.name, arguments: objectArgs(b.arguments) },
        }));
      }
      return out;
    }
    case MessageType.ToolResult:
      return withAttachments({
        role: "tool",
        name: msg.name ?? toolNameFor(msg.callId, context, i),
        content: textOf(msg),
      }, msg);
    default:
      // tolerant reader: unknown message types degrade to user text
      return withAttachments({ role: "user", content: textOf(msg) }, msg);
  }
}

/**
 * Attach base64 image and generic binary payloads through Ollama's sole
 * `images` channel. Non-image binaries receive a content label because that
 * channel has no MIME type or filename fields.
 */
function withAttachments(out, msg) {
  // Ollama /api/chat has one binary input channel: `images` is an array of
  // base64 payloads. It deliberately has no MIME/filename properties, so
  // pass each Context attachment through unchanged and label non-image files
  // in content. A capable local model is responsible for interpreting it.
  const attachments = (msg.content ?? [])
    .filter((b) => (b?.type === ContentType.Image || b?.type === ContentType.Binary) && typeof b.content === "string" && b.content !== "");
  const labels = attachments
    .filter((b) => b?.type === ContentType.Binary && !(mimetypeOf(b) ?? "").startsWith("image/"))
    .map((b) => `[${typeof b.filename === "string" && b.filename ? b.filename : "attachment"}]`);
  if (labels.length > 0) out.content = [out.content, ...labels].filter(Boolean).join("\n");
  if (attachments.length > 0) out.images = attachments.map((b) => b.content);
  return out;
}

/** Join text blocks; thinking stays local-only (never on the wire). */
function textOf(msg) {
  return (msg.content ?? [])
    .filter((b) => b?.type === ContentType.Text)
    .map((b) => b.text ?? "")
    .join("");
}

/** Ollama wants arguments as an object, never a JSON string. */
function objectArgs(args) {
  if (args !== null && typeof args === "object") return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch { /* fall through */ }
  }
  return {};
}

/** Resolve a tool result's name from its linked toolCall block. */
function toolNameFor(callId, context, before) {
  if (callId === undefined) return undefined;
  for (let k = before - 1; k >= 0; k--) {
    for (const block of context[k]?.content ?? []) {
      if (block?.type === ContentType.ToolCall && block.callId === callId) {
        return block.name;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------ incoming: msg2events */

/**
 * @param {object} msg - one whole NDJSON frame from the default read
 * @param {object} state - per-request translator state (owned by IO)
 * @param {object} [aiio] - the IO instance (context-usage reporting)
 * @returns {Array<object>} normalized response events
 */
function msg2events(msg, state = {}, aiio) {
  if (msg?.error) {
    return [{ type: "error", error: String(msg.error), native: msg }];
  }
  const events = [];
  const m = msg?.message;

  // Block-index allocation: thinking (when present) is block 0, text
  // follows, tool calls come after — so a thinking-capable model's
  // blocks index consistently (text-only responses keep text at 0).
  const alloc = (key) => {
    if (state[key] === undefined) {
      state[key] = state.nextIndex ?? 0;
      state.nextIndex = (state.nextIndex ?? 0) + 1;
    }
    return state[key];
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

  if (typeof m?.thinking === "string" && m.thinking !== "") {
    if (!state.thinkingOpen) {
      events.push({ type: "thinking_start", contentIndex: alloc("thinkIndex") });
      state.thinkingOpen = true;
    }
    events.push({ type: "thinking_delta", contentIndex: state.thinkIndex, text: m.thinking });
  }

  if (typeof m?.content === "string" && m.content !== "") {
    closeThinking();
    if (!state.textOpen) {
      events.push({ type: "text_start", contentIndex: alloc("textIndex") });
      state.textOpen = true;
    }
    events.push({ type: "text_delta", contentIndex: state.textIndex, text: m.content });
  }

  if (Array.isArray(m?.tool_calls)) {
    closeThinking();
    closeText();
    for (const call of m.tool_calls) {
      const i = alloc("callIndex");
      delete state.callIndex; // every call gets its own fresh index
      const callId = `ollama-${(state.callSeq = (state.callSeq ?? 0) + 1)}`;
      const args = call.function?.arguments ?? {};
      events.push({
        type: "toolcall_start",
        contentIndex: i,
        callId,
        name: call.function?.name,
        arguments: args,
      });
      events.push({ type: "toolcall_end", contentIndex: i, arguments: args });
    }
  }

  if (msg?.done === true) {
    closeThinking();
    closeText();
    // the exact context consumption the server measured for this request
    if (Number.isFinite(msg.prompt_eval_count)) {
      aiio?.setContextUsage?.({ used: msg.prompt_eval_count });
    }
    const usage =
      Number.isFinite(msg.prompt_eval_count) && Number.isFinite(msg.eval_count)
        ? { inputTokens: msg.prompt_eval_count, outputTokens: msg.eval_count }
        : undefined;
    events.push({
      type: "done",
      usage,
      doneReason: msg.done_reason,
      native: stripFrame(msg),
    });
  }
  return events;
}

/** Keep frame metadata small: timings and eval info, not the message echo. */
function stripFrame(msg) {
  const { message, ...rest } = msg;
  return rest;
}

/* --------------------------------------- metadata surface: models/login */

/**
 * Model list from the local API as a MAP (unique model names as keys,
 * optional metadata as values), cached in the endpoint's auth
 * namespace on every successful fetch; falls back to the cache (or a
 * static config list) when the server is unreachable. Each model's
 * context window comes from `/api/show` (its model_info carries
 * `<family>.context_length`, which /api/tags lacks) — best-effort,
 * parallel, failures leave the window unknown.
 * @param {object} aiio
 * @returns {Promise<Object>} the model map
 */
async function models(aiio, url = DEFAULT_URL) {
  try {
    const response = await fetch(`${url}/api/tags`, singleShot({ signal: aiio?.requestSignal }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const map = {};
    for (const m of data.models ?? []) {
      if (typeof m?.name !== "string" || m.name === "") continue;
      map[m.name] = {
        label: m.name,
        reasoning: false,
        input: ["text"],
        ...(Number.isFinite(m.details?.context_length) ? { contextWindow: m.details.context_length } : {}),
        ...(Number.isFinite(m.size) ? { size: m.size } : {}),
        ...(typeof m.details?.family === "string" ? { family: m.details.family } : {}),
      };
    }
    await Promise.all(Object.keys(map).map(async (name) => {
      if (map[name].contextWindow !== undefined) return;
      try {
        const show = await fetch(`${url}/api/show`, singleShot({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name }),
          signal: aiio?.requestSignal,
        }));
        if (!show.ok) return;
        const info = (await show.json()).model_info ?? {};
        const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
        if (key && Number.isFinite(info[key]) && info[key] > 0) {
          map[name].contextWindow = info[key];
        }
      } catch { /* the window stays unknown for this model */ }
    }));
    aiio?.authSet?.({ models: map }); // refresh the cached snapshot
    return map;
  } catch {
    const cached = aiio?.settings?.models;
    return cached !== null && typeof cached === "object" && !Array.isArray(cached) ? cached : {};
  }
}

/** Trivial no-auth login: records the marker in the provider namespace. */
async function login(aiio, input = {}) {
  const auth = { type: "none" };
  aiio?.authSet?.({ auth }, input);
  return auth;
}

/** Ollama REST protocol. Construction replaces the old connect() hook. */
export default class OllamaProvider {
  static provider = metadata;

  /** The well-known local Ollama server (login wizard preset). */
  static knownEndpoints = [
    { name: "ollama", label: "Ollama (local)", url: DEFAULT_URL },
  ];

  static async detectEndpoints({ endpoints = {}, signal } = {}) {
    if (endpoints.ollama) return {};
    try {
      const response = await fetch(`${DEFAULT_URL}/api/tags`, singleShot({ signal }));
      if (!response.ok) return {};
      // dynamic: the server is environment-defined (running today,
      // maybe gone tomorrow) — never persisted
      return { ollama: { provider: "ollama", url: DEFAULT_URL, local: true, dynamic: true } };
    } catch {
      return {};
    }
  }

  constructor(url = DEFAULT_URL, aiio) {
    this.baseUrl = String(url).replace(/\/$/, "");
    this.url = `${this.baseUrl}/api/chat`;
    this.aiio = aiio;
  }

  context2msg(context, aiio = this.aiio) { return context2msg(context, aiio); }
  msg2events(message, state, aiio = this.aiio) { return msg2events(message, state, aiio); }
  async models() { return models(this.aiio, this.baseUrl); }
  async login(input) { return login(this.aiio, input); }

  /** Strict connection verification (login flows): throw on failure. */
  async testConnection() {
    const headers = {};
    const token = this.aiio?.settings?.auth?.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${this.baseUrl}/api/tags`, singleShot({
      headers,
      signal: this.aiio?.requestSignal,
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const data = await response.json();
    return { models: Array.isArray(data.models) ? data.models.length : 0 };
  }
}
