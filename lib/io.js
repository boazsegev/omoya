/**
 * lib/io.js — IO: provider IO/schema conversion, nothing else.
 *
 * This module depends on lib/context.js and lib/env.js. It completes a
 * registered provider class's wire side (lib/io/provider.js), maps the
 * library thinking levels to the model's native modes, and publishes
 * the provider failure taxonomy (ProviderError) and THINKING_LEVELS.
 *
 * An IO instance keeps NO context between requests: each write() receives
 * the caller's Context and converts it to one provider request. During
 * the request, `context` is that Context: IO keeps its ROOT RECORD (type
 * "io-root": the qualified model and a hash of the request's tool
 * definitions) current, so a model or tool change shows as
 * `context.dirty`, and providers read `context.dirty` to drop replay
 * data bound to history that changed. It holds connection state for
 * the active request (a provider connection is created and closed for each
 * request) and exposes:
 *
 *   settings   — provider-namespaced LIVE settings view (via the
 *                Env connection, env.connection(selector))
 *   tools()    — the request's tool catalog (Env.tools(safe, selector),
 *                snapshotted once per request), per-instance availability
 *                selection applied
 *   authSet(a) — persists endpoint data through the Env connection
 *   write(context, callbacks?, options?) — one request over a Context, resolves with
 *                the terminal done/error event
 *   close()     — cancel active request, emit terminal partial, close,
 *                permanently disconnect
 *
 * State machine per instance: idle → sending → reading → idle,
 * repeating. Sending while not idle is a contract error (no concurrent
 * in-flight requests). After close() the instance is "closed" forever;
 * the caller constructs a replacement.
 *
 * IO knows nothing about agents, and publishes no events of its own:
 * each write() reports its request through the callbacks it was given.
 * `model` retains a qualified `<endpoint>/<model>` selector; only wire translators
 * extract the native model ID. Switching endpoints requires another IO instance.
 *
 * IO sanitizes outgoing requests (headers/body from the connector)
 * and validates converted responses (valid response events; message
 * metadata rides along — tolerant reader). An `auth`-classified failure
 * before any response data triggers the MULTI-PROCESS refresh (another
 * process may have rotated the endpoint's credentials): Env re-reads
 * the endpoint's persisted settings/auth record and the request retries
 * ONCE with the updated token (lib/io/request.js). Metadata RECORDS (context
 * entries with a string `type` — harness/tool-owned data, messageIsRecord)
 * and empty messages are filtered OUT of every provider-bound context:
 * they persist in the session and ride the agent's array, but the model
 * never sees them. Errors surface in the auth/network/provider/malformed
 * taxonomy (+ "cancelled" on close()).
 *
 * Per-request timeouts (each: write options > live provider-
 * namespaced settings > provider metadata > default; all accept a
 * millisecond numeral or a unit string via lib/util.js):
 *   - timeout        overall cap per request (default 1048575ms) — an
 *                    agent may legitimately work for a long time;
 *   - connectTimeout no response from the provider at all (default
 *                    30000ms) — a hung connection. Its connection budget is
 *                    computed from the serialized request body; callers should
 *                    treat it as a guardrail, not a latency prediction;
 *   - stuckTimeout   no DATA between message events while reading
 *                    (default 120000ms) — a stuck model; every frame
 *                    (text/thinking/tool-call block or delta) resets
 *                    it, so long-but-active generations never trip it.
 */

import Env from "./env.js";
import Context from "./context.js";
const { messageIsRecord, messageHasContent, messagesValidate } = Context;
import { connectBudget, resolveTimeout, runRequest } from "./io/request.js";
import { sanitizeRequest, bodyBytes } from "./io/sanitize.js";
import { durationTry } from "./util.js";
import { publishedTools } from "./tool-runtime.js";
import { ProviderError } from "./io/provider-error.js";
import { providerComplete } from "./io/provider.js";
import { THINKING_LEVELS, thinkingNative } from "./io/thinking.js";
import { fetchWithDeadline } from "./io/http.js";

/** Resolve a request timeout using the Env's provider settings and an optional per-request override. @param {{env: Env, model: string, timeout?: number|string}} options Request inputs; no provider settings override. @returns {number} Milliseconds. @throws {TypeError|Error} Missing Env, unsupported settings override, or invalid model. */
export function timeoutsResolve(options = {}) {
  if (Object.hasOwn(options, "settings")) throw new TypeError("IO.timeoutsResolve: configure provider settings on Env");
  return resolveTimeout(options);
}
// IO exposes the provider environment and Context helpers used to build
// and validate provider-bound requests.
/** The global environment constructor used by IO and provider authors. */
export { default as Env } from "./env.js";
/** The Context namespace for validating every provider-bound request. */
export { default as Context } from "./context.js";
/** The stable provider failure class (auth/network/provider/malformed). */
export { ProviderError } from "./io/provider-error.js";
/** Selectable thinking levels, weakest -> strongest (IO maps them to native modes). */
export { THINKING_LEVELS } from "./io/thinking.js";

