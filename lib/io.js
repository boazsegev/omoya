/**
 * lib/io.js — IO: provider IO/schema conversion, nothing else.
 *
 * This module depends on lib/context.js and lib/env.js. It completes a
 * registered provider class's wire side (lib/io/provider.js), maps the
 * library thinking levels to the model's native modes, and publishes
 * the provider failure taxonomy (ProviderError) and THINKING_LEVELS.
 *
 * An IO instance carries NO context — every write() is a blank-slate
 * context-to-provider-request conversion. It holds connection state for
 * the active request (a provider connection is created and closed for each
 * request) and exposes:
 *
 *   settings   — provider-namespaced LIVE settings view (via the
 *                Env connection, env.connection(selector))
 *   tools()    — the request's tool catalog (Env.tools(safe, selector),
 *                snapshotted once per request), per-instance availability
 *                selection applied
 *   authSet(a) — persists endpoint data through the Env connection
 *   write(context, callbacks?, options?) — one request, resolves with
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
 * `model` and `modelCurrent` retain qualified `<endpoint>/<model>` strings;
 * only wire translators extract the native model ID. A write override stays
 * on this IO's endpoint; switching endpoints requires another IO instance.
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
 * Per-request timeouts (each: write options > constructor > provider-
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

/** Resolve effective per-request timeout values using IO's precedence and defaults. */
export { resolveTimeout as timeoutsResolve } from "./io/request.js";
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
  /** @returns {string} Effective request URL. */
  url;
  /** @returns {number} Overall request timeout in milliseconds. */
  timeout;
  /** @returns {number} Connection watchdog in milliseconds. */
  connectTimeout;
  /** @returns {number} Reading watchdog in milliseconds. */
  stuckTimeout;
  /**
   * Configure one provider IO session. Resolves the registered endpoint and
   * provider, then selects URL and timeouts from explicit options, live
   * provider settings, provider metadata, and defaults, in that order.
   * @param {Object} [options={}] Constructor options.
   * @param {object} options.env Env registry; required.
   * @param {string} options.model Registered `<endpoint>/<model>` selector.
   * @param {string} [options.url] URL override; otherwise use the resolved endpoint URL.
   * @param {number|string} [options.timeout] Overall request cap; otherwise settings/metadata or 1048575 ms.
   * @param {number|string} [options.connectTimeout] Connection timeout; otherwise settings/metadata or 30000 ms.
   * @param {number|string} [options.stuckTimeout] Reading watchdog; otherwise settings/metadata or 120000 ms.
   * @param {object} [options.settings={}] Per-invocation settings merged over the live provider namespace; not persisted.
   * @param {string[]} [options.tools] Tool selection: omitted or ["*"] means all, [] none, otherwise the named subset.
   * @param {boolean} [options.safe=false] Whether to publish read-only tools only.
   * @param {(event:object)=>void} [options.onData] Optional default data callback.
   * @param {(line:string)=>void} [options.onLog] Optional default log callback.
   * @param {boolean} [options.remember=true] Whether Env.connection records this pair as last used.
   * @throws {TypeError} If `env` is missing, a separate endpoint option is supplied, or model is not a valid qualified selector.
   * @returns {IO} The initialized provider IO session.
   * @throws {ProviderError} If endpoint resolution reports a provider-classified failure; other resolution errors propagate.
   * @effects Resolves and retains the provider link and initializes this instance in the idle state.
   */
  constructor({ env, model, url, timeout, connectTimeout, stuckTimeout, settings, tools, safe = false, onData, onLog, remember = true, ...options } = {}) {
    if (Object.hasOwn(options, "endpoint")) throw new TypeError("IO: use model: <endpoint>/<model>, not endpoint");
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
    this.url = url ?? link.url;
    this.timeout =
      durationTry(timeout) ?? durationTry(this.settings.timeout) ??
      durationTry(this.provider.timeout) ?? DEFAULT_TIMEOUT;
    this.connectTimeout =
      durationTry(connectTimeout) ?? durationTry(this.settings.connectTimeout) ??
      durationTry(this.provider.connectTimeout) ?? DEFAULT_CONNECT_TIMEOUT;
    this.stuckTimeout =
      durationTry(stuckTimeout) ?? durationTry(this.settings.stuckTimeout) ??
      durationTry(this.provider.stuckTimeout) ?? DEFAULT_STUCK_TIMEOUT;
    this._onData = onData;
    this._onLog = onLog;
    this._toolSelection = tools;
    this._safe = safe === true;
    this._toolCatalog = new Map(); // the request's Env.tools() snapshot
    this._settingsOverride =
      settings !== null && typeof settings === "object" && !Array.isArray(settings)
        ? settings
        : {};

    this._state = "idle"; // idle | sending | reading | closed
    this._controller = null;
    this._connection = null;
    this._killed = false;
    this._active = null; // in-flight write() promise
    this._contextUsage = { used: undefined, total: undefined }; // provider-reported context readout
    this._planUsage = null; // provider-reported plan/quota readout (last known, merged)
  }

  /**
   * Read the request state machine's current state.
   * @returns {"idle"|"sending"|"reading"|"closed"} Current lifecycle state.
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
    this._contextUsage = { used: undefined, total: undefined };
  }

  /**
   * Build the live provider-namespaced settings view with per-instance
   * overrides applied. The returned `think` is the model's native mode,
   * mapped from the library level and narrowed by model/provider capabilities.
   * @returns {object} A fresh merged settings object; undefined native thinking means provider default.
   * @effects None; does not mutate the Env settings.
   */
  get settings() {
    const merged = { ...this._link.settings, ...this._settingsOverride };
    const meta = merged.models?.[this.modelCurrent.slice(this.modelCurrent.indexOf("/") + 1)];
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
   * Set/clear a per-invocation settings override AFTER construction
   * (e.g. Agent's /agent-thinking toggling `think` on a live connection).
   * @param {string} key
   * @param {*} value Value to override; `undefined` clears the override.
   * @returns {void}
   * @effects Mutates this IO instance's non-persisted settings overrides.
   */
  settingsSet(key, value) {
    if (value === undefined) delete this._settingsOverride[key];
    else this._settingsOverride[key] = value;
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
   * Get the active request's abort signal for the HTTP backend.
   * @returns {AbortSignal|undefined} The signal, or undefined when no controller exists.
   * @effects None; read-only.
   */
  get requestSignal() {
    return this._controller?.signal;
  }

  /**
   * Get the effective model, preferring the current request override.
   * @returns {string} Qualified request model override, or the qualified instance model.
   * @effects None; read-only.
   */
  get modelCurrent() {
    return this._requestModel ?? this.model;
  }

  /**
   * The provider-reported context readout of the CURRENT/last request:
   * `{used, total}` in tokens, each undefined when the provider hasn't
   * reported it. Providers update it during a request via
   * contextUsage() (e.g. from a usage frame or model metadata);
   * IO itself fills `used` from the terminal usage envelope when the
   * provider left it unset. Consumers (Agent) read it after write()
   * resolves; missing data is their cue to approximate.
   * @returns {{used: number|undefined, total: number|undefined}} A defensive copy of the current/last request report.
   * @effects None; read-only.
   */
  get contextUsage() {
    return { ...this._contextUsage };
  }

  /**
   * Report actual context consumption and/or the model's available
   * context window (provider → IO channel; connectors call this from
   * their translators/metadata surfaces). Finite numbers merge over the
   * current report; anything else is ignored.
   * @param {{used?: number, total?: number}} [report={}] Provider-reported usage values.
   * @returns {void} Read contextUsage after assignment for the merged report.
   * @effects Stores finite nonnegative `used` and positive `total` values, floored to integers; invalid values are ignored.
   */
  set contextUsage({ used, total } = {}) {
    if (Number.isFinite(used) && used >= 0) this._contextUsage.used = Math.floor(used);
    if (Number.isFinite(total) && total > 0) this._contextUsage.total = Math.floor(total);
  }

  /**
   * The provider-reported PLAN/QUOTA readout (rate limits, subscription
   * allowances): `{label?, quotas}` where each quota entry is
   * `{total?, remaining?, used?, reset?}` — whatever the provider
   * publishes, nothing invented. null until the provider reports.
   * Unlike contextUsage it is LAST-KNOWN (never reset per request — a
   * quota snapshot stays meaningful between requests).
   * @returns {{label?: string, quotas: Object}|null} A defensive copy of the last complete report, or null before any report.
   * @effects None; read-only.
   */
  get planUsage() {
    return this._planUsage === null
      ? null
      : { ...this._planUsage, quotas: Object.fromEntries(
          Object.entries(this._planUsage.quotas).map(([k, v]) => [k, { ...v }]),
        ) };
  }

  /**
   * Report plan/quota usage (provider → IO channel; connectors call
   * this from their reportPlanUsage hook or metadata surfaces). Each
   * call is ONE COMPLETE SNAPSHOT of what one response publishes: the
   * last-known report is REPLACED, never merged — a quota a response
   * stops publishing is gone (merged leftovers would keep showing a
   * previous endpoint's plan after an endpoint switch — see
   * lib/agent/run.js, which hands the report straight to the agent).
   * Tolerant reader: only finite numbers and non-empty strings are
   * kept.
   * @param {{label?: string, quotas?: Object}} [report={}] Complete provider quota snapshot.
   * @returns {void} Read planUsage after assignment for the stored report.
   * @effects Replaces the prior snapshot, retaining only non-empty strings and finite numbers; absent/invalid fields are omitted.
   */
  set planUsage({ label, quotas } = {}) {
    const next = { quotas: {} };
    if (typeof label === "string" && label !== "") next.label = label;
    if (quotas !== null && typeof quotas === "object" && !Array.isArray(quotas)) {
      for (const [name, quota] of Object.entries(quotas)) {
        if (quota === null || typeof quota !== "object" || Array.isArray(quota)) continue;
        const kept = {};
        for (const [field, value] of Object.entries(quota)) {
          if (Number.isFinite(value)) kept[field] = value;
          else if (typeof value === "string" && value !== "") kept[field] = value;
        }
        next.quotas[name] = kept;
      }
    }
    this._planUsage = next;
  }

  /**
   * Run one provider request over a complete context.
   * @param {Array} context Complete context; metadata records and empty messages are filtered before validation/provider conversion.
   * @param {Object} [callbacks={}] CamelCase response callbacks for this request.
   * @param {Object} [options={}] Per-request overrides.
   * @param {string} [options.model] Qualified `<endpoint>/<model>` override on the same endpoint. Construct another IO to switch endpoints.
   * @param {number|string} [options.timeout] Overall request cap override.
   * @param {number|string} [options.connectTimeout] Connection timeout override.
   * @param {number|string} [options.stuckTimeout] Reading watchdog override.
   * @returns {Promise<object>} Resolves with the terminal done/error event. Rejects TypeError for split, invalid, or cross-endpoint model overrides without reserving the instance; rejects ProviderError for a closed/busy instance or malformed context.
   * @effects Reserves the instance synchronously, may refresh OAuth, starts one request, and returns the instance to idle after request finalization unless closed.
   */
  write(context, callbacks = {}, options = {}) {
    if (Object.hasOwn(options, "endpoint")) return Promise.reject(new TypeError("IO.write: use model: <endpoint>/<model>, not endpoint"));
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
    // only. The agent's own array is untouched.
    const outgoing = Array.isArray(context) && context.some((m) => messageIsRecord(m) || !messageHasContent(m))
      ? context.filter((m) => !messageIsRecord(m) && messageHasContent(m))
      : context; // non-arrays fall through to messagesValidate's malformed error
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
      if (options.model !== undefined) {
        const link = this.env.connection(options.model, { remember: false });
        if (link.endpoint !== this._link.endpoint) throw new TypeError("IO.write: model must belong to this IO endpoint; construct another IO to switch endpoints");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    // Reserve synchronously, before optional OAuth refresh yields.  The
    // public write() contract rejects a second call immediately; waiting
    // for _run() to set this state left an acquisition race.
    this._state = "sending";
    this._controller = new AbortController();
    this._active = this._refreshOAuthIfNeeded().then(
      () => this._run(outgoing, callbacks, options),
      () => this._run(outgoing, callbacks, options), // a request can still surface a useful auth error
    ).finally(() => {
      this._active = null;
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
   * (Env's own file-over-memory rule); this instance adopts that record
   * as its per-invocation override and follows a changed endpoint URL.
   * @returns {boolean} Whether the effective auth record changed; false if reload fails or records compare equal.
   * @effects Reloads persisted endpoint auth, may update this instance's auth override and URL; suppresses reload errors so they do not mask provider verdicts.
   */
  _refreshEndpointAuth() {
    const before = this.settings;
    const authBefore = before.auth === null || typeof before.auth !== "object" || Array.isArray(before.auth)
      ? undefined
      : before.auth;
    let reloaded;
    try {
      reloaded = this._link.authReload(authBefore);
    } catch {
      return false; // a refresh failure must never mask the provider's verdict
    }
    // Absorb the current effective record: an explicit settings override
    // of `auth`/`url` must not freeze the very credential rotation this
    // retry exists to pick up.
    if (reloaded.auth !== undefined) this._settingsOverride.auth = reloaded.auth;
    if (typeof reloaded.url === "string" && reloaded.url !== this.url) this.url = reloaded.url;
    const next = this.settings;
    const authNext = next.auth === null || typeof next.auth !== "object" || Array.isArray(next.auth)
      ? undefined
      : next.auth;
    return JSON.stringify(authBefore) !== JSON.stringify(authNext);
  }

  /**
   * Cancel the active request (terminal partial emitted by the in-flight
   * write), close the connection, permanently disconnect the instance.
   * @returns {Promise<void>} Resolves after request finalization and connection teardown; repeated calls after closure resolve immediately.
   * @effects Aborts any active request, awaits it, attempts connection closure (teardown errors are suppressed), and permanently marks this instance closed.
   */
  async close() {
    if (this._state === "closed") return;
    this._killed = true;
    if (this._controller) {
      const err = new Error("killed");
      err.name = "AbortError";
      this._controller.abort(err);
    }
    if (this._active) {
      await this._active.catch(() => {});
    }
    if (this._connection) {
      try {
        await this._connection.close();
      } catch { /* teardown errors are not surfaced */ }
      this._connection = null;
    }
    this._state = "closed";
  }
}

Object.assign(IO, {
  Env, Context,
  timeoutsResolve: resolveTimeout,
  ProviderError, THINKING_LEVELS,
});
export default IO;
