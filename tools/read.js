/**
 * tools/read.js — the `read` tool: an independent, read-only,
 * cwd-rooted file access tool. Thin WRAPPER publishing the callable
 * implemented under tools/read/. The tool scan is NOT recursive:
 * sub-folders are never scanned, so the modules in read/ (binary,
 * glob, grep, ignore, mime-map, mime-detection, read, util) are this
 * tool's PRIVATE helpers — internal libraries it does not export as
 * tools.
 *
 * One exception BY DESIGN: tools/guard/ is the shared guard layer
 * EVERY tool imports (read, write, edit, bash) — the deterministic
 * path resolver (guard/resolve.js) and the fast-path content
 * trip-wire (guard/paths.js); path traversal policy is global,
 * never per-tool (see those files).
 *
 * Helper imports are stamped with the shared refresh revision
 * (toolRevision() — lib/env/mcp.js, the tiny runtime the tool scan
 * publishes it through): every refreshTools() bumps it, the wrapper
 * re-runs, and the helpers re-import fresh — editing any read/*
 * module applies on refresh without touching this wrapper.
 */

import { toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: one instance across cache-busted imports — no whole-library load for a timestamp

const timestamp = toolRevision(); // shared tool-registry revision
const { read, readDescription } = await import(`./read/read.js?now=${timestamp}`);

export { read };

export function toolDescription() {
  return { read: readDescription() };
}
