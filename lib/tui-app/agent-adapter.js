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

import Context from "../context.js";
const { userMessage } = Context;
import Agent from "../agent.js";
import { effect } from "../gtui/gtui.js";
import { NAMES } from "../namespace.js";
import { attachmentMessage, hasAttachment } from "./attachment-draft.js";

const { EVENT, RESPONSE_CALLBACK_EVENTS } = Agent;

const REAL_AGENT = Symbol.for(NAMES.realAgentSymbol);
const RESPONSE_TYPES = Object.freeze([
  "start", "text_start", "text_delta", "text_end",
  "thinking_start", "thinking_delta", "thinking_end",
  "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error",
]);

/** The app's message vocabulary for agent-turn/question lifecycle. */
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
function taskKey(origin) {
  let key = agentKeys.get(origin);
  if (!key) { key = `agent.turn.${++nextAgentKey}`; agentKeys.set(origin, key); }
  return key;
}
/** A fresh one-shot task key: every fire-and-forget effect below (enqueue,
 *  interrupt, question resolve/reset) gets its own so GTUI's per-key task
 *  dedup never cancels an unrelated pending one — only "agent.turn" is a
 *  stable, long-lived key. */
const oneShotKey = (name) => `agent.${name}.${nextKey++}`;

/**
 * @param {object} agent - the Agent this adapter drives (the viewed session)
 * @returns {{turnEffect: Function, enqueueEffect: Function, interruptEffect: Function,
 *   resolveQuestionEffect: Function, resetTimeoutEffect: Function, abandonPending: Function,
 *   installQuestionBridge: Function}}
 */
export function createAgentAdapter(agent) {
  const pending = new Map(); // requestId -> resolve, one entry per open question

  /**
   * Interactive tools call this through Agent.setQuestion. Installed fresh
   * at the top of every turn (see runLoop) so `ask` always dispatches
   * through THAT turn's own `send` — never a channel outliving its task.
   * @param {(message: object) => void} send
   */
  function installQuestionBridge(send, origin) {
    const previous = origin._question;
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
    origin.setQuestion(bridge);
    return () => { if (origin._question === bridge) origin.setQuestion(previous); };
  }

  /** @param {string} requestId @param {Array|null} answers */
  function resolveQuestion(requestId, answers) {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    resolve(answers);
  }

  /** Every still-open question resolves null (tools/question.js's "user
   *  busy/away" refusal) — a clean exit never leaves a tool call hanging. */
  function abandonPending() {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  }

  /** Renew the active tool's inactivity deadline. Parity with
   *  lib/tui/repl.js's questionBridge (onInput → resetTimeout); a no-op
   *  outside a tool call (Agent.toolContext's own fallback). */
  function resetQuestionTimeout() {
    agent._toolContext?.().resetTimeout();
  }

  /**
   * Run the agent to completion over whatever it already has (pending +
   * context): a submitted message, or a loop already in flight that
   * picks up a message enqueued mid-turn on its own next iteration —
   * never a second "agent.turn" task.
   * @param {(message: object) => void} send
   */
  async function runLoop(send, origin, beforeRun = undefined) {
    const restoreQuestion = installQuestionBridge(send, origin);
    const handles = [
      ...RESPONSE_CALLBACK_EVENTS.map(([, event], index) => origin.onEvent(event, (value = {}) =>
        send(msg.turnEvent({ ...value, type: RESPONSE_TYPES[index] }, origin)))),
      origin.onEvent(EVENT.TOOL_EXECUTE, (call) => send(msg.toolEvent({ type: "tool.execute", call }, origin))),
      origin.onEvent(EVENT.TOOL_DATA, ({ call, chunk }) => send({ type: "agent.tool.data", call, chunk, origin })),
      origin.onEvent(EVENT.TOOL_RESULT, ({ result, display }) => send(msg.toolEvent({ type: "tool.result", result, display }, origin))),
    ];
    try {
      await beforeRun?.();
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
    /** Starts the turn loop. Call only when no turn is running — a message
     *  arriving mid-turn is just enqueueEffect, never a second turnEffect. */
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
    /** Queue a message. Its own key: never collides with "agent.turn". */
    enqueueEffect(message) {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("enqueue"), async ({ send }) => {
        // Resolve every draft attachment before enqueueing, so a failed read
        // cannot submit surrounding text as a partial turn.
        const assembled = typeof message === "string" && hasAttachment(message)
          ? await attachmentMessage(message)
          : typeof message === "string" ? userMessage(message) : message;
        origin.enqueue(assembled);
        send({ type: "agent.queue.changed", pendingCount: origin.pending.length, origin });
      });
    },
    /** Assemble an attachment draft BEFORE starting its one observing run.
     * `Agent.enqueue` starts idle delivery itself; installing the stream
     * bridge first prevents the former enqueue/turn race from producing an
     * attachment turn followed by a literal-text turn. */
    submitEffect(text) {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(taskKey(origin), async ({ send, signal }) => {
        const onAbort = () => origin.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const message = await attachmentMessage(text);
          return await runLoop(send, origin, () => {
            origin.enqueue(message);
            send({ type: "agent.queue.changed", pendingCount: origin.pending.length, origin });
          });
        } catch (error) { return msg.turnFailed(error, origin); }
        finally { signal.removeEventListener("abort", onAbort); }
      });
    },
    /** agent.cancel() flows back through the ACTIVE turn's own event stream
     *  (an error/cancelled terminal) — this never aborts the task itself. */
    interruptEffect() {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("interrupt"), () => { origin.cancel(); });
    },
    resolveQuestionEffect(requestId, answers) {
      return effect.task(oneShotKey("question.resolve"), () => resolveQuestion(requestId, answers));
    },
    resetTimeoutEffect() {
      return effect.task(oneShotKey("question.reset"), () => resetQuestionTimeout());
    },
    // Commands may require the same structured confirmation UI as a tool,
    // but they run outside an Agent turn. The app owns that task's lifetime
    // and restores the prior bridge when it settles.
    installQuestionBridge,
    /** Keep a lifecycle listener alive for the app lifetime. */
    closeEffect() {
      const origin = agent[REAL_AGENT] ?? agent;
      return effect.task(oneShotKey("close-listener"), ({ send, signal }) => new Promise((resolve) => {
        const handle = origin.onEvent(EVENT.CLOSE_MARKED, () => send(msg.closeMarked(origin)));
        const stop = () => { origin.offEvent(handle); resolve(); };
        signal.addEventListener("abort", stop, { once: true });
      }));
    },
    abandonPending,
  };
}
