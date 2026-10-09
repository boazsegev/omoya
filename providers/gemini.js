/* Gemini Interactions protocol (HTTP + SSE). Context owns history; clean turns
 * continue by interaction ID, edited turns replay Context as documented Step[].
 * A configured endpoint URL is the API root (not /interactions).
 * No Google SDK or external package is used.
 */
import Context from "../lib/context.js";
const { MessageType, ContentType, mimetypeOf, contentIndexer } = Context;
const API_URL = "https://generativelanguage.googleapis.com/v1beta";

function headers(auth, settings = {}) {
  const result = { "content-type": "application/json" };
  if (auth?.type === "oauth") {
    if (!auth.token) throw new Error("Gemini OAuth: missing access token");
    const project = settings.oauth?.projectId ?? settings.projectId;
    if (!project) throw new Error("Gemini OAuth: configure a Google Cloud project for quota and billing");
    result.authorization = `Bearer ${auth.token}`;
    result["x-goog-user-project"] = project;
  } else if (auth?.token) result["x-goog-api-key"] = auth.token;
  return result;
}

function baseUrl(url) { return String(url ?? API_URL).replace(/\/+$/, ""); }
function modelName(aiio) { return aiio.model.slice(aiio.model.indexOf("/") + 1); }

function contentOf(block) {
  if (block.type === ContentType.Text) return { type: "text", text: block.text };
  if (block.type !== ContentType.Image && block.type !== ContentType.Binary) throw new Error(`Gemini: unsupported input block ${block.type}`);
  const mime = mimetypeOf(block);
  if (!mime || !/^(image\/|audio\/|video\/|application\/pdf$|text\/csv$)/.test(mime)) throw new Error(`Gemini: unsupported media type ${mime ?? "unknown"}`);
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document";
  return { type, mime_type: mime, data: block.content };
}

function messageSteps(message) {
  if (message.type === MessageType.User) return [{ type: "user_input", content: message.content.map(contentOf) }];
  if (message.type === MessageType.ToolResult) {
    if (!message.name || !message.callId) throw new Error("Gemini: tool result requires name and callId");
    const result = message.content.map(contentOf);
    if (message.error === true || typeof message.error === "string") result.unshift({ type: "text", text: `[tool error] ${typeof message.error === "string" ? message.error : "tool failed"}` });
    return [{ type: "function_result", call_id: message.callId, name: message.name, result }];
  }
  if (message.type !== MessageType.Assistant) return [];
  // The original steps contain signatures and server-tool steps not expressible
  // as display blocks. Use them verbatim while the history is unchanged.
  if (Array.isArray(message.gemini?.steps)) return message.gemini.steps;
  const steps = [];
  for (const block of message.content) {
    if (block.type === ContentType.Thinking && block.gemini?.step) steps.push(block.gemini.step);
    else if (block.type === ContentType.ToolCall) steps.push({ type: "function_call", id: block.callId, name: block.name, arguments: block.arguments });
    else if (block.type === ContentType.Text || block.type === ContentType.Image || block.type === ContentType.Binary) steps.push({ type: "model_output", content: [contentOf(block)] });
  }
  return steps;
}

function withoutGemini(message) {
  const { gemini, ...rest } = message;
  if (!Array.isArray(rest.content)) return rest;
  return { ...rest, content: rest.content.map((block) => {
    if (!block.gemini) return block;
    const { gemini: _metadata, ...clean } = block;
    return clean;
  }) };
}

function invalidate(context, aiio) {
  const from = aiio.context?.dirty ?? false;
  if (from === false) return context;
  const replacements = new Map();
  aiio.context.update((entries) => {
    for (let i = from; i < entries.length; i++) {
      if (entries[i].gemini || entries[i].content?.some((part) => part.gemini)) {
        const clean = withoutGemini(entries[i]);
        replacements.set(entries[i], clean);
        entries[i] = clean;
      }
    }
    return replacements.size > 0;
  });
  return context.map((entry) => replacements.get(entry) ?? entry);
}

