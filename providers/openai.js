// OpenAI Responses protocol plugin. The library's OpenAI defaults complete
// it: Env its catalog statics (models/testConnection/login), IO its wire
// methods. The plugin owns metadata, presets, endpoint detection, and the
// hosted web-search tool.

import { NAMES } from "../lib/namespace.js";
import Context from "../lib/context.js";
const { ContentType, MessageType } = Context;

const LM_STUDIO_URL = "http://localhost:1234/v1";

/**
 * Environment auto-configuration, pi's naming (an endpoint appears with
 * no login at all when its API key sits in the process environment).
 * Only endpoints that speak the OpenAI RESPONSES API — the one protocol
 * this plugin implements — are listed; a key for a chat-completions-only
 * service would auto-configure an endpoint that can only fail. Every
 * discovery is DYNAMIC: never persisted, re-detected every startup.
 *   - url:    fixed base URL
 *   - urlEnv: base URL from another environment variable (required)
 */
const ENV_ENDPOINTS = [
  { name: "openai", env: "OPENAI_API_KEY", url: "https://api.openai.com/v1", urlEnv: "OPENAI_BASE_URL" },
  { name: "azure-openai", env: "AZURE_OPENAI_API_KEY", urlEnv: "AZURE_OPENAI_BASE_URL", urlEnvRequired: true },
  { name: "xai", env: "XAI_API_KEY", url: "https://api.x.ai/v1" },
];

/* --------------------------------------------------- web-search tool */

/** The response head gets three seconds; after it, 1200 ms without another event. */
const HEAD_TIMEOUT = 3_000;
const IDLE_TIMEOUT = 1_200;
/** Endpoint+model pairs proven not to run the hosted tool (process lifetime). */
const unsupported = new Set();

/**
 * The `web-search` provider tool over the Responses hosted `web_search`
 * tool, probed per endpoint+model. Undefined = unsupported here (the
 * conventional web-search tool takes over).
 * @param {{aiio: object, args: object, signal?: AbortSignal, deadline?: number}} call
 * @returns {Promise<string|undefined>}
 */
async function webSearch({ aiio, args, signal, deadline }) {
  const query = String(args?.query ?? "").trim();
  if (query === "" || !aiio?.url) return undefined;
  // the Codex catalog already says when a model cannot use web_search
  if (aiio.settings?.models?.[aiio.modelCurrent.slice(aiio.modelCurrent.indexOf("/") + 1)]?.webSearch === false) return undefined;
  const probeKey = `${aiio.url} ${aiio.modelCurrent}`;
  if (unsupported.has(probeKey)) return undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new Error("web request cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  const remaining = () => (Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : Infinity);
  // one watchdog: the response head, then every received byte, re-arms it
  let timer;
  let expire;
  const expired = new Promise((_, reject) => { expire = reject; });
  expired.catch(() => {});
  const arm = (limit, message) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      expire(error);
    }, Math.min(limit, remaining()));
    timer.unref?.();
  };
  const within = (promise) => Promise.race([promise, expired]);
  const connection = aiio.connectionCreate({
    signal: controller.signal,
    onBytes: () => arm(IDLE_TIMEOUT, "provider web-search response stream stalled"),
  });
  try {
    const prompt = `Search the web for "${query}" and answer with the top results as a Markdown list: each result one bullet with its title, URL, and a one-or-two-sentence snippet.`;
    const [headers, body] = connection.context2msg([{ type: MessageType.User, content: [{ type: ContentType.Text, text: prompt }] }], aiio);
    body.tools = [{ type: "web_search" }];
    body.tool_choice = "required";
    arm(HEAD_TIMEOUT, "provider web-search response head timed out");
    try {
      await within(connection.send([headers, body]));
    } catch (error) {
      if (error?.status >= 400 && error.status < 500 && /web_search|tool/i.test(String(error.body ?? error.message))) {
        unsupported.add(probeKey);
        return undefined;
      }
      throw error;
    }
    arm(IDLE_TIMEOUT, "provider web-search response stream stalled");
    const items = [];
    for (;;) {
      const event = await within(connection.read());
      if (!event) break;
      if (event.type === "response.output_item.done" && event.item) items.push(event.item);
      if (event.type === "response.completed") break;
      if (event.type === "error" || event.type === "response.failed") {
        throw new Error(event.error?.message ?? event.response?.error?.message ?? "web search response failed");
      }
    }
    if (!items.some((item) => item.type === "web_search_call")) {
      unsupported.add(probeKey);
      return undefined;
    }
    return items
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((block) => typeof block?.text === "string")
      .map((block) => block.text)
      .join("");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
    await connection.close();
  }
}

