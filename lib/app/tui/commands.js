/** Slash-command routing owned by the AI application. Terminal capabilities are injected. */

import CLI from "../../cli.js";
const { completeOAuthPaste } = CLI;
import { COMMANDS, COMMAND_ARG_HINTS, HELP_LINES, THINKING_LEVELS } from "./command-data.js";
import { createHandlers } from "./command-handlers.js";
import { matchNamespaceInside } from "./completion.js";

export { COMMANDS, COMMAND_ARG_HINTS, THINKING_LEVELS };
export const TOOL_PREFIX = "tool-";

/**
 * Resolve a typed slash command to its canonical name when the prefix is unique.
 * Exact matches win; ambiguous prefixes and unmatched text remain unchanged, while
 * a unique namespace match may resolve a nested command.
 * @param {string} typed Submitted command token, including its leading slash.
 * @returns {string} Canonical command name or the unchanged token.
 */
function resolveCommand(typed) {
  const prefixes = COMMANDS.filter((command) => command.startsWith(typed));
  if (COMMANDS.includes(typed)) return typed;
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 0) return typed;
  const nested = matchNamespaceInside(COMMANDS, typed);
  return nested.length === 1 ? nested[0] : typed;
}

/**
 * Split submitted input into the command token, first-line tokens, and raw arguments.
 * The first line is whitespace-tokenized; subsequent lines are preserved in `rawArg`.
 * @param {string} line Complete submitted input.
 * @returns {{typed: string, rest: string[], rawArg: string}} Parsed command token,
 *   remaining first-line tokens, and arguments joined with any subsequent lines.
 */
function parseSubmission(line) {
  const newline = line.indexOf("\n");
  const firstLine = newline === -1 ? line : line.slice(0, newline);
  const restLines = newline === -1 ? "" : line.slice(newline + 1);
  const [typed, ...rest] = firstLine.trim().split(/\s+/);
  return { typed, rest, rawArg: [rest.join(" "), restLines].filter((value) => value !== "").join("\n") };
}

/**
 * Route a `/tool-…` token to a registered tool, or log an unknown-tool message.
 * Registered-tool lookup may be asynchronous; matching names invoke `handlers.runTool`.
 * @param {object} options Routing dependencies and parsed input.
 * @param {object} options.agent Agent whose environment supplies the registered-tool set.
 * @param {object} options.handlers Handler collection; `runTool(name, rawArg)` runs a tool.
 * @param {(message: string) => void} options.log Logger for unknown tool names.
 * @param {string} options.typed Submitted slash-command token.
 * @param {string} options.rawArg Raw argument text passed to the tool handler.
 * @returns {Promise<boolean>} Resolves `true` when the reserved tool namespace was handled,
 *   otherwise `false` when the token is outside that namespace.
 * @throws Propagates failures from tool lookup or the tool handler.
 */
async function routeTool({ agent, handlers, log, typed, rawArg }) {
  if (!typed.slice(1).startsWith(TOOL_PREFIX)) return false;
  const name = typed.slice(1 + TOOL_PREFIX.length);
  if (name !== "" && (await agent.env.tools()).has(name)) await handlers.runTool(name, rawArg);
  else log(`unknown tool: ${typed} (the "${TOOL_PREFIX}" namespace is reserved for registered tools)`);
  return true;
}

/**
 * Expand a named prompt (or list prompts for an empty name), logging unknown names.
 * @param {object} options Prompt dependencies and parsed input.
 * @param {object} options.agent Agent whose environment supplies the prompt registry.
 * @param {object} options.handlers Handler collection with `promptExpand(name, rawArg)`.
 * @param {(message: string) => void} options.log Logger for unknown prompt names.
 * @param {string} options.typed Submitted slash-command token.
 * @param {string} options.rawArg Raw prompt argument text.
 * @returns {void} No value; invokes the prompt handler or logger for its effects.
 * @throws Propagates prompt-registry, prompt-handler, or logger failures.
 */
function routePrompt({ agent, handlers, log, typed, rawArg }) {
  const name = typed.slice(1);
  if (name === "" || agent.env.prompts().has(name)) handlers.promptExpand(name, rawArg);
  else log(`unknown command or prompt: ${typed} (commands: ${COMMANDS.join(", ")}; / alone lists prompts)`);
}

/**
 * Dispatch a recognized command to its handler or terminal hook.
 * Some handlers/hooks are awaited; command validation or handler errors can reject the promise.
 * @param {string} command Canonical slash-command name.
 * @param {object} args Parsed command arguments.
 * @param {string} args.typed Submitted command token.
 * @param {string[]} args.rest Remaining first-line argument tokens.
 * @param {string} args.rawArg Raw argument text, including subsequent lines.
 * @param {object} dependencies Dispatch dependencies.
 * @param {object} dependencies.handlers Command handler collection.
 * @param {(message: string) => void} dependencies.log Logger for command feedback.
 * @param {(value: string) => boolean} dependencies.completeOAuth OAuth redirect/code-state completion callback.
 * @param {object} dependencies.hooks Optional terminal lifecycle hooks.
 * @returns {Promise<void>} Resolves after dispatch; may reject when a handler or hook fails.
 * @throws Propagates handler, hook, or command-validation errors to the caller.
 */
