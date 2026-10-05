/**
 * lib/web-app/commands.js — the web app's slash-command + prompt layer,
 * built ONLY on public Agent/Env/CLI façades (never tui-app's private command
 * handlers). A submitted line starting with "/" is routed here; everything
 * else is a chat message.
 *
 * Namespacing mirrors the harness convention: built-ins are namespaced
 * (/context-*, /endpoint-*, /session-*, /agent-*), /tool-<name> runs a
 * registered tool, and a bare /<name> that matches no command expands as a
 * user prompt (env.prompts()). The everyday aliases /new and /anon and the
 * control words /help, /menu, /reload, /bye, /exit, /quit stay un-namespaced.
 * A unique prefix is enough (/context-c… is ambiguous, /agent-st is not).
 *
 * Every command returns { text?, exit?, cleared?, renew?, open?, copy? } —
 * plain facts the server turns into wire packets; this module never touches a
 * socket. `open` names a client view (login, palette, context, help); `copy`
 * is text for the browser clipboard.
 */

import Context from "../../context.js";
import IO from "../../io.js";
import CLI from "../../cli.js";
import Agent from "../../agent.js";
import { modelParts } from "../shared/format.js";
const { messageSystem, ContentType, MessageType } = Context;
const THINKING_LEVELS = ["default", ...IO.THINKING_LEVELS];

/** The commands the web app offers for autocomplete. */
export const COMMAND_LIST = Object.freeze([
  "/context-edit", "/context-pop", "/context-rollback", "/context-system", "/context-copy",
  "/context-clear-thoughts", "/context-compact", "/compact",
  "/endpoint-model", "/endpoint-login", "/endpoint-logout", "/endpoint-oauth-paste",
  "/session-new", "/new", "/anon", "/session-resume", "/session-fork", "/session-name",
  "/session-delete!", "/session-delete-all!",
  "/agent-name", "/agent-safe", "/agent-thinking", "/agent-session-save", "/agent-status",
  "/continue", "/reload", "/menu", "/help", "/bye", "/exit", "/quit",
]);

/** Per-command argument hints (ghost text after the command in the composer). */
export const COMMAND_HINTS = Object.freeze({
  "/compact": "[focus…]", "/context-edit": "[i]", "/context-pop": "[count]", "/context-rollback": "<i>", "/context-system": "<text…>",
  "/endpoint-model": "[endpoint/model]", "/endpoint-login": "[package|local endpoint provider url [token]]",
  "/endpoint-logout": "<endpoint>", "/endpoint-oauth-paste": "<redirect-url|code#state>",
  "/session-new": "[id|false]", "/new": "[id|false]", "/session-resume": "[id|latest]", "/session-fork": "[id|false]",
  "/session-name": "<name>", "/agent-name": "[name]", "/agent-safe": "[on|off]",
  "/agent-thinking": `[${THINKING_LEVELS.join("|")}]`, "/agent-session-save": "[true|false]",
});

const HELP = [
  "commands (namespaced; a unique prefix is enough; /<prompt> expands a user prompt; /tool-<name> runs a tool):",
  "  context — the conversation:",
  "  /context-edit [i]          open the context viewer (editing message i)",
  "  /context-pop [n]           drop message(s) from the end",
  "  /context-rollback <i>      drop every message at index >= i",
  "  /context-system <text...>  append a system message",
  "  /context-copy              copy the last response to the clipboard",
  "  /context-clear-thoughts    strip thinking blocks (no model call)",
  "  /compact [focus...]        summarize history, optionally guiding what to preserve",
  "  /context-compact           alias for /compact",
  "  endpoint — provider connections:",
  "  /endpoint-model [<endpoint>/<model>]  list or switch the model",
  "  /endpoint-login            open the sign-in dialog",
  "  /endpoint-login <package|local> <endpoint> <provider> <url> [token]  direct form",
  "  /endpoint-logout <endpoint>  remove an endpoint (settings + auth)",
  "  /endpoint-oauth-paste <url|code#state>  finish a browser sign-in by hand",
  "  session — persistence:",
  "  /new, /session-new [id|false]  replace this session with a fresh one (false: anonymous)",
  "  /anon                      a new anonymous (unlogged) session",
  "  /session-resume [id|latest] resume a stored session",
  "  /session-fork [id|false]   fork this session, keeping a snapshot",
  "  /session-name <name>       rename the current session",
  "  /session-delete!           clear this session and restart it",
  "  /session-delete-all!       delete ALL session files (asks first)",
  "  agent — runtime behavior:",
  "  /agent-name [name]         show or set the agent's display name",
  "  /agent-safe [on|off]       read-only (safe) mode",
  "  /agent-thinking [level]    thinking level (" + THINKING_LEVELS.join("/") + ")",
  "  /agent-session-save [true|false]  show or set session saving",
  "  /agent-status              model, session, context, tools, plan, MCP",
  "  app:",
  "  /continue                  re-activate the agent over the current context",
  "  /menu                      open the command palette (Ctrl/⌘+K)",
  "  /reload                    re-render the transcript from the context",
  "  /bye, /exit, /quit         close this agent",
];