const DEFAULT_TIMEOUT = 1_048_575;
const DEFAULT_CONNECT_TIMEOUT = 30_000;
const DEFAULT_STUCK_TIMEOUT = 120_000;

/** One provider IO session: context in, normalized response events out. */
export class IO {
  /** @returns {Env} The shared live environment. */
  env;
  /** @returns {string} Provider protocol registry name. */
  protocol;
  /** @returns {Function} Wire-completed provider constructor for trusted host/provider code. */
  Provider;
  /** @returns {object} Live provider metadata; never serialize wholesale to a model. */
  provider;
  /** @returns {string} Connection endpoint name. */
  name;
  /** @returns {?Context} The Context of the request in flight (null while idle); providers read its `dirty` and may edit replay data in it. */
  context = null;
  /** @returns {string} Effective URL from the current Env provider configuration. */
  get url() { return this._link.settings.url; }
  /** @returns {number} Current default overall request timeout in milliseconds. */
  get timeout() { return durationTry(this._link.settings.timeout) ?? durationTry(this.provider.timeout) ?? DEFAULT_TIMEOUT; }
  /** @returns {number} Current default connection watchdog in milliseconds. */
  get connectTimeout() { return durationTry(this._link.settings.connectTimeout) ?? durationTry(this.provider.connectTimeout) ?? DEFAULT_CONNECT_TIMEOUT; }
  /** @returns {number} Current default reading watchdog in milliseconds. */
  get stuckTimeout() { return durationTry(this._link.settings.stuckTimeout) ?? durationTry(this.provider.stuckTimeout) ?? DEFAULT_STUCK_TIMEOUT; }
  /**
   * Configure one provider IO session. Resolves the registered endpoint and
   * provider; URL, credentials and timeout defaults read Env's live
   * provider configuration, including after this IO is cached.
   * @param {Object} [options={}] Constructor options.
   * @param {object} options.env Env registry; required.
   * @param {string} options.model Registered `<endpoint>/<model>` selector.
   * @param {{think?: boolean|string}} [options.settings] Agent-local thinking selection only; provider configuration belongs to Env.
   * @param {string[]} [options.tools] Tool selection: omitted or ["*"] means all, [] none, otherwise the named subset.
   * @param {boolean} [options.safe=false] Whether to publish read-only tools only.
   * @param {(event:object)=>void} [options.onData] Optional default data callback.
   * @param {(line:string)=>void} [options.onLog] Optional default log callback.
   * @param {boolean} [options.remember=true] Whether Env.connection records this pair as last used.
   * @throws {TypeError} Invalid options container, unknown own top-level keys (including symbols), missing `env`, a separate endpoint option, or invalid qualified model. Key validation precedes provider lookup; settings payload keys remain open.
   * @returns {IO} The initialized provider IO session.
   * @throws {ProviderError} If endpoint resolution reports a provider-classified failure; other resolution errors propagate.
   * @effects Resolves and retains the provider link and initializes this instance in the idle state.
   */
  constructor(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("IO: options must be an object");
    const keys = new Set(["env", "model", "settings", "tools", "safe", "onData", "onLog", "remember"]);
    for (const key of Reflect.ownKeys(options)) {
      if (key === "endpoint") throw new TypeError("IO: use model: <endpoint>/<model>, not endpoint");
      if (!keys.has(key)) throw new TypeError(`IO: unknown option ${String(key)}`);
    }
    const { env, model, settings, tools, safe = false, onData, onLog, remember = true } = options;
    if (settings !== undefined && (settings === null || typeof settings !== "object" || Array.isArray(settings) || Reflect.ownKeys(settings).some((key) => key !== "think"))) {
      throw new TypeError("IO: settings accepts only agent-local think; configure providers on Env");
    }
    if (!env) throw new TypeError("IO: env (Env) is required");
    this.env = env;
    // Env resolves the pair: the effective connection (a bare preferences
    // placeholder rides the completing layer's provider + url) and its
    // registered provider class — IO never re-derives either.
    let link;
    try {
      link = env.connection(model, { remember });
    } catch (error) {
      throw error?.kind ? new ProviderError(error.kind, error.message) : error;
    }
    this._link = link;
    this.protocol = link.Protocol.provider?.name;
    this.Provider = providerComplete(link.Protocol);
    this.provider = link.Protocol.provider;

    this.name = link.endpoint;
    this._model = model;
    this._onData = onData;
    this._onLog = onLog;
    this._toolSelection = tools;
    this._safe = safe === true;
    this._toolCatalog = new Map(); // the request's Env.tools() snapshot
    this._thinking = settings?.think;
    this._authRetry = undefined;

    this._state = "idle"; // idle | sending | reading | cancelling | closing | closed
    this._controller = null;
    this._connection = null;
    this._active = null; // in-flight write() promise
    this._closePromise = null;
  }

