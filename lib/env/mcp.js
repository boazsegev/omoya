/**
 * lib/env/mcp.js — the encapsulated MCP (Model Context Protocol)
 * client runtime, exposed on the Env façade as `Env.mcpPool` /
 * `Env.closeMcpPool()` (the `mcp` tool and the CLI teardown are its
 * only consumers). The state itself lives in lib/tool-runtime.js —
 * the dependency-free tool-runtime leaf — so tool modules share it
 * (and the tool-refresh revision) WITHOUT importing the library;
 * this module is the Env-private re-export of that surface.
 */

export { mcpPool, closeMcpPool } from "../tool-runtime.js";
