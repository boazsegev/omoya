/**
 * lib/io/request.js — one provider request (private to IO): the
 * three-timeout model (an overall cap, a connection timeout whose
 * budget scales with the body size, and a stuck-model watchdog
 * re-armed around every read), the connector event pump (validated,
 * assembled, usage-finalized), and the terminal synthesis (done on a
 * bare stream end, cancelled partial on kill, classified error
 * otherwise). An `auth`-classified failure before any response data
 * triggers the multi-process refresh (the Env connection's authReload
 * via IO._refreshEndpointAuth) and ONE re-send with the updated
 * credentials — several processes share the settings folder, and a
 * token rotated elsewhere must not strand this one.
 */

import Context from "../context.js";
import { durationTry } from "../util.js";
import { ProviderError, classifyError, depletionError } from "./provider-error.js";
import { retryAfterMs } from "./retry-after.js";
const { ContentType, callbacksNormalize, eventDispatch, eventValidate, assemblerCreate, usageFinalize } = Context;
import { sanitizeRequest, bodyBytes } from "./sanitize.js";

/**
 * The connection-timeout budget for one request: the base timeout plus
 * one millisecond per request-body byte (before compression) — larger
 * prompts get proportionally more time to produce a first response.
 * @param {number} baseMs - the configured connectTimeout
 * @param {number} bytes - the request body's byte size (bodyBytes); falsy values contribute zero
 * @returns {number} milliseconds
 */
export function connectBudget(baseMs, bytes) {
  return baseMs + Math.max(0, Math.floor(bytes || 0));
}

const DEFAULT_TIMEOUT = 1_048_575;

/**
 * The effective overall request timeout without constructing a connection:
 * explicit > endpoint settings > provider metadata > default. Accepts ms
 * numerals or unit strings. Throws on an unknown endpoint, like IO itself.
 * @param {Object} [options={}] - timeout resolution inputs
 * @param {object} options.env - the Env (sole registry surface); required
 * @param {string} options.model - registered `<endpoint>/<model>` selector
 * @param {number|string} [options.timeout] - explicit override; omitted means use settings/provider/default precedence
 * @param {object} [options.settings] - per-invocation overrides over the namespace; omitted means use endpoint settings unchanged
 * @returns {number} milliseconds
 * @throws {TypeError|ProviderError|Error} if env is missing or the Env cannot resolve the model
 */
export function resolveTimeout({ env, model, timeout, settings } = {}) {
  if (!env) throw new TypeError("IO.resolveTimeout: env (Env) is required");
  let link;
  try {
    link = env.connection(model, { remember: false });
  } catch (error) {
    throw error?.kind ? new ProviderError(error.kind, error.message) : error;
  }
  const override = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const namespaced = { ...link.settings, ...override };
  return durationTry(timeout) ?? durationTry(namespaced.timeout) ?? durationTry(link.Protocol.provider?.timeout) ?? DEFAULT_TIMEOUT;
}

/**
 * Synthesize a successful terminal event for a stream that ended without one.
 * @param {object} context - request context used to finalize usage
 * @param {object} assembler - assembled response; its `message()` supplies the message
 * @param {object|null} usage - provider usage to finalize, or null to estimate
 * @returns {object} a `done` event containing the assembled message and finalized usage
 * @effects Calls the assembler and usage finalizer; does not dispatch the event.
 */
export function terminalDone(context, assembler, usage) {
  return {
    type: "done",
    message: assembler.message(),
    usage: usageFinalize(usage, context, assembler.message()),
  };
}