function context2msg(context, aiio) {
  const messages = invalidate(context, aiio).filter((message) => typeof message?.type === "number");
  const systems = messages.filter((message) => message.type === MessageType.System);
  const conversation = messages.filter((message) => message.type !== MessageType.System);
  const last = conversation.at(-1);
  const previous = (last?.type === MessageType.User || last?.type === MessageType.ToolResult)
    ? [...conversation].reverse().find((m) => m.type === MessageType.Assistant)?.gemini?.interactionId
    : undefined;
  const pendingResults = conversation.slice(conversation.findLastIndex((m) => m.type === MessageType.Assistant) + 1).filter((m) => m.type === MessageType.ToolResult);
  const knownCalls = new Set(conversation.at(conversation.findLastIndex((m) => m.type === MessageType.Assistant))?.content?.filter((b) => b.type === ContentType.ToolCall).map((b) => b.callId) ?? []);
  if (pendingResults.some((result) => !knownCalls.has(result.callId))) throw new Error("Gemini: tool result has no matching function call");
  // A server-side predecessor is usable only when all following messages are
  // new input/results, and no change invalidated the ID.
  const previousIndex = previous ? conversation.findLastIndex((m) => m.type === MessageType.Assistant && m.gemini?.interactionId === previous) : -1;
  const tail = previousIndex >= 0 ? conversation.slice(previousIndex + 1) : conversation;
  const input = tail.flatMap(messageSteps);
  if (input.length === 0) throw new Error("Gemini: no input to send");
  const body = { model: modelName(aiio), input, stream: true };
  if (previousIndex >= 0) body.previous_interaction_id = previous;
  // No valid predecessor after an edit: replay full history. Each completed
  // interaction is stored so a clean subsequent turn can refer to its ID.
  if (systems.length) body.system_instruction = systems.map((m) => m.content.filter((b) => b.type === ContentType.Text).map((b) => b.text).join("\n")).join("\n\n");
  const tools = aiio.tools?.() ?? [];
  if (tools.length) body.tools = tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object", properties: {} } }));
  const thinking = aiio.settings?.think;
  body.generation_config = { ...(thinking ? { thinking_level: thinking } : {}), thinking_summaries: "auto" };
  return [headers(aiio.settings?.auth, aiio.settings), body];
}

function usageOf(usage) {
  if (!usage) return undefined;
  return Context.usageNormalize(usage);
}

function summaryText(summary) {
  return Array.isArray(summary) ? summary.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("") : "";
}

function msg2events(frame, state = {}, aiio) {
  const kind = frame?.event_type;
  state.steps ??= new Map();
  state.index ??= contentIndexer();
  state.content ??= new Map();
  const events = [];
  if (kind === "error" || frame?.error) return [{ type: "error", error: frame.error?.message ?? String(frame.error ?? "Gemini interaction failed"),
    ...(frame.error?.code === "gateway_timeout" ? { kind: "network" } : {}), native: frame }];
  if (kind === "step.start") {
    const step = { ...frame.step,
      ...(Array.isArray(frame.step?.content) ? { content: frame.step.content.map((item) => ({ ...item })) } : {}),
      ...(Array.isArray(frame.step?.summary) ? { summary: frame.step.summary.map((item) => ({ ...item })) } : {}) };
    state.steps.set(frame.index, step);
    if (step.type === "model_output") {
      const text = step.content?.[0]?.type === "text" ? step.content[0].text : undefined;
      if (text) {
        const index = state.index.of(frame.index);
        events.push({ type: "text_start", contentIndex: index }, { type: "text_delta", contentIndex: index, text });
        state.content.set(frame.index, true);
      }
    }
    if (step.type === "thought") {
      const text = summaryText(step.summary);
      if (text) {
        const index = state.index.of(frame.index);
        events.push({ type: "thinking_start", contentIndex: index }, { type: "thinking_delta", contentIndex: index, text });
        state.content.set(frame.index, true);
      }
    }
    if (step.type === "function_call") {
      events.push({ type: "tool_call_start", contentIndex: state.index.of(frame.index), callId: step.id, name: step.name, arguments: "" });
    }
  }
  if (kind === "step.delta") {
    const step = state.steps.get(frame.index);
    const delta = frame.delta ?? {};
    if (!step) return [];
    if (delta.type === "text" && step.type === "model_output") {
      step.content ??= [];
      if (!step.content.length) step.content.push({ type: "text", text: "" });
      step.content[0].text += delta.text ?? "";
      const index = state.index.of(frame.index);
      if (!state.content.has(frame.index)) { events.push({ type: "text_start", contentIndex: index }); state.content.set(frame.index, true); }
      events.push({ type: "text_delta", contentIndex: index, text: delta.text ?? "" });
    } else if ((delta.type === "arguments_delta" || delta.type === "arguments") && step.type === "function_call") {
      const fragment = delta.arguments ?? delta.partial_arguments ?? "";
      step._arguments = (step._arguments ?? "") + fragment;
      events.push({ type: "tool_call_delta", contentIndex: state.index.of(frame.index), arguments: fragment });
    } else if (delta.type === "thought_signature" && step.type === "thought") step.signature = delta.signature;
    else if (delta.type === "thought_summary" && step.type === "thought") {
      const content = delta.content;
      if (content) {
        step.summary ??= [];
        step.summary.push({ ...content });
        const text = summaryText([content]);
        if (text) {
          const index = state.index.of(frame.index);
          if (!state.content.has(frame.index)) { events.push({ type: "thinking_start", contentIndex: index }); state.content.set(frame.index, true); }
          events.push({ type: "thinking_delta", contentIndex: index, text });
        }
      }
    } else if ((delta.type === "image" || delta.type === "audio" || delta.type === "document") && step.type === "model_output") {
      step.content ??= [];
      step.content.push(delta);
    }
  }
  if (kind === "step.stop") {
    const step = state.steps.get(frame.index);
    if (step?.type === "function_call") {
      let args = step.arguments;
      if (step._arguments !== undefined) {
        try { args = JSON.parse(step._arguments); } catch { return [{ type: "error", error: "Gemini returned malformed function arguments" }]; }
        delete step._arguments;
        step.arguments = args;
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) return [{ type: "error", error: "Gemini returned invalid function arguments" }];
      events.push({ type: "tool_call_end", contentIndex: state.index.of(frame.index), arguments: args });
    } else if (step?.type === "model_output" && state.content.has(frame.index)) events.push({ type: "text_end", contentIndex: state.index.of(frame.index) });
    else if (step?.type === "thought" && state.content.has(frame.index)) events.push({ type: "thinking_end", contentIndex: state.index.of(frame.index) });
  }
  if (kind === "interaction.completed") {
    const interaction = frame.interaction ?? {};
    if (!['completed', 'requires_action'].includes(interaction.status)) return [{ type: "error", error: `Gemini interaction ${interaction.status ?? "unknown"}`, native: frame }];
    const steps = [...state.steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step);
    if (interaction.status === "requires_action" && !steps.some((step) => step.type === "function_call")) return [{ type: "error", error: "Gemini requires action without a function call" }];
    if (interaction.status === "completed" && steps.some((step) => step.type === "function_call")) return [{ type: "error", error: "Gemini completed with unresolved function calls" }];
    const content = [];
    for (const step of steps) {
      if (step.type === "thought" && summaryText(step.summary)) content.push({ type: ContentType.Thinking, text: summaryText(step.summary), gemini: { step } });
      else if (step.type === "function_call") content.push({ type: ContentType.ToolCall, callId: step.id, name: step.name, arguments: step.arguments ?? {} });
      else if (step.type === "model_output") for (const item of step.content ?? []) {
        if (item.type === "text") content.push({ type: ContentType.Text, text: item.text });
        else if (item.type === "image" || item.type === "audio" || item.type === "document") content.push({ type: item.type === "image" ? ContentType.Image : ContentType.Binary, content: item.data, mimetype: item.mime_type });
      }
    }
    if (Number.isFinite(interaction.usage?.total_input_tokens)) aiio?.context && (aiio.context.contextUsage = { used: interaction.usage.total_input_tokens });
    state.completed = true;
    events.push({ type: "done", doneReason: interaction.status, message: { type: MessageType.Assistant, content, gemini: { interactionId: interaction.id, steps } }, usage: usageOf(interaction.usage), native: { id: interaction.id, status: interaction.status } });
  }
  return events;
}

