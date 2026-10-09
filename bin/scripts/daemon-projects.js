#!/usr/bin/env bun
/** Fresh child: read pinned project settings through Env, never in the supervisor. */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import Env from "../../lib/env.js";

const cwd = await realpath(process.cwd());
const env = await Env.open(cwd);
try {
  const pins = env.constructor.settings.projects;
  const available = [];
  for (const [path, pin] of Object.entries(pins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (path !== pin.folder || !isAbsolute(path)) continue;
    try {
      const canonical = await realpath(path);
      if ((await stat(canonical)).isDirectory() && !available.includes(canonical)) available.push(canonical);
    } catch (error) { console.error(`daemon: pinned project unavailable: ${path}: ${error.message}`); }
  }
  const candidates = available.length ? available : [cwd];
  const jobsRoots = [];
  for (const root of candidates) {
    try { if ((await stat(join(root, "ai-jobs"))).isDirectory()) jobsRoots.push(root); }
    catch (error) { if (error.code !== "ENOENT") console.error(`daemon: cannot check Jobs in ${root}: ${error.message}`); }
  }
  process.stdout.write(JSON.stringify({ webRoot: available[0] ?? cwd, jobsRoots }) + "\n");
} finally {
  await env.close();
}
