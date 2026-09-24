/**
 * lib/io/request.js — one provider request (private to IO): the
 * three-timeout model (an overall cap, a connection timeout whose
 * budget scales with the body size, and a stuck-model watchdog
 * re-armed around every read), the connector event pump (validated,
 * assembled, usage-finalized), and the terminal synthesis (done on a
 * bare stream end, cancelled partial on kill, classified error
 * otherwise). An `auth`-classified failure before any response data
 * triggers the multi-process refresh (Env.refreshEndpointSettings via
 * IO._refreshEndpointAuth) and ONE re-send with the updated
 * credentials — several processes share the settings folder, and a
 * token rotated elsewhere must not strand this one. Plus the GLOBAL
 * ACTIVE-IO ledger: IO alone owns the
 * maxActive accounting — an instance occupies its Env.activeIO
 * slot for exactly the request's in-flight duration (added here,
 * removed in the finally), so a settled request — a tool call
 * requested, a turn ended, a timeout — frees the slot for the next
 * IO, whatever the owning agent goes on to do.
 */

import Env from "../env.js";
import Context from "../context.js";
const { classifyError, ProviderError, tryDuration, parseModelSelector, ENV_EVENT } = Env;
const { normalizeCallbacks, dispatch, validateResponseEvent, createAssembler, finalizeUsage } = Context;
import { sanitizeRequest, bodyBytes } from "./sanitize.js";

/**
 * The connection-timeout budget for one request: the base timeout plus
 * one millisecond per request-body byte (before compression) — larger
 * prompts get proportionally more time to produce a first response.
 * @param {number} baseMs - the configured connectTimeout
 * @param {number} bytes - the request body's byte size (bodyBytes)
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
 * @param {Object} options
 * @param {object} options.env - the Env (sole registry surface)
 * @param {string} options.model - registered `<endpoint>/<model>` selector
 * @param {number|string} [options.timeout] - explicit override
 * @param {object} [options.settings] - per-invocation overrides over the namespace
 * @returns {number} milliseconds
 */
export function resolveTimeout({ env, model, timeout, settings } = {}) {
  if (!env) throw new TypeError("IO.resolveTimeout: env (Env) is required");
  const { endpoint } = parseModelSelector(env, model, "IO");
  const config = env.endpoint(endpoint);
  const Protocol = env.provider(config.provider);
  if (!Protocol) throw new ProviderError("provider", `IO: endpoint "${endpoint}" uses unknown provider protocol "${config.provider}"`);
  const override = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const namespaced = { ...env.endpointSettings(endpoint), ...override };
  return tryDuration(timeout) ?? tryDuration(namespaced.timeout) ?? tryDuration(Protocol.provider?.timeout) ?? DEFAULT_TIMEOUT;
}

/** Synthesize the terminal done of a stream that ended without one. */
export function terminalDone(context, assembler, usage) {
  return {
    type: "done",
    message: assembler.message(),
    usage: finalizeUsage(usage, context, assembler.message()),
  };
}

/**
 * Report TOKEN DEPLETION to the Env usage ledger when
 * the PROVIDER says this failure means its budget is spent — the
 * connection's own depletionError hook (lib/env/provider.js: exact
 * signals only — a 429/402 status or an error body/code that names a
 * rate/quota/billing budget; a 404, a 401 credential verdict, a
 * transient 5xx never mark). A connector-emitted error terminal
 * carries no connection reference, so the shared predicate answers
 * for it. The spawnable-endpoint listing and the spawn policy read
 * the ledger from then on; a later success clears the mark
 * (lib/agent/run.js). IO only ever REPORTS here — policy lives in
 * Env, dialect lives in the provider, never in the request runner.
 */
function reportDepletion(aiio, classified) {
  const depleted = typeof aiio._connection?.depletionError === "function"
    ? aiio._connection.depletionError(classified)
    : Env.depletionError(classified); // a connector-emitted error terminal
}

/** The kill() terminal: a partial assistant response when data exists. */
export function terminalCancelled(context, assembler) {
  const partial = assembler.message();
  const hasData = Array.isArray(partial.content) && partial.content.length > 0;
  return {
    type: "error",
    error: "cancelled",
    kind: "cancelled",
    cancelled: true,
    ...(hasData ? { message: partial } : {}),
    usage: finalizeUsage(null, context, partial),
  };
}

/**
 * Run one provider request over a complete context (the body of
 * IO.write, minus its state-machine guards). Resolves with the
 * terminal done/error event.
 * @param {object} aiio - the IO instance
 * @param {Array} context - complete context
 * @param {Object} callbacks - camelCase response callbacks
 * @param {Object} options - per-request model/timeout overrides
 * @returns {Promise<object>} the terminal done/error event
 */
