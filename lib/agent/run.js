/**
 * lib/agent/run.js — the tool loop (private to Agent): complete
 * context → IO request → tool calls? execute, append each result
 * beside its call, next request → repeat until done/error.
 *
 * The PRIMARY runaway guard is CONTEXT USAGE, not a request/tool-call
 * count (agent.policy.context — settings.context.cap / .turn, see
 * lib/agent/policy.js and contextGuardTrip below): a model that
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
 * growing interval (agent.policy.retry: `attempts` total, `base`
 * doubling per retry, capped at `max`). A retried
 * failure persists NO assistant message (a mid-stream error's
 * partial would read as a completed answer); the assistant message
 * lands only once the request settles for good. A cancel during the
 * wait surfaces immediately, and a failed attempt's login-required
 * side effect applies only when the retries are spent.
 *
 * AUTO-COMPACTION (agent.policy.context.autocompact, compactAuto in
 * lib/agent/compact.js) runs at the top of every iteration, BEFORE the
 * runaway guard, so it can keep the guard from tripping. Its compact
 * turn is a NESTED runLoop (compacting: true — never auto-compacts or
 * guards itself) under the outer run's busy/close lifecycle.
 */

import Context from "../context.js";
import { modelSelectorParse } from "./model-select.js";
const { ContentType, eventDispatch, messageHasContent, messageHasError, tokensEstimateMessages } = Context;
import { RETRYABLE_KINDS, awaitTimeout } from "./reliability.js";
import { retryDelay } from "./policy.js";
import { compactAuto } from "./compact.js";
import { EVENT, RESPONSE_CALLBACK_EVENTS } from "./events.js";

/** A runaway-guard stop: log, surface an ordinary error event, flush.
 *  No request was made, so there is no bookkeeping to wait for —
 *  completeTerminal() fires right away. */
export async function guarded(agent, agentSet, error) {
  agent._emit(EVENT.LOG, error);
  const event = { type: "error", error };
  eventDispatch(agentSet, event);
  completeTerminal(agent, event);
  await agent._flushLive();
  return event;
}

/**
 * The CONTEXT-USAGE runaway guard (agent.policy.context — cap / turn,
 * lib/agent/policy.js): checked at the top
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
  const { cap, turn: turnCap } = agent.policy.context;
  // The last provider report describes the PREVIOUS request. Results
  // appended since then (especially large tool output) must be budgeted
  // before sending the next request, not hidden behind that old report.
  const projected = Math.max(used, tokensEstimateMessages(agent.context.messages()));
  const usedFrac = projected / total;
  if (usedFrac >= cap) {
    return `runaway guard: context usage is ${Math.round(usedFrac * 100)}% of the ${total}-token ` +
      `window (cap ${Math.round(cap * 100)}%) — user oversight and /compact are required before continuing`;
  }
  const turnFrac = Math.max(0, projected - turnStartUsed) / total;
  if (turnFrac >= turnCap) {
    return `runaway guard: this turn alone consumed ${Math.round(turnFrac * 100)}% of the ${total}-token ` +
      `context window (cap ${Math.round(turnCap * 100)}%) — user oversight and /compact are required before continuing`;
  }
  return null;
}

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
  agent._emit(event?.type === "error" ? EVENT.REQUEST_ERROR : EVENT.REQUEST_DONE, agentEvent(event ?? {}));
  return event;
}

const NOOP = () => {};

function eventCallbacks(agent) {
  const callbacks = {};
  for (const [callback, event] of RESPONSE_CALLBACK_EVENTS) {
    // DONE/ERROR reach subscribers only through completeTerminal(),
    // called once this request's bookkeeping has run — never wired
    // here, or a subscriber (e.g. the web app's live status) would
    // observe EVENT.REQUEST_DONE/ERROR before usage/context/plan accounting
    // and message persistence have happened for it. A no-op function
    // (not `false`) — this same object is also called directly via
    // eventDispatch(agentSet, ...) below (guarded/cancelledTerminal/"no
    // model"), which — unlike normalizeCallbacks — doesn't tolerate
    // a non-function value.
    if (event === EVENT.REQUEST_DONE || event === EVENT.REQUEST_ERROR) { callbacks[callback] = NOOP; continue; }
    callbacks[callback] = (value) => agent._emit(event, agentEvent(value));
  }
  return callbacks;
}

/**
 * Run the tool loop until done/error.
 * @param {object} agent
 * @param {Object} [options]
 * @param {string|object} [options.endpoint] - per-request endpoint selection
 * @param {string} [options.model] - per-request model selection
 * @param {number} [options.timeout] - per-request timeout (ms)
 * @param {boolean} [options.contextGuard] - false only for internal
 *   compaction, which must run above the normal 90% ceiling
 * @param {boolean} [options.compacting] - an internal compact turn: no
 *   slash commands, no auto-compaction
 * @param {boolean} [options.pendingHold] - queued messages stay pending
 *   (auto-compaction's turn leaves them for the request after it)
 * @returns {Promise<object>} the terminal done/error event
 */
