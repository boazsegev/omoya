/**
 * tui help text. Flag names, terminal behavior, and prose are owned by
 * this executable adapter, never by the reusable library. A neutral
 * sentinel makes executable renames/aliases one function call, never a
 * dangerous replacement of the short word "ai" inside ordinary prose.
 */
import { NAMES } from "../../lib/namespace.js";

const PROGRAM = "{{program}}";
const TEMPLATE = `${PROGRAM} — interactive REPL front end

usage: ${PROGRAM} [--model <endpoint>/<model>] [--url <url>]
              [--token <key>] [--timeout <ms>] [--tools <list>]
              [--session <id> | --resume <id>] [--safe]
              [--max-turns <n>] [--max-tool-calls <n>] [--login] [--logout <endpoint>]
              [--init [--force]] [--help]

stdin:   interactive lines, one user message per line (piped) or one
         composed multi-line message (real terminal); EOF exits.
         slash-commands (namespaced; / alone lists commands + prompts):
           /endpoint-model                     list the available models
           /endpoint-model <endpoint>/<model>  switch the combo (<model> alone
                                      keeps the current endpoint)
           /context-edit [<i>]         edit message i (default: the last one)
                                  IN THE INPUT AREA: ↑/↓ past the
                                  buffer's edge moves to the previous/
                                  next message (edit several in one
                                  session), Enter saves every change,
                                  ^C/Esc cancels; message boundaries
                                  are maintained (type, thinking, and
                                  tool blocks stay untouched)
           /context-edit <i> <text...>     replace message i's content
           /context-edit <i> <j> <text...>  replace block j's text in message i
           /context-copy              copy the last response to the clipboard
           /context-rollback <i>      remove every message at index >= i
           /context-pop               remove the last message
           /session-new [session-id]  start a new, empty session (the old
                                    file stays on disk; 0/false = anonymous)
           /new [session-id]          flat alias of /session-new
           /anon                      flat alias of /session-new false
                                    (a new anonymous, unpersisted session)
           /session-resume [id|latest]  resume a session (an explicit id
                                    resumes anywhere: the cwd becomes the
                                    session's own folder)
           /session-delete!           clear the current session and restart it
           /context-system <text...>  append a system message (multi-line
                                     body allowed: "/context-system\\" then
                                     more lines, e.g. via a "! <cmd>" line)
         a /<name> matching no command loads that custom PROMPT into
         the input area (//<name> is the explicit form; / alone lists
         the catalog).
         context-mutating commands (/context-edit /context-rollback
         /context-pop /session-new /session-delete!) re-render the
         whole view from the active context — the TUI always reflects it.
         on a real terminal, three ways into a multi-line message:
         paste (bracketed paste — works on nearly any terminal; a large
         paste collapses to "[Pasted N lines]" in the input area, real
         text spliced back in at submit — editing into it discards the
         real content rather than sending it mangled), a line ending in
         "\\" (trailing backslash, stripped — universal fallback), or
         Shift+Enter (best-effort, terminal-dependent). Otherwise Enter
         submits. Typing / at the start of a message already lists
         the command/prompt candidates below the input; Tab — or ↓
         inside a command's argument — completes
         commands/arguments/paths and shows a navigable candidate list
         (a command's argument candidates already list passively below
         the input, and the expected argument shows as a dim "ghost",
         e.g. "/endpoint-model " → "<endpoint>/<model>"), Up/Down navigate the
         buffer then recall history, Alt+← → move word-wise, Ctrl+← →
         jump to the start/end of the line, Ctrl-O toggles the
         full-text block viewer over thinking/tool/text blocks (← →
         between blocks, ↑ ↓ / wheel scroll, f filters message types
         or searches text, c copies the block, q/Esc/^O closes), Alt+Ctrl+arrows cycle existing linked agents
         without opening a new one, Ctrl-X toggles the main menu (help,
         commands, models, thinking level; click or wheel to
         navigate), Ctrl-P opens the endpoint/model selection menu,
         Ctrl-M the current endpoint's model menu (kitty /
         modifyOtherKeys terminals — legacy bytes can't tell ^M from
         Enter); a mouse click in the writing area places the
         cursor (tui.mouse setting: true = managed everywhere, false =
         off, unset = overlays inline / managed in alt; with mouse
         reporting on, hold Shift to scroll/select
         natively); Ctrl-C cancels a running response; with no agent
         running it clears the input, and on an empty input shows
         "Press ^C again to exit" (a second ^C exits; any other key
         dismisses the notice — the agent never sees any of this); a
         line starting with "! " is a bash command, replaced by its
         output before sending — if that's the WHOLE message, its
         output is queued onto the next one instead (e.g.
         "/context-system\\" then "! skill core" sends that skill's
         output as the system message)
stdout:  the rendered response stream — text/thinking deltas as they
         arrive; a tool call's line mutates into its collapsed final
         state when the answer lands (details + first answer line;
         Ctrl-O shows the full exchange); thinking streams in full
         while alive and collapses to a last-10-line preview when
         done; all colors come from the terminal's own palette (the
         theme supplies hues), no backgrounds in live text
stderr:  the bordered input area, command results, diagnostics, usage

options:
  --model <endpoint>/<model>  model id, optionally endpoint-prefixed; a
                              bare endpoint selects its first available
                              model (default endpoint: none unless selected;
                              default model: the last-used combo)
  --url <url>          endpoint URL (overrides settings)
  --token <key>        auth token for this invocation only (never persisted)
  --timeout <dur>      overall cap per request (default 1048575ms);
                       a ms numeral or a unit string ("500ms", "20s",
                       "20m", "1h"). The hung-connection timeout is
                       separate (provider setting connectTimeout, 30s
                       base + 1ms per request-body byte, so large
                       contexts get proportionally longer to answer);
                       so is the stuck-model timeout (stuckTimeout 120s)
  --tools <list>       tool availability: "*" or comma-separated names
                       (default: all discovered tools)
  --no-tool-fork      disable the tool sandbox: file tools run in-process
                       (default: forked — a crashing tool can't kill ${PROGRAM})
  --tool-timeout <dur> host override of Env.toolTimeout (default 120s);
                       a ms numeral or unit string ("30s", "5m"). Tools
                       may request a schema-declared timeout; Agent extracts
                       and caps it at Env.toolTimeoutLimit (default 20m)
  --tool-async        execute one message's tool calls concurrently
  --safe              safe mode: publish and execute ONLY read-only tools
                      (schemas marked safe: true) — exploration and planning
                      without mutation; unsafe calls are refused with a
                      tool error
  --session <id>       persist the context to the sessions folder as
                       session-<id>.jsonl (default: a fresh random UUID;
                       "0"/"false"/"anon" = anonymous, nothing written)
  --resume <id>        replay that session log first, then continue it
                     (true / latest: the latest session in the folder; an
                     explicit id resumes ANYWHERE — the cwd becomes the
                     session's own folder)
  --input <file>       scripted input: feed the file's bytes through the
                       interactive TUI (the line editor, pager, menu) as
                       if typed on a terminal — for programs driving
                       ${PROGRAM}; the stream's end exits like Ctrl-D
  --screen <name>      the screen mode (default: settings tui.alt ? alt :
                       inline — native terminal scrollback; alt = the
                       alternate-screen TUI; line = the piped cooked-mode
                       loop)
  --max-turns <n>      FALLBACK runaway guard (for when the context window
                       is unknown): provider requests per turn (32)
  --max-tool-calls <n> same fallback: tool executions per turn (64)
                       (the PRIMARY guard is context usage, settings.
                       contextGuardCap/contextGuardTurnCap — 90%/40%)
  --login              configure an endpoint with the interactive wizard, then exit
  --logout <endpoint> remove an endpoint from settings.json and auth, then exit
  --init               write a fresh ${NAMES.projectSettings} into the project
                       folder: every known setting, commented out
                       (see API.md's "Settings defaults schema"); --force
                       overwrites an existing file. Then exit
  --list               print one available public model per line as
                       <endpoint>/<model>, then exit
  --help               show this text and exit

cancellation: SIGINT during a response kills the in-flight request;
              the partial assistant message renders and persists,
              then the REPL continues

exit codes: 0 clean EOF · 1 usage/startup error`;

/** Render help for the executable's actual argv[1] basename. */
export function formatHelp(program = "ai") {
  return TEMPLATE.replaceAll(PROGRAM, program);
}

/** Default `ai` help text for library consumers. */
export const HELP_TEMPLATE = formatHelp();

