// Shared test-only process boundary: child Bun scripts receive this via --preload.
// Keep this independent of bun:test; production commands never import it.
import { isolateBunChildren } from "./spawn-isolation.js";

const ambientKeys = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "XAI_API_KEY",
  "MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "KIMI_API_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
];

export function scrubAmbientKeys(env) {
  for (const key of ambientKeys) delete env[key];
}

export function guardLiveFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...args) => {
    const target = String(url?.url ?? url);
    if (target.includes(":11434") || target.includes(":1234")) {
      throw new Error(`live model server fetch forbidden in tests: ${target}`);
    }
    if (target.includes("models.dev")) return Promise.reject(new Error(`registry fetch forbidden in tests: ${target}`));
    return original(url, ...args);
  };
}

// The parent has already removed ambient keys; keep explicit keys that
// detection tests set in their fixture environments.
guardLiveFetch();
isolateBunChildren();
