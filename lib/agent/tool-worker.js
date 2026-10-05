/**
 * lib/agent/tool-worker.js — the child-process side of
 * lib/agent/tool-sandbox.js.
 *
 * Spawned as `<runtime> lib/agent/tool-worker.js`: reads ONE JSON line
 * from stdin — {dir, settings, roots, name, args, cwd, projectCwd,
 * file?, questionBridge?, detached?} — rebuilds an Env
 * from it, loads the ONE tool module the parent's registry named
 * (file; never a root rescan), invokes the tool, and writes ONE JSON
 * result line to stdout:
 * {ok: true, value} or {ok: false, error}. All ordinary failures are
 * reported on stdout with exit 0; a nonzero exit (or silence) means
 * the tool destroyed the process (e.g. process.exit) and the parent
 * reports that instead — which is the entire point of the sandbox.
 *
 * THE RESULT LINE IS THE LAST THING WRITTEN — and it must survive
 * everything a tool printed at IMPORT (a script without an
 * import.meta.main guard can dump megabytes onto stdout while the
 * tool scan loads it): the process exits only after the writable
 * side FLUSHED. process.exit() right after write() discards
 * user-space pipe buffers — the truncated-result race the parent
 * reports as "worker exited without a result (code 0)".
 *
 * This file is executed, not imported, and must stay runtime-agnostic
 * (no Bun-only APIs).
 */

import Env from "../env.js";
import Sandbox from "../sandbox.js";
import { createReadStream, createWriteStream } from "node:fs";

/**
 * Host-only tool modules the worker never loads: their registry entry has
 * no worker-loadable module file, so the Agent never forks them. A worker
 * hit means a hand-written tool root shadows a host-managed name, and loading
 * the harness module would ALSO shadow every call into the in-process
 * tool. (skill.js is NOT here: a forkable tool that builds its own
 * throwaway Env per call.) Keeping these out of the worker halves its
 * startup: process + OS-jail + settings + ONE tool module.
 */
// chat and note need rich host-owned state. Question crosses only the
// explicit ask/answer IPC above, so it is safe to run in the worker.
const WORKER_SKIP = /(?:^|[\/\\])(?:chat|note)\.js$/;

let settled = false;
// Directional JSONL IPC: fd 3 writes worker requests, fd 4 reads host
// replies. The descriptors are supplied by tool-sandbox.js and are separate
// pipes (not a duplex stream), preserving stdin's one-shot bootstrap.
let ipcOut = null;
let ipcIn = null;
try { ipcOut = createWriteStream(null, { fd: 3, autoClose: false }); } catch { /* no interactive IPC */ }
try { ipcIn = createReadStream(null, { fd: 4, autoClose: false }); } catch { /* no interactive IPC */ }
const waits = new Map();
let sequence = 0;
let replyBuffer = "";
ipcIn?.setEncoding?.("utf8");
/**
 * Consume UTF-8 IPC chunks, buffer bounded JSONL replies, and resolve matching
 * host-question requests. Malformed/irrelevant lines are ignored; oversized
 * input destroys the IPC reader.
 * @param {string|Buffer} chunk Incoming IPC data chunk.
 * @returns {void}
 */
ipcIn?.on("data", (chunk) => {
  replyBuffer += String(chunk);
  if (replyBuffer.length > 64_000) { try { ipcIn.destroy(); } catch {} return; }
  let nl;
  while ((nl = replyBuffer.indexOf("\n")) >= 0) {
    const line = replyBuffer.slice(0, nl);
    replyBuffer = replyBuffer.slice(nl + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.type !== "answer" || typeof message.id !== "string") continue;
    const resolve = waits.get(message.id);
    if (resolve) { waits.delete(message.id); resolve(message.answers ?? null); }
  }
});
/** Resolve all pending host questions with null when the IPC reader ends. @returns {void} */
ipcIn?.on("end", () => { for (const resolve of waits.values()) resolve(null); waits.clear(); });
/** Resolve all pending host questions with null when the IPC reader errors. @returns {void} */
ipcIn?.on("error", () => { for (const resolve of waits.values()) resolve(null); waits.clear(); });
/** Ignore IPC writer errors; unavailable asks are handled by askHost. @returns {void} */
ipcOut?.on("error", () => {});
/**
 * Send questions to the parent over IPC and await its matching answer.
 * @param {unknown} questions Questions to forward unchanged.
 * @returns {Promise<unknown|null>} The host answer, or null if IPC is unavailable or fails.
 */
function askHost(questions) {
  if (!ipcOut?.writable) return Promise.resolve(null);
  const id = `ask-${++sequence}`;
  /** Store the pending resolver and attempt the JSONL write; write failures resolve null. @param {(value: unknown|null) => void} resolve Promise resolver. @returns {void} */
  return new Promise((resolve) => {
    waits.set(id, resolve);
    try { ipcOut.write(`${JSON.stringify({ type: "ask", id, questions })}\n`); }
    catch { waits.delete(id); resolve(null); }
  });
}
/**
 * End and destroy both directional IPC streams, then settle outstanding asks.
 * @returns {void}
 */
function closeIPC() {
  for (const pipe of [ipcOut, ipcIn]) {
    try { pipe?.end?.(); } catch {}
    try { pipe?.destroy?.(); } catch {}
  }
  for (const resolve of waits.values()) resolve(null);
  waits.clear();
}
/** Close IPC and exit successfully once stdout has flushed. @returns {void} */
process.stdout.on("finish", () => { closeIPC(); process.exit(0); });
/** Exit unsuccessfully if stdout fails because the parent is gone. @returns {void} */
process.stdout.on("error", () => process.exit(1)); // the parent is gone
/**
 * Write the single result as its own final line, then end stdout so its
 * writable buffer flushes before the process exits. Prefixing a newline ensures
 * import-time tool output that lacks a trailing newline cannot merge with the
 * result and confuse the parent's last-line parse.
 * @param {string} payload Serialized result to send to the parent.
 * @returns {void} Does nothing after a result has already been scheduled.
 */