/** Concatenate text blocks, ignoring non-text blocks.
 * @param {Array<object>} content - Content blocks; nullish input is treated as empty.
 * @returns {string} Joined text content.
 */
const blockText = (content) => (content ?? []).map((b) => (b?.type === ContentType.Text ? String(b.text ?? "") : "")).join("");
/** Format the agent's current endpoint and model selection.
 * @param {Agent} agent - Agent to inspect.
 * @returns {string} Endpoint/model string, using `(none)` when the model is unset.
 */
const combo = (agent) => agent.model ?? "(none)";

/** Resolve a command by exact name or unique prefix; leave ambiguous/unknown text unchanged.
 * @param {string} typed - Submitted command token.
 * @returns {string} The matching command or original token.
 */
export function resolveCommand(typed) {
  if (COMMAND_LIST.includes(typed)) return typed;
  const matches = COMMAND_LIST.filter((command) => command.startsWith(typed));
  return matches.length === 1 ? matches[0] : typed;
}

/** Select the first public model after login, if one is listed.
 * @param {Agent} agent - Agent whose endpoint/model selection is updated.
 * @param {string} name - Logged-in endpoint name.
 * @returns {string} Selected endpoint/model combo, or endpoint name when no model is set.
 * @throws {Error} Propagates errors while listing endpoint models or setting the model.
 */
export function adoptEndpoint(agent, name) {
  const first = CLI.listEndpointModels(agent.env).find((entry) => entry.name === name)?.models[0];
  if (first) (agent.model = `${name}/${first}`);
  return first ? agent.model : name;
}

/** Log out an endpoint and clear the agent selection if it pointed to that endpoint.
 * @param {Agent} agent - Agent whose selection may be cleared.
 * @param {string} name - Endpoint name to remove.
 * @returns {object} Result returned by CLI.logoutEndpoint.
 * @throws {Error} Propagates errors from endpoint logout.
 */
export function removeEndpoint(agent, name) {
  const result = CLI.logoutEndpoint(agent.env, name);
  if (modelParts(agent.model).endpoint === result.name) (agent.model = undefined);
  return result;
}

/**
 * Execute one slash-command or prompt against an agent.
 * @param {Agent} agent - Agent whose context, settings, and tools the command uses.
 * @param {string} line - Full submitted line, normally beginning with "/".
 * @param {object} [io={}] - Optional server hooks: `continue()` resumes agent work and `clear()` clears server-owned messages.
 * @returns {Promise<{text?:string, exit?:boolean, cleared?:boolean, renew?:boolean, open?:string, copy?:string, fill?:string}>} Plain command result for the server to translate into client behavior.
 * @throws {Error} Unexpected failures from agent, environment, CLI, or context operations propagate; tool argument/call errors are returned as result text.
 */
