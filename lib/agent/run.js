/**
 * lib/agent/run.js — the tool loop (private to Agent): complete
 * context → IO request → tool calls? execute, append each result
 * beside its call, next request → repeat until done/error.
 *
 * The PRIMARY runaway guard is CONTEXT USAGE, not a request/tool-call
 * count (settings.contextGuardCap / contextGuardTurnCap — see
 * lib/env/context-guard.js and contextGuardTrip below): a model that
 * quotes one huge file spins the context out just as "runaway" as one
 * that loops forever on trivial calls, and a count can't tell the two
 * apart. There is intentionally no request or tool-call count limit:
 * when a provider does not expose a context window, the loop relies on
 * completion, cancellation, and tool timeouts rather than guessing a
 * false runaway from a count. Failed/denied/unknown tool calls
 * surface to the model as tool-result errors.
 *
 * Every tool call in the LIVE response executes — identical repeats
 * included (a mutating tool must be safe to publish, and a tool that
 * reads mutated data must return FRESH data: re-reading an edited
 * file is a legitimate repeat). Calls execute ONLY in real time —
 * from the just-completed live response. A call found anywhere in
 * existing history (mid-context, answered or not) is NEVER executed
 * by the harness. That's the whole rule: live executes, history
 * doesn't. callId is irrelevant to execution — it is pure
 * call→answer linkage, owned by Agent (generated when missing,
 * regenerated on collision) so providers that restart id sequences
 * per request can't mislink results. There is no executed-list and
 * no stored-answer reuse: the context is only the conversation
 * record, never an execution cache. Cross-turn repeats are the
 * model's own new calls with fresh ids — legitimate.
 *
 * RETRIES: a failed IO request whose failure class CAN heal with
 * time (Env.RETRYABLE_KINDS — network/provider/auth; a depleted
 * token budget surfaces as one of those) is attempted again after a
 * growing interval (env.maxAttempts attempts total, env.retryDelay —
 * retryBase doubling per attempt, capped at retryMax). A retried
 * failure persists NO assistant message (a mid-stream error's
 * partial would read as a completed answer); the assistant message
 * lands only once the request settles for good. A cancel during the
 * wait surfaces immediately, and a failed attempt's login-required
 * side effect applies only when the retries are spent.
 */

import Context from "../context.js";
import Env from "../env.js";
const { ContentType, dispatch, hasContent } = Context;
const { RETRYABLE_KINDS, awaitTimeout } = Env;
import { EVENT, RESPONSE_CALLBACK_EVENTS } from "./events.js";

/** A runaway-guard stop: log, surface an ordinary error event, flush.
 *  No request was made, so there is no bookkeeping to wait for —
 *  completeTerminal() fires right away. */
export async function guarded(agent, agentSet, error) {
  agent._emit(EVENT.LOG, error);
  const event = { type: "error", error };
  dispatch(agentSet, event);
  completeTerminal(agent, event);
  await agent._flushLive();
  return event;
}

/**
 * The CONTEXT-USAGE runaway guard (settings.contextGuardCap /
 * contextGuardTurnCap — lib/env/context-guard.js): checked at the top
 * of every loop iteration, so it gates EVERY continuation alike — the
 * very first request of a turn that inherited an already-critical
 * context, another tool-call round, or the next queued message alike.
 * A model window is required (Number.isFinite(total) > 0); without
 * one the percentage is unknowable and this guard stays silent.
 * @param {object} agent
 * @param {number} turnStartUsed - agent.contextUsage.used as of THIS
 *   invocation's start (the per-turn growth baseline)
 * @returns {string|null} the guard message, or null when under both caps
 */
export function contextGuardTrip(agent, turnStartUsed) {
  const { used, total } = agent.contextUsage;
  if (!Number.isFinite(total) || total <= 0) return null;
  const cap = agent.env.contextGuardCap;
  const turnCap = agent.env.contextGuardTurnCap;
  const usedFrac = used / total;
  if (usedFrac >= cap) {
    return `runaway guard: context usage is ${Math.round(usedFrac * 100)}% of the ${total}-token ` +
      `window (cap ${Math.round(cap * 100)}%) — user oversight and /compact are required before continuing`;
  }
  const turnFrac = Math.max(0, used - turnStartUsed) / total;
  if (turnFrac >= turnCap) {
    return `runaway guard: this turn alone consumed ${Math.round(turnFrac * 100)}% of the ${total}-token ` +
      `context window (cap ${Math.round(turnCap * 100)}%) — user oversight and /compact are required before continuing`;
  }
  return null;
}

/**
 * Run the tool loop until done/error.
 * @param {object} agent
 * @param {Object} [callbacks] - normalized response callbacks (camelCase)
 * @param {Object} [options]
 * @param {string|object} [options.endpoint] - per-request endpoint selection
 * @param {string} [options.model] - per-request model selection
 * @param {number} [options.timeout] - per-request timeout (ms)
 * @returns {Promise<object>} the terminal done/error event
 */
function agentEvent(value) {
  const event = { ...value };
  delete event.type;
  return event;
}