  /**
   * Read the request state machine's current state.
   * @returns {"idle"|"sending"|"reading"|"cancelling"|"closing"|"closed"} Current lifecycle state.
   * @effects None; this is a read-only view.
   */
  get state() {
    return this._state;
  }

  /** @returns {string} Qualified endpoint/model selector; assignment changes the model only while idle and on this connection's endpoint. */
  get model() { return this._model; }

  /** Select a model on the same endpoint. Validation precedes mutation; busy/closed IO refuses selection. @param {string} selector Qualified model. @throws {TypeError|ProviderError} Invalid, cross-endpoint, busy, or closed selection. */
  set model(selector) {
    if (this.state !== "idle") throw new ProviderError("provider", `IO.model: cannot select while ${this.state}`);
    const link = this.env.connection(selector, { remember: false });
    if (link.endpoint !== this._link.endpoint) throw new TypeError("IO.model: another endpoint requires another IO instance");
    this._model = selector;
  }

  /**
   * Build the live provider-namespaced settings view with per-instance
   * agent-local thinking applied. The returned `think` is the model's native mode,
   * mapped from the library level and narrowed by model/provider capabilities.
   * @returns {object} A fresh merged settings object; undefined native thinking means provider default.
   * @effects None; does not mutate the Env settings.
   */
  get settings() {
    const merged = { ...this._link.settings };
    if (this._authRetry !== undefined) merged.auth = this._authRetry;
    if (this._thinking !== undefined) merged.think = this._thinking;
    const meta = merged.models?.[this.model.slice(this.model.indexOf("/") + 1)];
    const modes = Array.isArray(meta?.thinking) ? meta.thinking : this.provider?.capabilities?.thinking;
    const fallback = meta?.thinkingDefault ?? this.provider?.capabilities?.thinkingDefault;
    return { ...merged, think: thinkingNative(merged.think, modes, fallback) };
  }

  /**
   * A fresh provider connection over this endpoint/model for a
   * provider tool's one-off request (context2msg/send/read/close);
   * the caller closes it.
   * @param {object} [options={}] Connection options.
   * @param {AbortSignal} [options.signal] Signal assigned to abort its transport.
   * @param {(bytes: Uint8Array) => void} [options.onBytes] Raw response-byte progress callback.
   * @returns {object} A newly constructed provider connection; caller owns and must close it.
   * @throws {Error} If the provider constructor fails.
   * @effects Creates a new provider connection and optionally attaches the signal and byte callback.
   */
  connectionCreate({ signal, onBytes } = {}) {
    const connection = new this.Provider(this.url, this);
    if (signal) connection.signal = signal;
    if (onBytes) connection._onChunk = onBytes;
    return connection;
  }

  /**
   * fetch bounded by a wall-clock deadline and a fast connect fail-fast
   * (provider tools' plain HTTP requests).
   * @param {string|URL} url Request URL.
   * @param {object} [init={}] Fetch initialization; any supplied signal is honored.
   * @param {{deadline?: number, connectTimeout?: number}} [options={}] Deadline is epoch milliseconds; connect timeout is milliseconds (default 3000).
   * @returns {Promise<Response>} Resolves to the fetch response.
   * @throws {TypeError} May reject for invalid fetch arguments; transport and deadline failures reject the promise.
   * @effects Starts a bounded HTTP request using the global `fetch` implementation.
   */
  fetch(url, init = {}, { deadline, connectTimeout } = {}) {
    return fetchWithDeadline(fetch, url, init, { deadline, connectTimeoutMs: connectTimeout });
  }

