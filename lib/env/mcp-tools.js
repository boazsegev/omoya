/**
 * lib/env/mcp-tools.js — MCP (Model Context Protocol) servers as an Env
 * TOOL SOURCE (private to Env), next to the tool folders: Env reads
 * `settings.mcp`, owns the stdio client pool (lib/env/mcp-client.js),
 * and — while at least one server is configured — registers the
 * built-in `mcp` tool plus one `mcp-<name>` shortcut per server.
 * env.close() stops every pooled server.
 *
 * Servers are USER-CONFIGURED at `settings.mcp` (the trust anchor —
 * only the package/settings-scoped settings files can name a server; a
 * project-scoped `mcp` key is REJECTED at load, schema `layers`; the
 * live settings tree is read at call time, so a file written
 * mid-session can never inject one):
 *   "mcp": {
 *     "notes": { "command": "bun", "args": ["./mcp/notes.js"],
 *                "env": { "FOO": "1" }, "timeout": 30000,
 *                "safe": true, "description": "Personal notes" }
 *   }
 *
 * The `mcp` tool's actions:
 *   servers  list the configured servers and their connection state;
 *   tools    list one server's tools (every configured server's when
 *            `server` is omitted) — connects lazily;
 *   call     invoke one tool on one server: its text content is the
 *            answer; an `isError` result surfaces as a tool error
 *            (`error.mcpDetail` carries the server's own text).
 *
 * PER-SERVER SHORTCUTS: one `mcp-<name>` tool per configured server
 * (rebuilt with every tool refresh, like the scanned tools). Each is
 * `{tool, arguments}` — action "call" with its server fixed; the
 * config's own `description` is folded into the shortcut's. A shortcut
 * inherits its server's `safe` mark.
 *
 * Servers spawn with the working folder as their cwd, WITHOUT the OS
 * write sandbox on purpose: an MCP server is a user-installed package
 * whose own writes (caches, configs, self-updates) a write-deny jail
 * would break — the trust anchor and the child environment
 * (lib/util.js childEnv: the settings env-allow/env-refuse stages, the
 * config's own `env` last) are the guards.
 *
 * SAFE MODE: the `mcp` tool is published as safe, but the safety
 * decision belongs to the SERVER: under `context.safe` (the calling
 * Agent's mode) only `"safe": true` servers are reachable — listings
 * hide the rest and a call to an unmarked server is refused.
 *
 * The pool's state is the `mcp` tool's catalog `status`
 * ({configured, connected}; /agent-status, the TUI info area).
 */

import { childEnv } from "../util.js";
import { mcpConnect, mcpRequest, mcpKey } from "./mcp-client.js";

const DEFAULT_TIMEOUT = 30_000; // ms per request (config may override)
const UNREACHABLE = "Choose a server listed by servers, then try again.";

/** The configured servers from the live settings tree. */
function configuredServers(env) {
  const servers = env.settings.mcp;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers).filter(([, config]) => typeof config?.command === "string" && config.command !== ""),
  );
}

/** The servers a caller may reach: safe-marked ones only under context.safe. */
function reachableServers(env, context) {
  const all = configuredServers(env);
  return context?.safe === true
    ? Object.fromEntries(Object.entries(all).filter(([, config]) => config.safe === true))
    : all;
}

const timeoutOf = (config) => (Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT);

function connect(env, name, config, context) {
  return mcpConnect(env._mcpPool, name, { ...config, env: childEnv(env.settings, config.env) }, context);
}

/** Publish the pool state as the `mcp` tool's catalog status. */
function reportStatus(env, servers) {
  const connected = [...env._mcpPool.entries()].filter(([, conn]) => !conn.closed).map(([key, conn]) => conn.name ?? key);
  const entry = env._tools.get("mcp");
  if (entry) entry.status = { ...entry.status, configured: Object.keys(servers).length, connected };
}

/** One server's tool list (handshake + tools/list, cached per connection). */
async function listTools(env, name, config, context) {
  const conn = await connect(env, name, config, context);
  if (conn.tools === null) {
    const result = await mcpRequest(conn, "tools/list", {}, timeoutOf(config), context);
    conn.tools = Array.isArray(result?.tools) ? result.tools : [];
  }
  return conn.tools;
}

/** Call one tool on one reachable server; `timeout` is capped at the server's own. */
async function callServer(env, { server, tool, arguments: toolArgs, timeout }, context) {
  const config = reachableServers(env, context)[server];
  if (!config) throw new Error(UNREACHABLE);
  if (typeof tool !== "string" || tool === "") throw new TypeError("Choose a tool name: call tools for the selected server, then try again.");
  const conn = await connect(env, server, config, context);
  const duration = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, timeoutOf(config)) : timeoutOf(config);
  const result = await mcpRequest(conn, "tools/call", { name: tool, arguments: toolArgs ?? {} }, duration, context);
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  if (result?.isError === true) {
    const error = new Error("Fix the remote tool arguments, then try again. If it still fails, ask the user to check that server's access and configuration.");
    error.mcpDetail = text !== "" ? text : JSON.stringify(result?.structuredContent ?? result ?? null);
    throw error;
  }
  return text !== "" ? text : JSON.stringify(result?.structuredContent ?? result ?? null);
}

