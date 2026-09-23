/**
 * lib/tool-sandbox.js — defensive tool encapsulation: run a tool call
 * in a FORKED child process, so a tool that crashes the process it is
 * in (process.exit, a native segfault, an uncaught top-level throw)
 * can never take the Agent's process down with it. With
 * `sandbox: true` (the tool's schema metadata) the worker itself is
 * wrapped in the OS write sandbox (lib/env/os-sandbox.js) — the kernel
 * denies every write outside Env's project folder, while the worker's real
 * cwd is the agent's working folder, for the worker and anything it spawns.
 *
 * A fork requires a worker-loadable module file (`entry.file`): the worker
 * reconstructs a tool by importing that file. Built-ins and programmatic
 * registrations are closures in the host process, not serializable modules,
 * so they stay in-process. This is a worker-capability boundary, separate
 * from the tool's trust or sandbox policy.
 *
 * Protocol (one shot): the parent writes one JSON line to the child's
 * stdin — {dir, settings, roots, name, args, cwd} — the child (lib/
 * tool-worker.js) rebuilds an Env, invokes the tool, and writes one
 * JSON line to stdout: {ok: true, value} or {ok: false, error}. Any
 * other outcome — nonzero exit, closed stdout without a result,
 * timeout — resolves as {ok: false, error}. Never throws.
 */

import { spawn } from "node:child_process";
import { NAMES } from "../namespace.js";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve as resolvePath } from "node:path";
import Env from "../env.js";
const { osSandboxWrap, DEFAULT_TOOL_TIMEOUT: ENV_DEFAULT_TOOL_TIMEOUT } = Env;

/** Default Agent-enforced tool-call duration (120 seconds). */
export const DEFAULT_TOOL_TIMEOUT = ENV_DEFAULT_TOOL_TIMEOUT;

const WORKER = fileURLToPath(new URL("./tool-worker.js", import.meta.url));

/**
 * Run one tool call in a forked child process; never throws — every
 * failure (spawn error, crash, timeout, bad result line) resolves as
 * {ok: false, error}.
 * @param {Object} options
 * @param {object} options.env - the parent's registry
 *   surface (dir/settings/tool roots are handed to the child)
 * @param {string} options.name - flattened tool name
 * @param {object} options.args - the tool call's arguments
 * @param {number} [options.timeout] - ms before the child is killed
 *   (default 120s; explicit 0 disables — Agent's outer timeout wrapper
 *   uses 0 so it alone owns callback grace + termination)
 * @param {boolean} [options.sandbox] - run the worker under the OS
 *   write sandbox (lib/env/os-sandbox.js — the kernel denies writes
 *   outside Env's project folder; the tool's `sandbox: true` metadata)
 * @param {boolean} [options.detached] - default true; false inherits the hosts process group
 * @param {string} [options.cwd] - agent-local tool root (defaults env.cwd)
 * @param {(control: {kill: (signal: string) => void}) => void} [options.onChild]
 *   - receives the child KILL control as soon as it spawns: the
 *   Agent's cancel path signals the in-flight tool through it (the
 *   whole process group when the worker spawns detached)
 * @param {(chunk: string) => void} [options.onData] - LIVE streaming:
 *   the worker's stderr line channel ("{"data": ...}" records —
 *   a tool's incremental output, e.g. a running bash command) rides
 *   back here DURING execution, capped on arrival; the result line
 *   keeps sole ownership of stdout.
 * @param {(questions: Array) => Promise<Array|null>|Array|null} [options.onQuestion]
 *   Trusted-host bridge for a sandbox worker's typed fd-3 `ask` request.
 *   fd 3 is worker→host and fd 4 host→worker JSONL; both close at teardown.
 * @param {boolean} [options.questionBridge] - whether the worker receives a
 *   callable question bridge (false preserves the ordinary headless refusal).
 * @param {typeof spawn} [options.spawnImpl] - injectable for tests
 * @returns {Promise<{ok: true, value: any} | {ok: false, error: string}>}
 */
