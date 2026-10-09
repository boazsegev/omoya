/**
 * Opt-in application entry point. The default namespace includes the headless
 * Agent facade plus App; presentation helpers are available only under App.
 * Importing lib/agent.js alone never loads this module.
 */
import Agent from "./agent.js";
import CLI from "./app/cli.js";
import Markdown from "./app/markdown/index.js";
import TUI from "./app/tui/index.js";
import Web from "./app/web/index.js";
import { GTUI } from "./app/gtui/gtui.js";

/**
 * Application presentation namespace. Importing it loads CLI, GTUI, TUI,
 * Markdown and Web. Its static references are borrowed, not copied or owned;
 * neither import nor construction starts a server or opens a terminal.
 */
export class App {}
Object.assign(App, { CLI, GTUI, Markdown, TUI, Web });

// Retain the same Agent constructor and core static identities across both
// entry points. Jobs is installed by the headless core facade, not by App.
export { Agent };
/** Immutable application facade: core helpers remain under Agent; only App adds presentation. */
export default Object.freeze({ Agent, App });