  /**
   * Set/clear the Agent's thinking selection AFTER construction.
   * Provider configuration changes must go through Env.
   * @param {string} key
   * @param {*} value Thinking level; `undefined` restores the Env default.
   * @returns {void}
   * @effects Changes this IO instance's non-persisted thinking selection.
   */
  settingsSet(key, value) {
    if (key !== "think") throw new TypeError("IO.settingsSet: only think is agent-local; configure providers on Env");
    this._thinking = value;
  }

  /**
   * Return this request's publishable tool catalog, filtered by availability,
   * safe mode, configured selection, and the endpoint's provider tools.
   * @returns {Array<{name: string, ...Object}>} Fresh tool descriptors; secret tools are excluded.
   * @effects None; reads the request's tool catalog snapshot.
   */
  tools() {
    return [...publishedTools(this._toolCatalog, this._toolSelection).values()];
  }

  /**
   * Route auth persistence to the endpoint's namespace and refresh the
   * live settings view.
   * @param {object} auth Authentication data to persist.
   * @param {{scope?: "local"|"package"}} [options] Persistence scope, if specified.
   * @returns {object} The persisted endpoint section returned by the Env connection.
   * @throws {Error} Propagates persistence or Env connection errors.
   * @effects Persists endpoint authentication and updates the underlying live settings view.
   */
  authSet(auth, options) {
    return this._link.authSet(auth, options);
  }

  /**
   * Run one provider request over a complete context.
   * @param {Context} context The conversation; metadata records and empty messages are filtered before validation/provider conversion, and IO updates its root record during the request.
   * @param {Object} [callbacks={}] CamelCase response callbacks for this request.
   * @param {Object} [options={}] Per-request overrides.
   * @param {number|string} [options.timeout] Overall request cap override.
   * @param {number|string} [options.connectTimeout] Connection timeout override.
   * @param {number|string} [options.stuckTimeout] Reading watchdog override.
   * @returns {Promise<object>} Resolves with the terminal done/error event. Rejects TypeError for a non-Context argument or any model/endpoint write override without reserving the instance; rejects ProviderError for a closed/busy instance or malformed context.
   * @effects Reserves the instance synchronously, may refresh OAuth, starts one request, and returns the instance to idle after request finalization unless closed.
   */
  write(context, callbacks = {}, options = {}) {
    if (Object.hasOwn(options, "model") || Object.hasOwn(options, "endpoint")) return Promise.reject(new TypeError("IO.write: model and endpoint overrides are not supported; select IO.model or construct another IO"));
    if (!(context instanceof Context)) return Promise.reject(new TypeError("IO.write: context must be a Context"));
    if (this._state === "closed") {
      return Promise.reject(
        new ProviderError("provider", `IO "${this.name}" is permanently disconnected`),
      );
    }
    if (this._state !== "idle") {
      return Promise.reject(
        new ProviderError(
          "provider",
          `IO "${this.name}": contract error — write() while ${this._state} (no concurrent in-flight requests)`,
        ),
      );
    }
    // metadata RECORDS (string `type` — harness/tool-owned data riding
    // the context, messageIsRecord) NEVER leave the harness, and neither do
    // EMPTY messages (messageHasContent — an append-merge may legitimately
    // leave one in the live array after its payload merged into the
    // previous message; no provider dialect can carry a contentless
    // message): the provider-bound context is consumable messages
    // only. The Context itself is untouched.
    const outgoing = context.messages().filter((m) => !messageIsRecord(m) && messageHasContent(m));
    try {
      messagesValidate(outgoing);
    } catch (err) {
      return Promise.reject(
        new ProviderError("malformed", `IO: invalid context — ${err.message}`),
      );
    }
    try {
      // A user may disable the endpoint while this IO lives (env.connection refuses new ones).
      if (this._link.settings.disabled === true) throw new TypeError(`IO.write: endpoint ${JSON.stringify(this.name)} is disabled`);
    } catch (error) {
      return Promise.reject(error);
    }
    // Reserve synchronously, before optional OAuth refresh yields.  The
    // public write() contract rejects a second call immediately; waiting
    // for _run() to set this state left an acquisition race.
    this._state = "sending";
    this._controller = new AbortController();
    this.context = context;
    this._active = this._refreshOAuthIfNeeded().then(
      () => this._run(outgoing, callbacks, options),
      () => this._run(outgoing, callbacks, options), // a request can still surface a useful auth error
    ).finally(() => {
      this._active = null;
      this.context = null;
      this._authRetry = undefined;
    });
    return this._active;
  }