export async function runCommand(agent, line, io = {}) {
  const newline = line.indexOf("\n");
  const firstLine = newline === -1 ? line : line.slice(0, newline);
  const restLines = newline === -1 ? "" : line.slice(newline + 1);
  const [typedRaw, ...rest] = firstLine.trim().split(/\s+/);
  const rawArg = [rest.join(" "), restLines].filter((v) => v !== "").join("\n");

  // //<name> always expands a prompt, never a command or tool.
  if (typedRaw.startsWith("//")) return expandPrompt(agent, typedRaw.slice(2), rawArg);
  const name = typedRaw.slice(1);

  // /tool-<name> — run a registered tool directly (the manual door).
  if (name.startsWith("tool-")) {
    const tool = name.slice("tool-".length);
    const entry = (await agent.env.tools()).get(tool);
    if (!entry) return { text: `unknown tool: ${typedRaw}` };
    let args;
    try { args = CLI.resolveToolArgs(rawArg, { name: tool, schema: entry.schema }); }
    catch (error) { return { text: `tool ${tool}: ${error?.message ?? error}` }; }
    try {
      const value = await agent.env.toolCall(tool, args, { question: agent.question ?? null, env: agent.env, call: undefined, agent });
      const { result, system, display } = CLI.unwrapToolResult(value);
      return { text: [CLI.formatToolResult(result), ...system.map((t) => `[system] ${t}`), ...display.map((t) => `[display] ${t}`)].join("\n") };
    } catch (error) {
      return { text: `tool ${tool} failed: ${error?.message ?? error}` };
    }
  }

  const typed = resolveCommand(typedRaw);
  switch (typed) {
    case "/help": return { text: HELP.join("\n") };
    case "/menu": return { open: "palette" };
    case "/reload": return { renew: true };

    case "/bye": case "/exit": case "/quit":
      agent.close();
      return { text: "session closed", exit: true };

    case "/new": case "/session-new": {
      agent.contextNew(rest[0]); // "0"/"false"/"anon": not logged (Context.idAnonymous)
      return { text: `new session: ${agent.context.summary}`, cleared: true, renew: true };
    }
    case "/anon": { agent.contextNew(false); return { text: `new session: ${agent.context.summary}`, cleared: true, renew: true }; }

    case "/session-resume": {
      let id = rest[0];
      if (id === undefined || id === "latest") id = Context.latest({ dir: agent.env.settings.sessions, cwd: agent.env.cwd });
      if (!id) return { text: "no sessions of this folder to resume" };
      const result = agent.contextResume(id);
      return { text: `resumed session: ${result.id} (${agent.context.length} messages)`, cleared: true, renew: true };
    }
    case "/session-fork": { agent.contextFork(rest[0]); return { text: `forked: ${agent.context.summary}`, cleared: true, renew: true }; }
    case "/session-name": {
      if (!rest[0]) return { text: "usage: /session-name <name>" };
      const result = agent.context.rename(rest.join(" "));
      return { text: `session named: ${result.id}` };
    }
    case "/session-delete!": {
      const count = io.clear ? io.clear() : 0;
      return { text: `cleared ${count} message(s); session restarted (${agent.context.summary})`, renew: true };
    }
    case "/session-delete-all!": {
      const ask = agent.question?.ask;
      if (typeof ask !== "function") return { text: "needs an open browser for the confirmation" };
      const { Context } = await import("../../context.js");
      const dir = agent.env.settings.sessions;
      const count = Context.list({ dir }).length;
      if (count === 0) return { text: "no session files in the sessions folder" };
      const answers = await ask.call(agent.question, [{
        header: "Sessions",
        question: `Delete ALL ${count} session file(s) — every project's, permanently? The live session is unaffected (it may re-persist on its next flush).`,
        options: [{ label: "Cancel", description: "Keep every session file." }, { label: "Delete all", description: `Permanently delete the ${count} session file(s).` }],
      }]);
      if (!Array.isArray(answers) || !answers[0]?.labels?.includes("Delete all")) return { text: "cancelled — no session files deleted" };
      const { deleted } = Context.deleteAll({ dir });
      return { text: `deleted ${deleted} session file(s)` };
    }

    case "/endpoint-model": {
      if (rest.length === 0) {
        const current = combo(agent);
        const candidates = CLI.listModelCandidates(agent.env).sort();
        return { text: [`model: ${current}`, `available (${candidates.length}):`, ...candidates.map((c) => `  ${c}${c === current ? "  ← current" : ""}`)].join("\n") };
      }
      const selected = await CLI.resolveModelCombo(rest[0], agent.env);
      const endpoint = modelParts(agent.model).endpoint;
      const isBareModel = !rest[0].includes("/") && !CLI.listEndpointModels(agent.env).some(({ name }) => name === rest[0]);
      const qualified = selected ?? (isBareModel && endpoint ? `${endpoint}/${rest[0]}` : undefined);
      if (!qualified || !modelParts(qualified).model) return { text: `unknown model "${rest[0]}"` };
      (agent.model = qualified);
      const current = modelParts(agent.model);
      return { text: `endpoint: ${current.endpoint}, model: ${current.model}` };
    }
    case "/endpoint-login": {
      if (rest.length === 0) return { open: "login" };
      if (rest.length < 4 || rest.length > 5) return { text: "usage: /endpoint-login <package|local> <endpoint> <provider> <url> [token]" };
      const [scope, endpoint, provider, url, token] = rest;
      const result = await CLI.loginEndpoint(agent.env, { scope, name: endpoint, provider, url, token });
      return { text: `endpoint saved: ${result.name} (${provider} at ${url}, ${scope}) — model: ${adoptEndpoint(agent, result.name)}` };
    }
    case "/endpoint-logout": {
      if (rest.length !== 1) return { text: "usage: /endpoint-logout <endpoint>" };
      const result = removeEndpoint(agent, rest[0]);
      return { text: `endpoint removed: ${result.name}${result.dynamic ? " (environment-defined — it re-detects while the environment provides it)" : ""}` };
    }
    case "/endpoint-oauth-paste": {
      if (rest.length === 0) return { text: "usage: /endpoint-oauth-paste <redirect-url|code#state>" };
      return { text: CLI.completeOAuthPaste(rest.join(" ")) ? "sign-in redirect received — completing the login" : "no browser sign-in is in progress" };
    }

    case "/agent-name": {
      if (rest.length === 0) return { text: `agent name: ${agent.name}` };
      const value = rest.join(" ").trim();
      if (value === "") return { text: "usage: /agent-name [name]" };
      (agent.name = value);
      return { text: `agent name: ${agent.name}`, renew: true };
    }
    case "/agent-safe": {
      if (rest.length === 0) return { text: `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}` };
      if (!["on", "off", "true", "false"].includes(rest[0])) return { text: "usage: /agent-safe [on|off]" };
      (agent.safe = rest[0] === "on" || rest[0] === "true");
      return { text: `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}` };
    }
    case "/agent-thinking": {
      if (rest.length === 0) return { text: `thinking: ${agent.thinking ?? "provider default"} (levels: ${THINKING_LEVELS.join(", ")})` };
      const level = rest[0];
      if (!THINKING_LEVELS.includes(level)) return { text: `unknown thinking level "${level}" (use ${THINKING_LEVELS.join("/")})` };
      (agent.thinking = level === "default" ? undefined : level);
      return { text: `thinking: ${level}` };
    }
    case "/agent-session-save": {
      if (rest.length === 0) return { text: `session save: ${agent.context.save}` };
      if (!["true", "false"].includes(rest[0])) return { text: "usage: /agent-session-save [true|false]" };
      return { text: `session save: ${(agent.context.save = rest[0] === "true")}` };
    }
    case "/agent-status": return { text: await statusText(agent) };

    case "/context-edit": return { open: "context", ...(rest[0] !== undefined && /^\d+$/.test(rest[0]) ? { index: Number(rest[0]) } : {}) };
    case "/context-copy": {
      const last = agent.context.messages().reverse().find((m) => m?.type === MessageType.Assistant && blockText(m.content).trim() !== "");
      if (!last) return { text: "no assistant response to copy" };
      return { copy: blockText(last.content) };
    }
    case "/context-pop": {
      const count = Math.max(1, Number.parseInt(rest[0] ?? "1", 10) || 1);
      let removed = 0;
      while (removed < count && agent.context.pop() !== undefined) removed++;
      return { text: removed ? `popped ${removed} message(s); context now ${agent.context.length}` : "context already empty", renew: true };
    }
    case "/context-rollback": {
      const index = Number.parseInt(rest[0] ?? "", 10);
      if (!Number.isInteger(index) || index < 0) return { text: "usage: /context-rollback <i>" };
      const removed = agent.context.rollback(index);
      return { text: `rolled back ${removed?.length ?? 0} message(s); context now ${agent.context.length}`, renew: true };
    }
    case "/context-system": {
      if (rawArg.trim() === "") return { text: "usage: /context-system <text...>" };
      agent.context.append(messageSystem(rawArg.trim()));
      return { text: "system message appended", renew: true };
    }
    case "/context-clear-thoughts": {
      let cleared = 0;
      agent.context.messages().forEach((message, i) => {
        if (message?.type !== MessageType.Assistant) return;
        const content = message.content ?? [];
        if (!content.some((b) => b?.type === ContentType.Thinking)) return;
        agent.context.edit(i, { ...message, content: content.filter((b) => b?.type !== ContentType.Thinking) });
        cleared++;
      });
      return { text: cleared ? `cleared thinking blocks from ${cleared} message(s)` : "no thinking blocks in the context", renew: true };
    }
    case "/context-compact": case "/compact": {
      if (agent.context.length === 0) return { text: "nothing to compact — the context is empty" };
      const result = await agent.compact(rawArg);
      return { text: result.ok ? `compacted ${result.before} messages` : "nothing to compact", renew: true };
    }
    case "/continue": {
      if (typeof io.continue === "function") io.continue();
      return { text: undefined };
    }

    default: return expandPrompt(agent, name, rawArg, typedRaw);
  }
}