export async function runRequest(aiio, context, callbacks, options) {
  const assembler = createAssembler();
  let terminal = null;
  const set = normalizeCallbacks(callbacks, {
    onData: aiio._onData,
    onLog: aiio._onLog,
    onTerminal: (event) => {
      terminal = event;
    },
  });
  const emit = (event) => {
    try {
      validateResponseEvent(event); // response validator
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
      if (event.usage?.source === undefined) {
        event.usage = finalizeUsage(event.usage, context, assembler.message());
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
    dispatch(set, event);
    return event;
  };

  const overallMs = tryDuration(options.timeout) ?? aiio.timeout;
  const connectMs = tryDuration(options.connectTimeout) ?? aiio.connectTimeout;
  const stuckMs = tryDuration(options.stuckTimeout) ?? aiio.stuckTimeout;
  const model = options.model ?? aiio.model;
  // write() creates this controller synchronously when it reserves the
  // instance, so kill() also works during asynchronous OAuth acquisition.
  const controller = aiio._controller ?? new AbortController();
  aiio._controller = controller;
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
  // the GLOBAL ACTIVE-IO ledger (Env.activeIO): the slot is held
  // for exactly the in-flight request — tool calls run on the client
  // and hold no slot, so the ledger's size is the true concurrent-IO measure
  aiio.env?.activeIO?.add(aiio);
  aiio.env?._emitEvent?.(ENV_EVENT.IO_START, { io: aiio });
  try {
    // kill() can abort during asynchronous OAuth acquisition, before this
    // request runner begins. AbortSignal listeners do not replay, so stop
    // before a connector can start a read that would otherwise wait forever.
    if (controller.signal.aborted) throw controller.signal.reason;
    emit({ type: "start" });

    aiio._state = "sending";
    let connection = new aiio.Provider(aiio.url, aiio);
    aiio._connection = connection;

    await aiio.env.refreshToolAvailability?.();
    if (controller.signal.aborted) throw controller.signal.reason;
    const send = async () => {
      const msg = connection.context2msg(context, aiio);
      const [headers, body] = sanitizeRequest(msg); // request sanitizer
      const budget = connectBudget(connectMs, bodyBytes(body));
      connectTimer = setTimeout(
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
    const read = async () => {
      aiio._state = "reading";
      const tstate = {}; // per-request translator state
      for (;;) {
        // Stuck-model watchdog: every frame (any block or delta) resets
        // it — only a model producing NOTHING trips it.
        const stuckTimer = setTimeout(
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
    const attempt = async () => {
      try {
        await send();
        if (controller.signal.aborted) throw controller.signal.reason;

        // plan/quota reporting hook: the response (headers included) is
        // on the connection — the protocol parses its rate-limit/quota
        // dialect into aiio.setPlanUsage (default: OpenAI x-ratelimit-*;
        // reporting failures never break a request). Some dialects (the
        // Codex backend's separate usage endpoint) report via their own
        // network call instead and return a promise — never awaited here
        // (must not add latency to the turn), and any late rejection is
        // swallowed rather than surfacing as an unhandled rejection.
        if (connection.response?.headers && typeof connection.reportPlanUsage === "function") {
          try {
            connection.reportPlanUsage(connection.response.headers, aiio)?.catch?.(() => {});
          } catch { /* plan reporting is best-effort */ }
        }

        await read();
        return terminal?.type === "error" ? terminal : null;
      } catch (err) {
        if (aiio._killed) throw err; // kill owns its terminal
        const classified = connection?.classifyError?.(err) ?? classifyError(err, aiio.name);
        return { type: "error", error: classified.message, kind: classified.kind, cause: err };
      }
    };

    let authRetry = true; // one refresh-and-resend per request (see below)
    for (;;) {
      const failed = await attempt();

      // MULTI-PROCESS AUTH REFRESH: several processes share the settings
      // folder; another one may have rotated this endpoint's credentials
      // since this process loaded them. An `auth` failure BEFORE ANY
      // response data was emitted re-reads the endpoint's persisted
      // settings/auth record (Env.refreshEndpointSettings) and re-sends
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
          emit({ type: "error", error: failed.error, kind: failed.kind });
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
      // kill(): terminal partial assistant response when data exists
      emit(terminalCancelled(context, assembler));
    } else {
      // the CONNECTION's own classification wins (a provider may refine
      // one status code's kind from its error body — see
      // lib/env/provider.js's INSTANCE_DEFAULTS and providers/kimi.js);
      // the shared taxonomy is the fallback when there's no connection
      // yet (a failure constructing it, before _connection is set)
      const classified = aiio._connection?.classifyError?.(err) ?? classifyError(err, aiio.name);
      reportDepletion(aiio, classified);
      emit({
        type: "error",
        error: classified.message,
        kind: classified.kind,
        message: assembler.message(),
        usage: finalizeUsage(null, context, assembler.message()),
      });
    }
    return terminal;
  } finally {
    clearTimeout(overallTimer);
    if (connectTimer) clearTimeout(connectTimer);
    aiio._requestModel = null;
    aiio.env?.activeIO?.delete(aiio); // the IO settled — the slot frees
    aiio.env?._emitEvent?.(ENV_EVENT.IO_DONE, { io: aiio, terminal });
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
