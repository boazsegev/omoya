/**
 * lib/providers/test.js — scripted TEST connector: predetermined
 * responses, zero network, zero model dependence. Exists so "live"
 * end-to-end tests exercise the whole stack (CLI processes, sessions,
 * tool loop, TUI) without a real model — a real model makes tests
 * flaky (response variance, availability, model intelligence level).
 *
 * The SCRIPT is an array of TURNS; each turn is an array of response
 * BLOCKS served for one provider request (the Agent's tool loop
 * consumes one turn per request — a tool-call turn plus its answer
 * turn is two script turns). Block shapes:
 *   {"thinking": "..."}                              reasoning block
 *   {"text": "..."}                                  visible text
 *   {"toolCall": {"name": "...", "arguments": {...}}}  tool call
 *     (optional "callId"; generated test-N otherwise)
 *   {"error": "..."}                                 provider failure
 * Turns are consumed in order per IO instance (one conversation);
 * when the script runs out, the LAST turn repeats. An unknown block
 * surfaces as a provider error (fail loudly, never silently pass).
 *
 * Script source (first hit wins):
 *   1. settings.script  — provider-namespaced settings (settings.json
 *      "test" section) or per-invocation overrides (Agent/IO
 *      `settings: {script: ...}`) — the in-process path;
 *   2. process.env[NAMES.testScriptEnv] — the spawned-process path.
 * Either may be: an inline ARRAY, a JSON string of one, or a PATH to
 * a JSON file holding one (a string not starting with "[" is a path;
 * re-read on every request, so a test may extend the file mid-run).
 * With no script the request fails with an explicit error event.
 *
 * Transport: custom non-HTTP connect/send/read/close (send primes the
 * turn's frames, read pops one block descriptor per call, msg2events
 * translates it to normalized events). models() is a fixed local
 * list; login() a no-auth marker (neither touches disk or network).
 */

import { readFileSync } from "node:fs";
import { NAMES } from "../lib/namespace.js";
import { fileURLToPath } from "node:url";
import Env from "../lib/env.js";
const { ProviderError } = Env;

const metadata = {
  label: "Test (scripted)",
  secret: true,
  spawn: true,
  capabilities: { tools: true, thinking: true, streaming: true },
};

const FIXED_MODELS = {
  "test-model": { label: "Test Model", reasoning: true, input: ["text"], secret: true },
  ui: { label: "UI demonstration", reasoning: true, input: ["text"] },
  "ui-response": { label: "UI worker response", reasoning: true, input: ["text"] },
};
const BUILTIN_SCRIPTS = {
  ui: fileURLToPath(new URL("./test/ui.json", import.meta.url)),
  "ui-response": fileURLToPath(new URL("./test/ui-response.json", import.meta.url)),
};

/** Turn cursors per IO instance (one conversation per instance). */
const cursors = new WeakMap();

/**
 * Resolve the script for this request (re-resolved every connect, so
 * a file-based script may be extended between turns).
 * @param {object} aiio
 * @returns {Array<Array<object>>} array of turns (arrays of blocks)
 */
function resolveScript(aiio) {
  let source = aiio?.settings?.script ?? process.env[NAMES.testScriptEnv] ?? BUILTIN_SCRIPTS[aiio?.currentModel];
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed !== "" && !trimmed.startsWith("[")) {
      source = readFileSync(trimmed, "utf8"); // a path, not inline JSON
    }
  }
  if (typeof source === "string") source = JSON.parse(source);
  if (
    !Array.isArray(source) || source.length === 0 ||
    !source.every((turn) => Array.isArray(turn))
  ) {
    throw new ProviderError(
      "provider",
      `test provider: no script (set settings.script or ${NAMES.testScriptEnv} to an array of turns, JSON, or a JSON file path)`,
    );
  }
  return source;
}

/* ------------------------------------------------ outgoing: context2msg */

/** The full context rides along untouched for test introspection. */
function context2msg(context, aiio) {
  return [{}, { model: aiio?.currentModel, messages: context }];
}

/** Claim the next turn's blocks into the connection's frame queue. */
async function send(connection, msg) {
  const script = resolveScript(connection.aiio);
  const cursor = cursors.get(connection.aiio) ?? 0;
  cursors.set(connection.aiio, cursor + 1);
  connection.request = msg;
  connection.frames = script[Math.min(cursor, script.length - 1)].slice();
}

/** Non-HTTP buffering read: one scripted block descriptor per call. */
async function read(connection) {
  while (connection.frames?.length > 0) {
    const frame = connection.frames.shift();
    if (frame?.delay === undefined) return frame;
    if (!Number.isFinite(frame.delay) || frame.delay < 0 || frame.delay > 10_000) {
      return { error: `test provider: invalid delay ${JSON.stringify(frame.delay)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, frame.delay));
  }
  return null;
}

/** Nothing to tear down (no transport). */
async function close() {}

/* ------------------------------------------------ incoming: msg2events */

/**
 * Translate one scripted block descriptor into normalized events.
 * Block indexes allocate sequentially within the request (adjacent
 * same-kind blocks fold later, at context append — see Context).
 * @param {object} block - one script block
 * @param {object} state - per-request translator state (owned by IO)
 * @returns {Array<object>} normalized response events
 */
function msg2events(block, state = {}) {
  const index = (state.nextIndex = (state.nextIndex ?? -1) + 1);

  if (typeof block?.thinking === "string") {
    return [
      { type: "thinking_start", contentIndex: index },
      { type: "thinking_delta", contentIndex: index, text: block.thinking },
      { type: "thinking_end", contentIndex: index },
    ];
  }
  if (typeof block?.text === "string") {
    return [
      { type: "text_start", contentIndex: index },
      { type: "text_delta", contentIndex: index, text: block.text },
      { type: "text_end", contentIndex: index },
    ];
  }
  if (block?.toolCall !== null && typeof block?.toolCall === "object") {
    const call = block.toolCall;
    const callId = call.callId ?? `test-${(state.callSeq = (state.callSeq ?? 0) + 1)}`;
    const args = call.arguments ?? {};
    return [
      {
        type: "toolcall_start",
        contentIndex: index,
        callId,
        name: call.name,
        arguments: args,
      },
      { type: "toolcall_end", contentIndex: index, arguments: args },
    ];
  }
  if (typeof block?.error === "string") {
    return [{ type: "error", error: block.error }];
  }
  return [
    {
      type: "error",
      error: `test provider: unknown script block ${JSON.stringify(block)?.slice(0, 120)}`,
    },
  ];
}

/* --------------------------------------- metadata surface: models/login */

/** Fixed local model map — never the network, never the auth cache. */
async function models() {
  return Object.fromEntries(Object.entries(FIXED_MODELS).map(([k, v]) => [k, { ...v }]));
}

async function login() {
  return { type: "none" };
}

/** Scripted transport protocol. It is configured as a secret endpoint. */
export default class TestProvider {
  static provider = metadata;

  constructor(url, aiio) {
    this.url = url;
    this.aiio = aiio;
    this.frames = null;
    this.request = null;
  }

  context2msg(context, aiio = this.aiio) { return context2msg(context, aiio); }
  msg2events(message, state, aiio = this.aiio) { return msg2events(message, state, aiio); }
  async send(message) { return send(this, message); }
  async read() { return read(this); }
  async close() { return close(this); }
  async models() { return models(); }
  async login() { return login(); }
}
