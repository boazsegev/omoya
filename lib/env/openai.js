// OpenAI protocol defaults used to complete provider classes.
// Provider plugins do not import this private module; defineProvider()
// supplies any missing methods from this one implementation. The JWT /
// codex helpers live in openai-codex.js, model listing and verification
// in openai-models.js — both re-exported here for the single completion
// surface (defineProvider picks names off this module).

import Context from "../context.js";
const { ContentType, MessageType, mimetypeOf } = Context;
import { ProviderError } from "./provider-error.js";
import { defaultSend, defaultRead, defaultClose } from "./http.js";
import { accountIdOf, isCodexBackend } from "./openai-codex.js";
import { resolveEffort, sortEfforts, supportedValues } from "./thinking.js";

export { jwtClaims, accountIdOf, isCodexBackend } from "./openai-codex.js";
export { models, reportPlanUsage, testConnection } from "./openai-models.js";

/** Initialize the default REST connection fields after a plugin constructor. */
export function initializeOpenAI(connection, url, aiio) {
  connection.aiio ??= aiio;
  connection.baseUrl ??= String(url ?? "https://api.openai.com/v1").replace(/\/$/, "");
  connection.url ??= `${connection.baseUrl}/responses`;
}

/** OpenAI Responses API request conversion. */
export function context2msg(context, aiio = this.aiio) {
  const token = aiio?.settings?.auth?.token;
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const accountId = accountIdOf(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const instructions = context
    .filter((message) => message?.type === MessageType.System)
    .map(textOf)
    .filter(Boolean)
    .join("\n\n");
  const input = [];
  for (const message of context) input.push(...toInputItems(message));
  const body = {
    model: aiio?.currentModel,
    input,
    stream: true,
  };
  if (instructions) body.instructions = instructions;
  if (isCodexBackend(this)) {
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
 * The Responses `reasoning` object for one model. Effort is always
 * explicit — the model's advertised default, else DEFAULT_THINKING —
 * translated to a symbol the model accepts. `summary` is separately
 * opt-in: without it the API streams no reasoning summary, so no
 * thinking block ever reaches the normalized event pipeline. Models
 * known not to reason (or not to summarize) omit what they reject.
 */
function reasoningOptions(settings, model) {
  const meta = settings.models?.[model];
  if (meta?.reasoning === false) return undefined;
  const reasoning = {
    effort: resolveEffort(settings.think, { levels: meta?.reasoningLevels, defaultLevel: meta?.defaultReasoning }),
  };
  if (meta?.reasoningSummary !== false) reasoning.summary = "auto";
  return reasoning;
}

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
    const mimetype = mimetypeOf(block);
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

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === ContentType.Text)
    .map((block) => block.text ?? "")
    .join("");
}

/** Convert one OpenAI Responses stream event to normalized events. */
export function msg2events(message, state = {}, aiio) {
  const io = aiio ?? this?.aiio;
  const type = message?.type;
  if (type === "error" || type === "response.failed") {
    const error = message.error?.message ?? message.response?.error?.message ?? "OpenAI response failed";
    return [{ type: "error", error: String(error), native: message }];
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
      type: "toolcall_start",
      contentIndex: index,
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments ?? "",
    }];
  }
  if (type === "response.function_call_arguments.delta") {
    const index = callIndex(state, message);
    return [{ type: "toolcall_delta", contentIndex: index, arguments: message.delta ?? "" }];
  }
  if (type === "response.function_call_arguments.done") {
    const index = callIndex(state, message);
    return [{ type: "toolcall_end", contentIndex: index, arguments: parseArguments(message.arguments) }];
  }
  if (type === "response.completed") {
    const usage = message.response?.usage;
    // the exact context consumption the endpoint measured for this request
    if (Number.isFinite(usage?.input_tokens)) {
      io?.setContextUsage?.({ used: usage.input_tokens });
    }
    return [{
      type: "done",
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

function allocate(state, key) {
  state.indexes ??= new Map();
  if (!state.indexes.has(key)) {
    state.indexes.set(key, state.nextIndex ?? 0);
    state.nextIndex = (state.nextIndex ?? 0) + 1;
  }
  return state.indexes.get(key);
}

function reasoningIndex(state, message) {
  const item = message.item_id ?? message.output_index ?? 0;
  return allocate(state, `thinking:${item}:${message.content_index ?? 0}`);
}

function callIndex(state, message) {
  const key = message.output_index ?? message.item_id ?? message.call_id;
  return state.calls?.get(key) ?? allocate(state, `call:${key}`);
}

function parseArguments(value) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(value ?? "{}"); } catch { return value ?? ""; }
}

/**
 * Default REST send/read/close preserve the blocking transport contract.
 * A 400 naming a `reasoning` parameter is answered once: the request is
 * corrected (the nearest supported effort, or the rejected field
 * dropped), the model's learned limits are cached, and it is resent.
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

/** The request corrected for a reasoning rejection, or null. */
function correctReasoning(connection, message, err) {
  const [headers, body] = Array.isArray(message) ? message : [undefined, message];
  if (err?.status !== 400 || !body?.reasoning) return null;
  let error;
  try { error = JSON.parse(err.body ?? "")?.error; } catch { return null; }
  const param = String(error?.param ?? "");
  if (param !== "reasoning" && !param.startsWith("reasoning.")) return null;
  // the model accepts the parameter, not this value: its list is the truth
  if (error.code === "unsupported_value" && param === "reasoning.effort") {
    const levels = supportedValues(error.message);
    if (!levels) return null;
    const effort = resolveEffort(body.reasoning.effort, { levels });
    if (effort === body.reasoning.effort) return null;
    rememberModel(connection, body.model, { reasoningLevels: sortEfforts(levels) });
    return [headers, { ...body, reasoning: { ...body.reasoning, effort } }];
  }
  if (error.code !== "unsupported_parameter") return null;
  if (param === "reasoning.summary") {
    rememberModel(connection, body.model, { reasoningSummary: false });
    const { summary, ...reasoning } = body.reasoning;
    return [headers, { ...body, reasoning }];
  }
  // the model does not reason at all (effort/reasoning rejected outright)
  rememberModel(connection, body.model, { reasoning: false });
  const { reasoning, ...rest } = body;
  return [headers, rest];
}

/** Merge learned limits into the cached model entry (when one exists). */
function rememberModel(connection, model, patch) {
  const models = connection.aiio?.settings?.models;
  if (!models || typeof models !== "object" || Array.isArray(models) || !models[model]) return;
  connection.aiio?.authSet?.({ models: { ...models, [model]: { ...models[model], ...patch } } });
}
export async function read() { return defaultRead(this); }
export async function close() { return defaultClose(this); }

/** Persist an API token supplied by a login wizard. */
export async function login(input = {}) {
  const token = input.token ?? this.aiio?.settings?.auth?.token;
  if (!token) throw new ProviderError("auth", "OpenAI login requires an API token");
  const auth = { type: "api_key", token };
  this.aiio?.authSet?.({ auth }, input);
  return auth;
}
