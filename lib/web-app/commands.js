/**
 * lib/web-app/commands.js — the web app's slash-command + prompt layer,
 * built ONLY on public Agent/Env façades (never tui-app's private command
 * handlers). A submitted line starting with "/" is routed here; everything
 * else is a chat message.
 *
 * Namespacing mirrors the harness convention: built-ins are namespaced
 * (/context-*, /endpoint-*, /session-*, /agent-*), /tool-<name> runs a
 * registered tool, and a bare /<name> that matches no command expands as a
 * user prompt (Env.promptBody). The everyday aliases /new and /anon and the
 * control words /help, /bye, /exit, /quit stay un-namespaced.
 *
 * Every command returns { text?, exit?, cleared?, renew? } — plain facts the
 * server turns into wire packets; this module never touches a socket.
 */

import Agent from "../agent.js";
import Context from "../context.js";
import Env from "../env.js";
const { systemMessage } = Context;
const { THINKING_LEVELS } = Env;

/** The commands the web app offers for autocomplete. */
export const COMMAND_LIST = Object.freeze([
  "/context-pop", "/context-rollback", "/context-clear-thoughts", "/context-compact", "/context-system",
  "/endpoint-model",
  "/session-new", "/new", "/anon", "/session-resume", "/session-fork", "/session-name",
  "/agent-name", "/agent-safe", "/agent-thinking", "/agent-status",
  "/continue", "/help", "/bye", "/exit", "/quit",
]);

const HELP = [
  "commands (namespaced; /<prompt> expands a user prompt; /tool-<name> runs a tool):",
  "  /new [id|false]            replace this session with a fresh one (false: anonymous)",
  "  /session-resume <id|latest> resume a stored session",
  "  /session-fork [id|false]   fork this session, keeping a snapshot",
  "  /session-name <name>       rename the current session",
  "  /endpoint-model [<endpoint>/<model>]  list or switch the model",
  "  /agent-name [name]         show or set the agent's display name",
  "  /agent-safe [on|off]       read-only (safe) mode",
  "  /agent-thinking [level]    thinking level (" + THINKING_LEVELS.join("/") + ")",
  "  /agent-status              model, session, context, tools",
  "  /context-pop [n]           drop message(s) from the end",
  "  /context-rollback <i>      drop every message at index >= i",
  "  /context-system <text...>  append a system message",
  "  /context-clear-thoughts    strip thinking blocks (no model call)",
  "  /context-compact           summarize the conversation (model call)",
  "  /continue                  re-activate the agent over the current context",
  "  /bye, /exit, /quit         close this agent",
];

const text = (value) => String(value ?? "");
const blockText = (content) => (content ?? []).map((b) => (b?.type === "text" ? text(b.text) : "")).join("");

/**
 * Execute one slash-command or prompt against an agent.
 * @param {Agent} agent
 * @param {string} line - the full submitted line (starts with "/")
 * @param {object} io - { submit:(text)=>void } to inject a model message
 * @returns {Promise<{text?:string, exit?:boolean, cleared?:boolean, renew?:boolean}>}
 */