async function execute(command, args, dependencies) {
  const { handlers, log, completeOAuth, hooks } = dependencies;
  switch (command) {
    case "/endpoint-model": await handlers.model(args.rest); break;
    case "/mcp-login": {
      if (args.rest.length !== 1) throw new Error("usage: /mcp-login <server>");
      await handlers.mcpLogin(args.rest[0]);
      break;
    }
    case "/mcp-oauth-paste": {
      if (!args.rest.length) throw new Error("usage: /mcp-oauth-paste <redirect-url>");
      log(handlers.mcpPaste(args.rest.join(" ")) ? "MCP sign-in redirect received" : "no MCP sign-in is in progress");
      break;
    }
    case "/endpoint-login": await handlers.login(args.rest); break;
    case "/endpoint-logout": handlers.logout(args.rest); break;
    case "/endpoint-oauth-paste": {
      if (args.rest.length === 0) throw new Error("usage: /endpoint-oauth-paste <redirect-url|code#state>");
      log(completeOAuth(args.rest.join(" ")) ? "sign-in redirect received — completing the login" : "no browser sign-in is in progress");
      break;
    }
    case "/context-edit": handlers.edit(args.rest); break;
    case "/context-rollback": handlers.rollback(args.rest); break;
    case "/context-pop": handlers.pop(args.rest); break;
    case "/context-system": handlers.system(args.rawArg); break;
    case "/context-copy": await handlers.copyLast(); break;
    case "/continue": hooks.onContinue ? await hooks.onContinue() : log("continue: not available"); break;
    case "/context-clear-thoughts": handlers.clearThoughts(args.rest); break;
    case "/context-compact": case "/compact": await handlers.compact(args.rawArg); break;
    case "/session-fork": handlers.fork(args.rest); break;
    case "/session-name": handlers.rename(args.rest); break;
    case "/session-new": case "/new": handlers.newSession(args.rest); break;
    case "/anon": handlers.newSession(["false"]); break;
    case "/session-resume": handlers.resume(args.rest); break;
    case "/session-delete!": handlers.deleteAll(args.rest); break;
    case "/session-delete-all!": await handlers.sessionsDeleteAll(args.rest); break;
    case "/agent-name": handlers.name(args.rest); break;
    case "/agent-thinking": handlers.thinking(args.rest); break;
    case "/agent-safe": await handlers.safeMode(args.rest); break;
    case "/agent-session-save": handlers.sessionSave(args.rest); break;
    case "/agent-status": await handlers.status(); break;
    case "/reload": hooks.onReload ? (hooks.onReload(), log("view reloaded")) : log("reload: not on a TTY"); break;
    case "/menu": hooks.onMenu ? await hooks.onMenu() : log("menu: press ^X on a real terminal"); break;
    case "/help": HELP_LINES.forEach((line) => log(line)); break;
    case "/bye": case "/exit": case "/quit": hooks.onExit ? hooks.onExit() : log("exit: close the input (Ctrl-D on an empty line)"); break;
    default: log(`unknown command: ${command} (commands: ${COMMANDS.join(", ")})`);
  }
}

/**
 * Build the command router. `copy` is required: the application chooses a GTUI
 * copy effect adapter while the legacy shim injects its terminal implementation.
 * @param {object} options Router dependencies and optional terminal hooks.
 * @param {object} options.agent Agent whose environment provides tool and prompt registries.
 * @param {(text: string) => (void|Promise<void>)} options.copy Required clipboard effect callback.
 * @param {(value: string) => boolean} [options.completeOAuth=completeOAuthPaste] Callback to consume an OAuth redirect or code/state value.
 * @param {(message: string) => void} [options.log=()=>{}] Logger for routing and command feedback.
 * @param {object} options Additional lifecycle-hook properties are collected and passed to command handlers.
 * @returns {{handle: (line: string) => Promise<boolean>}} Router exposing the input handler.
 * @throws {TypeError} If `copy` is not a function; also propagates errors creating handlers.
 */
export function createCommands({ agent, copy, completeOAuth = completeOAuthPaste, log = () => {}, ...hooks }) {
  if (typeof copy !== "function") throw new TypeError("createCommands requires an injected copy function");
  const handlers = createHandlers({ agent, copy, log, ...hooks });
  return {
    /**
     * Handle one submitted input line, routing slash commands and prompt expansions.
     * Non-command input returns `false`; slash input returns `true`, including unknown
     * commands. Command-execution failures are caught and reported through `log`.
     * @param {string} line Complete user input line.
     * @returns {Promise<boolean>} Resolves `true` when consumed, otherwise `false`.
     * @throws May propagate parsing, routing, or logging failures outside command execution.
     */
    async handle(line) {
      if (!line.startsWith("/")) return false;
      const args = parseSubmission(line);
      if (args.typed.startsWith("//")) {
        handlers.promptExpand(args.typed.slice(2), args.rawArg);
        return true;
      }
      const command = resolveCommand(args.typed);
      if (await routeTool({ agent, handlers, log, typed: args.typed, rawArg: args.rawArg })) return true;
      if (!COMMANDS.includes(command)) {
        routePrompt({ agent, handlers, log, typed: args.typed, rawArg: args.rawArg });
        return true;
      }
      try {
        await execute(command, args, { handlers, log, completeOAuth, hooks });
      } catch (error) {
        log(`command failed: ${error.message}`);
      }
      return true;
    },
  };
}
