# GTUI — backend-neutral UI runtime (design target)

> Implemented runtime. GTUI is self-contained; `lib/tui-app/` supplies the AI application and `lib/tui.js` dispatches it through the inline or alt terminal host.

GTUI lets an application describe **state, messages, semantic views and effects**. A host (terminal inline, terminal alt, memory/test, a future GUI) owns everything physical: cells, pixels, wrapping, cursor, ANSI, raw mode, mouse protocols, scrollback, diffing.

## 1. Research — what is borrowed

| Project | What it is | Borrowed | Not borrowed |
|---|---|---|---|
| [Elm](https://guide.elm-lang.org/architecture/) | Model → `update(msg)` → `view`; commands/subscriptions produce messages | the loop; effects as data | — |
| [Bubble Tea](https://github.com/charmbracelet/bubbletea) | Elm loop for terminals; runtime owns input/render; `Cmd`s run concurrently and return messages; **inline by default**, alt screen opt-in; `tea.Println` prints above the live program | runtime ownership, concurrent effects, inline-first, "print above" = `feed` commits | exposing `Program` options to apps |
| [Ratatui](https://ratatui.rs/concepts/rendering/) | a rendering library, not a runtime; widgets draw into rect-bounded buffers; `Viewport::Inline` + `Terminal::insert_before` push finished lines into native scrollback above a live viewport | private cell buffer + diff; inline viewport discipline | buffers/frames as public API |

## 2. Layers and import rules

```
lib/tui.js            ai façade: reads settings, picks mode, builds host
  └─ lib/tui-app/     ai UI application: model/update/view, agent adapter, commands, menus, status content, theme roles
       └─ lib/gtui/gtui.js   GTUI public façade (this document)
            └─ lib/gtui/**   private: runtime, layout, controls, terminal hosts, cells, diff, ANSI, key/mouse decode, width
```

| Module | May import | Must never import |
|---|---|---|
| `lib/gtui/**` | `node:` builtins, own files | anything else in `lib/` (no `tui-helpers`, `cli.js`, `env.js`, `context.js`) |
| `lib/tui-app/**` | `../gtui/gtui.js` only, lower ai public modules, own files | gtui privates, `lib/tui/`, `lib/tui-old/`, `lib/tui-helpers/` |

Enforced by a **recursive** architecture test. Generic terminal primitives GTUI needs (`width.js`, mouse/key decoding, cursor/sync/title controls, OSC-52, theme detection) are owned by gtui. Port, never bridge.

## 3. Public API

```js
import { GTUI } from "../gtui/gtui.js";

// lib/tui.js — the only place that knows about processes and modes
const host = GTUI.host.terminal({ input: process.stdin, output: process.stdout, mode: "inline" }); // or "alt"
const ui = new GTUI({ host, theme });   // theme: resolved token object built by lib/tui-app
const { reason, code } = await ui.run(app);
```

```js
// lib/tui-app — no terminal vocabulary anywhere
const app = {
  init: () => ({ model: initialModel(agent), effects: [] }),
  bindings: () => ["ctrl+c", "ctrl+x", "ctrl+o", "ctrl+p", "ctrl+m"], // reach update before the focused control
  update(model, message) {
    switch (message.type) {
      case "input.submit":
        return {
          model: { ...model, draft: "", busy: true },
          effects: [GTUI.effect.task("turn", ({ signal, send }) => runTurn(agent, message.value, { signal, send }))],
        };
      case "key":
        if (message.key === "ctrl+c" && model.busy) return { model, effects: [GTUI.effect.cancel("turn")] };
        return { model, effects: [] };
      default:
        return { model, effects: [] };
    }
  },
  view: (model) => GTUI.view.column({ title: model.title }, [
    GTUI.view.feed({ id: "transcript", items: model.items.map(toFeedItem) }), // [{ key, done, node }]
    GTUI.view.input({ id: "draft", value: model.draft, focus: true, maxRows: 8, active: model.busy, completions: model.completions }),
    GTUI.view.grid({ columns: ["fill", "auto"] }, [
      GTUI.view.text({ role: "status.identity", overflow: "clip-start" }, model.identity),
      GTUI.view.text({ role: "status.activity", active: model.busy }, model.activity),
      GTUI.view.text({ role: "status.keys", priority: -1 }, model.keys),   // dropped first when tight
      GTUI.view.text({ role: "status.usage" }, model.usage),
    ]),
  ]),
};
```

### Instance

- `new GTUI({ host, theme })` — `host` from `GTUI.host.*`; `theme` a resolved token object (§6). GTUI never reads ai settings.
- `ui.run(app)` → `Promise<{ reason: "quit"|"stop"|"input-end", code }>`. The host is always restored; a throw from `update`/`view` restores the host, then rejects. An optional synchronous `app.dispose()` runs before task cancellation.
- `ui.dispatch(message)` — deliver an external message (agent question bridge, signals). Idempotent after stop.
- `ui.stop()` — call `app.dispose()`, abort all tasks, restore host, resolve `run`. Idempotent.

### Static namespaces

- `GTUI.view` — nodes and controls (§4).
- `GTUI.effect` — `task(key, run)`, `cancel(key)`, `after(ms, message)`, `copy(text)`, `open(url)`, `notify(text)` (host-level OSC notification, never visible screen text), `refresh()`, `quit(code)`.
- `GTUI.event` — constructors/guards for the reserved message types hosts emit: `key`, `paste`, `pointer`, `resize`, `focus`, `input.change`, `input.submit`, `menu.select`, `menu.cancel`, `selection.copy`, `task.done`, `task.failed`, `copy.done`. App messages use any other `type`.
- `GTUI.host` — `terminal({ input, output, mode, title? })` and `memory({ width, height })`. Hosts are opaque; `memory` adds `send(event)`, `flush()`, `snapshot()` (lines + role spans + focus/caret, no ANSI) and a recorded `effects` list for app tests.
- `GTUI.keybindings.create(name, strings)` — creates an immutable, reusable named routing context with sixteen null-prototype modifier tables. The terminal's normalized string key codes route directly; absent entries are false. Legacy string arrays remain accepted by `bindings`.

### Runtime semantics (non-negotiable)

1. `update` is synchronous and pure; `view` is pure.
2. Background updates schedule one cancellable next event-loop frame (`setImmediate`), so streaming token microtasks coalesce without starving input I/O. Interactive/control messages render synchronously so each key in an input chunk sees the current control tree.
3. Effects never block update or rendering. `task` runs concurrently: `send(message)` streams messages, the resolved value (message/array/undefined) is dispatched, errors become `task.failed`, `cancel(key)` aborts `signal` and suppresses later messages. Starting a task with a live key aborts the previous one.
4. Timers are one-shot `after` (Bubble Tea `Tick` style); re-arm in `update`. Visual animation is **not** app-ticked (§6).
5. Optional synchronous `dispose` releases app-owned bridges before runtime tasks are aborted; host restoration is guaranteed even if it throws.

## 4. Views and controls

| Node | Purpose |
|---|---|
| `text(props, content)` | spans with `role`, `link`, `source` offsets, `overflow` (`wrap`, `clip-end`, `clip-start`), `priority`, `active` |
| `row`, `column`, `grid` | layout with `fill`/`auto`/fixed tracks; tight space drops lowest `priority` first. A `column({ maxRows, overflow: "tail" })` is a visual suffix viewport: children are fully wrapped/theme-rendered first, then only the final rows draw (with original source spans intact). |
| `panel` | border + title + `active` (border animation) |
| `feed` | keyed transcript items `{ key, done, node }` (§5) |
| `scroll` | viewport over content; host owns offset and streaming-anchor stability; optional title/footer reuse the menu viewport frame; arrows/wheel/page keys scroll. Fixed-viewport hosts may show a `scroll.track`/`scroll.thumb` column only while content overflows. |
| `overlay` | modal layer; captures focus and keys except app `bindings`; `fill: true` gives its child the centered 80% × 90% safe area |
| `input` | **controlled** text control (below); `cursor: { shape: "line"|"underline"|"block"|number, blinkMs }` defaults to a line cursor with a 450 ms half-period |
| `menu` | **controlled** list: items `{ id, label, hint, children }`, filter query, highlight window; emits `menu.select`/`menu.cancel` |

**Controlled controls.** The host owns editing mechanics and geometry: caret movement, word ops, wrapping, vertical movement across wrapped rows, selection, scroll window, completion-list layout, hit-testing, and cursor timing. The app owns the value and policy: it receives `input.change { id, value, caret, selection }` and `input.submit`, and supplies `completions` content. Keys the control cannot use (e.g. Up on the first visual row) bubble to `update` as `key` — that is how history works without the app knowing rows.

**Key precedence:** app `bindings(model)` → focused control → `update`.

**Escape sequences are declarative** (`key-sequences.js`): one semantic key ↔ its spelling in every protocol the terminal may speak (legacy CSI/tilde, kitty CSI-u, xterm modifyOtherKeys), with kitty/xterm modifier values mapped to GTUI modifier bits by table. The byte filter DECODES the raw stream through those maps and the host ENABLES the protocols — a new terminal protocol is a new map entry, never new procedural translation code, so decode and enable bytes cannot drift into per-key brittleness. Plain Left/Right collapse an active selection to its sides (the universal editor gesture) before any grapheme step.

**Input history:** every GTUI input has a host-owned, 20-state undo/redo stream. Consecutive updates that only insert one non-whitespace grapheme (with unchanged prefix and optional postfix) share an undo state, stretching word entry beyond that limit. `Ctrl+Z` (or terminal-reported `Meta+Z`) restores the prior value/caret/selection, `Ctrl+Shift+Z` (or `Shift+Meta+Z`) redoes it, a new edit after undo clears the redo branch, and submission clears both streams.

**Pointer:** events carry a resolved target — `{ kind, target: id, index }` — never x/y or columns. Input/menu clicks and scroll-wheel events are implemented. There is exactly ONE primed selection at a time, whatever the gesture: a mouse press in an input sets its caret and clears any mounted text selection, a mouse drag over an input selects through the same `input.change { selection }` the keyboard's Shift-moves use, and a mouse drag over selectable text emits `selection.change { text }` so the app's Copy key — the same key that copies an input keyboard selection — copies it (`selection.copy` remains GTUI's own immediate-copy gesture; both feed the same copy effect). Input keyboard selections copy in logical source order; Block View copies a complete source block with `c`, which is the reliable alt-screen path. With terminal-inline `mouse: "always"`, selectable transcript text also supports managed source-range drag selection; `"overlays"` (the inline default) leaves terminal-native selection and scrolling available, and `"off"` captures no pointer input. Native terminal copying selects physical rendered cells, including any borders or decoration; GTUI cannot filter that terminal-owned clipboard selection.

## 5. Modes (terminal host)

| Concern | `alt` | `inline` |
|---|---|---|
| screen | alternate screen, cell diff, absolute addressing | no `?1049h/l`, no CUP; relative movement only |
| `feed` | scrollable viewport, app-level selection | only the evicted, completed prefix prints once into native scrollback; the visible tail and any changed suffix stay live. Normal renders do not reprint the full screen. |
| resize / `effect.refresh()` | full repaint | clear and rebuild the bounded native history at the new width |
| pointer | `always` by default; `off` disables reporting | `overlays` by default reports only for overlays/completions, preserving native selection/scroll; `always` additionally enables managed selectable-transcript source copy; `off` disables reporting |
| overlays | viewport takeover rendered by the alt frame | same viewport takeover rendered in the live region |

Both: never write a pending-wrap final column, reset SGR at every style boundary, preserve cursor style/visibility and title, render bidi glyphs in visual order while retaining logical source offsets, copy through OSC 52/system-tool fallback, and exit cleanly on throw/signal. Alt frames use synchronized output; inline uses bounded relative repainting. The terminal host accepts `scrollBar: { show, track, thumb }`; alt enables it by default, while inline retains native scrollback without a bar.

## 6. Themes

- **GTUI owns the mechanism**: token lookup with fallback to `text`, generic control tokens (`text`, `muted`, `accent`, `error`, `border`, `border.active`, `selection`, `input.*`, `completion.*`, `menu.*`, `overlay.*`), style values `{ fg, bg, bold, dim, italic, underline, reverse, strike }` with colors `ansi:<0-255>` | `#rrggbb` | `default`, and `{ dark, light }` variants picked from host capability (unknown → no subtle background, as `theme.js` does today).
- **Animations are declarative**: tokens may name a generic animation (`comet` head/tail/nose stops + length ratio + crossing time + mirror; `wave` text crest; `flash` period). A node with `active: true` animates on the host clock; a GUI host may use native animation.
- **`lib/tui-app` owns ai roles** (`message.user`, `status.identity`, …), the default theme and settings parsing (`tui.theme`, `tui.themes`). The default theme uses the exact legacy palette indices so terminal bytes match.

## 7. Private (never exported, never imported outside gtui)

Cells/buffers, diff, ANSI emit/parse, key/mouse/paste decoding, raw mode, cursor/sync/title/alt-screen protocols, width tables, final-column workarounds, layout solver internals, control state machines, host implementations.

## 8. Legacy → new owner

| Legacy | `lib/tui-app/` (ai semantics) | `lib/gtui/` private (generic, ported) |
|---|---|---|
| `tui-helpers/editor.js`, `input-render.js`, `input-keys.js`, `input-mouse.js`, `completion.js` | submit/history/queue policy, completion sources | `input` control, comet border |
| `status.js`, `status-lines.js`, `view-rows.js` | readout content: combo, cwd, thinking, IO state, usage, MCP, quotas, key hints | grid priorities/overflow, `wave`/`flash` |
| `messages.js`, `markdown-ansi.js`, `selection.js`, `lib/tui/linkify.js`, `sticky.js` | messages → nodes via `lib/markdown.js`, previews, `contextBlocks`, raw copy, link detection, sticky policy | rich spans, `feed`, selection → source offsets, OSC 8 |
| `menu.js`, `pager.js`, `question.js`, `repl-overlays.js`, `overlay-frame.js` | item trees, block list/hop, questionnaire state, login/session flows as model sub-states | `menu`, `scroll`, `overlay` |
| `commands.js`, `command-data.js`, `command-handlers.js`, `repl-turns.js`, `repl-switch.js`, `agent-slot.js`, `bash.js`, `line-repl.js`, `stream.js` | all (terminal defaults such as OSC-52 copy become injected effects) | — |
| `width.js`, `layout.js`, `mouse.js`, `byte-filter.js`, `key-stream.js`, `term.js`, `terminal-title.js`, `clipboard.js`, `theme.js`, `mouse-controller.js`, `lib/tui/inline-screen.js`, `lib/tui-old/screen.js`, `frame.js` | — | terminal host |

## 9. Anti-patterns from the rejected attempt

- ai application inside the library: `lib/gtui/repl.js`, `app-*.js` importing `lib/cli.js`, `tui-helpers/commands.js`, `messages.js`, `clipboard.js`.
- Foreign terminal-owning loops: `runMenu`/`runPager` `{write, keys}` loops, `app-keyfeed.js` pause/resume, `session.pause()`.
- App shape leaking into the runtime: a former driver reading `model().overlay`, `inlineFrame`, `inlineReset`, `invalidate()`, `cursorWidth` from settings.
- Blocking effects: `await program.runCmds()` before paint froze rendering for a whole streaming turn.
- Apps emitting SGR strings that the runtime parses back (`writeAnsiRow`).

## 10. Migration rule

No dispatch change and no legacy deletion until every capability-matrix row has memory-host behavior tests **and** terminal-byte tests in both modes **and** an interactive smoke. Memory/buffer tests never prove terminal parity.