export async function runCommand(agent, line, io = {}) {
  const newline = line.indexOf("\n");
  const firstLine = newline === -1 ? line : line.slice(0, newline);
  const restLines = newline === -1 ? "" : line.slice(newline + 1);
  const [typed, ...rest] = firstLine.trim().split(/\s+/);
  const rawArg = [rest.join(" "), restLines].filter((v) => v !== "").join("\n");
  const name = typed.slice(1);

  // /tool-<name> — run a registered tool directly (the manual door).
  if (name.startsWith("tool-")) {
    const tool = name.slice("tool-".length);
    if (!agent.env.hasTool(tool)) return { text: `unknown tool: ${typed}` };
    let args = {};
    if (rawArg.trim() !== "") {
      try { args = JSON.parse(rawArg); } catch { args = rawArg; }
    }
    try {
      const value = await agent.env.callTool(tool, args, { question: null, env: agent.env, call: undefined, agent });
      const result = typeof value === "object" && value !== null && "result" in value ? value.result : value;
      return { text: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
    } catch (error) {
      return { text: `tool ${tool} failed: ${error?.message ?? error}` };
    }
  }

  switch (typed) {
    case "/help": return { text: HELP.join("\n") };

    case "/bye": case "/exit": case "/quit":
      agent.close();
      return { text: "session closed", exit: true };

    case "/new": case "/session-new": {
      const id = rest[0];
      const result = agent.newSession(["0", "false", "anon"].includes(id) ? false : id);
      return { text: result.anonymous ? "new anonymous session" : `new session: ${result.id}`, cleared: true, renew: true };
    }
    case "/anon": { const result = agent.newSession(false); return { text: "new anonymous session", cleared: true, renew: true }; }

    case "/session-resume": {
      const id = rest[0] ?? "latest";
      const result = agent.resumeSession(id);
      return { text: `resumed session: ${result.id}`, cleared: true, renew: true };
    }
    case "/session-fork": { const result = agent.fork(rest[0]); return { text: `forked: ${result.id ?? "anonymous"}`, cleared: true, renew: true }; }
    case "/session-name": {
      if (!rest[0]) return { text: "usage: /session-name <name>" };
      const result = agent.renameSession(rest.join(" "));
      return { text: `session named: ${result.id}` };
    }

    case "/endpoint-model": {
      if (rest.length === 0) {
        const current = `${agent.endpoint ? `${agent.endpoint}/` : ""}${agent.model ?? "(none)"}`;
        const candidates = agent.env ? [...new Set([agent.endpoint, ...(agent.env.endpointNames?.() ?? [])])].filter(Boolean) : [];
        return { text: `model: ${current}\nendpoints: ${candidates.join(", ") || "(none)"}` };
      }
      const CLI = (await import("../cli.js")).default;
      const combo = await CLI.resolveModelCombo(rest[0], agent.env, { url: agent.url });
      if (combo.endpoint === undefined || combo.model === undefined) return { text: `unknown model "${rest[0]}"` };
      agent.endpoint = combo.endpoint;
      agent.model = combo.model;
      CLI.writeLastCombo(agent.env, { endpoint: agent.endpoint, model: agent.model });
      return { text: `endpoint: ${agent.endpoint}, model: ${agent.model}` };
    }

    case "/agent-name": {
      if (rest.length === 0) return { text: `agent name: ${agent.name}` };
      const value = rest.join(" ").trim();
      if (value === "") return { text: "usage: /agent-name [name]" };
      agent.name = value;
      return { text: `agent name: ${agent.name}`, renew: true };
    }
    case "/agent-safe": {
      if (rest.length === 0) return { text: `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}` };
      const on = rest[0] === "on" || rest[0] === "true";
      agent.setSafe(on);
      return { text: `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}` };
    }
    case "/agent-thinking": {
      if (rest.length === 0) return { text: `thinking: ${agent.thinking ?? "provider default"} (levels: ${THINKING_LEVELS.join(", ")})` };
      const level = rest[0];
      if (!THINKING_LEVELS.includes(level)) return { text: `unknown thinking level "${level}" (use ${THINKING_LEVELS.join("/")})` };
      agent.setThinking(level === "default" ? undefined : level);
      return { text: `thinking: ${level}` };
    }
    case "/agent-status": {
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const m of agent.context) if (m?.type in counts) counts[m.type]++;
      const combo = `${agent.endpoint ? `${agent.endpoint}/` : ""}${agent.model ?? "(none)"}`;
      const tools = agent.env.toolNames?.() ?? [];
      return { text: [
        `model: ${combo} (thinking: ${agent.thinking ?? "provider default"})`,
        `session: ${agent.session ? agent.session.id : "anonymous"}`,
        `context: ${agent.context.length} message(s) — ${counts[1]} system, ${counts[2]} user, ${counts[3]} assistant, ${counts[4]} tool`,
        `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}`,
        `tools (${tools.length}): ${tools.join(", ")}`,
      ].join("\n") };
    }

    case "/context-pop": {
      const count = Math.max(1, Number.parseInt(rest[0] ?? "1", 10) || 1);
      for (let i = 0; i < count; i++) agent.pop();
      return { text: `popped ${count} message(s)`, renew: true };
    }
    case "/context-rollback": {
      const index = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(index)) return { text: "usage: /context-rollback <i>" };
      agent.rollback(index);
      return { text: `rolled back to ${index}`, renew: true };
    }
    case "/context-system": {
      if (rawArg.trim() === "") return { text: "usage: /context-system <text...>" };
      agent.append(systemMessage(rawArg));
      return { text: "system message appended", renew: true };
    }
    case "/context-clear-thoughts": {
      const before = agent.context.length;
      agent.context = agent.context.map((m) => m?.type === Context.MessageType.Assistant
        ? { ...m, content: (m.content ?? []).filter((b) => b?.type !== Context.ContentType.Thinking) }
        : m);
      return { text: "thinking blocks cleared", renew: true };
    }
    case "/context-compact": {
      const result = await agent.compact();
      return { text: result.ok ? `compacted ${result.before} messages` : "nothing to compact", renew: true };
    }
    case "/continue": {
      if (typeof io.continue === "function") io.continue();
      return { text: "continuing" };
    }

    default: {
      // A bare /<name> that is no command expands as a user prompt.
      const body = agent.env.promptBody?.(name);
      if (body == null) return { text: `unknown command or prompt: ${typed} (/help lists commands)` };
      const submit = rawArg ? `${body}\n${rawArg}` : body;
      if (typeof io.submit === "function") io.submit(submit);
      return { text: undefined };
    }
  }
}

/** Autocomplete catalog: slash commands, user prompts, and tools. */
export function catalog(agent) {
  const env = agent?.env;
  return {
    commands: COMMAND_LIST,
    prompts: env?.promptNames?.() ?? [],
    tools: (env?.toolNames?.() ?? []).map((name) => `/tool-${name}`),
    toolSchemas: env?.toolSchemas?.(undefined, { includeSecret: true }) ?? [],
  };
}