/** Notify subscribers a request has concluded — called ONLY once its
 *  bookkeeping (usage/context/plan accounting, message persistence) has
 *  actually happened, never synchronously mid-write. See eventCallbacks:
 *  onDone/onError are deliberately left unwired there for this reason,
 *  and every terminal producer (the write() loop below, guarded(),
 *  cancelledTerminal()) calls this explicitly once it is truly done. */
function completeTerminal(agent, event) {
  agent._emit(event?.type === "error" ? EVENT.ERROR : EVENT.DONE, agentEvent(event ?? {}));
  return event;
}

const NOOP = () => {};

function eventCallbacks(agent) {
  const callbacks = {};
  for (const [callback, event] of RESPONSE_CALLBACK_EVENTS) {
    // DONE/ERROR reach subscribers only through completeTerminal(),
    // called once this request's bookkeeping has run — never wired
    // here, or a subscriber (e.g. the web app's live status) would
    // observe EVENT.DONE/ERROR before usage/context/plan accounting
    // and message persistence have happened for it. A no-op function
    // (not `false`) — this same object is also called directly via
    // dispatch(agentSet, ...) below (guarded/cancelledTerminal/"no
    // model"), which — unlike normalizeCallbacks — doesn't tolerate
    // a non-function value.
    if (event === EVENT.DONE || event === EVENT.ERROR) { callbacks[callback] = NOOP; continue; }
    callbacks[callback] = (value) => agent._emit(event, agentEvent(value));
  }
  return callbacks;
}

