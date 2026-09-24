/**
 * lib/io.js — IO: provider IO/schema conversion, nothing else.
 *
 * This module depends on lib/context.js and lib/env.js. It re-exports
 * the provider contract and HTTP defaults for IO consumers and provider
 * authors.
 *
 * An IO instance carries NO context — every write() is a blank-slate
 * context-to-provider-request conversion. It holds connection state for
 * the active request (a provider connection is created and closed for each
 * request) and exposes:
 *
 *   settings   — provider-namespaced LIVE settings view (via Env)
 *   tools()    — current tool catalog, per-instance availability
 *                selection applied (between-request refresh visible)
 *   authSet(a) — routes to Env.authSet(endpoint name, a)
 *   write(context, callbacks?, options?) — one request, resolves with
 *                the terminal done/error event
 *   kill()     — cancel active request, emit terminal partial, close,
 *                permanently disconnect
 *
 * State machine per instance: idle → sending → reading → idle,
 * repeating. Sending while not idle is a contract error (no concurrent
 * in-flight requests). After kill() the instance is "closed" forever;
 * the caller constructs a replacement.
 *
 * IO owns the GLOBAL ACTIVE-IO ledger (Env.activeIO): an instance
 * adds ITSELF for exactly a request's in-flight duration and removes
 * itself the moment the IO settles — a tool call requested, a turn
 * ended, a timeout (lib/io/request.js). The ledger's size is the
 * settings.maxActive measure (maxActive caps concurrent IO, never
 * agents: tool calls are client work and hold no slot). IO knows
 * nothing about agents — the set carries instances, never identities.
 *
 * IO sanitizes outgoing requests (headers/body from the connector)
 * and validates converted responses (valid response events; message
 * metadata rides along — tolerant reader). An `auth`-classified failure
 * before any response data triggers the MULTI-PROCESS refresh (another
 * process may have rotated the endpoint's credentials): Env re-reads
 * the endpoint's persisted settings/auth record and the request retries
 * ONCE with the updated token (lib/io/request.js). Metadata RECORDS (context
 * entries with a string `type` — harness/tool-owned data, isRecord)
 * and empty messages are filtered OUT of every provider-bound context:
 * they persist in the session and ride the agent's array, but the model
 * never sees them. Errors surface in the auth/network/provider/malformed
 * taxonomy (+ "cancelled" on kill).
 *
 * Per-request timeouts (each: write options > constructor > provider-
 * namespaced settings > provider metadata > default; all accept a
 * millisecond numeral or a unit string via lib/env/duration.js):
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
const {
  ProviderError, classifyError, defineProvider, tryDuration, mergeAuthUpdate,
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody,
  defaultRead, defaultClose,
} = Env;
const { isRecord, hasContent, validateContext } = Context;
import { connectBudget, resolveTimeout, runRequest } from "./io/request.js";
import { sanitizeRequest, bodyBytes } from "./io/sanitize.js";
const { parseModelSelector } = Env;

export { sanitizeRequest, bodyBytes } from "./io/sanitize.js";
export { connectBudget, resolveTimeout } from "./io/request.js";
// IO exposes the provider environment and Context helpers used to build
// and validate provider-bound requests.
/** The global environment constructor used by IO and provider authors. */
export { default as Env } from "./env.js";
/** The Context namespace for validating every provider-bound request. */
export { default as Context } from "./context.js";
export {
  ProviderError, classifyError, defineProvider,
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody,
  defaultRead, defaultClose,
} from "./env.js";

const DEFAULT_TIMEOUT = 1_048_575;
const DEFAULT_CONNECT_TIMEOUT = 30_000;
const DEFAULT_STUCK_TIMEOUT = 120_000;