export async function runLoop(agent, options = {}) {
  const agentSet = eventCallbacks(agent);
  const turnStartUsed = agent.contextUsage.used; // the per-turn growth cap's baseline
  if (agent._closeMarked) throw new Error("Agent.run: agent is closed");
  // a compact turn inside an active run: the outer run owns busy/cancel/close
  const nested = agent._running === true;
  if (!nested) {
    agent._running = true; // public busy surface (TUI status indicator)
    agent._cancelRequested = false; // a fresh run re-arms the cancel path
  }

  /** The tool-phase cancel: mirror of the IO kill's terminal. No new
   *  request is in flight here, so — as in guarded() — there is no
   *  bookkeeping to wait for; completeTerminal() fires right away. */
  const cancelledTerminal = async () => {
    const event = { type: "error", error: "cancelled", kind: "cancelled", cancelled: true };
    eventDispatch(agentSet, event);
    completeTerminal(agent, event);
    await agent._flushLive();
    return event;
  };

  try {
    const selected = options.model === undefined
      ? { endpoint: agent.endpoint, model: agent.model }
      : modelSelectorParse(agent.env, options.model, "Agent.run");
    const { endpoint, model } = selected;
    if (!endpoint || !model) {
      const event = { type: "error", error: "Please load a model" };
      eventDispatch(agentSet, event);
      return completeTerminal(agent, event);
    }

    for (;;) {
      // AUTO-COMPACTION precedes the guard. A cancel or close during its
      // compact turn ends the run with that turn's terminal.
      if (options.compacting !== true) {
        let compactTerminal = null;
        const compaction = compactAuto(agent, async (compactOptions) =>
          (compactTerminal = await runLoop(agent, { ...options, ...compactOptions })));
        if (compaction) {
          const { done } = await compaction;
          if (done || agent._cancelRequested || agent._closeMarked) return compactTerminal;
        }
      }
      // The CONTEXT-USAGE guard gates every continuation alike — the
      // very first request of a turn that inherited an already-critical
      // context, another tool-call round, or the next queued message.
      const contextTrip = options.contextGuard === false ? null : contextGuardTrip(agent, turnStartUsed);
      if (contextTrip) return await guarded(agent, agentSet, contextTrip);
      // Pending user messages join the context BEFORE the request —
      // after any tool results (they appended at the previous
      // iteration's end), exactly per the flush contract.
      if (options.pendingHold !== true) agent._flushPending();
      // A FAILED response that is still the last message was not
      // responded to — the user continued as it stands — so it is
      // retracted and the request re-attempted (Context.errorPop). A reply
      // flushed just above keeps it: then it is part of the conversation.
      agent.context.errorPop();
      // The LATEST user message is trimmed of surrounding whitespace
      // (trailing EOLs, tabs, every white space) before it can reach a
      // provider: an append()/resume path can bypass send()'s trim,
      // and a message hollowed out by the trim is swept away next — so
      // a whitespace-only latest user message never produces a provider
      // 400 over `content: ""` and the turn simply continues.
      agent._trimLatestUserMessage();
      if (options.compacting !== true) {
        const focus = agent._prepareUserMessages();
        if (focus !== null) {
          // The slash command is removed before IO; run its internal
          // summarization turn under this same run lifecycle.
          return await agent._compactTurn(focus);
        }
      }
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
      const maxAttempts = agent.policy.retry.attempts;
      try {
        for (let attempt = 1; ; attempt++) {
          terminal = await aiio.write(agent.context.messages(), agentSet, {
            model,
            timeout: options.timeout,
          });
          // RETRY: only a failure class that can heal with time, and
          // never a close-terminal (close() ends the instance for good)
          const retryable = terminal?.type === "error" && terminal?.cancelled !== true &&
            RETRYABLE_KINDS.includes(terminal?.kind);
          // A provider-specified rate-limit wait is a continuation of the turn,
          // not a hidden short retry inside this active run. Let the host
          // display the deadline and allow an immediate user override.
          if (terminal?.type === "error" && (terminal?.message?.error?.retry > 0 || terminal?.retryAfterMs > 0)) break;
          if (!retryable || attempt >= maxAttempts || agent._cancelRequested) break;
          const delay = retryDelay(agent.policy.retry, attempt - 1);
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

      // Persist the assistant message (complete, kill-partial, or a
      // failed response carrying its error — messageHasError) — only one
      // with actual CONTENT or an error: an interrupted turn can produce
      // a content-NONEMPTY yet CONTENTLESS partial (a text_start whose
      // delta never arrived), and no provider dialect can carry such a
      // message. appendMessage already refuses it; checking here keeps
      // the refusal from ever firing and the context free of empties.
      const message = terminal?.message;
      const kept = message && (messageHasContent(message) || messageHasError(message));
      const storedMessage = kept ? agent._append(message) : null;
      await agent._flushLive(); // yields after terminal persistence
      if (storedMessage && terminal?.type === "done") {
        agent._emit(EVENT.MESSAGE_COMMITTED, storedMessage);
      }

      // the public connection surface: a success clears a past
      // disconnect; a connection-class failure (network/auth/provider)
      // marks it until a request succeeds again
      if (terminal?.type === "done") {
        agent._disconnected = false;
        // a success also clears a past login-required mark (the
        // connection persists the endpoint record)
        const connection = typeof endpoint === "string" ? agent._connection(endpoint, model) : null;
        if (connection?.settings?.loginRequired === true) connection.authSet?.({ loginRequired: false });
        // a success is the proof a reported TOKEN DEPLETION refilled
      } else if (terminal?.type === "error" && ["network", "auth", "provider"].includes(terminal.kind)) {
        agent._disconnected = true;
        // AUTH failure: the credentials are dead — mark the endpoint
        // login-required (its catalog entries stay listed, flagged); the
        // TUI marks it (login) and routes menu selection to the re-login flow
        if (terminal.kind === "auth" && typeof endpoint === "string") {
          agent._connection(endpoint, model)?.authSet?.({ loginRequired: true });
        }
      }

      // Subscribers learn this request is done only now — usage, context,
      // and plan accounting; message persistence and MESSAGE_COMMITTED;
      // and the connection-state bookkeeping above have all already run
      // (see eventCallbacks/completeTerminal). Fires once per write(), the
      // same cadence as before — only the timing moved.
      if (terminal) completeTerminal(agent, terminal);

      const retry = terminal?.message?.error?.retry ?? terminal?.retryAfterMs;
      if (terminal?.type === "error" && Number.isFinite(retry) && retry > 0 && !agent._cancelRequested && !agent._closeMarked) {
        // Do not retain the scheduled promise: no caller of this run should
        // wait on the next turn, and cancellation/close must not strand it.
        void agent.run({ after: retry }).catch((error) => {
          agent._emit(EVENT.LOG, `delayed continuation failed: ${error.message}`);
        });
      }
      if (!terminal || terminal.type === "error") return terminal;

      const calls = (message?.content ?? []).filter(
        (block) => block && block.type === ContentType.ToolCall && block.name,
      );
      if (calls.length === 0) {
        // done — but messages queued mid-turn still go out: flush them
        // (top of the loop) and continue with one more request.
        if (terminal.type === "done" && agent._pending.length > 0 && options.pendingHold !== true) continue;
        return terminal;
      }

      const claimedIds = new Set(); // ids resolved within THIS message (first keeps, later regenerate)
      // Read-only runs may overlap; anything not explicitly safe is a
      // barrier. Drain each run before a mutation and before starting the
      // next read run, so readers never observe a pending write.
      const catalog = await agent.env.tools(false, `${endpoint}/${model}`);
      const readOnly = (call) => catalog.get(call.name)?.safe === true;
      for (let i = 0; i < calls.length;) {
        if (agent._cancelRequested) return await cancelledTerminal();
        const first = calls[i];
        if (!readOnly(first)) {
          agent._appendOutcome(await agent._dispatch(first, claimedIds, calls));
          i++;
        } else {
          const group = [];
          while (i < calls.length && readOnly(calls[i])) {
            group.push(calls[i++]);
          }
          const { concurrency } = agent.policy.tools;
          for (let at = 0; at < group.length; at += concurrency) {
            if (agent._cancelRequested) return await cancelledTerminal();
            const outcomes = await Promise.all(group.slice(at, at + concurrency).map((call) => agent._dispatch(call, claimedIds, calls)));
            for (const outcome of outcomes) agent._appendOutcome(outcome);
          }
        }
        // Unstarted calls remain unanswered on cancellation; the repair
        // pass supplies their results before the next provider request.
        if (agent._cancelRequested) return await cancelledTerminal();
      }
      if (agent._cancelRequested) return await cancelledTerminal();
      await agent._flushLive();
    }
  } finally {
    if (!nested) {
      agent._running = false;
      // completeTerminal() (bookkeeping, then DONE/ERROR) always runs before
      // its return/continue is reached above, so CLOSED is still observably
      // last here.
      if (agent._closeMarked) agent._performClose();
    }
  }
}