/**
 * The `mcp` tool.
 * @param {object} env
 * @param {{action: "servers"|"tools"|"call", server?: string, tool?: string, arguments?: object, timeout?: number}} args
 * @param {object} [context] - the tool context ({safe, signal})
 * @returns {Promise<string>}
 */
async function mcp(env, { action, server, tool, arguments: toolArgs, timeout } = {}, context) {
  const servers = reachableServers(env, context);
  reportStatus(env, servers);
  if (action === "servers") {
    const names = Object.keys(servers);
    if (names.length === 0) return "No MCP servers are available. Ask the user to configure a server, then call servers again.";
    return names.map((name) => {
      const conn = env._mcpPool.get(mcpKey(name, servers[name]));
      return `${name}: ${conn ? (conn.closed ? "unavailable" : "connected") : "not connected"}`;
    }).join("\n");
  }
  if (action === "tools") {
    const names = server !== undefined ? [server] : Object.keys(servers);
    if (names.length === 0) return "No MCP servers are available. Ask the user to configure one, then try again.";
    const sections = await Promise.all(names.map(async (name) => {
      if (!servers[name]) throw new Error(UNREACHABLE);
      const tools = await listTools(env, name, servers[name], context);
      const lines = tools.map((t) => {
        const desc = String(t.description ?? "").replace(/\s+/g, " ").trim();
        return `  ${t.name}${desc ? ` — ${desc}` : ""}`;
      });
      return `${name} (${tools.length} tool${tools.length === 1 ? "" : "s"}):${lines.length > 0 ? `\n${lines.join("\n")}` : " (none)"}`;
    }));
    return sections.join("\n");
  }
  if (action === "call") {
    if (typeof server !== "string" || server === "") throw new TypeError("Choose a server name: call servers first, then try again.");
    const answer = await callServer(env, { server, tool, arguments: toolArgs, timeout }, context);
    reportStatus(env, servers);
    return answer;
  }
  throw new Error("Choose action servers, tools, or call, then try again.");
}

const MCP_SCHEMA = {
  // SAFE under a condition: the safety decision belongs to the SERVER
  safe: true,
  description: "Use an MCP server in three steps: call servers to discover names, call tools with a server to discover its tools, then call with that server, tool, and arguments. Server responses are returned as tool results.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["servers", "tools", "call"], description: "What to do" },
      server: { type: "string", description: "The configured server name (tools/call)" },
      tool: { type: "string", description: "The remote tool's name (call)" },
      arguments: { type: "object", description: "The remote tool's arguments (call)" },
    },
    required: ["action"],
  },
};

/**
 * Register the `mcp` tool and the per-server shortcuts for the servers
 * configured now (Env construction and every tool refresh: a server
 * removed from settings drops its shortcut; none configured, no tools).
 * @param {object} env
 */
export function mcpRegister(env) {
  env._mcpPool ??= new Map(); // key -> connection (lib/env/mcp-client.js)
  for (const name of env._mcpShortcuts ?? []) env._tools.delete(name);
  env._mcpShortcuts = new Set(); // every name this source registered
  const servers = configuredServers(env);
  if (Object.keys(servers).length === 0) return;
  if (!env._tools.has("mcp")) {
    env.toolAdd("mcp", (args, context) => mcp(env, args, context), MCP_SCHEMA, { builtin: true });
    env._mcpShortcuts.add("mcp");
  }
  for (const [server, config] of Object.entries(servers)) {
    const name = `mcp-${server}`;
    if (env._tools.has(name)) continue; // a scanned tool of the same name wins
    const description = String(config.description ?? "").trim();
    env.toolAdd(name, (args, context) => mcp(env, { action: "call", server, tool: args?.tool, arguments: args?.arguments }, context), {
      ...(config.safe === true ? { safe: true } : {}),
      description: `Call a tool on configured MCP server "${server}".${description ? ` ${description}` : ""}`,
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The remote tool's name" },
          arguments: { type: "object", description: "The remote tool's arguments" },
        },
        required: ["tool"],
      },
    }, { builtin: true });
    env._mcpShortcuts.add(name);
  }
}

/**
 * Stop every pooled server (env.close). Idempotent, never throws.
 * @param {object} env
 */
export function mcpClose(env) {
  for (const [key, conn] of env._mcpPool ?? []) {
    try { conn.close?.("MCP pool closed"); } catch { /* already gone */ }
    env._mcpPool.delete(key);
  }
}
