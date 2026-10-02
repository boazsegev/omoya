/**
 * lib/tui-app/agent-adapter.js — the ONE seam between the Agent (an
 * imperative, stateful object owned by lib/agent.js) and the app's
 * pure GTUI model: turns become `task` streams (each Agent run()
 * callback becomes a dispatched message), interrupting a turn is a
 * fire-and-forget agent.cancel() that flows back through that SAME
 * task's own event stream (never an aborted task — Agent owns what
 * "cancelled" means), a message submitted while already busy is
 * just another enqueue (the running loop drains it on its own next
 * iteration — never a second task), and the question bridge turns
 * an interactive tool's pending Promise into a dispatched message,
 * resolved later by an effect the app's `update` returns.
 */

import Context from "../../context.js";
const { messageUser } = Context;
import Agent from "../../agent.js";
import { effect } from "../gtui/gtui.js";
import { NAMES } from "../../namespace.js";
import { attachmentMessage, hasAttachment } from "./attachment-draft.js";

const { EVENT, EVENT_CALLBACKS } = Agent;

const REAL_AGENT = Symbol.for(NAMES.realAgentSymbol);
const RESPONSE_TYPES = Object.freeze([
  "start", "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "tool_call_start", "tool_call_delta", "tool_call_end", "done", "error",
]);

/** Immutable message constructors for agent-turn and question lifecycle.
 * @property {(text: string) => object} submit Build an agent.submit message.
 * @property {() => object} interrupt Build an agent.interrupt message.
 * @property {(event: object, origin: object) => object} turnEvent Build a turn-event message.
 * @property {(event: object, origin: object) => object} toolEvent Build a tool-event message.
 * @property {(pendingCount: number, origin: object) => object} turnSettled Build a settled-turn message.
 * @property {(error: Error, origin: object) => object} turnFailed Build a failed-turn message.
 * @property {(requestId: string, questions: Array) => object} questionOpened Build a question-opened message.
 * @property {(origin: object) => object} questionTimedOut Build a timeout message.
 * @property {(origin: object) => object} closeMarked Build a close-marked message.
 */
export const msg = Object.freeze({
  submit: (text) => Object.freeze({ type: "agent.submit", text }),
  interrupt: () => Object.freeze({ type: "agent.interrupt" }),
  turnEvent: (event, origin) => Object.freeze({ type: "agent.turn.event", event, origin }),
  toolEvent: (event, origin) => Object.freeze({ type: "agent.tool.event", event, origin }),
  turnSettled: (pendingCount, origin) => Object.freeze({ type: "agent.turn.settled", pendingCount, origin }),
  turnFailed: (error, origin) => Object.freeze({ type: "agent.turn.failed", error, origin }),
  questionOpened: (requestId, questions) => Object.freeze({ type: "agent.question.opened", requestId, questions }),
  questionTimedOut: (origin) => Object.freeze({ type: "agent.question.timed-out", origin }),
  closeMarked: (origin) => Object.freeze({ type: "agent.close.marked", origin }),
});

let nextRequestId = 0;
let nextKey = 0;
let nextAgentKey = 0;
const agentKeys = new WeakMap();
/** Return the stable task key assigned to an Agent origin.
 * @param {object} origin Agent instance used as the key.
 * @returns {string} Stable key unique to this origin.
 */
function taskKey(origin) {
  let key = agentKeys.get(origin);
  if (!key) { key = `agent.turn.${++nextAgentKey}`; agentKeys.set(origin, key); }
  return key;
}
/** Generate a fresh one-shot task key so per-key dedup never cancels an unrelated pending effect; only the agent turn uses a stable long-lived key.
 * @param {string} name Effect category included in the key.
 * @returns {string} Fresh task key.
 */
const oneShotKey = (name) => `agent.${name}.${nextKey++}`;

/** Create an adapter exposing GTUI effects and message bridges for an Agent session.
 * @param {object} agent The Agent this adapter drives (the viewed session).
 * @returns {object} Adapter operations: `turnEffect()`, `compactEffect(focus = "")`, `enqueueEffect(message)`, `submitEffect(text)`, `interruptEffect()`, `resolveQuestionEffect(requestId, answers)`, `resetTimeoutEffect()`, `installQuestionBridge(send, origin)`, `closeEffect()`, and `abandonPending()`. Effect methods return GTUI task descriptions; `abandonPending` refuses open questions with null.
 */