export function callToolSandboxed({
  env, name, args, timeout = DEFAULT_TOOL_TIMEOUT, sandbox = false, detached = true, cwd, spawnImpl = spawn, onChild, onData, onQuestion, questionBridge = false,
}) {
  return new Promise((resolve) => {
    let child;
    const toolRoot = typeof cwd === "string" ? cwd : (typeof env?.cwd === "string" ? env.cwd : process.cwd());
    try {
      // The OS jail covers the whole project, matching the permitted
      // project-relative paths. Its process cwd remains the narrower agent
      // folder, so relative paths mean the same thing in every tool.
      const projectRoot = typeof env?.cwd === "string" ? resolvePath(env.cwd) : toolRoot;
      const [file, argv] = sandbox
        ? osSandboxWrap(process.execPath, [WORKER], projectRoot, toolRoot)
        : [process.execPath, [WORKER]];
      child = spawnImpl(file, argv, {
        // Two directional IPC pipes: fd 3 worker→host requests and fd 4
        // host→worker replies. stdin keeps its one-shot bootstrap contract.
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        // the worker marks itself: a tool module CAN tell it runs
        // forked (import-time side effects belong behind this flag —
        // the parent's tool scan imports the same files in-process)
        env: { ...process.env, [NAMES.toolWorkerEnv]: "1" },
        // Every tool sees the agent folder as its real working directory;
        // even non-jailed forked calls must not inherit the host cwd.
        cwd: toolRoot,
        // the worker spawns DETACHED (its own process group): a cancel
        // or timeout kill must reach the WHOLE group — the tool's own
        // children (a bash command) and the sandbox wrapper between us
        // and the worker (sandbox-exec/bwrap) would otherwise orphan
        ...(process.platform !== "win32" ? { detached } : {}),
      });
    } catch (err) {
      resolve({ ok: false, error: `worker spawn failed: ${err.message}` });
      return;
    }
    let settled = false;
    const closeIPC = () => {
      for (const pipe of [child.stdio?.[3], child.stdio?.[4]]) {
        try { pipe?.end?.(); } catch { /* already closed */ }
        try { pipe?.destroy?.(); } catch { /* already closed */ }
      }
    };
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeIPC();
      resolve(result);
    };
    // the cancel path's kill control: signal the child — the WHOLE
    // process group (the worker spawns detached: the tool's own
    // children and the sandbox wrapper come along)
    const kill = (signal) => {
      if (settled) return;
      try {
        if (process.platform !== "win32" && detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };
    onChild?.({ kill });
    const timer = timeout > 0
      ? setTimeout(() => {
          kill("SIGKILL");
          done({ ok: false, error: `timed out after ${timeout}ms` });
        }, timeout)
      : null;
    timer?.unref?.();

    // chunk-collected, decoded ONCE: per-chunk Buffer→string coercion
    // splits multi-byte UTF-8 at chunk boundaries (replacement chars
    // would corrupt the result line's payload)
    const outChunks = [];
    const errChunks = [];
    const text = (chunks) => Buffer.concat(
      chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)),
    ).toString("utf8");
    child.stdout.on("data", (chunk) => { outChunks.push(chunk); });
    // fd 3 is a strict worker→host request channel. Only a schema-shaped ask
    // enters the trusted bridge; malformed/unknown records have no effect.
    const ipcRequests = child.stdio?.[3];
    const ipcReplies = child.stdio?.[4];
    let ipcPending = "";
    ipcRequests?.setEncoding?.("utf8");
    ipcRequests?.on("data", (chunk) => {
      ipcPending += String(chunk);
      if (ipcPending.length > 64_000) { try { ipcRequests.destroy(); } catch {} return; }
      let nl;
      while ((nl = ipcPending.indexOf("\n")) >= 0) {
        const line = ipcPending.slice(0, nl);
        ipcPending = ipcPending.slice(nl + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.type !== "ask" || typeof message.id !== "string" || !Array.isArray(message.questions)) continue;
        Promise.resolve(typeof onQuestion === "function" ? onQuestion(message.questions) : null)
          .then((answers) => reply(message.id, answers))
          .catch(() => reply(message.id, null));
      }
    });
    ipcRequests?.on("error", () => {});
    ipcReplies?.on("error", () => {});
    const reply = (id, answers) => {
      if (settled || ipcReplies?.destroyed || !ipcReplies?.writable) return;
      try { ipcReplies.write(`${JSON.stringify({ type: "answer", id, answers })}\n`); } catch { /* worker ended */ }
    };
    // stderr doubles as the LIVE DATA channel: the worker's own
    // progress records are complete "{"data": ...}" lines (relayed
    // to onData, bounded per call); genuine worker noise still
    // collects for the exit report.
    const STREAM_LIMIT = 4_000;
    let streamed = 0;
    let errPending = "";
    child.stderr.on("data", (chunk) => {
      errChunks.push(chunk);
      if (typeof onData !== "function") return;
      errPending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl;
      while ((nl = errPending.indexOf("\n")) >= 0) {
        const line = errPending.slice(0, nl).trim();
        errPending = errPending.slice(nl + 1);
        if (!line.startsWith('{"data":')) continue;
        if (streamed >= STREAM_LIMIT) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.data !== "string") continue;
          const remaining = STREAM_LIMIT - streamed;
          const piece = parsed.data.length <= remaining
            ? parsed.data
            : `${parsed.data.slice(0, remaining)}\n[… live output capped …]`;
          streamed += piece.length;
          onData(piece);
        } catch { /* not a data record */ }
      }
    });
    child.on("error", (e) => done({ ok: false, error: `worker spawn failed: ${e.message}` }));
    child.on("close", (code, signal) => {
      const out = text(outChunks);
      const err = text(errChunks);
      // the result is the LAST non-empty stdout line — imported tool
      // modules may print their own noise before it
      const line = out.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
      if (line !== "") {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.ok === "boolean") return done(parsed);
        } catch { /* not a result line — fall through to the exit report */ }
      }
      const detail = err.trim().split("\n")[0];
      const how = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
      done({
        ok: false,
        error: `worker exited without a result (${how})${detail ? `: ${detail}` : ""}`,
      });
    });

    const request = JSON.stringify({
      dir: env.dir,
      settings: env.settings,
      roots: env._toolRoots ?? undefined,
      name,
      args,
      questionBridge,
      detached,
      // The parent's already-validated registry names the module file:
      // the worker imports that ONE module instead of rescanning every
      // tool root (a stray duplicate file can never fail this call).
      // The path must be ABSOLUTE — the worker's cwd is the jailed
      // root, not this process's cwd.
      ...(typeof env?.toolEntry === "function" && typeof env.toolEntry(name)?.file === "string"
        ? { file: isAbsolute(env.toolEntry(name).file) ? env.toolEntry(name).file : resolvePath(env.toolEntry(name).file) }
        : {}),
      // `cwd` is the real tool working directory; projectCwd remains the
      // enclosing Env boundary for guards and project configuration.
      cwd: toolRoot,
      projectCwd: typeof env?.cwd === "string" ? resolvePath(env.cwd) : toolRoot,
    });
    child.stdin.on?.("error", () => {}); // the child may already be gone
    child.stdin.end(request);
  });
}
