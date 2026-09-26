/**
 * lib/web-app/session.js — one browser connection's view over ONE Agent.
 *
 * This is the ONLY seam between the imperative Agent (lib/agent.js) and
 * the wire: it subscribes to the agent's public events, forwards them as
 * JSON packets, installs the question bridge (interactive tools), and
 * drives turns (enqueue + run). It owns NO conversation state — the Agent
 * owns context, the session store, the tool loop, and what "cancelled"
 * means; this module only translates.
 *
 * Turn model (mirrors Agent's own contract):
 *   - a user message is `agent.enqueue(userMessage(text))`, then one
 *     `agent.run()`; run() is one-at-a-time and drains the pending queue
 *     itself, so a submit while busy is just another enqueue — never a
 *     second run loop.
 *   - cancel is `agent.cancel()`; the terminal flows back through the
 *     SAME run's event stream.
 *
 * Everything here is JSON-safe before it reaches the socket.
 */

import Context from "../context.js";
import Markdown from "../markdown.js";
import Agent from "../agent.js";
const { sanitizeText } = Markdown;
const { userMessage, binaryContent, MessageType, ContentType } = Context;
const { EVENT, RESPONSE_CALLBACK_EVENTS } = Agent;

const RESPONSE_KIND = Object.freeze({
  [EVENT.TEXT_DELTA]: "text",
  [EVENT.THINKING_DELTA]: "thinking",
});
const TOOLCALL_EVENTS = new Set([EVENT.TOOLCALL_START, EVENT.TOOLCALL_DELTA, EVENT.TOOLCALL_END]);

/**
 * @param {object} agent - the Agent this connection views
 * @param {(packet: object) => void} send - JSON-safe packet sink
 */
export class AgentSession {
  #agent; #sinks = new Set(); #handles = []; #pending = new Map(); #requestId = 0; #running = false;
  #history = []; #current = null;

  constructor(agent) {
    if (!agent) throw new TypeError("AgentSession requires an agent");
    this.#agent = agent;
    this.#history = historyOf(agent.context);
    this.#subscribe();
  }

