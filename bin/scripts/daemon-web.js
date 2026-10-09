#!/usr/bin/env bun
/** Web child: adopt the selected project before importing the application. */
const [project, app, ...args] = process.argv.slice(2);
if (!project || !app) throw new TypeError("daemon Web child needs a project folder and app wrapper");
process.chdir(project);
// The supervisor restarts every Web exit, so the app's exit control reads Restart app.
process.env.AI_DAEMON = "1";
process.argv = [process.argv[0], app, ...args];
await import(app);
