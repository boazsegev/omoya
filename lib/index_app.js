/**
 * Full application entry point. The Agent module owns the headless core tree
 * (`{ Context, Env, IO, Agent }`). This opt-in layer adds presentation and
 * application concerns: CLI and App (App.Markdown, App.TUI, App.Web, App.GTUI).
 * Jobs remains in the primary library entry because tools and
 * non-application hosts use it.
 */

import Core from "./index.js";
import CLI from "./cli.js";
import App from "./app.js";

Core.Env._loadThemes = true;

export default { ...Core, CLI, App };
