// test/fakes.js — shared test doubles for the Agent unit.
// Not a test file: bun test only runs *.test.js.
import { readdirSync, rmSync, statSync } from "node:fs"; // vacuumStaleTempDirs
import { normalizeCallbacks, dispatch } from "../lib/context.js";
import { createAssembler } from "../lib/context.js";

/**
 * A fake IO duck-type: { state, write(context, callbacks, options),
 * kill() }. `handler(io, callbacks, options)` returns the terminal event.
 * Every write snapshots the received context (Agent must pass the
 * COMPLETE current context each request).
 */
export function fakeIO(handler) {
  const io = {
    state: "idle",
    writes: [],
    kills: 0,
    async write(context, callbacks = {}, options = {}) {
      io.writes.push({ context: structuredClone(context), options });
      return handler(io, callbacks, options);
    },
    async kill() {
      io.kills++;
      io.state = "closed";
      io._onKill?.();
    },
  };
  return io;
}

/**
 * A fake IO scripted per turn: script[i] is an array of normalized
 * events for write #i (last entry repeats). Terminal events get the
 * assembled message attached, mirroring real IO behavior.
 */
export function scriptedIO(script) {
  let turn = 0;
  const io = fakeIO(async (_io, callbacks) => {
    const events = script[Math.min(turn, script.length - 1)];
    turn++;
    return emitScript(events, callbacks);
  });
  io.turns = () => turn;
  return io;
}

/** Dispatch a scripted event list; returns the terminal event. */
export function emitScript(events, callbacks = {}) {
  const assembler = createAssembler();
  const set = normalizeCallbacks(callbacks, {});
  let terminal = null;
  for (const raw of events) {
    let event = raw;
    if ((event.type === "done" || event.type === "error") && event.message === undefined) {
      const assembled = assembler.message();
      if (assembled.content.length > 0) event = { ...event, message: assembled };
    }
    assembler.consume(event);
    if (Number.isInteger(event.contentIndex)) event.content = assembler.message().content[event.contentIndex];
    dispatch(set, event);
    if (event.type === "done" || event.type === "error") terminal = event;
  }
  if (!terminal) {
    const assembled = assembler.message();
    terminal = assembled.content.length > 0 ? { type: "done", message: assembled } : { type: "done" };
    dispatch(set, terminal);
  }
  return terminal;
}

/** A createIO factory recording every construction. */
export function recordingFactory(make) {
  const made = [];
  const factory = (opts) => {
    const io = make(opts, made.length);
    made.push({ opts, io });
    return io;
  };
  factory.made = made;
  return factory;
}

/** A throwaway Env rooted at an empty folder (no JSON scan noise).
 *  Leak control: bun test never fires process "exit" and module
 *  instances multiply under the runner, so hook-based cleanup is
 *  unreliable — instead the first testEnv of a process VACUUMS stale
 *  env-* dirs (older than an hour, never in-use ones). Thousands of
 *  leaked empty dirs in ai-tmp break posix_spawn (EBADF) when the
 *  project lives on a synced (iCloud) volume. */
let tempVacuumed = false;
function vacuumStaleTempDirs() {
  if (tempVacuumed) return;
  tempVacuumed = true;
  try {
    const cutoff = Date.now() - 3_600_000;
    for (const name of readdirSync("./ai-tmp")) {
      if (!name.startsWith("env-")) continue;
      try {
        if (statSync(`./ai-tmp/${name}`).mtimeMs < cutoff) {
          rmSync(`./ai-tmp/${name}`, { recursive: true, force: true });
        }
      } catch { /* vanished or unreadable: skip */ }
    }
  } catch { /* no ai-tmp yet */ }
}
export async function testEnv() {
  const { mkdtempSync } = await import("node:fs");
  const { Env } = await import("../lib/env.js");
  vacuumStaleTempDirs();
  const dir = mkdtempSync("./ai-tmp/env-");
  // cwd isolated too (defaults to process.cwd() — the repo root while
  // running the suite): resolveSystemPrompt()'s project-local AGENTS.md
  // layer must never pick up whatever real file happens to sit there.
  // The user settings layer pins to the same folder (dynamic writes
  // land here, never in the shared suite layer).
  // Deterministic named endpoints let Agent unit tests exercise connection
  // selection without detecting or depending on any locally installed service.
  const providers = Object.fromEntries(
    ["capturing", "fake", "p", "p1", "p2", "test", "x"].map((name) => [name, { provider: "test", url: "test://script" }]),
  );
  return new Env({ dir, cwd: dir, settings: { providers }, settingsDir: dir });
}

export const USER = (text) => ({ type: 2, content: [{ type: "text", text }] });
export const TOOLCALL = (contentIndex, callId, name, args) => [
  { type: "toolcall_start", contentIndex, callId, name, arguments: args },
  { type: "toolcall_end", contentIndex, arguments: args },
];
export const TEXT = (contentIndex, text) => [
  { type: "text_start", contentIndex },
  { type: "text_delta", contentIndex, text },
  { type: "text_end", contentIndex },
];
