/**
 * Full application entry point. The Agent module owns the headless core tree
 * (`{ Context, Env, IO, Agent }`). This opt-in layer adds presentation and
 * application concerns: Markdown, CLI, TUI/GTUI, and Web. Jobs remains in
 * the primary library entry because tools and non-application hosts use it.
 */

import Core from "./index.js";
import Markdown from "./markdown.js";
import CLI from "./cli.js";
import TUI from "./tui.js";
import Web from "./web.js";

const GTUI = TUI.GTUI;
Core.Env._loadThemes = true;

export default { ...Core, Markdown, CLI, TUI, GTUI, Web };