/** Native Gemini Interactions API provider. Configured URL is an API root. */
export default class GeminiProvider {
  static provider = { label: "Gemini", capabilities: { tools: true, streaming: true, thinking: ["minimal", "low", "medium", "high"] } };
  static get knownEndpoints() {
    const endpoints = [{ name: "gemini", label: "Google Gemini API", url: API_URL }];
    const clientId = process.env.GOOGLE_GEMINI_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_GEMINI_OAUTH_CLIENT_SECRET;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (clientId && clientSecret && projectId) endpoints.push({
      name: "gemini-oauth", label: "Google Gemini API (OAuth, own Cloud project)", url: API_URL,
      note: "Developer API billing/quota applies; Gemini Apps subscriptions are not used.",
      oauth: {
        label: "Google Gemini API", clientId, clientSecret, projectId,
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        redirectUri: "http://127.0.0.1:18995/callback",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
      },
    });
    return endpoints;
  }
  static detectEnvironment({ endpoints = {} } = {}) {
    if (endpoints.gemini) return {};
    const token = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    return token ? { gemini: { provider: "gemini", url: API_URL, dynamic: true, auth: { type: "api_key", token } } } : {};
  }
  static login({ token } = {}) { return { type: "api_key", token }; }
  static async models({ url = API_URL, auth, settings, signal } = {}) {
    const found = {};
    let next;
    do {
      const query = next ? `?pageToken=${encodeURIComponent(next)}` : "";
      const response = await fetch(`${baseUrl(url)}/models${query}`, { method: "GET", headers: headers(auth, settings), signal });
      if (!response.ok) throw Object.assign(new Error(`Gemini models: HTTP ${response.status}`), { status: response.status });
      const data = await response.json();
      for (const model of data.models ?? []) {
        if (!model.name?.startsWith("models/") || !model.supportedGenerationMethods?.includes("generateContent")) continue;
        found[model.name.slice(7)] = { label: model.displayName ?? model.name, contextWindow: model.inputTokenLimit, maxTokens: model.outputTokenLimit };
      }
      next = data.nextPageToken;
    } while (next);
    return found;
  }
  static async testConnection(options) { const models = await this.models(options); return { models: Object.keys(models).length }; }
  constructor(url = API_URL, aiio) {
    this.baseUrl = baseUrl(url);
    this.url = `${this.baseUrl}/interactions?alt=sse`;
    this.aiio = aiio;
    this.requireTerminal = true;
  }
  context2msg(context, aiio = this.aiio) { return context2msg(context, aiio); }
  msg2events(frame, state, aiio = this.aiio) {
    const events = msg2events(frame, state, aiio);
    if (state.completed) this.completed = true;
    return events;
  }
  send(message, base) { return base(message); }
}
