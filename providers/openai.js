// OpenAI Responses protocol plugin. Missing instance methods are completed
// by Env's internal OpenAI defaults; the plugin owns metadata and known
// OpenAI-compatible endpoint detection only.

import { NAMES } from "../lib/namespace.js";
import Env from "../lib/env.js";
const { singleShot, openaiWebSearch } = Env;

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

export default class OpenAIProvider {
  static provider = {
    label: "OpenAI",
    capabilities: {
      tools: true,
      thinking: true,
      streaming: true,
      // the Responses API `web_search` server tool (implementation in
      // lib/env/openai.js — this module is metadata only, but the
      // Agent's capability lookup reads THIS static object, so the
      // handler is referenced here)
      "web-search": openaiWebSearch,
    },
  };

  /** Endpoints the OpenAI Responses protocol can talk to (login wizard presets). */
  static knownEndpoints = [
    { name: "openai", label: "OpenAI", url: "https://api.openai.com/v1" },
    {
      name: "openai-codex",
      label: "OpenAI Codex (ChatGPT)",
      url: "https://chatgpt.com/backend-api/codex",
      // the codex backend has no OpenAI-shaped GET /models (its
      // /models?client_version= catalog only annotates reasoning
      // levels/defaults): verification is the freshly issued OAuth
      // JWT itself. models() builds the CANDIDATE superset from the
      // public models.dev registry (the same catalog pi bundles —
      // newly released models appear without a code update), probes
      // each candidate, and caches only account-usable models; the
      // static list below is the offline fallback.
      verify: "jwt",
      registry: { url: "https://models.dev/api.json", provider: "openai" },
      models: {
        "gpt-5.3-codex-spark": { label: "GPT-5.3 Codex Spark", reasoning: true, contextWindow: 128000, maxTokens: 128000 },
        "gpt-5.4": { label: "GPT-5.4", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-5.4-mini": { label: "GPT-5.4 mini", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-5.5": { label: "GPT-5.5", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-5.6-luna": { label: "GPT-5.6 Luna", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-5.6-sol": { label: "GPT-5.6 Sol", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-5.6-terra": { label: "GPT-5.6 Terra", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
        "gpt-6-astra": { label: "GPT-6 Astra", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
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

  static async detectEndpoints({ endpoints = {}, signal } = {}) {
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
        const response = await fetch(`${LM_STUDIO_URL}/models`, singleShot({ signal }));
        if (response.ok) found["lm-studio"] = { provider: "openai", url: LM_STUDIO_URL, dynamic: true };
      } catch { /* no local LM Studio */ }
    }
    return found;
  }
}
