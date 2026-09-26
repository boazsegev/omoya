/**
 * lib/app.js — App: the presentation front ends over the headless core.
 *
 *   App.TUI   the terminal front end (lib/app/tui/) — interactive inline/alt
 *             REPL, the piped line REPL, and the `om` application runner
 *   App.Web   the browser chat SPA (lib/app/web/) — `om --serve`
 *   App.Markdown  markdown structure (lib/app/markdown/) — the lexer/walker,
 *             display sanitizer, and git-diff parser both front ends render with
 *   App.GTUI  the generic terminal UI runtime (lib/app/gtui/) — view/effect/
 *             event/host APIs for building terminal apps; it imports nothing
 *             outside its own folder
 *
 * lib/app/shared/ holds browser-safe presentation text (tool summaries,
 * durations, quota ordering) both front ends use: the TUI imports it and
 * the web server serves the same file to the SPA. TUI and Web never import
 * each other.
 */

import Markdown from "./app/markdown/index.js";
import TUI from "./app/tui/index.js";
import Web from "./app/web/index.js";
import { GTUI } from "./app/gtui/gtui.js";

/**
 * Static namespace for the application front ends.
 * @property {object} Markdown - Markdown structure and display sanitizing.
 * @property {object} TUI - Terminal front end.
 * @property {object} Web - Browser front end.
 * @property {typeof GTUI} GTUI - Generic terminal UI runtime.
 */
export class App {}
Object.assign(App, { Markdown, TUI, Web, GTUI });
export default App;
