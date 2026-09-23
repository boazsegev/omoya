/**
 * lib/tui-helpers/command-data.js — slash-command tables (private to the
 * TUI): the recognized names, the thinking levels, the per-command
 * argument hints (the dim "ghost text" after the command), and the
 * /help text.
 *
 * Built-in commands are NAMESPACED (`/context-*`, `/endpoint-*`,
 * `/session-*`, `/agent-*`, `/tool-*`) so the flat `/name` space stays
 * free for user PROMPTS: a single-slash name that matches no command
 * expands as a prompt (see commands.js); `/tool-<name>` runs a
 * registered tool directly and — unlike every other namespace — never
 * falls back to a prompt on a miss. Only the REPL's own control words
 * (/help /menu /reload /bye /exit /quit), the everyday session
 * ALIASES (/new → /session-new, /anon → /session-new false), and
 * /continue stay un-namespaced. /continue is deliberately TOP-LEVEL,
 * never /context-continue: it doesn't continue the CONTEXT (nothing
 * ended) — it re-activates the AGENT over what's already there.
 */

/** Recognized slash-command names — reused by lib/tui-helpers/input.js for completion. */
export const COMMANDS = [
  // context: the conversation array (view, edit, compact)
  "/context-edit", "/context-pop", "/context-rollback", "/context-system", "/context-copy",
  "/context-clear-thoughts", "/context-compact",
  // endpoint: provider connections and models
  "/endpoint-model", "/endpoint-login", "/endpoint-logout", "/endpoint-oauth-paste",
  // session: persistence lifecycle
  "/session-new", "/session-resume", "/session-fork", "/session-name", "/session-switch", "/session-unlink", "/session-delete!", "/session-delete-all!",
  // flat session ALIASES (un-namespaced on purpose: the everyday actions)
  "/new", "/anon",
  // agent: runtime behavior
  "/agent-name", "/agent-thinking", "/agent-safe", "/agent-session-save", "/agent-status",
  // the REPL itself (un-namespaced control words) — /continue activates
  // the Agent over the existing context; it is TOP-LEVEL on purpose
  // (see the module doc), never /context-continue
  "/reload", "/menu", "/help", "/bye", "/exit", "/quit", "/continue",
];

import Env from "../env.js";
const { THINKING_LEVELS } = Env;

/** Selectable thinking levels (/agent-thinking, the ^X menu) — lib/env/thinking.js. */
export { THINKING_LEVELS };

/**
 * Expected arguments per command, one hint per position (a trailing
 * "..." entry is variadic — it stays as the ghost for every later
 * position). lib/tui-helpers/input.js renders these as dim "ghost text" after
 * the command once the cursor sits in an argument position.
 */
export const COMMAND_ARG_HINTS = {
  "/endpoint-model": ["<endpoint>/<model>"],
  "/endpoint-login": ["<package|local>", "<endpoint>", "<provider>", "<url>", "[token]"],
  "/endpoint-logout": ["<endpoint>"],
  "/endpoint-oauth-paste": ["<redirect-url|code#state>"],
  "/context-edit": ["<i>", "[j]", "<text...>"],
  "/context-rollback": ["<i>"],
  "/context-pop": ["[count]"],
  "/context-system": ["<text...>"],
  "/session-fork": ["[id|false]"],
  "/session-name": ["<name>"],
  "/agent-thinking": [`[${THINKING_LEVELS.join("|")}]`],
  "/agent-safe": ["[on|off]"],
  "/agent-session-save": ["[true|false]"],
  "/session-new": ["[session-id or false (anonymous)]"],
  "/new": ["[session-id or false (anonymous)]"],
  "/session-resume": ["[session-id|latest]"],
};

export const HELP_LINES = [
  "commands (namespaced; a unique prefix is enough, e.g. /context-e):",
  "  context — the conversation array:",
  "  /context-edit [<i>]      edit a message in the input area (↑/↓ moves",
  "                           between messages, Enter saves, ^C cancels)",
  "  /context-edit <i> [j] <text...>  replace a message / block directly",
  "  /context-pop [count]     remove one or more messages from the end",
  "  /context-rollback <i>    remove every message at index >= i",
  "  /context-system <text...>  append a system message",
  "  /context-copy            copy the last response to the clipboard",
  "  /context-clear-thoughts  strip thinking blocks from the context (no model call)",
  "  /context-compact         ask the model to summarize, replacing history with it",
  "  endpoint — provider connections:",
  "  /endpoint-model [<endpoint>/<model>]  list available models, or switch the combo",
  "  /endpoint-login          add an endpoint with the TUI wizard",
  "  /endpoint-login <package|local> <endpoint> <provider> <url> [token]  direct form",
  "  /endpoint-logout <endpoint>  remove an endpoint (settings.json + auth)",
  "  /endpoint-oauth-paste <url|code#state>  feed a pasted browser sign-in redirect",
  "  session — persistence:",
  "  /session-new [session-id or false (anonymous)]  start a new, empty session",
  "                             (random id default; false/0/anon = anonymous;",
  "                             anonymous stays anonymous)",
  "  /session-resume [session-id|latest]  resume an existing session (an explicit",
  "                             id resumes anywhere: the cwd becomes the session's)",
  "  /session-fork [id|false]   fork the session into a new id",
  "                             (random default; false/0 = hidden)",
  "  /session-name <name>       rename the session — saved under the proper name",
  "                             (<name>.jsonl; the old name's file is gone)",
  "  /session-delete!         clear the current session and restart it",
  "  /session-delete-all!     delete ALL session files (every project's),",
  "                           after a confirmation",
  "  /new [...]               alias of /session-new (same arguments)",
  "  /anon                    alias of /session-new false — a new ANONYMOUS",
  "                           (unpersisted) session",
  "  agent — runtime behavior:",
  `  /agent-thinking [level]  show or set thinking (${THINKING_LEVELS.join("/")})`,
  "  /agent-safe [on|off]     safe mode: publish and run read-only tools only",
  "  /agent-session-save [true|false]  show or set session saving",
  "  /agent-status            context details, tools (+ their live status), MCP",
  "  repl:",
  "  /reload                  refresh the display (re-rendered from the context;",
  "                           a running turn continues)",
  "  /menu                    open the main menu (same as ^X)",
  "  /help                    this text",
  "  /bye, /exit, /quit       leave the REPL",
  "  /continue                re-activate the Agent over the existing context,",
  "                           no new message (top-level: it isn't a context edit)",
  "tools:",
  "  /tool-<name> [json-args] run a registered tool directly (the \"tool-\" prefix",
  "                           is reserved — it never falls back to a prompt),",
  "                           outside any Agent turn — a JSON object, or a bare",
  "                           value shorthanded into its first schema property,",
  "                           same grammar as bin/scripts/tool — the ^X menu's Tools",
  "                           sub-menu lists them",
  "prompts:",
  "  /<name> [data...]        load a custom prompt into the input area",
  "                           (/ alone lists them; //<name> also works and",
  "                           never resolves as a command or tool)",
  "keys: Enter submit · Shift+Enter soft break · Tab/↓ complete · / lists commands+prompts",
  "      Alt+←/→ word · Ctrl+←/→ line · Alt+↑/↓ scroll · Alt+Shift+↑ recall queued · Alt+Shift+←/→ linked agents",
  "      Alt+Bksp del word · Ctrl+Bksp del line · drag/double-click select · Cmd+C copies",
  "      ^O block viewer · ^X menu · ^C/Esc cancel · ^C ^C exit · ^D EOF",
];