export function createAgentAdapter(agent) {
  const pending = new Map(); // requestId -> resolve, one entry per open question

  /**
   * Interactive tools call this through Agent.question. Installed fresh
   * at the top of every turn (see runLoop) so `ask` always dispatches
   * through THAT turn's own `send` — never a channel outliving its task.
   * @param {(message: object) => void} send Dispatch function for question messages.
   * @param {object} origin Agent whose bridge is replaced.
   * @returns {() => void} Restore function, conditional on this bridge remaining installed.
   * @throws Propagates errors from `origin.question`.
   */
  function installQuestionBridge(send, origin) {
    const bridge = {
      ask(questions) {
        return new Promise((resolve) => {
          const requestId = String(nextRequestId++);
          pending.set(requestId, resolve);
          send({ ...msg.questionOpened(requestId, questions), origin });
        });
      },
      // Agent's timeout boundary calls this before returning the timeout to
      // the model. Refuse the pending ask as well as dismissing its UI: a
      // late menu answer must never resume the timed-out worker tool.
      timeout() {
        if (pending.size === 0) return;
        abandonPending();
        send(msg.questionTimedOut(origin));
      },
    };
    return origin.questionInstall(bridge);
  }

  /** Resolve and remove a pending question if it remains open.
   * @param {string} requestId Identifier supplied when the question opened.
   * @param {Array|null} answers Answers for the waiting tool; null refuses it.
   * @returns {void}
   */
  function resolveQuestion(requestId, answers) {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    resolve(answers);
  }

  /** Refuse all still-open questions with null (the tool's user-busy/away result).
   * @returns {void}
   */
  function abandonPending() {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  }

  /** Renew the active tool's inactivity deadline; no-op outside a tool call.
   * @returns {void}
   * @throws Propagates errors from the active tool context.
   */
  function resetQuestionTimeout() {
    agent.questionTimeoutReset?.();
  }

  /**
   * Run the agent to completion over whatever it already has (pending +
   * context): a submitted message, or a loop already in flight that
   * picks up a message enqueued mid-turn on its own next iteration —
   * never a second "agent.turn" task.
   * @param {(message: object) => void} send Dispatch function for stream messages.
   * @param {object} origin Agent whose events and run loop are observed.
   * @param {(() => (void|Promise<void>))|undefined} [beforeRun=undefined] Optional setup run after listeners are installed.
   * @param {(() => any|Promise<any>)|undefined} [runOnce=undefined] Optional operation replacing the normal run/drain loop.
   * @returns {Promise<object>} Settled-turn message or `runOnce` result.
   * @throws Rejects on setup/run failure; event listeners and question bridge are restored in `finally`.
   */
  async function runLoop(send, origin, beforeRun = undefined, runOnce = undefined) {
    const restoreQuestion = installQuestionBridge(send, origin);
    const handles = [
      ...EVENT_CALLBACKS.map(([, event], index) => origin.onEvent(event, (value = {}) =>
        send(msg.turnEvent({ ...value, type: RESPONSE_TYPES[index] }, origin)))),
      origin.onEvent(EVENT.TOOL_EXECUTE, (call) => send(msg.toolEvent({ type: "tool.execute", call }, origin))),
      origin.onEvent(EVENT.TOOL_DATA, ({ call, chunk }) => send({ type: "agent.tool.data", call, chunk, origin })),
      origin.onEvent(EVENT.TOOL_RESULT, ({ result, display }) => send(msg.toolEvent({ type: "tool.result", result, display }, origin))),
    ];
    try {
      await beforeRun?.();
      if (runOnce) return await runOnce();
      let terminal;
      for (;;) {
        // Agent.run synchronously removes the next pending request before its
        // first provider await. Publish the resulting queue immediately,
        // including while that provider connection is still waiting.
        const run = origin.run();
        send({ type: "agent.queue.changed", pendingCount: origin.pending.length, origin });
        terminal = await run;
        if (terminal?.type !== "done" || origin.pending.length === 0) break;
      }
      return msg.turnSettled(origin.pending.length, origin);
    } finally {
      for (const handle of handles) origin.offEvent(handle);
      restoreQuestion();
    }
  }

  return {
    /** Start the turn loop only when idle; mid-turn submissions use enqueueEffect.
     * @returns {object} GTUI task effect; abort requests cancellation and errors become failure messages.
     */
    turnEffect() {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(taskKey(origin), async ({ send, signal }) => {
        const onAbort = () => origin.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try { return await runLoop(send, origin); }
        catch (error) { return msg.turnFailed(error, origin); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    },
    /** /context-compact: ONE guarded-off summarization run (Agent owns
     *  the algorithm — agent.compact, lib/agent/compact.js) on the
     *  agent's stable task key, so GTUI's per-key dedup makes it mutually
     *  exclusive with any queued ordinary turn, and the compact run's own
     *  events stream to the transcript exactly like a normal turn's. Call
     *  only when no turn is running (the app guards with activeTurns —
     *  the same claim as app.continue). Settles through the very same
     *  turnSettled path: compaction IS a turn, so it ends like one.
     * @param {string} [focus=""] Optional focus passed to Agent.compact.
     * @returns {object} GTUI task effect that logs and settles or fails the turn.
     */
    compactEffect(focus = "") {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(taskKey(origin), async ({ send, signal }) => {
        const onAbort = () => origin.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await runLoop(send, origin, undefined, () => origin.compact(focus));
          send({ type: "app.log", text: result?.ok ? `compacted ${result.before} messages` : "nothing to compact — the model returned no usable summary" });
          return msg.turnSettled(origin.pending.length, origin);
        } catch (error) { return msg.turnFailed(error, origin); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    },
    /** Queue a message with a one-shot key; attachment drafts are assembled first.
     * @param {string|object} message Text or message to enqueue.
     * @returns {object} GTUI task effect; assembly errors reject before enqueueing.
     */
    enqueueEffect(message) {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("enqueue"), async ({ send }) => {
        // Resolve every draft attachment before enqueueing, so a failed read
        // cannot submit surrounding text as a partial turn.
        const assembled = typeof message === "string" && hasAttachment(message)
          ? await attachmentMessage(message)
          : typeof message === "string" ? messageUser(message) : message;
        origin.send(assembled);
        send({ type: "agent.queue.changed", pendingCount: origin.pending.length, origin });
      });
    },
    /** Assemble an attachment draft BEFORE starting its one observing run.
     * `Agent.send` starts idle delivery itself; installing the stream
     * bridge first prevents the former enqueue/turn race from producing an
     * attachment turn followed by a literal-text turn.
     * @param {string} text Attachment-draft text to assemble and submit.
     * @returns {object} GTUI task effect; errors become turn-failed messages.
     */
    submitEffect(text) {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(taskKey(origin), async ({ send, signal }) => {
        const onAbort = () => origin.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const message = await attachmentMessage(text);
          return await runLoop(send, origin, () => {
            origin.send(message);
            send({ type: "agent.queue.changed", pendingCount: origin.pending.length, origin });
          });
        } catch (error) { return msg.turnFailed(error, origin); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    },
    /** Request cancellation through the active turn's event stream; does not abort its task.
     * @returns {object} GTUI one-shot task effect.
     */
    interruptEffect() {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("interrupt"), () => { origin.cancel(); });
    },
    /** Create an effect resolving a pending question; unknown IDs are ignored.
     * @param {string} requestId Pending question identifier.
     * @param {Array|null} answers Answers to deliver, or null to refuse.
     * @returns {object} GTUI one-shot task effect.
     */
    resolveQuestionEffect(requestId, answers) {
      return effect.task(oneShotKey("question.resolve"), () => resolveQuestion(requestId, answers));
    },
    /** Create an effect renewing the active tool's inactivity deadline.
     * @returns {object} GTUI one-shot task effect.
     */
    resetTimeoutEffect() {
      return effect.task(oneShotKey("question.reset"), () => resetQuestionTimeout());
    },
    // Commands may require the same structured confirmation UI as a tool,
    // but they run outside an Agent turn. The app owns that task's lifetime
    // and restores the prior bridge when it settles.
    installQuestionBridge,
    /** Keep a lifecycle listener alive for the app lifetime, ending on task abort.
     * @returns {object} GTUI task effect that emits close-marked messages.
     */
    closeEffect() {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("close-listener"), ({ send, signal }) => new Promise((resolve) => {
        const handle = origin.onEvent(EVENT.CLOSE_MARKED, () => send(msg.closeMarked(origin)));
        const stop = () => { origin.offEvent(handle); resolve(); };
        signal.addEventListener("abort", stop, { once: true });
      }));
    },
    /** Refuse all currently pending questions with null.
     * @returns {void}
     */
    abandonPending,
  };
}
