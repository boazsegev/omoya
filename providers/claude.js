/* Claude Pro/Max subscription dialect. Reuses Anthropic's Messages
 * parser and model catalog; subscription authentication and wire names
 * are owned here, never inferred from an Anthropic API-key endpoint. */
import AnthropicProvider from "./anthropic.js";

const URL = "https://api.anthropic.com/v1";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// Explicit 5-minute retention for non-identity breakpoints (pi omits
// ttl because the API's default is five minutes).
const SHORT_CACHE = { type: "ephemeral", ttl: "5m" };
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const CLI_VERSION = "2.1.280";
const CLAUDE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "KillShell", "NotebookEdit", "Skill",
  "Task", "TaskOutput", "TodoWrite", "WebFetch", "WebSearch",
];
const TOOL_NAMES = new Map(CLAUDE_TOOLS.map((name) => [name.toLowerCase(), name]));
function wireName(name) { return TOOL_NAMES.get(name.toLowerCase()) ?? name; }
function localName(name, tools) {
  if (typeof name !== "string") return name;
  return tools.find((tool) => typeof tool.name === "string" && tool.name.toLowerCase() === name.toLowerCase())?.name ?? name;
}

function subscriptionHeaders(auth) {
  if (auth?.type !== "oauth" || !auth.token) throw new Error("Claude subscription requires OAuth sign-in");
  return {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": OAUTH_BETA,
    authorization: `Bearer ${auth.token}`,
    "user-agent": `claude-cli/${CLI_VERSION}`,
    "x-app": "cli",
  };
}

function rewriteOutgoing(body) {
  const system = [{ type: "text", text: IDENTITY, cache_control: { type: "ephemeral" } }];
  if (body.system) system.push({ type: "text", text: body.system, cache_control: { ...SHORT_CACHE } });
  body.system = system;
  for (const tool of body.tools ?? []) tool.name = wireName(tool.name);
  if (body.tools?.length) body.tools.at(-1).cache_control = { ...SHORT_CACHE };
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") block.name = wireName(block.name);
    }
  }
  const last = body.messages.at(-1);
  // Anthropic accepts at most four explicit breakpoints: identity, system,
  // tool catalog and the last eligible conversation block. Earlier turns
  // are covered by the prefix, not individually marked.
  if (last?.role === "user") {
    const block = last.content.at(-1);
    if (["text", "image", "tool_result", "document"].includes(block?.type)) block.cache_control = { ...SHORT_CACHE };
  }
  return body;
}

/** Server-tool wire (web_search/web_fetch side requests): subscription
 *  OAuth headers plus the Claude Code identity system block the
 *  subscription requires — the same framing Claude Code's WebSearch uses. */
function serverToolWire(aiio, body) {
  const headers = subscriptionHeaders(aiio?.settings?.auth);
  return [headers, { ...body, system: [{ type: "text", text: IDENTITY }] }];
}

/** OAuth-specific connection; transport and Messages event parsing are inherited. */
export default class ClaudeProvider extends AnthropicProvider {
  static provider = {
    label: "Claude Pro/Max (subscription)",
    capabilities: {
      ...AnthropicProvider.provider.capabilities,
      tools: AnthropicProvider.webTools(serverToolWire),
    },
  };

  static knownEndpoints = [{
    name: "claude",
    label: "Claude Pro/Max (subscription)",
    url: URL,
    // surfaced by the login wizard (Env.endpointPresets extras ride along)
    note: "OAuth inference bills EXTRA CREDITS, not subscription allowances, and depends on Anthropic's continued support — the endpoint may break.",
    verify: "messages",
    registry: { url: "https://models.dev/api.json", provider: "anthropic" },
    models: AnthropicProvider.knownEndpoints[0].models,
    oauth: {
      label: "Claude Pro/Max (subscription)",
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      redirectUri: "http://localhost:53692/callback",
      scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      extraAuthorizeParams: { code: "true" },
      tokenFormat: "json",
      tokenIncludesState: true,
    },
  }];

  static async detect() { return {}; }

  /** Strict login verification: a 1-token subscription request. */
  static async testConnection({ url = URL, auth, signal } = {}) {
    const models = this.knownEndpoints[0].models;
    const body = rewriteOutgoing({
      model: Object.keys(models)[0], max_tokens: 1, stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const response = await fetch(`${String(url).replace(/\/$/, "")}/messages`, {
      method: "POST", headers: subscriptionHeaders(auth), signal, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`),
        { status: response.status, body: text });
    }
    await response.body?.cancel?.();
    return { models: Object.keys(models).length };
  }

  /** The auth record a subscription OAuth token stores. */
  static login(input = {}, { settings } = {}) {
    const token = input.token ?? settings?.auth?.token;
    if (typeof token !== "string" || !token.startsWith("sk-ant-oat")) throw new Error("Claude subscription requires an OAuth access token");
    return { type: "oauth", token };
  }

  context2msg(context, aiio = this.aiio) {
    const headers = subscriptionHeaders(aiio?.settings?.auth);
    const [, body] = super.context2msg(context, aiio);
    return [headers, rewriteOutgoing(body)];
  }

  msg2events(message, state, aiio = this.aiio) {
    const events = super.msg2events(message, state, aiio);
    const tools = aiio?.tools?.() ?? [];
    for (const event of events) {
      if (event.type === "tool_call_start") event.name = localName(event.name, tools);
      if (event.type === "done") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "toolCall") block.name = localName(block.name, tools);
        }
      }
    }
    return events;
  }
}