export async function runLoop(agent, options = {}) {
  const agentSet = eventCallbacks(agent);
  const turnStartUsed = agent.contextUsage.used; // the per-turn growth cap's baseline
  if (agent._closeMarked) throw new Error("Agent.run: agent is closed");
  agent._running = true; // public busy surface (TUI status indicator)
  agent._cancelRequested = false; // a fresh run re-arms the cancel path
  agent._cancelCount = 0; // and its escalation ladder
  // NOTE: the maxActive ledger is IO's concern, never the loop's —
  // an agent holds an Env.activeIO slot only while one of its
  // requests is actually in flight (lib/io/request.js); tool calls
  // are client work and occupy nothing.

  /** The tool-phase cancel: mirror of the IO kill's terminal. No new
   *  request is in flight here, so — as in guarded() — there is no
   *  bookkeeping to wait for; completeTerminal() fires right away. */
  const cancelledTerminal = async () => {
    const event = { type: "error", error: "cancelled", kind: "cancelled", cancelled: true };
    dispatch(agentSet, event);
    completeTerminal(agent, event);
    await agent._flushLive();
    return event;
  };

  try {
    const selected = options.model === undefined
      ? { endpoint: agent.endpoint, model: agent.model }
      : Env.parseModelSelector(agent.env, options.model, "Agent.run");
    const { endpoint, model } = selected;
    if (!endpoint || !model) {
      const event = { type: "error", error: "Please load a model" };
      dispatch(agentSet, event);
      return completeTerminal(agent, event);
    }

    for (;;) {
      // The CONTEXT-USAGE guard gates every continuation alike — the
      // very first request of a turn that inherited an already-critical
      // context, another tool-call round, or the next queued message.
      const contextTrip = options.contextGuard === false ? null : contextGuardTrip(agent, turnStartUsed);
      if (contextTrip) return await guarded(agent, agentSet, contextTrip);
      // Pending user messages join the context BEFORE the request —
      // after any tool results (they appended at the previous
      // iteration's end), exactly per the flush contract.
      agent._flushPending();
      // EMPTY messages never persist: an interrupted turn can leave a
      // contentless message in the live array (appendMessage refuses an
      // incoming empty, but a merge or an edit can legitimately hollow
      // one out in place), and no provider dialect can carry one
      // (chat-completions serialize it as content:null — a provider 400,
      // a poisoned session). Sweep before every write; the session
      // shares this array, so the sweep persists too.
      agent._sweepEmptyMessages();
      // Interrupted turns leave assistant tool_calls no result ever
      // answered (cancel, runaway guard, crash) — strict dialects 400
      // the whole request over one orphan. Repair before every write.
      agent._repairToolCalls();
      // Preserve the pre-existing durability point: a queued user message
      // (and any synthesized repair) reaches the session before a provider
      // request that might hang. The async path yields instead of blocking.
      await agent._flushLive();
      const aiio = agent._connection(endpoint, model);

      agent._activeIO = aiio;
      let terminal;
      const maxAttempts = Math.max(1, agent.env.maxAttempts ?? 1);
      try {
        for (let attempt = 1; ; attempt++) {
          terminal = await aiio.write(agent.context, agentSet, {
            model,
            timeout: options.timeout,
          });
          // RETRY: only a failure class that can heal with time, and
          // never a kill-terminal (kill() closes the instance for good)
          const retryable = terminal?.type === "error" && terminal?.cancelled !== true &&
            RETRYABLE_KINDS.includes(terminal?.kind);
          if (!retryable || attempt >= maxAttempts || agent._cancelRequested) break;
          const delay = agent.env.retryDelay(attempt - 1);
          agent._emit(EVENT.LOG,
            `request attempt ${attempt} of ${maxAttempts} failed (${terminal.kind}) — retrying in ${Math.round(delay / 100) / 10}s`,
          );
          // Agent owns the cancellation notification; Env only races its
          // completion promise with the deadline. Clearing this callback in
          // finally releases the losing cancellation path after either result.
          const completed = await awaitTimeout(delay, (signal) => new Promise((resolve) => {
            agent._signalCancel = resolve;
            // Env aborts this signal after either winner, removing the losing
            // Agent-owned notification listener/callback immediately.
            signal.addEventListener("abort", () => {
              agent._signalCancel = null;
            }, { once: true });
          })).finally(() => { agent._signalCancel = null; });
          if (completed) break;
        }
      } finally {
        agent._activeIO = null;
      }
      if (terminal?.usage) agent._accumulateUsage(terminal.usage);
      // the context readout: the provider's own report (via IO) wins;
      // the last usage envelope is the runner-up (see contextUsage)
      agent._contextReport = aiio.contextUsage ?? agent._contextReport;
      if (terminal?.usage) agent._lastUsage = terminal.usage;
      // the plan/quota readout is last-known per endpoint (see planUsage)
      if (aiio.planUsage) agent._planUsage = aiio.planUsage;

      // Persist the assistant message (complete or kill-partial) —
      // only one with actual CONTENT (hasContent): an interrupted
      // turn can produce a content-NONEMPTY yet CONTENTLESS partial
      // (a text_start whose delta never arrived), and no provider
      // dialect can carry such a message. appendMessage already
      // refuses it; checking here keeps the refusal from ever firing
      // and the context free of empties from the start.
      const message = terminal?.message;
      const storedMessage = message && hasContent(message) ? agent._append(message) : null;
      await agent._flushLive(); // yields after terminal persistence
      if (storedMessage && terminal?.type === "done") {
        agent._emit(EVENT.MESSAGE_COMMITTED, storedMessage);
      }

      // the public connection surface: a success clears a past
      // disconnect; a connection-class failure (network/auth/provider)
      // marks it until a request succeeds again
      if (terminal?.type === "done") {
        agent._disconnected = false;
        // a success also clears a past login-required mark
        if (typeof endpoint === "string" && agent.env.endpointSettings?.(endpoint)?.loginRequired === true) {
          agent.env.authSet?.(endpoint, { loginRequired: false });
        }
        // a success is the proof a reported TOKEN DEPLETION refilled
      } else if (terminal?.type === "error" && ["network", "auth", "provider"].includes(terminal.kind)) {
        agent._disconnected = true;
        // AUTH failure: the credentials are dead — drop the (now
        // unreachable) cached models and mark the endpoint
        // login-required; the TUI marks it (login) and routes menu
        // selection to the re-login flow
        if (terminal.kind === "auth" && typeof endpoint === "string") {
          agent.env.authSet?.(endpoint, { loginRequired: true, models: {} });
        }
      }

      // Subscribers learn this request is done only now — usage, context,
      // and plan accounting; message persistence and MESSAGE_COMMITTED;
      // and the connection-state bookkeeping above have all already run
      // (see eventCallbacks/completeTerminal). Fires once per write(), the
      // same cadence as before — only the timing moved.
      if (terminal) completeTerminal(agent, terminal);

      if (!terminal || terminal.type === "error") return terminal;

      const calls = (message?.content ?? []).filter(
        (block) => block && block.type === ContentType.ToolCall && block.name,
      );
      if (calls.length === 0) {
        // done — but messages queued mid-turn still go out: flush them
        // (top of the loop) and continue with one more request.
        if (terminal.type === "done" && agent._pending.length > 0) continue;
        return terminal;
      }

      const claimedIds = new Set(); // ids resolved within THIS message (first keeps, later regenerate)
      if (agent._toolCall.async && calls.length > 1) {
        // concurrent dispatch (toolCall.async): the message's calls
        // run in parallel; results append BESIDE THEIR CALLS, in the
        // message's call order, exactly like the sequential path. The
        // runaway guard pre-checks the batch (a parallel batch can't
        // trip mid-way like the sequential loop does).
        const outcomes = await Promise.all(
          calls.map((call) => agent._dispatch(call, claimedIds, calls)),
        );
        for (const outcome of outcomes) agent._appendOutcome(outcome);
      } else {
        for (const call of calls) {
          agent._appendOutcome(await agent._dispatch(call, claimedIds, calls)); // result beside its call
          // a cancel lands between calls too: the remaining calls of
          // the batch do NOT start (their calls stay unanswered — the
          // repair pass synthesizes their results before the next write)
          if (agent._cancelRequested) return await cancelledTerminal();
        }
      }
      if (agent._cancelRequested) return await cancelledTerminal();
      await agent._flushLive();
    }
  } finally {
    agent._running = false;
    // completeTerminal() (bookkeeping, then DONE/ERROR) always runs before
    // its return/continue is reached above, so CLOSED is still observably
    // last here.
    if (agent._closeMarked) agent._performClose();
    // requestEnd(): the turn has fully settled —
    // close through the canonical lifecycle, never idling forever.
    if (agent._endRequested) agent.close();
  }
}