  /**
   * Execute the validated provider request through the request runner.
   * @param {Array} context Provider-bound context.
   * @param {Object} callbacks Request response callbacks.
   * @param {Object} options Request-specific overrides.
   * @returns {Promise<object>} Resolves with the terminal request event; rejects if request execution fails.
   * @effects Delegates provider I/O, callbacks, state transitions, and cleanup to `runRequest`.
   */
  async _run(context, callbacks, options) {
    return runRequest(this, context, callbacks, options); // lib/io/request.js
  }

  /**
   * Refresh expiring OAuth credentials before a request when OAuth settings
   * and a refresh token are available.
   * @returns {Promise<void>} Resolves when no refresh is needed or refresh/persistence completes.
   * @throws {Error} Rejects if dynamic OAuth loading, token refresh, or persistence fails; `write()` tolerates this and proceeds to request execution.
   * @effects May contact the OAuth service and persist replacement auth through `authSet`.
   */
  async _refreshOAuthIfNeeded() {
    const settings = this.settings;
    const auth = settings.auth ?? {};
    if (auth.type !== "oauth" || !Number.isFinite(auth.expires) || auth.expires > Date.now() + 30_000) return;
    if (typeof auth.refresh !== "string" || !settings.oauth) return;
    const { refreshOAuth } = await import("./io/oauth.js");
    this.authSet({ auth: await refreshOAuth(settings.oauth, auth.refresh) });
  }

  /**
   * The MULTI-PROCESS auth refresh (lib/io/request.js calls it on an
   * `auth`-classified failure): another process may have rotated this
   * endpoint's credentials (login, OAuth refresh) while this one still
   * holds its startup snapshot. The Env connection re-reads the
   * endpoint's persisted record and merges it over the current auth
   * (Env's own file-over-memory rule); a transient merged credential is
   * retained for this retry only, never masking later Env updates.
   * @returns {Promise<boolean>} Whether the effective auth record changed; false if reload fails or records compare equal.
   * @effects Reloads persisted endpoint auth and may retain transient retry credentials; suppresses reload errors so they do not mask provider verdicts.
   */
  async _refreshEndpointAuth() {
    const before = this.settings;
    const authBefore = before.auth === null || typeof before.auth !== "object" || Array.isArray(before.auth)
      ? undefined
      : before.auth;
    let reloaded;
    try {
      reloaded = await this._link.authReload(authBefore);
    } catch {
      return false; // a refresh failure must never mask the provider's verdict
    }
    // The reload updates Env; keep merged credentials only during this retry.
    if (reloaded.auth !== undefined) this._authRetry = reloaded.auth;
    const next = this.settings;
    const authNext = next.auth === null || typeof next.auth !== "object" || Array.isArray(next.auth)
      ? undefined
      : next.auth;
    return JSON.stringify(authBefore) !== JSON.stringify(authNext);
  }

  /**
   * Interrupt the active request, emitting a terminal partial; IO remains reusable.
   * @returns {Promise<void>} Resolves after the in-flight request settles; no-op when idle/closed.
   * @effects Aborts the owned connection signal, awaits teardown, and returns to idle. Repeated calls are safe.
   */
  async cancel() {
    if (this._state === "closed" || this._state === "closing" || !this._active) return;
    this._state = "cancelling";
    const err = new Error("cancelled");
    err.name = "AbortError";
    this._controller?.abort(err);
    await this._active.catch(() => {});
  }

  /**
   * Permanently disconnect after interrupting any active request.
   * @returns {Promise<void>} Resolves when the request settles and its connection closes; concurrent/repeated calls await the same outcome.
   * @throws {Error|AggregateError} Request finalization or connection teardown failures, after the instance enters closed. Repeated close reports the same failure; construct a new IO to reconnect.
   * @effects Aborts the owned connection signal and transitions irreversibly to closed.
   */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._state = "closing";
    const active = this._active;
    const connection = this._connection;
    const err = new Error("closed");
    err.name = "AbortError";
    this._controller?.abort(err);
    this._closePromise = (async () => {
      const errors = [];
      if (active) {
        try { await active; } catch (error) { errors.push(error); }
      }
      // runRequest normally owns closing its connection. An idle connection,
      // if supplied by a provider, still belongs to this instance.
      if (!active && connection) {
        try { await connection.close(); } catch (error) { errors.push(error); }
        this._connection = null;
      }
      this._state = "closed";
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "IO failed to close");
    })();
    return this._closePromise;
  }
}

Object.assign(IO, {
  Env, Context,
  timeoutsResolve,
  ProviderError, THINKING_LEVELS,
});
export default IO;
