/**
 * tools/bash.js — run a bash command from the working folder.
 *
 * The command scanner refuses visible outside paths, `cd`, `ln`, and `ls`; the Agent's
 * OS sandbox denies writes outside the working folder. This cannot prevent a
 * command from reading through a symlink created or supplied inside the tree:
 * see SECURITY.md. The `read` tool does reject symlinks directly.
 */

import { spawn } from "node:child_process";
// The tiny MCP-runtime module carries the shared tool revision: Bun
// resolves it to ONE instance across cache-busted imports, so this
// tool stamps its helper imports WITHOUT loading the whole library —
// a forked sandbox worker stays process + jail + settings + this file.
import { toolRevision } from "../lib/tool-runtime.js";

const timestamp = toolRevision();
const { findCommandTraversal } = await import(`./guard/paths.js?now=${timestamp}`);
const { childEnv } = await import(`./guard/env.js?now=${timestamp}`);

const MAX_OUTPUT = 50_000;
const ACTIVE_CHILDREN = new Set();
const CD_WORDS = new Set(["cd"]);
const LINK_WORDS = new Set(["ln"]);
const LIST_WORDS = new Set(["ls"]);
const PREFIX_WORDS = new Set(["command", "builtin", "exec", "env", "time", "nice", "sudo", "xargs"]);

function refusal(message) {
  return new Error(message);
}

function commandWord(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  if (index >= words.length) return null;
  let word = words[index];
  while (PREFIX_WORDS.has(word) && index + 1 < words.length) {
    word = words[++index];
    if (word.startsWith("-")) return null;
  }
  return word;
}

export function hasCdCommand(command) {
  return String(command).split(/[;&|()\n`]+/).some((segment) => CD_WORDS.has(commandWord(segment)));
}

/** True when a command segment invokes ln, which can author links. */
export function hasLinkCommand(command) {
  return String(command).split(/[;&|()\n`]+/).some((segment) => LINK_WORDS.has(commandWord(segment)));
}

/** True when a command segment invokes ls, which inspects folder contents. */
export function hasListCommand(command) {
  return String(command).split(/[;&|()\n`]+/).some((segment) => LIST_WORDS.has(commandWord(segment)));
}

function capOutput(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  return `${text.slice(0, half)}\n[… ${text.length - MAX_OUTPUT} characters elided …]\n${text.slice(-half)}`;
}

export async function bash({ command, env } = {}, context) {
  if (typeof command !== "string" || command.trim() === "") {
    throw new TypeError("Provide a non-empty Bash command, then try again.");
  }
  if (hasCdCommand(command)) {
    throw refusal("Remove cd and use paths relative to the working folder instead.");
  }
  if (hasLinkCommand(command)) {
    throw refusal("Remove ln and use a regular file or folder instead.");
  }
  if (hasListCommand(command)) {
    throw refusal("Use the read tool to inspect folders instead of ls.");
  }
  const cwd = context?.agent?.folder ?? context?.env?.cwd ?? context?.agent?.env?.cwd ?? process.cwd();
  const boundary = context?.env?.cwd ?? context?.agent?.env?.cwd ?? cwd;
  const violations = await findCommandTraversal(command, { cwd, boundary });
  if (violations.length > 0) {
    throw refusal("Keep every path argument inside the working folder, then try again.");
  }
  const onData = typeof context?.onData === "function" ? context.onData : null;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("bash", ["-c", command], {
        cwd, env: childEnv(context?.env?.settings, env),
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" && context?.detached !== false,
      });
    } catch (error) { reject(error); return; }
    ACTIVE_CHILDREN.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      ACTIVE_CHILDREN.delete(child);
      fn(value);
    };
    // LIVE STREAMING: complete output lines ride to the binding
    // DURING execution (context.onData — the TUI shows the command
    // isn't stuck), while the full output still collects for the
    // final result. One-line records only: a chunk's trailing partial
    // line waits for its terminator.
    const stream = { out: "", err: "" };
    const emitLines = (which, chunk) => {
      if (onData === null) return;
      stream[which] += String(chunk);
      let nl;
      while ((nl = stream[which].indexOf("\n")) >= 0) {
        const line = stream[which].slice(0, nl);
        stream[which] = stream[which].slice(nl + 1);
        if (line !== "") onData(line);
      }
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; emitLines("out", chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; emitLines("err", chunk); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      let text = stdout.trimEnd();
      if (stderr.trim() !== "") text += `${text === "" ? "" : "\n"}[stderr]\n${stderr.trimEnd()}`;
      text = capOutput(text) || "(no output)";
      if (code !== 0) text = `[exit code ${code ?? "?"}]\n${text}`;
      finish(resolve, text);
    });
  });
}

export function onTimeout() {
  for (const child of ACTIVE_CHILDREN) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

export function toolDescription() {
  return { bash: {
    // The worker relays complete output records through its one-way stderr
    // protocol, so bash remains forked and OS-sandboxed while streaming.
    sandbox: true, onTimeout,
    description: "Run a Bash command in the working folder; return output and any exit code. Use read to inspect folders.",
    inputSchema: { type: "object", properties: {
      command: { type: "string", description: "The bash command line to run (no cd, ln, or ls; use read for folder listing; every visible path argument must stay inside the working folder)" },
      timeout: { type: "integer", description: "Requested milliseconds timeout (default: 120000; capped at 1200000)" },
      env: { type: "object", description: "Extra environment variables for the command." },
    }, required: ["command"] },
  } };
}