/**
 * Report TOKEN DEPLETION to the Env usage ledger when
 * the PROVIDER says this failure means its budget is spent — the
 * connection's own depletionError hook (lib/io/provider-error.js: exact
 * signals only — a 429/402 status or an error body/code that names a
 * rate/quota/billing budget; a 404, a 401 credential verdict, a
 * transient 5xx never mark). A connector-emitted error terminal
 * carries no connection reference, so the shared predicate answers
 * for it. The spawnable-endpoint listing and the spawn policy read
 * the ledger from then on; a later success clears the mark
 * (lib/agent/run.js). IO only ever REPORTS here — policy lives in
 * Env, dialect lives in the provider, never in the request runner.
 * @param {object} aiio - IO instance; its current connection may supply the provider-specific predicate
 * @param {object} classified - classified failure passed to that predicate or the shared fallback
 * @returns {void}
 * @effects Calls the connection's `depletionError` hook when available, otherwise `depletionError`; does not mutate the ledger itself.
 */
function reportDepletion(aiio, classified) {
  const depleted = typeof aiio._connection?.depletionError === "function"
    ? aiio._connection.depletionError(classified)
    : depletionError(classified); // a connector-emitted error terminal
}

/**
 * Determine whether an assembled message contains visible text or a named tool call.
 * @param {object|null|undefined} message - candidate message; absent content is treated as empty
 * @returns {boolean} true only when a text block has non-whitespace text or a tool-call block has a name
 */
function answered(message) {
  return (message?.content ?? []).some((/** @param {object} block - message content block to inspect @returns {boolean|string|undefined} whether the block is an answer-bearing tool call or text */ block) =>
    (block?.type === ContentType.ToolCall && block.name) ||
    (block?.type === ContentType.Text && block.text?.trim()));
}

/**
 * Convert a successful terminal event with no answer into a provider error event.
 * @param {object} done - original `done` event; an optional `doneReason` is included in the explanation
 * @returns {object} a shallow copy with `type: "error"`, `kind: "provider"`, and an empty-response error
 * @effects Does not mutate the supplied event.
 */
function unanswered(done) {
  const reason = done.doneReason ? ` (${done.doneReason})` : "";
  return { ...done, type: "error", kind: "provider", error: `the provider returned an empty response${reason}` };
}

/**
 * Build the cancellation terminal emitted when close interrupts a request.
 * @param {object} context - request context used to finalize usage
 * @param {object} assembler - response assembler whose partial message may be attached
 * @returns {object} a cancelled error event, with a partial message only when content exists
 * @effects Calls the assembler and usage finalizer; does not dispatch the event.
 */
export function terminalCancelled(context, assembler) {
  const partial = assembler.message();
  const hasData = Array.isArray(partial.content) && partial.content.length > 0;
  return {
    type: "error",
    error: "cancelled",
    kind: "cancelled",
    cancelled: true,
    ...(hasData ? { message: partial } : {}),
    usage: usageFinalize(null, context, partial),
  };
}

/**
 * Run one provider request over a complete context (the body of
 * IO.write, minus its state-machine guards). Resolves with the
 * terminal done/error event.
 * @param {object} aiio - the IO instance
 * @param {Array} context - complete context
 * @param {Object} callbacks - camelCase response callbacks normalized by Context
 * @param {Object} options - required per-request overrides object; `timeout`, `connectTimeout`, and `stuckTimeout` accept duration values and fall back to IO timeouts when absent/invalid, while `model` selects the model and falls back to the IO model
 * @returns {Promise<object>} resolves with the terminal done/error event; the request runner handles operational failures as terminal events
 * @throws {Error} for failures from request setup, callbacks, or cleanup outside the classified provider-error paths
 * @effects Sends and reads through a provider connection, dispatches response events, updates IO request/usage/state fields, manages timers and cancellation, may refresh auth and retry once, and closes the connection. Provider/connector errors are classified and emitted; teardown errors are suppressed.
 */