export default class OpenAIProvider {
  static provider = {
    label: "OpenAI",
    capabilities: {
      streaming: true,
      thinking: ["none", "minimal", "low", "medium", "high", "xhigh"],
      // the effort sent when neither the user nor the model names one
      thinkingDefault: "high",
      // web-search over the Responses hosted `web_search` tool. OpenAI
      // exposes open_page only as an agentic web_search action, never a
      // direct fetch inside a usable budget: web-fetch is not offered.
      tools: { "web-search": { function: webSearch } },
    },
  };

  /** Endpoints the OpenAI Responses protocol can talk to (login wizard presets). */
  static knownEndpoints = [
    { name: "openai", label: "OpenAI", url: "https://api.openai.com/v1" },
    {
      name: "openai-codex",
      label: "OpenAI Codex (ChatGPT)",
      url: "https://chatgpt.com/backend-api/codex",
      // The Codex account catalog (/models?client_version=) is
      // authoritative when available; an unsuccessful catalog read
      // falls back to probing public models.dev candidates, then this
      // small bundled list. OAuth verification uses the issued JWT.
      verify: "jwt",
      registry: { url: "https://models.dev/api.json", provider: "openai" },
      models: {
        "gpt-6-luna": { label: "GPT-6 Luna", reasoning: true, contextWindow: 1050000, maxTokens: 128000 },
        "gpt-6-sol": { label: "GPT-6 Sol", reasoning: true, contextWindow: 1050000, maxTokens: 128000 },
        "gpt-6-astra": { label: "GPT-6 Astra", reasoning: true, contextWindow: 1050000, maxTokens: 128000 },
      },
      // browser sign-in (pi template): ChatGPT subscription OAuth,
      // PKCE + loopback callback, paste fallback for headless use
      oauth: {
        label: "ChatGPT (Codex)",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        authorizeUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        redirectUri: "http://localhost:1455/auth/callback",
        scope: "openid profile email offline_access",
        extraAuthorizeParams: { originator: NAMES.agentName, codex_cli_simplified_flow: "true" },
      },
    },
    // Keep the token and browser credentials as distinct choices: both
    // target Copilot, but OAuth needs its own login-flow descriptor.
    { name: "github-copilot", label: "GitHub Copilot (API token)", url: "https://api.githubcopilot.com" },
    {
      name: "github-copilot-oauth",
      label: "GitHub Copilot (OAuth)",
      url: "https://api.githubcopilot.com",
      oauth: {
        label: "GitHub Copilot",
        // This VS Code client id is registered for GitHub's DEVICE flow,
        // not our localhost callback. The former browser-code flow was
        // rejected with “redirect_uri is not associated with this
        // application”; device authorization has no redirect URI at all.
        clientId: "01ab8ac9400c4e429b23",
        deviceAuthorizationUrl: "https://github.com/login/device/code",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scope: "read:user",
      },
    },
    { name: "lm-studio", label: "LM Studio (local)", url: "http://localhost:1234/v1" },
  ];

  static async detect({ endpoints = {}, signal } = {}) {
    const found = {};
    // ambient API keys (pi's environment naming — see ENV_ENDPOINTS):
    // the process environment configures endpoints with no login at
    // all. Each carries its key as `auth` and is DYNAMIC — Env keeps
    // both in memory only, never persisted (a key removed from the
    // environment must leave nothing behind).
    for (const { name, env, url, urlEnv, urlEnvRequired } of ENV_ENDPOINTS) {
      if (endpoints[name]) continue;
      const key = process.env[env];
      if (typeof key !== "string" || key === "") continue;
      const baseUrl = urlEnv ? process.env[urlEnv] || url : url;
      if (!baseUrl || (urlEnvRequired && !process.env[urlEnv])) continue;
      found[name] = {
        provider: "openai",
        url: baseUrl,
        dynamic: true,
        auth: { type: "api_key", token: key },
      };
    }
    if (!endpoints["lm-studio"]) {
      try {
        const response = await fetch(`${LM_STUDIO_URL}/models`, { headers: { connection: "close" }, signal });
        if (response.ok) found["lm-studio"] = { provider: "openai", url: LM_STUDIO_URL, dynamic: true };
      } catch { /* no local LM Studio */ }
    }
    return found;
  }
}