function finish(payload) {
  if (settled) return;
  settled = true;
  /** End stdout after the result write flushes. @returns {void} */
  process.stdout.write(`\n${payload}\n`, () => process.stdout.end());
}

let input = "";
process.stdin.setEncoding("utf8");
/** Append a UTF-8 bootstrap input chunk. @param {string|Buffer} chunk Input data. @returns {void} */
process.stdin.on("data", (chunk) => { input += chunk; });
/** Start the worker after stdin's one-shot JSON bootstrap is complete. @returns {void} */
process.stdin.on("end", () => {
  /** Convert an otherwise-unhandled main rejection to the worker error result. @param {unknown} err Rejected error. @returns {void} */
  main(input).catch((err) => {
    finish(JSON.stringify({ ok: false, error: `worker: ${err?.message ?? err}` }));
  });
});

/**
 * Resolve ONE tool without a registry scan: import only its module and
 * re-derive the entry the way the scan does (toolDescription(env) —
 * describe()/toolSchema() aliases included — so an `fn`-carrying entry
 * like the mcp-<server> shortcuts rebuilds its closure against the
 * worker's env). A transient stray file in a tool root can never fail
 * the call: nothing rescans the roots.
 * @param {Env} env Worker environment used to rebuild the tool entry.
 * @param {string} file Parent-validated module path to import.
 * @param {string} name Registry tool name to resolve from the module.
 * @returns {Promise<{fn: Function, schema: unknown}>} Resolved callable and schema.
 * @throws {Error} If the module is worker-forbidden or does not expose the named tool.
 */
async function loadSingleTool(env, file, name) {
  if (WORKER_SKIP.test(String(file))) {
    throw new Error(`worker: ${file} is an in-process-only tool module (shadows a builtin name?)`);
  }
  const mod = await import(file);
  const describe = typeof mod.toolDescription === "function" ? mod.toolDescription
    : typeof mod.describe === "function" ? mod.describe
    : typeof mod.toolSchema === "function" ? mod.toolSchema
    : null;
  const schema = describe?.(env)?.[name];
  const fn = typeof schema?.fn === "function" ? schema.fn : mod[name];
  if (typeof fn !== "function") throw new Error(`worker: ${file} does not publish "${name}"`);
  return { fn, schema };
}

/**
 * Rebuild the worker environment, register and invoke the requested tool, then
 * send its serialized success or failure result to the parent.
 * @param {string} raw JSON bootstrap record from stdin.
 * @returns {Promise<void>} Resolves after result handling; ordinary failures are reported on stdout.
 * @throws {Error} Malformed input or environment, loading, and registration failures reject
 *   and are converted by the stdin handler into a worker error result.
 */
async function main(raw) {
  const { dir, settings, name, args, cwd, projectCwd, file, questionBridge, deadline } = JSON.parse(raw);
  // cwd is the Agent working directory. The rebuilt Env retains projectCwd
  // for reads; the OS jail permits writes only beneath cwd.
  const env = new Env({ dir, settings, cwd: projectCwd ?? cwd, auth: false });
  // The parent's validated registry names the module file; load that
  // ONE module (no rescan) and register it under the call's name so
  // the dispatch below is the registry's own path — the same entry
  // resolution the in-process call uses (a stale name throws through
  // the registry, not a bespoke branch).
  if (typeof file !== "string") throw new Error(`worker: no module file for "${name}"`);
  const single = await loadSingleTool(env, file, name);
  env.toolAdd(name, single.fn, single.schema, { file });
  try {
    // a NEAR-PLAIN tool context (only data can cross the fork):
    // settings-reading tools (bash's env inheritance stages) see the
    // same tree the in-process path would hand them; the one-way
    // onData bridge streams a tool's incremental output (a running
    // bash command) back to the parent over stderr records — each a
    // complete line, never interleaved with the worker's diagnostics
    /**
     * Forward one-line incremental tool output to the parent as a stderr JSON record.
     * @param {string} chunk Tool output fragment; non-string, empty, or multiline data is ignored.
     * @returns {void} Write failures are swallowed when the parent has gone away.
     */
    const onData = (chunk) => {
      if (typeof chunk !== "string" || chunk === "") return;
      if (chunk.includes("\n") || chunk.includes("\r")) return; // one record per line
      try { process.stderr.write(`${JSON.stringify({ data: chunk })}\n`); } catch { /* the parent is gone */ }
    };
    const value = await env.toolCall(name, args, {
      detached: false,
      sandbox: Sandbox,
      deadline,
      question: questionBridge === true ? { ask: askHost } : null,
      // Preserve the parent's working-directory context separately from
      // Env.cwd, which remains the project boundary in this worker.
      agent: { folder: cwd },
      env,
      onData,
    });
    let line;
    try {
      line = JSON.stringify({ ok: true, value: value ?? null });
    } catch {
      line = JSON.stringify({ ok: true, value: String(value) }); // non-serializable: degrade, don't die
    }
    finish(line);
  } catch (err) {
    // a thrown error's `system` payload (string|string[]) rides along —
    // the parent's Agent appends it to the context as System messages
    const system = typeof err?.system === "string" || Array.isArray(err?.system)
      ? { system: err.system }
      : {};
    finish(JSON.stringify({ ok: false, error: err?.message ?? String(err), ...system }));
  }
}
