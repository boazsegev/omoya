// Shared test-only process boundary: child Bun scripts receive this via --preload.
// Keep this independent of bun:test; production commands never import it.
import { isolateBunChildren } from "./spawn-isolation.js";
import { credentialEnvName } from "../lib/util.js";

// Credentials follow the same name rule tool calls use (childEnv), so any
// provider (present or future) finds none. The list names the remaining
// non-secret provider settings that would still reshape detected endpoints.
const ambientSettings = [
  "OPENAI_BASE_URL", "AZURE_OPENAI_BASE_URL", "MOONSHOT_BASE_URL",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_WORKSPACE_ID", "GOOGLE_CLOUD_PROJECT",
];

export function scrubAmbientKeys(env) {
  for (const key of Object.keys(env)) {
    if (credentialEnvName(key) || ambientSettings.includes(key)) delete env[key];
  }
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
