/**
 * Primary library entry point. Agent owns the headless dependency tree
 * (Context ← Env ← IO ← Agent); Jobs is an independent library domain used
 * by both tools and hosts. Markdown, CLI, and presentation layers remain in
 * `index_app.js`.
 */

import Agent from "./agent.js";
import Jobs from "./jobs.js";

export default { ...Agent, Agent, Jobs };