export async function runRequest(aiio, context, callbacks, options) {
  const assembler = assemblerCreate();
  let terminal = null;
  const set = callbacksNormalize(callbacks, {
    onData: aiio._onData,
    onLog: aiio._onLog,
    /** Capture the terminal event for runRequest's result.
     * @param {object} event - terminal event dispatched by Context
     * @returns {void}
     * @effects Stores the event in the enclosing request's terminal variable.
     */
    onTerminal: (event) => {
      terminal = event;
    },
  });
  /** Validate, assemble, account for, and dispatch one connector event.
   * @param {object} raw - connector event to process
   * @returns {object} validated and assembled event
   * @throws {ProviderError} when the event fails validation; callback errors also propagate
   * @effects Updates assembler, terminal/context usage state, depletion reporting, and invokes callbacks.
   */
  const emit = (raw) => {
    const event = raw.type === "done" && !answered(raw.message ?? assembler.message()) ? unanswered(raw) : raw;
    try {
      eventValidate(event); // response validator
    } catch (cause) {
      throw new ProviderError("malformed", `IO: invalid connector event — ${cause.message}`);
    }
    assembler.consume(event);
    if (Number.isInteger(event.contentIndex)) {
      event.content = assembler.message().content[event.contentIndex];
    }
    if (event.type === "done" || event.type === "error") {
      // terminal events carry the assembled message; usage accounting:
      // provider-reported wins, estimate fills gaps (already-tagged
      // usage is final — synthesized terminals pre-tag theirs)
      if (event.message === undefined) {
        const assembled = assembler.message();
        if (assembled.content.length > 0) event.message = assembled;
      }
      // A FAILED response is its message carrying the error (Context
      // hasError) — whatever arrived first, possibly nothing. A cancel is
      // the user's own stop, not a failure: its partial stays plain.
      if (event.type === "error" && event.cancelled !== true) {
        const message = String(event.error ?? "request failed");
        const retry = event.retryAfterMs;
        event.message = { ...(event.message ?? assembler.message()),
          error: Number.isFinite(retry) && retry > 0 ? { message, retry } : message };
      }
      if (event.usage?.source === undefined) {
        event.usage = usageFinalize(event.usage, context, assembler.message());
      }
      // the context readout's `used` defaults to the request's actual
      // input count — only a PROVIDER-reported count qualifies (an
      // estimated envelope must not masquerade as an exact readout)
      if (aiio._contextUsage.used === undefined &&
          event.usage?.source === "provider" && Number.isFinite(event.usage?.inputTokens)) {
        aiio._contextUsage.used = event.usage.inputTokens;
      }
    }
    if (event.type === "error") reportDepletion(aiio, event); // a connector-emitted error terminal
    eventDispatch(set, event);
    return event;
  };

  const overallMs = durationTry(options.timeout) ?? aiio.timeout;
  const connectMs = durationTry(options.connectTimeout) ?? aiio.connectTimeout;
  const stuckMs = durationTry(options.stuckTimeout) ?? aiio.stuckTimeout;
  const model = options.model ?? aiio.model;
  // write() creates this controller synchronously when it reserves the
  // instance, so close() also works during asynchronous OAuth acquisition.
  const controller = aiio._controller ?? new AbortController();
  aiio._controller = controller;
  /** Abort the request with a timeout-style error.
   * @param {string} message - timeout explanation stored in the abort reason
   * @returns {void}
   * @effects Aborts the request controller.
   */
  const abortWith = (message) => {
    const err = new Error(message);
    err.name = "TimeoutError";
    controller.abort(err);
  };
  // The three-timeout model (see the module doc): an overall cap, a
  // connection timeout (armed once the request body is known — its
  // budget scales with the body size — and cleared once the response
  // starts), and a stuck-model watchdog re-armed around every read.
  const overallTimer = setTimeout(
    /** Abort when the overall request deadline expires. @returns {void} @effects Aborts the controller. */
    () => abortWith(`request timeout after ${overallMs}ms (overall cap)`),
    overallMs,
  );
  // These are pure watchdogs: a settled request clears them, and an
  // abandoned one (the run resolved, the process is exiting) must never
  // keep the event loop alive on their account.
  overallTimer.unref?.();
  let connectTimer = null;

  aiio._requestModel = model;
  aiio._contextUsage = { used: undefined, total: undefined }; // fresh report per request
  try {
    // close() can abort during asynchronous OAuth acquisition, before this
    // request runner begins. AbortSignal listeners do not replay, so stop
    // before a connector can start a read that would otherwise wait forever.
    if (controller.signal.aborted) throw controller.signal.reason;
    emit({ type: "start" });

    aiio._state = "sending";
    let connection = new aiio.Provider(aiio.url, aiio);
    aiio._connection = connection;

    // one catalog snapshot per request (Env rechecks dynamic availability)
    aiio._toolCatalog = await aiio.env.tools?.(aiio._safe, model) ?? new Map();
    if (controller.signal.aborted) throw controller.signal.reason;
    /**
     * Convert and sanitize the request, then send it under the connection watchdog.
     * @returns {Promise<void>} resolves after the provider send completes
     * @throws {Error} propagates provider send failures or abort reasons
     * @effects Arms and clears the connection timeout and sends through the current connection.
     */
    const send = async () => {
      const msg = connection.context2msg(context, aiio);
      const [headers, body] = sanitizeRequest(msg); // request sanitizer
      const budget = connectBudget(connectMs, bodyBytes(body));
      connectTimer = setTimeout(
        /** Abort when the connection deadline expires. @returns {void} @effects Aborts the controller. */
        () => abortWith(`connection timeout after ${budget}ms (no response from ${aiio.name}; ${connectMs}ms + 1ms per body byte)`),
        budget,
      );
      connectTimer.unref?.();
      try {
        await connection.send([headers, body]);
      } finally {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    /**
     * Read provider frames until stream end, terminal event, or abort.
     * @returns {Promise<void>} resolves when reading ends or a terminal event is received
     * @throws {Error} propagates provider read/translation/validation failures and abort reasons
     * @effects Changes IO state, arms and clears the stuck watchdog per read, and emits translated events.
     */
    const read = async () => {
      aiio._state = "reading";
      const tstate = {}; // per-request translator state
      for (;;) {
        // Stuck-model watchdog: every frame (any block or delta) resets
        // it — only a model producing NOTHING trips it.
        const stuckTimer = setTimeout(
          /** Abort when the model produces no frame before the watchdog deadline. @returns {void} @effects Aborts the controller. */
          () => abortWith(`model stuck: no data for ${stuckMs}ms`),
          stuckMs,
        );
        stuckTimer.unref?.();
        let native;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          native = await connection.read();
        } finally {
          clearTimeout(stuckTimer);
        }
        if (native == null) break;
        const events = connection.msg2events(native, tstate, aiio);
        const list = Array.isArray(events) ? events : [events];
        for (const event of list) {
          if (event == null || event === false) continue;
          emit(event);
          if (terminal) break;
        }
        if (terminal) break;
      }
    };

    // One provider attempt: send, report plan usage, read to a terminal
    // (or stream end). A THROWN error classifies in-band (the
    // connection's own classifier wins, the shared taxonomy is the
    // fallback) and returns as a terminal-shaped verdict so the auth
    // refresh below can answer it; a kill re-throws to the outer catch.
    /**
     * Run one send-and-read attempt and convert ordinary thrown failures to error verdicts.
     * @returns {Promise<object|null>} terminal error verdict, or null after a non-error terminal/stream end
     * @throws {Error} re-throws errors when the request was killed
     * @effects Sends and reads from the connection, reports plan usage best-effort, and classifies failures.
     */
    const attempt = async () => {
      try {
        await send();
        if (controller.signal.aborted) throw controller.signal.reason;

        // plan/quota reporting hook: the response (headers included) is
        // on the connection — the protocol parses its rate-limit/quota
        // dialect into aiio.planUsage (default: OpenAI x-ratelimit-*;
        // reporting failures never break a request). Some dialects (the
        // Codex backend's separate usage endpoint) report via their own
        // network call instead and return a promise — never awaited here
        // (must not add latency to the turn), and any late rejection is
        // swallowed rather than surfacing as an unhandled rejection.
        if (connection.response?.headers && typeof connection.reportPlanUsage === "function") {
          try {
            connection.reportPlanUsage(connection.response.headers, aiio)?.catch?.(/** Swallow an asynchronous best-effort reporting failure. @param {Error} _error - rejected plan-reporting error @returns {void} */ () => {});
          } catch { /* plan reporting is best-effort */ }
        }

        await read();
        return terminal?.type === "error" ? terminal : null;
      } catch (err) {
        if (aiio._killed) throw err; // kill owns its terminal
        const classified = connection?.classifyError?.(err) ?? classifyError(err, aiio.name);
        return { type: "error", error: classified.message, kind: classified.kind, status: classified.status,
          retryAfterMs: retryAfterMs(err) ?? retryAfterMs(classified), cause: err };
      }
    };

    let authRetry = true; // one refresh-and-resend per request (see below)
    for (;;) {
      const failed = await attempt();

      // MULTI-PROCESS AUTH REFRESH: several processes share the settings
      // folder; another one may have rotated this endpoint's credentials
      // since this process loaded them. An `auth` failure BEFORE ANY
      // response data was emitted re-reads the endpoint's persisted
      // settings/auth record (the Env connection's authReload) and re-sends
      // ONCE with the updated credentials — the failure must not strand
      // this process until restart. Response data already emitted (or a
      // kill) makes the request final: the events are live on the wire.
      const emittedData = assembler.message().content.length > 0;
      if (
        !authRetry || failed?.kind !== "auth" || aiio._killed ||
        controller.signal.aborted || emittedData || !aiio._refreshEndpointAuth()
      ) {
        if (failed && terminal?.type !== "error") {
          // a thrown failure the connector never emitted: surface it
          // through the same terminal synthesis as any connector error
          reportDepletion(aiio, failed.cause ?? failed);
          emit({ type: "error", error: failed.error, kind: failed.kind, status: failed.status, retryAfterMs: failed.retryAfterMs });
        }
        break;
      }
      authRetry = false;
      terminal = null; // the swallowed error never leaves IO
      aiio._contextUsage = { used: undefined, total: undefined }; // the retry's report is fresh
      const closed = connection;
      try {
        await closed.close();
      } catch { /* teardown errors are not surfaced */ }
      aiio._state = "sending";
      connection = new aiio.Provider(aiio.url, aiio); // rebuilt over the refreshed settings view
      aiio._connection = connection;
      emit({ type: "start" }); // one fresh attempt boundary (a retry after refresh)
    }

    // Stream ended without a connector terminal event: synthesize done.
    if (!terminal) {
      emit(terminalDone(context, assembler, null));
    }
    return terminal;
  } catch (err) {
    if (aiio._killed) {
      // close(): terminal partial assistant response when data exists
      emit(terminalCancelled(context, assembler));
    } else {
      // the CONNECTION's own classification wins (a provider may refine
      // one status code's kind from its error body — see
      // lib/io/provider.js and providers/kimi.js);
      // the shared taxonomy is the fallback when there's no connection
      // yet (a failure constructing it, before _connection is set)
      const classified = aiio._connection?.classifyError?.(err) ?? classifyError(err, aiio.name);
      reportDepletion(aiio, classified);
      emit({
        type: "error",
        error: classified.message,
        kind: classified.kind,
        status: classified.status,
        retryAfterMs: retryAfterMs(err),
        message: assembler.message(),
        usage: usageFinalize(null, context, assembler.message()),
      });
    }
    return terminal;
  } finally {
    clearTimeout(overallTimer);
    if (connectTimer) clearTimeout(connectTimer);
    aiio._requestModel = null;
    const wasKilled = aiio._killed;
    if (aiio._connection) {
      try {
        await aiio._connection.close();
      } catch { /* teardown errors are not surfaced */ }
      aiio._connection = null;
    }
    aiio._controller = null;
    aiio._state = wasKilled ? "closed" : "idle";
  }
}