/** A bare /<name> that is no command expands as a user prompt. The body
 * (plus any trailing data) is returned as `fill` for the composer — never
 * auto-submitted (TUI parity: reviewed/edited before Enter). An empty name
 * returns the prompt catalog instead.
 * @param {Agent} agent - Agent providing the prompt catalog.
 * @param {string} name - Prompt name; empty means list all prompts.
 * @param {string} rawArg - Optional trailing text appended to the prompt body.
 * @param {string} [typed=`//${name}`] - Original command token for unknown-prompt feedback.
 * @returns {{text?:string,fill?:string}} Prompt listing/error text or composer fill text.
 */
function expandPrompt(agent, name, rawArg, typed = `//${name}`) {
  if (!name) return { text: Agent.promptCatalog(agent.env.prompts()).trimEnd() };
  const body = agent.env.prompts().get(name)?.body;
  if (body === undefined) return { text: `unknown command or prompt: ${typed} (/help lists commands)` };
  return { fill: rawArg ? `${body}\n${rawArg}` : body };
}

/** Build a textual snapshot of agent, context, tools, plan quotas, and MCP state.
 * @param {Agent} agent - Agent to inspect.
 * @returns {Promise<string>} Multiline status report.
 * @throws {Error} Propagates failures while loading the tool catalog.
 */