/** One provider IO session: context in, normalized response events out. */
export class IO {
  /**
   * Configure one provider IO session: resolve the provider module from
   * the registered endpoint and resolve the model, endpoint URL, and
   * three timeouts from options > provider
   * settings > provider metadata > defaults.
   * @param {Object} options
   * @param {object} options.env - the Env (sole registry surface)
   * @param {string} options.model - registered `<endpoint>/<model>` selector.
   * @param {string} [options.url]
   * @param {number|string} [options.timeout] - overall cap per request
   * @param {number|string} [options.connectTimeout] - base connection timeout
   * @param {number|string} [options.stuckTimeout] - stuck-model watchdog
   * @param {object} [options.settings] - explicit settings, merged OVER
   *   the live provider namespace (per-invocation overrides, never
   *   persisted — CLI flags land here)
   * @param {string[]} [options.tools] - per-instance tool availability
   *   selection (omitted/["*"] = all, [] = none, explicit = subset)
   * @param {(event:object)=>void} [options.onData] - binding stdout default
   * @param {(line:string)=>void} [options.onLog] - binding stderr default
   */
  constructor({ env, model, url, timeout, connectTimeout, stuckTimeout, settings, tools, onData, onLog } = {}) {
    if (!env) throw new TypeError("IO: env (Env) is required");
    this.env = env;
    const selected = parseModelSelector(env, model, "IO");
    const endpointName = selected.endpoint;
    const config = env.endpoint(endpointName);
    const Protocol = env.provider(config.provider);
    if (!Protocol) {
      throw new ProviderError(
        "provider",
        `IO: endpoint "${endpointName}" uses unknown provider protocol "${config.provider}"`,
      );
    }
    this.endpoint = endpointName;
    this.protocol = config.provider;
    this.Provider = Protocol;
    this.provider = Protocol.provider;

    this.name = endpointName;
    this.model = selected.model;
    this.url = url ?? config.url;
    this.timeout =
      tryDuration(timeout) ?? tryDuration(this.settings.timeout) ??
      tryDuration(this.provider.timeout) ?? DEFAULT_TIMEOUT;
    this.connectTimeout =
      tryDuration(connectTimeout) ?? tryDuration(this.settings.connectTimeout) ??
      tryDuration(this.provider.connectTimeout) ?? DEFAULT_CONNECT_TIMEOUT;
    this.stuckTimeout =
      tryDuration(stuckTimeout) ?? tryDuration(this.settings.stuckTimeout) ??
      tryDuration(this.provider.stuckTimeout) ?? DEFAULT_STUCK_TIMEOUT;
    this._onData = onData;
    this._onLog = onLog;
    this._toolSelection = tools;
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

  /** The request state machine's current state. @returns {"idle"|"sending"|"reading"|"closed"} */
  get state() {
    return this._state;
  }

  /** @returns {object} live provider-namespaced settings view (explicit
   *  overrides merged over the Env namespace) */
  get settings() {
    return { ...this.env.endpointSettings(this.endpoint), ...this._settingsOverride };
  }

  /**
   * Set/clear a per-invocation settings override AFTER construction
   * (e.g. Agent's /agent-thinking toggling `think` on a live connection).
   * @param {string} key
   * @param {*} value - undefined clears the override
   */
  setOption(key, value) {
    if (value === undefined) delete this._settingsOverride[key];
    else this._settingsOverride[key] = value;
  }

  /** @returns {Array} the current publishable tool catalog (availability applied) */
  tools() {
    return this.env.toolSchemas(this._toolSelection);
  }

  /**
   * Route auth persistence to the endpoint's namespace and refresh the
   * live settings view.
   * @param {object} auth
   * @param {{scope?: "local"|"package"}} [options] - persistence scope
   * @returns {object} the persisted endpoint section
   */
  authSet(auth, options) {
    return this.env.authSet(this.endpoint, auth, options);
  }

  /** @returns {AbortSignal|undefined} the in-flight request's abort signal (used by the HTTP backend) */
  get requestSignal() {
    return this._controller?.signal;
  }

  /** @returns {string|undefined} effective model: per-request override wins over the instance default */
  get currentModel() {
    return this._requestModel ?? this.model;
  }

  /**
   * The provider-reported context readout of the CURRENT/last request:
   * `{used, total}` in tokens, each undefined when the provider hasn't
   * reported it. Providers update it during a request via
   * setContextUsage() (e.g. from a usage frame or model metadata);
   * IO itself fills `used` from the terminal usage envelope when the
   * provider left it unset. Consumers (Agent) read it after write()
   * resolves; missing data is their cue to approximate.
   * @returns {{used: number|undefined, total: number|undefined}}
   */
  get contextUsage() {
    return { ...this._contextUsage };
  }

  /**
   * Report actual context consumption and/or the model's available
   * context window (provider → IO channel; connectors call this from
   * their translators/metadata surfaces). Finite numbers merge over the
   * current report; anything else is ignored.
   * @param {{used?: number, total?: number}} report
   * @returns {{used: number|undefined, total: number|undefined}}
   */
  setContextUsage({ used, total } = {}) {
    if (Number.isFinite(used) && used >= 0) this._contextUsage.used = Math.floor(used);
    if (Number.isFinite(total) && total > 0) this._contextUsage.total = Math.floor(total);
    return this.contextUsage;
  }

  /**
   * The provider-reported PLAN/QUOTA readout (rate limits, subscription
   * allowances): `{label?, quotas}` where each quota entry is
   * `{total?, remaining?, used?, reset?}` — whatever the provider
   * publishes, nothing invented. null until the provider reports.
   * Unlike contextUsage it is LAST-KNOWN (never reset per request — a
   * quota snapshot stays meaningful between requests).
   * @returns {{label?: string, quotas: Object}|null}
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
   * this from their reportPlanUsage hook or metadata surfaces). Tolerant
   * reader: only finite numbers and non-empty strings are kept, quota
   * entries merge key-by-key over the last-known report.
   * @param {{label?: string, quotas?: Object}} report
   * @returns {{label?: string, quotas: Object}|null}
   */
  setPlanUsage({ label, quotas } = {}) {
    const current = this._planUsage ?? { quotas: {} };
    if (typeof label === "string" && label !== "") current.label = label;
    if (quotas !== null && typeof quotas === "object" && !Array.isArray(quotas)) {
      for (const [name, quota] of Object.entries(quotas)) {
        if (quota === null || typeof quota !== "object" || Array.isArray(quota)) continue;
        const kept = { ...(current.quotas[name] ?? {}) };
        for (const [field, value] of Object.entries(quota)) {
          if (Number.isFinite(value)) kept[field] = value;
          else if (typeof value === "string" && value !== "") kept[field] = value;
        }
        current.quotas[name] = kept;
      }
    }
    this._planUsage = current;
    return this.planUsage;
  }

  /**
   * Run one provider request over a complete context.
   * @param {Array} context - complete context (validated, tolerant)
   * @param {Object} [callbacks] - camelCase response callbacks
   * @param {Object} [options]
   * @param {string} [options.model] - per-request model override
   * @param {number|string} [options.timeout] - per-request overall cap
   * @param {number|string} [options.connectTimeout] - per-request base connection timeout
   * @param {number|string} [options.stuckTimeout] - per-request stuck watchdog
   * @returns {Promise<object>} the terminal done/error event
   */
  write(context, callbacks = {}, options = {}) {
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
    // the context, isRecord) NEVER leave the harness, and neither do
    // EMPTY messages (hasContent — an append-merge may legitimately
    // leave one in the live array after its payload merged into the
    // previous message; no provider dialect can carry a contentless
    // message): the provider-bound context is consumable messages
    // only. The agent's own array is untouched.
    const outgoing = Array.isArray(context) && context.some((m) => isRecord(m) || !hasContent(m))
      ? context.filter((m) => !isRecord(m) && hasContent(m))
      : context; // non-arrays fall through to validateContext's malformed error
    try {
      validateContext(outgoing);
    } catch (err) {
      return Promise.reject(
        new ProviderError("malformed", `IO: invalid context — ${err.message}`),
      );
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

  async _run(context, callbacks, options) {
    return runRequest(this, context, callbacks, options); // lib/io/request.js
  }

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
   * holds its startup snapshot. Env re-reads the endpoint's persisted
   * settings/auth files and merges them over the live tree; this
   * instance then adopts the CURRENT effective auth record as its
   * per-invocation override — file-over-memory via Env.mergeAuthUpdate,
   * the same update rule authSet applies — and follows a changed
   * endpoint URL.
   * @returns {boolean} whether the effective auth record changed
   */
  _refreshEndpointAuth() {
    const env = this.env;
    if (typeof env.refreshEndpointSettings !== "function") return false; // a test/embedding facade
    const before = this.settings;
    const authBefore = before.auth === null || typeof before.auth !== "object" || Array.isArray(before.auth)
      ? undefined
      : before.auth;
    let section;
    try {
      section = env.refreshEndpointSettings(this.endpoint);
    } catch {
      return false; // a refresh failure must never mask the provider's verdict
    }
    // Absorb the current effective record: an explicit settings override
    // of `auth`/`url` must not freeze the very credential rotation this
    // retry exists to pick up.
    if (section?.auth !== undefined) {
      this._settingsOverride.auth = mergeAuthUpdate(
        authBefore ?? {},
        section.auth === null || typeof section.auth !== "object" || Array.isArray(section.auth) ? {} : section.auth,
      );
    }
    // The refreshed section carries the endpoint's own connection fields
    // (authSet round-trips url/provider into the auth file): a rotated
    // URL is adopted even when a stale configured providers entry would
    // otherwise win the effective view.
    if (typeof section?.url === "string" && section.url !== this.url) this.url = section.url;
    const next = this.settings;
    const authNext = next.auth === null || typeof next.auth !== "object" || Array.isArray(next.auth)
      ? undefined
      : next.auth;
    return JSON.stringify(authBefore) !== JSON.stringify(authNext);
  }

  /**
   * Cancel the active request (terminal partial emitted by the in-flight
   * write), close the connection, permanently disconnect the instance.
   * Resolves when finalization completes. Idempotent.
   */
  async kill() {
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
  sanitizeRequest, bodyBytes, connectBudget, resolveTimeout,
  ProviderError, classifyError, defineProvider,
  HttpStatusError, defaultConnect, defaultSend, defaultSendHeaders, defaultSendBody,
  defaultRead, defaultClose,
});
export default IO;
