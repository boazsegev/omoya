// Endpoint login/persistence shared by CLI and TUI bindings.

import { createInterface } from "node:readline/promises";
import { runOAuthFlow, completeOAuthPaste, tokensToAuth, oauthPasteOnly } from "./oauth.js";

/**
 * Remove an endpoint using the `Env.logout` contract. Persisted configuration
 * and auth files are removed; an environment-detected endpoint is cleared
 * only in memory and will be rediscovered while the environment provides it.
 * @param {object} env - Environment whose endpoint to log out.
 * @param {string} name - Endpoint name.
 * @returns {{name: string, dynamic: boolean}} Logout result from `env.logout`.
 * @throws Propagates errors from `env.logout`.
 */
export function logoutEndpoint(env, name) {
  return env.logout(name);
}

/**
 * Configure and log in to one endpoint via `Env.login`. The provider shapes
 * credentials (or uses supplied `auth`, such as browser-OAuth tokens), then
 * verifies the connection and fetches its models; failed login leaves nothing
 * behind.
 * @param {object} env - Environment that owns the login operation.
 * @param {object} options - Login options; defaults to `{}`.
 * @param {string} options.name - Endpoint name.
 * @param {string} options.provider - Provider protocol identifier.
 * @param {string} options.url - Endpoint URL.
 * @param {string} [options.token] - Optional API token.
 * @param {object} [options.auth] - Optional pre-seeded authentication data.
 * @param {string} [options.scope="package"] - Endpoint scope.
 * @returns {Promise<*>} Resolves with the result of `env.login`.
 * @throws Propagates login, connection-verification, and model-fetch errors.
 */
export async function loginEndpoint(env, {
  name, provider, url, token, auth, scope = "package",
} = {}) {
  return env.login(name, { provider, url, token, auth }, { scope });
}

/**
 * Sign in to a preset endpoint with its browser OAuth flow and then log in
 * using the resulting tokens. If a readline interface is supplied, prompt for
 * a pasted code/redirect as a fallback while allowing loopback completion;
 * login still verifies the connection through `loginEndpoint`.
 * @param {object} env - Environment receiving the endpoint login.
 * @param {object} options - OAuth login settings.
 * @param {string} options.name - Endpoint name.
 * @param {string} options.provider - Provider protocol identifier.
 * @param {string} options.url - Endpoint URL.
 * @param {object} options.oauth - OAuth configuration for `runOAuthFlow`.
 * @param {string} options.scope - Endpoint scope.
 * @param {import("node:readline/promises").Interface} [options.rl] - Optional interface for the paste-fallback prompt.
 * @param {{write(string): *}} options.output - Writable output used for OAuth URLs and log messages.
 * @returns {Promise<*>} Resolves with the result of `loginEndpoint`.
 * @throws Rejects if OAuth fails or the subsequent endpoint login fails.
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
 * Run the cooked-terminal wizard used by `--login`. Lists known endpoints
 * from `Env.loginPresets` alongside a manual URL option, then prompts for
 * endpoint details and credentials or browser OAuth where available. Closes
 * its readline interface on completion or failure.
 * @param {object} env - Environment providing presets and endpoint login.
 * @param {object} [options={}] - I/O options; defaults to `{}`.
 * @param {import("node:stream").Readable} [options.input=process.stdin] - Prompt input stream.
 * @param {import("node:stream").Writable} [options.output=process.stderr] - Wizard and OAuth output stream.
 * @returns {Promise<*>} Resolves with the result of the selected endpoint login.
 * @throws {Error} If no protocols are loaded, a choice is invalid, the URL is missing, or OAuth/login fails; propagates errors from the login operation.
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

/**
 * Return the built-in setup URL for a provider; runtime endpoint discovery
 * remains owned by the environment.
 * @param {string} provider - Provider protocol identifier.
 * @returns {string} The provider's default URL, or an empty string if none is known.
 */
export function defaultUrl(provider) {
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}