async function statusText(agent) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const m of agent.context) if (m?.type in counts) counts[m.type]++;
  const catalog = await agent.env.tools?.() ?? new Map();
  const tools = [...catalog.keys()];
  const lines = [
    `agent: ${agent.name}${agent.description ? ` — ${agent.description}` : ""}`,
    `model: ${combo(agent)} (thinking: ${agent.thinking ?? "provider default"})`,
    `session: ${agent.context.summary}`,
    `context: ${agent.context.length} message(s) — ${counts[1]} system, ${counts[2]} user, ${counts[3]} assistant, ${counts[4]} tool`,
    `safe mode: ${agent.safe ? "on (read-only)" : "off (read/write)"}`,
    `tools (${tools.length}):`,
  ];
  for (const name of tools) {
    const entry = catalog.get(name);
    let desc = String(entry?.schema?.description ?? "").replace(/\s+/g, " ").trim();
    if (desc.length > 120) desc = `${desc.slice(0, 119)}…`;
    lines.push(`  ${name}${desc ? ` — ${desc}` : ""}${entry?.status ? ` status: ${JSON.stringify(entry.status)}` : ""}`);
  }
  for (const proc of agent.backgroundList().filter((item) => item.state === "running")) lines.push(`process ${proc.id}: ${proc.command} (${proc.uptime}ms, ${proc.bytes} bytes)`);
  const quotas = agent.planUsage?.quotas;
  if (quotas && Object.keys(quotas).length) {
    lines.push(`plan usage${agent.planUsage.label ? ` (${agent.planUsage.label})` : ""}:`);
    for (const [name, quota] of Object.entries(quotas)) {
      const parts = ["used", "remaining", "total", "unit", "windowSeconds", "reset"].filter((key) => quota?.[key] !== undefined).map((key) => `${key}=${quota[key]}`);
      lines.push(`  ${name}: ${parts.join(" · ")}`);
    }
  }
  const mcp = agent.env.settings?.mcp;
  const mcpNames = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? Object.keys(mcp) : [];
  if (mcpNames.length === 0) lines.push("MCP servers: none configured (settings.mcp)");
  else {
    const connected = catalog.get("mcp")?.status?.connected ?? [];
    lines.push(`MCP servers (${mcpNames.length}):`, ...mcpNames.map((name) => `  ${name} — ${mcp[name]?.url ?? mcp[name]?.command ?? "?"}${connected.includes(name) ? " (connected)" : ""}`));
  }
  return lines.join("\n");
}

/** Build autocomplete data from commands, prompts, and a tool-catalog snapshot.
 * Tool entries include secret tools intended for human use.
 * @param {Agent} agent - Agent whose environment supplies prompts; may be nullish.
 * @param {Map<string, object>} [tools=new Map()] - Tool catalog snapshot.
 * @returns {{commands: readonly string[], hints: object, prompts: string[], tools: string[], toolSchemas: object[]}} Autocomplete data.
 */
export function catalog(agent, tools = new Map()) {
  const env = agent?.env;
  return {
    commands: COMMAND_LIST,
    hints: COMMAND_HINTS,
    prompts: [...(env?.prompts?.().keys() ?? [])],
    tools: [...tools.keys()].map((name) => `/tool-${name}`),
    toolSchemas: [...tools.values()].map(({ name, schema }) => ({ name, ...schema })),
  };
}
