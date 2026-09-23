// Endpoint login/persistence shared by CLI and TUI bindings.

import { createInterface } from "node:readline/promises";
import { runOAuthFlow, completeOAuthPaste, tokensToAuth, oauthPasteOnly } from "./oauth.js";

/**
 * Remove an endpoint (the /logout and --logout contract): its entry
 * drops out of settings.json, its auth file is deleted, and the live
 * Env forgets it (see Env.removeEndpoint). Environment-detected
 * (dynamic) endpoints were never persisted — the removal is in-memory
 * only, and the endpoint re-detects on the next startup while the
 * environment still provides it.
 * @param {object} env
 * @param {string} name - endpoint name
 * @returns {{name: string, dynamic: boolean}}
 */
export function logoutEndpoint(env, name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("logout requires an endpoint name");
  }
  return env.removeEndpoint(name.trim());
}

/** Configure one endpoint, invoke its protocol login (or accept a
 *  pre-seeded `auth`, e.g. browser-OAuth tokens), verify the connection,
 *  and refresh models. */
export async function loginEndpoint(env, {
  name, provider, url, token, auth, scope = "package",
} = {}) {
  // ONE write per settings file per login (lib/env/persist.js): the
  // credentials, the endpoint config, the loginRequired clear and the
  // model refresh below each update the same files — batched, they
  // land once, atomically.
  return env.batch(() => loginEndpointInner(env, { name, provider, url, token, auth, scope }));
}

async function loginEndpointInner(env, {
  name, provider, url, token, auth, scope = "package",
} = {}) {
  if (!name || !provider || !url) {
    throw new Error("login requires endpoint name, provider protocol, and URL");
  }
  const Protocol = env.provider(provider);
  if (!Protocol) throw new Error(`unknown provider protocol: ${provider}`);
  if (!['package', 'local'].includes(scope)) throw new Error('login scope must be "package" or "local"');

  const existed = env.endpoint(name);
  const endpoint = {
    provider,
    url,
    ...(provider === "ollama" && existed?.remote !== true ? { local: true } : {}),
    ...(existed?.remote === true ? { remote: true } : {}),
  };
  env.endpoints[name] = endpoint;
  const aiio = {
    endpoint: name,
    url,
    tools: () => [],
    authSet: (data) => env.authSet(name, data, { scope }),
  };
  Object.defineProperty(aiio, "settings", { get: () => env.endpointSettings(name) });
  const connection = new Protocol(url, aiio);
  try {
    const credentials = auth ?? await connection.login({ token, scope });
    if (credentials && typeof credentials === "object" && !Array.isArray(credentials)) {
      env.authSet(name, { auth: credentials }, { scope });
    }
    // a KNOWN PRESET's behavioral extras persist with the endpoint
    // record: `verify` (the codex backend has no GET /models — its
    // verification is the OAuth JWT itself) and a static `models`
    // list (the fetch can't work where there is no route). A preset
    // with a model REGISTRY (models.dev) skips the static list: its
    // candidates live in the registry + the preset itself, and a
    // persisted copy would linger as stale data forever
    // (endpointSettings merges it under the probed cache).
    // the known preset (by NAME, else by protocol+URL — a RENAMED
    // preset endpoint keeps its extras)
    const preset = env.knownEndpoints?.().find(
      (entry) => entry.name === name && entry.provider === provider,
    ) ?? env.knownEndpoints?.().find(
      (entry) => entry.provider === provider && entry.url === url,
    );
    const extras = {
      ...(preset?.verify !== undefined ? { verify: preset.verify } : {}),
      ...(preset?.oauth !== undefined ? { oauth: preset.oauth } : {}),
      ...(preset?.models && typeof preset.models === "object" && !preset?.registry
        ? { models: preset.models } : {}),
    };
    // Keep the live endpoint record aligned with the durable preset
    // policy. endpoint() is the public connection configuration view;
    // leaving extras only in authSet's settings section made a
    // registry-backed preset lose its required verify mode immediately
    // after login. Registry presets intentionally have no static models.
    Object.assign(endpoint, extras);
    // the endpoint's record is its AUTH FILE: provider, url, the
    // preset extras and the credentials all land there, making the
    // endpoint self-contained (it auto-catalogs from the auth file).
    // settings.providers stays for MANUAL endpoint configuration —
    // a login never writes it.
    env.authSet(name, { ...endpoint, ...extras }, { scope });
    // a login ALWAYS tests the connection: a silent 401 (or a dead
    // URL) must fail loudly here, not surface as an empty model list
    // later. A failed test rolls the endpoint back (catch below).
    const verified = await connection.testConnection?.().catch((error) => {
      const err = new Error(`connection test failed for ${name} at ${url}: ${error.message}`);
      err.cause = error;
      err.status = error.status;
      throw err;
    });
    // a verified login also clears a past auth-failure mark (the menu's
    // `(login)` row) — the credentials just proved themselves
    if (env.endpointSettings(name).loginRequired === true) {
      env.authSet(name, { loginRequired: false });
    }
    try { await env.endpointModels(name, { refresh: true }); } catch { /* models list remains cache/static */ }
    return { name, endpoint: env.endpoint(name), auth: credentials, scope, verified };
  } catch (error) {
    if (existed) env.endpoints[name] = existed;
    else delete env.endpoints[name];
    throw error;
  } finally {
    await connection.close().catch(() => {});
  }
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
 * the loaded protocols can already talk to (Env.knownEndpoints —
 * e.g. OpenAI, GitHub Copilot, LM Studio, Ollama) next to a manual
 * (enter-URL) option: adding a NEW endpoint is half the reason the
 * wizard exists, so it is never limited to the known list.
 */
export async function runLoginWizard(env, {
  input = process.stdin,
  output = process.stderr,
} = {}) {
  const protocols = env.providerNames()
    .filter((name) => env.provider(name)?.provider?.secret !== true);
  if (protocols.length === 0) throw new Error("no provider protocols are loaded");
  const known = env.knownEndpoints?.() ?? [];
  const rl = createInterface({ input, output, terminal: input.isTTY === true });
  try {
    let provider, presetName, presetUrl, oauth;
    if (known.length > 0) {
      output.write("Known endpoints:\n");
      known.forEach((entry, i) => output.write(`  ${i + 1}. ${entry.label} | ${entry.url}\n`));
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
      provider = (await rl.question(`Protocol [${protocols[0]}]: `)).trim() || protocols[0];
      if (!protocols.includes(provider)) throw new Error(`unknown provider protocol: ${provider}`);
    }
    const existing = env.endpointNames({ includeSecret: true })
      .find((name) => env.endpoint(name)?.provider === provider);
    const nameDefault = presetName ?? existing ?? provider;
    const name = (await rl.question(`Endpoint name [${nameDefault}]: `)).trim() || nameDefault;
    const knownUrl = presetUrl ?? env.endpoint(name)?.url ?? defaultUrl(provider);
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
