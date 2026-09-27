// Endpoint login/persistence shared by CLI and TUI bindings.

import { createInterface } from "node:readline/promises";
import { runOAuthFlow, completeOAuthPaste, tokensToAuth, oauthPasteOnly } from "./oauth.js";

/**
 * Remove an endpoint (the /logout and --logout contract — Env.logout):
 * its configuration and auth files go; an environment-detected endpoint
 * clears in memory only and re-detects while the environment provides it.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {{name: string, dynamic: boolean}}
 */
export function logoutEndpoint(env, name) {
  return env.logout(name);
}

/** Configure one endpoint and log it in (Env.login: the provider shapes
 *  the credentials — or a pre-seeded `auth`, e.g. browser-OAuth tokens —
 *  then the connection is verified and its models fetched; a failure
 *  leaves nothing behind). */
export async function loginEndpoint(env, {
  name, provider, url, token, auth, scope = "package",
} = {}) {
  return env.login(name, { provider, url, token, auth }, { scope });
}

/**
 * Browser sign-in for one preset endpoint (pi template): run the OAuth
 * flow with a paste fallback prompt, then log the endpoint in with the
 * resulting tokens (loginEndpoint verifies the connection as always).
 */
async function runOAuthLogin(env, { name, provider, url, oauth, scope, rl, output }) {
  const flow = runOAuthFlow(oauth, {
    onAuthUrl: (u) => output.write(`authorize: ${u}\n`),
    onLog: (line) => output.write(`${line}\n`),
  });
  // The paste prompt is a FALLBACK channel, not the only one: a loopback
  // redirect (the common case) completes `flow` on its own the moment the
  // browser lands on it. Feed a pasted answer in as soon as it arrives,
  // but never block on it — awaiting the question first (as this used to)
  // stranded an already-completed browser sign-in until the user pressed
  // Enter. A paste-only flow (no loopback listener exists) still works:
  // `flow` simply has no other way to resolve, so it waits on this same
  // promise regardless.
  if (rl) {
    rl.question(oauthPasteOnly(oauth)
      ? "Paste the code the sign-in page shows (code#state): "
      : "Paste the redirect URL (empty = wait for the browser): ")
      .then((answer) => { if (answer.trim() !== "") completeOAuthPaste(answer); })
      .catch(() => {});
  }
  const tokens = await flow;
  const auth = tokensToAuth(tokens);
  return loginEndpoint(env, { name, provider, url, auth, scope });
}

/**
 * Cooked terminal wizard used by `--login`. Lists every KNOWN endpoint
 * the loaded protocols can already talk to (Env.loginPresets —
 * e.g. OpenAI, GitHub Copilot, LM Studio, Ollama) next to a manual
 * (enter-URL) option: adding a NEW endpoint is half the reason the
 * wizard exists, so it is never limited to the known list.
 */
export async function runLoginWizard(env, {
  input = process.stdin,
  output = process.stderr,
} = {}) {
  const known = env.loginPresets();
  const protocols = [...new Set(known.map((entry) => entry.provider))];
  if (protocols.length === 0) throw new Error("no provider protocols are loaded");
  const rl = createInterface({ input, output, terminal: input.isTTY === true });
  try {
    let provider, presetName, presetUrl, oauth;
    if (known.length > 0) {
      output.write("Known endpoints:\n");
      known.forEach((entry, i) => {
        output.write(`  ${i + 1}. ${entry.label} | ${entry.url}\n`);
        // a preset's caveat (billing surprises, provider-support
        // fragility) is part of the choice, not fine print
        if (typeof entry.note === "string" && entry.note !== "") output.write(`     note: ${entry.note}\n`);
      });
      output.write("  m. Manual endpoint (enter URL)\n");
      const answer = (await rl.question("Endpoint [m]: ")).trim();
      const picked = /^\d+$/.test(answer)
        ? known[Number(answer) - 1]
        : known.find((entry) => entry.name === answer);
      if (picked) {
        provider = picked.provider;
        presetName = picked.name;
        presetUrl = picked.url;
        oauth = picked.oauth;
      } else if (answer !== "" && answer !== "m") {
        throw new Error(`unknown endpoint choice: ${answer}`);
      }
    }
    if (!provider) {
      output.write(`Provider protocols: ${protocols.join(", ")}\n`);
      // the listed protocols publish presets; any registered protocol logs in
      // (Env.login rejects an unknown one)
      provider = (await rl.question(`Protocol [${protocols[0]}]: `)).trim() || protocols[0];
    }
    const nameDefault = presetName ?? provider;
    const name = (await rl.question(`Endpoint name [${nameDefault}]: `)).trim() || nameDefault;
    const knownUrl = presetUrl ?? defaultUrl(provider);
    const url = (await rl.question(`URL${knownUrl ? ` [${knownUrl}]` : ""}: `)).trim() || knownUrl;
    if (!url) throw new Error("endpoint URL is required");
    const scopeAnswer = (await rl.question("Scope (package/local) [package]: ")).trim() || "package";
    // OAuth-capable endpoints offer browser sign-in (the pi template):
    // a PKCE flow in the system browser, paste fallback for headless
    if (oauth) {
      const method = (await rl.question("Method (browser/api-key) [browser]: ")).trim() || "browser";
      if (method === "browser" || method === "b") {
        return await runOAuthLogin(env, { name, provider, url, oauth, scope: scopeAnswer, rl, output });
      }
    }
    const token = (await rl.question("Token (leave empty when not required): ")).trim() || undefined;
    try {
      return await loginEndpoint(env, { name, provider, url, token, scope: scopeAnswer });
    } catch (error) {
      // dead credentials on an OAuth-capable endpoint: offer the browser
      const status = error.status ?? error.cause?.status;
      if (oauth && (status === 401 || status === 403 || /401|403|unauthorized/i.test(error.message))) {
        const retry = (await rl.question("authentication failed — sign in with the browser instead? [Y/n]: ")).trim().toLowerCase();
        if (retry === "" || retry === "y" || retry === "yes") {
          return await runOAuthLogin(env, { name, provider, url, oauth, scope: scopeAnswer, rl, output });
        }
      }
      throw error;
    }
  } finally {
    rl.close();
  }
}

/** Known setup defaults only; runtime endpoint discovery remains class-owned. */
export function defaultUrl(provider) {
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}