  get agent() { return this.#agent; }
  get busy() { return this.#agent.busy === true; }

  /** Add a currently visible browser as a packet destination. A question
   *  still waiting for an answer is re-opened there (reload, agent switch). */
  addSink(send) {
    this.#sinks.add(send);
    for (const [requestId, { questions }] of this.#pending) send({ type: "question.open", requestId, questions });
  }

  /** Stop sending live packets to a browser while preserving this agent's
   * bridge and replay history for when it is selected again. */
  removeSink(send) { this.#sinks.delete(send); }

  #send(packet) { for (const sink of this.#sinks) sink(packet); }

  /** Agent-owned cumulative usage, current context-window readout, and
   * last-known provider plan/quota report — shaped for the display boundary
   * without creating a second accounting source (mirrors tui-app's
   * turnReadoutText/planLine; see lib/tui-app/status-data.js). */
  statusSnapshot() {
    const usage = this.#agent.usage ?? {};
    const context = this.#agent.contextUsage ?? {};
    return {
      input: Number(usage.inputTokens ?? 0), output: Number(usage.outputTokens ?? 0),
      used: Number(context.used ?? 0), available: Number(context.total ?? 0),
      plan: json(this.#agent.planUsage ?? null),
    };
  }

  /** The stored conversation as wire blocks, for replay on attach — the
   *  same shapes the live stream produces (user/text/thinking), so the
   *  client renders history and new turns identically. */
  historySnapshot() {
    // The event cache carries partial output and also supports provider/test
    // terminals that omit an assembled message. A new turn refreshes it from
    // Agent-owned context at START, before any new delta is appended.
    return this.#history.map((block) => ({ ...block }));
  }

  /** Structured, JSON-safe context for an inspector. Agent remains the sole
   * owner; this is a read-only projection rather than a client-side copy. */
  contextSnapshot() {
    return (this.#agent.context ?? []).map((message, messageIndex) => ({
      messageIndex,
      type: message.type,
      content: contextContent(message, messageIndex),
    }));
  }

  /** Edit a textual context block through Agent's canonical edit boundary. */
  editText(messageIndex, blockIndex, text) {
    const block = Context.blockAt(this.#agent.context, messageIndex, blockIndex);
    if (typeof block.text !== "string") throw new TypeError("only textual context blocks can be edited");
    this.#agent.editBlock(messageIndex, blockIndex, { ...block, text });
    this.refresh();
    return this.contextSnapshot();
  }

  rollback(messageIndex) {
    this.#agent.rollback(messageIndex);
    this.refresh();
    return this.contextSnapshot();
  }

  pop() {
    this.#agent.pop();
    this.refresh();
    return this.contextSnapshot();
  }

  deleteMessages(messageIndexes) {
    this.#agent.removeMessages(messageIndexes);
    this.#history = historyOf(this.#agent.context);
    return this.contextSnapshot();
  }

  /** Invoke one registered tool using the displayed session's interactive
   * question bridge and effective safe-mode Env view. */
  async callTool(name, args) {
    const env = this.#agent.safe ? this.#agent.env.safe : this.#agent.env;
    if (!env.hasTool(name)) throw new TypeError(`unknown tool "${name}"`);
    this.#send({ type: "tool.execute", call: { name, arguments: json(args) } });
    try {
      const value = await env.callTool(name, args, { question: this.#agent._question, env, call: undefined, agent: this.#agent });
      this.#send({ type: "tool.result", result: json(value), display: null });
      return value;
    } catch (error) {
      const message = error?.message ?? String(error);
      this.#send({ type: "tool.result", result: { content: [{ type: "text", text: message }] }, display: null });
      throw error;
    }
  }

  /* ---------------------------------------------------------------- wiring */

  #subscribe() {
    const origin = this.#agent;
    // Response-stream events (start/text/thinking/toolcall/done/error) are
    // the same set Agent bridges from IO; forward the deltas, and use
    // start/done/error as turn boundaries.
    for (const [, event] of RESPONSE_CALLBACK_EVENTS) {
      this.#handles.push(origin.onEvent(event, (value = {}) => this.#onResponse(event, value)));
    }
    this.#handles.push(origin.onEvent(EVENT.TOOL_EXECUTE, (call) => this.#send({ type: "tool.execute", call: json(call) })));
    this.#handles.push(origin.onEvent(EVENT.TOOL_DATA, ({ call, chunk }) => this.#send({ type: "tool.data", call: json(call), chunk: String(chunk ?? "") })));
    this.#handles.push(origin.onEvent(EVENT.TOOL_RESULT, ({ result, display }) => this.#send({ type: "tool.result", result: json(result), display: json(display) })));
    this.#handles.push(origin.onEvent(EVENT.SENT_MESSAGE, (message) => {
      this.#history = historyOf(this.#agent.context);
      this.#send({ type: "chat.user", message: { role: "user", text: messageText(message) } });
      this.#send({ type: "chat.queue", messages: this.pendingSnapshot() });
    }));
    origin.setQuestion(this.#questionBridge());
  }

  #onResponse(event, value) {
    if (TOOLCALL_EVENTS.has(event)) {
      if (this.#current) { this.#current.done = true; this.#current = null; }
      const phase = event === EVENT.TOOLCALL_START ? "start" : event === EVENT.TOOLCALL_END ? "end" : "delta";
      // `text` stays the compact display fragment; name/callId/index/args
      // let the client build one live card per call (a batch of parallel
      // calls streams interleaved, keyed by the provider content index).
      this.#send({
        type: `tool.call.${phase}`, text: toolCallText(value),
        ...(typeof value?.name === "string" ? { name: value.name } : {}),
        ...(typeof value?.callId === "string" ? { callId: value.callId } : {}),
        ...(Number.isInteger(value?.contentIndex) ? { index: value.contentIndex } : {}),
        ...(value?.arguments !== undefined ? { args: typeof value.arguments === "string" ? value.arguments : json(value.arguments) } : {}),
      });
      return;
    }
    const kind = RESPONSE_KIND[event];
    if (kind) {
      if (!this.#current || this.#current.kind !== kind) {
        if (this.#current) this.#current.done = true; // thinking → text: the earlier block is complete
        this.#current = { kind, text: "", done: false };
        this.#history.push(this.#current);
      }
      const text = String(value.text ?? value.delta ?? "");
      this.#current.text += text;
      this.#send({ type: "turn.delta", kind, text });
      return;
    }
    if (event === EVENT.START) {
      this.#running = true;
      this.#history = historyOf(this.#agent.context);
      this.#current = null;
      // `busy` refreshes the viewed-agent activity indicators (Stop button,
      // composer animation): busy flips BEFORE the request's first START, so
      // listeners relying on turn.start alone read the state one request
      // stale (fixed by the server's AGENT_START/AGENT_DONE sessions refresh).
      this.#send({ type: "turn.start", status: this.statusSnapshot(), busy: true });
      return;
    }
    if (event === EVENT.DONE || event === EVENT.ERROR) {
      this.#running = false;
      if (this.#current) this.#current.done = true;
      this.#current = null;
      // Prefer the Agent-owned context once it holds the assembled turn: its
      // blocks carry message indexes (edit/delete/view controls on replay).
      // The event cache stays when a terminal left no assembled message.
      const settled = historyOf(this.#agent.context);
      if (settled.length >= this.#history.length) this.#history = settled;
      // busy mirrors the Agent at this instant: with pending queued or a
      // tool round still ahead, the turn continues, so activity indicators
      // must stay lit instead of flickering off between requests.
      this.#send({ type: "turn.end", terminal: { type: value.type ?? (event === EVENT.DONE ? "done" : "error"), ...(value.error ? { error: String(value.error) } : {}), ...(value.kind ? { kind: String(value.kind) } : {}) }, pendingCount: this.#agent.pending.length, busy: this.#agent.busy === true, status: this.statusSnapshot() });
    }
  }

  /* ------------------------------------------------------------- questions */

  #questionBridge() {
    const session = this;
    return {
      ask(questions) {
        return new Promise((resolve) => {
          const requestId = `q${++session.#requestId}`;
          const payload = json(questions);
          session.#pending.set(requestId, { resolve, questions: payload });
          session.#send({ type: "question.open", requestId, questions: payload });
        });
      },
      // Agent invokes this before it reports an interactive tool timeout.
      // Refuse all pending asks and retract their dialogs so a stale browser
      // response cannot resume a completed worker tool call.
      timeout() {
        if (session.#pending.size === 0) return;
        for (const { resolve } of session.#pending.values()) resolve(null);
        session.#pending.clear();
        session.#send({ type: "question.close" });
      },
    };
  }

  /** Resolve (answers array) or refuse (null) one open question. */
  answerQuestion(requestId, answers) {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    // Every other view of this agent drops its copy of the dialog.
    this.#send({ type: "question.close", requestId });
    pending.resolve(answers);
    return true;
  }

  /* ------------------------------------------------------------------ turns */

  /** Queue a user message and ensure the run loop is draining. */
  /** Submit exactly one user message: text first (when present), then files. */
  submit(text, attachments = []) {
    const content = [];
    if (text) content.push(...userMessage(text).content);
    for (const attachment of attachments) content.push(binaryContent(attachment.name, attachment.bytes));
    if (!content.length) throw new TypeError("message requires text or attachment");
    const message = { type: MessageType.User, content };
    this.#agent.enqueue(message);
    this.#history = historyOf(this.#agent.context);
    const messages = this.pendingSnapshot();
    if (messages.length) this.#send({ type: "chat.queue", messages });
    else this.#send({ type: "chat.user", message: { role: "user", text, attachments: attachments.map(({ name, bytes }) => ({ name, size: bytes.byteLength })) } });
    if (!this.#running) void this.#drain();
  }

  cancel() { this.#agent.cancel(); }

  /** Remove every Agent-owned queued message so the client can return their
   * text to its editable draft, matching TUI Option+Up recall semantics. */
  unqueue() {
    const messages = this.#agent.drainPending();
    const text = messages.map(messageText).filter(Boolean).join("\n\n");
    this.#send({ type: "chat.queue", messages: this.pendingSnapshot() });
    return { text, messages: this.pendingSnapshot() };
  }

  pendingSnapshot() { return this.#agent.pending.map(messageText).filter(Boolean); }

  /** Clear this agent's session in place (/session-delete!): drop every
   *  message and flush the now-empty store. */
  clear() {
    const count = this.#agent.context.length;
    if (count > 0) this.#agent.rollback(0);
    this.#agent.session?.flush?.();
    this.#history = historyOf(this.#agent.context);
    return count;
  }

  /** Refresh the replay cache from Agent-owned context (after a command
   *  edits context outside a turn). */
  refresh() { this.#history = historyOf(this.#agent.context); }

  /** Re-activate the agent over its current context (no new message). */
  continue() { if (!this.#running) void this.#drain(); }

  /** One run() at a time; the loop continues while run() keeps draining
   *  pending (Agent.run already loops internally while pending grows, so a
   *  single settled run is enough — but a message can arrive between the
   *  settle and our check, so re-check before idling). */
  async #drain() {
    if (this.#running) return;
    try {
      let terminal = await this.#agent.run();
      while (terminal?.type === "done" && this.#agent.pending.length > 0) {
        terminal = await this.#agent.run();
      }
    } catch (error) {
      // A run that throws (e.g. no usable endpoint) never reaches DONE/ERROR:
      // report it as the turn's terminal so every view clears its activity
      // indicators and shows the failure in the transcript.
      this.#running = false;
      if (this.#current) this.#current.done = true;
      this.#current = null;
      const message = error?.message ?? String(error);
      this.#send({ type: "turn.end", terminal: { type: "error", error: message }, pendingCount: this.#agent.pending.length, busy: this.#agent.busy === true, status: this.statusSnapshot() });
    }
  }

  /** Detach every listener and refuse all open questions (a clean close
   *  never leaves a tool call hanging). */
  dispose() {
    for (const handle of this.#handles) this.#agent.offEvent(handle);
    this.#handles = [];
    for (const { resolve } of this.#pending.values()) resolve(null);
    this.#pending.clear();
    this.#sinks.clear();
    if (this.#agent._question?.ask) this.#agent.setQuestion(null);
  }
}

/** Project agent-owned context into the SPA's transcript shapes — the SAME
 *  kinds the live stream produces (user/text/thinking/tool-call/tool-answer/
 *  system), so replayed history and live turns render identically. */
function historyOf(context) {
  const blocks = [];
  const names = new Map(); // callId -> tool name (a result may omit its name)
  for (const [messageIndex, message] of (context ?? []).entries()) {
    const content = message?.content ?? [];
    if (message.type === MessageType.User) {
      const attachments = content.filter((block) => block?.type !== ContentType.Text && typeof block?.name === "string").map((block) => ({ name: block.name }));
      blocks.push({ kind: "user", text: textOf(content), done: true, messageIndex, blockIndex: 0, editable: true, ...(attachments.length ? { attachments } : {}) });
    } else if (message.type === MessageType.System) {
      blocks.push({ kind: "system", text: textOf(content), done: true, messageIndex, blockIndex: 0, editable: true });
    } else if (message.type === MessageType.ToolResult) {
      const call = { name: message.name ?? names.get(message.callId) ?? "tool", callId: message.callId };
      const output = content.map((block) => (block?.type === ContentType.Text ? sanitizeText(String(block.text ?? ""), { markdown: true }) : "")).filter(Boolean).join("\n");
      blocks.push({ kind: "tool-answer", text: { name: call.name, summary: "" }, tool: call, output, error: message.error === true, done: true, messageIndex, blockIndex: 0 });
    } else if (message.type === MessageType.Assistant) {
      for (const [blockIndex, block] of content.entries()) {
        const ref = { messageIndex, blockIndex };
        if (block?.type === ContentType.Thinking) blocks.push({ kind: "thinking", text: String(block.text ?? ""), done: true, editable: true, ...ref });
        else if (block?.type === ContentType.Text) blocks.push({ kind: "text", text: String(block.text ?? ""), done: true, editable: true, ...ref });
        else if (block?.type === ContentType.ToolCall) {
          if (block.callId) names.set(block.callId, block.name);
          const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(json(block.arguments) ?? {});
          blocks.push({ kind: "tool-call", text: args, name: block.name ?? "tool", callId: block.callId, done: true, ...ref });
        }
      }
    }
  }
  return blocks;
}

/** Concatenate a message's text blocks (user/system text lives in blocks). */
function textOf(content) {
  return content.map((block) => (block?.type === ContentType.Text ? String(block.text ?? "") : "")).join("");
}

function messageText(message) { return textOf(message?.content ?? []); }

/** Provider tool-call deltas vary in shape; preserve their useful textual
 * representation without leaking an unserializable provider object. */
function toolCallText(value) {
  if (typeof value === "string") return value;
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.delta === "string") return value.delta;
  if (typeof value?.name === "string") return value.name;
  if (value?.type === "toolcall_delta" && typeof value.arguments === "string") return value.arguments;
  return "";
}

function contextContent(message, messageIndex) {
  const blocks = (message.content ?? []).map((block, blockIndex) => contextBlock(message, block, messageIndex, blockIndex));
  if (message.type !== MessageType.ToolResult || !Array.isArray(message.display)) return blocks;
  return blocks.concat(message.display.map((display, displayIndex) => ({
    messageIndex,
    blockIndex: blocks.length + displayIndex,
    type: "display",
    viewerType: "tool display",
    text: typeof display === "string" ? display : null,
    data: json(display),
  })));
}

function contextBlock(message, block, messageIndex, blockIndex) {
  return {
    messageIndex,
    blockIndex,
    type: block?.type,
    viewerType: viewerType(message.type, block?.type),
    text: typeof block?.text === "string" ? block.text : null,
    data: json(block),
  };
}

function viewerType(messageType, blockType) {
  if (messageType === MessageType.System) return "system";
  if (messageType === MessageType.User) return "user";
  if (blockType === ContentType.Thinking) return "thinking";
  if (blockType === ContentType.ToolCall) return "tool call";
  if (messageType === MessageType.ToolResult) return "tool answer";
  return "assistant";
}

/** Deep JSON-safe copy (drops functions/symbols/undefined; tolerates cycles). */
function json(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => json(item, seen));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "function" || typeof entry === "symbol" || entry === undefined) continue;
    out[key] = json(entry, seen);
  }
  return out;
}
