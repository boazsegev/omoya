/** Slash-command routing owned by the AI application. Terminal capabilities are injected. */

import CLI from "../cli.js";
const { completeOAuthPaste } = CLI;
import { COMMANDS, COMMAND_ARG_HINTS, HELP_LINES, THINKING_LEVELS } from "./command-data.js";
import { createHandlers } from "./command-handlers.js";
import { matchNamespaceInside } from "./completion.js";

export { COMMANDS, COMMAND_ARG_HINTS, THINKING_LEVELS };
export const TOOL_PREFIX = "tool-";

function resolveCommand(typed) {
  const prefixes = COMMANDS.filter((command) => command.startsWith(typed));
  if (COMMANDS.includes(typed)) return typed;
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 0) return typed;
  const nested = matchNamespaceInside(COMMANDS, typed);
  return nested.length === 1 ? nested[0] : typed;
}

function parseSubmission(line) {
  const newline = line.indexOf("\n");
  const firstLine = newline === -1 ? line : line.slice(0, newline);
  const restLines = newline === -1 ? "" : line.slice(newline + 1);
  const [typed, ...rest] = firstLine.trim().split(/\s+/);
  return { typed, rest, rawArg: [rest.join(" "), restLines].filter((value) => value !== "").join("\n") };
}

async function routeTool({ agent, handlers, log, typed, rawArg }) {
  if (!typed.slice(1).startsWith(TOOL_PREFIX)) return false;
  const name = typed.slice(1 + TOOL_PREFIX.length);
  if (name !== "" && agent.env.hasTool(name)) await handlers.runTool(name, rawArg);
  else log(`unknown tool: ${typed} (the "${TOOL_PREFIX}" namespace is reserved for registered tools)`);
  return true;
}

function routePrompt({ agent, handlers, log, typed, rawArg }) {
  const name = typed.slice(1);
  if (name === "" || agent.env.promptBody(name) !== null) handlers.promptExpand(name, rawArg);
  else log(`unknown command or prompt: ${typed} (commands: ${COMMANDS.join(", ")}; / alone lists prompts)`);
}

async function execute(command, args, dependencies) {
  const { handlers, log, completeOAuth, hooks } = dependencies;
  switch (command) {
    case "/endpoint-model": await handlers.model(args.rest); break;
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
    case "/context-compact": await handlers.compact(args.rest); break;
    case "/session-fork": handlers.fork(args.rest); break;
    case "/session-name": handlers.rename(args.rest); break;
    case "/session-new": case "/new": handlers.newSession(args.rest); break;
    case "/anon": handlers.newSession(["false"]); break;
    case "/session-resume": handlers.resume(args.rest); break;
    case "/session-delete!": handlers.deleteAll(args.rest); break;
    case "/session-delete-all!": await handlers.sessionsDeleteAll(args.rest); break;
    case "/agent-name": handlers.name(args.rest); break;
    case "/agent-thinking": handlers.thinking(args.rest); break;
    case "/agent-safe": handlers.safeMode(args.rest); break;
    case "/agent-session-save": handlers.sessionSave(args.rest); break;
    case "/agent-status": handlers.status(); break;
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
 */
export function createCommands({ agent, copy, completeOAuth = completeOAuthPaste, log = () => {}, ...hooks }) {
  if (typeof copy !== "function") throw new TypeError("createCommands requires an injected copy function");
  const handlers = createHandlers({ agent, copy, log, ...hooks });
  return {
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
