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

/**
 * Return valid named server configurations from the live `env.settings.mcp` tree.
 * @param {object} env - Environment whose live settings are consulted.
 * @returns {Record<string, object>} Configurations with a non-empty string `command`; otherwise an empty object.
 */
function configuredServers(env) {
  const servers = env.settings.mcp;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers).filter(([, config]) => typeof config?.command === "string" && config.command !== ""),
  );
}

/**
 * Return configured servers reachable by this caller; safe mode exposes only explicitly safe servers.
 * @param {object} env - Environment providing live MCP settings.
 * @param {object} [context] - Tool context; `safe === true` restricts access.
 * @returns {Record<string, object>} Reachable server configurations.
 */
function reachableServers(env, context) {
  const all = configuredServers(env);
  return context?.safe === true
    ? Object.fromEntries(Object.entries(all).filter(([, config]) => config.safe === true))
    : all;
}

/**
 * Resolve a server's request timeout, falling back for missing or invalid values.
 * @param {object} config - Server configuration; positive finite `timeout` overrides the default.
 * @returns {number} Timeout in milliseconds.
 */
const timeoutOf = (config) => (Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT);

/**
 * Connect to a server using its configured child environment.
 * @param {object} env - Environment holding settings and the MCP connection pool.
 * @param {string} name - Configured server name.
 * @param {object} config - Server configuration.
 * @param {object} [context] - Tool context, including cancellation/safety information used by the client.
 * @returns {Promise<object>} The pooled or newly established connection.
 * @throws {Error} If connection setup fails or is cancelled.
 */
function connect(env, name, config, context) {
  return mcpConnect(env._mcpPool, name, { ...config, env: childEnv(env.settings, config.env) }, context);
}

/**
 * Publish the pool state as the `mcp` tool's catalog status.
 * @param {object} env - Environment whose tool catalog and MCP pool are updated.
 * @param {Record<string, object>} servers - Server configurations visible to the current caller.
 * @returns {void}
 * @effects Updates the registered `mcp` tool status when that tool exists.
 */
function reportStatus(env, servers) {
  const connected = [...env._mcpPool.entries()].filter(([, conn]) => !conn.closed).map(([key, conn]) => conn.name ?? key);
  const entry = env._tools.get("mcp");
  if (entry) entry.status = { ...entry.status, configured: Object.keys(servers).length, connected };
}

/**
 * Fetch one server's tool list, performing the handshake and caching `tools/list` per connection.
 * @param {object} env - Environment containing the MCP pool.
 * @param {string} name - Configured server name.
 * @param {object} config - Server configuration, including request timeout.
 * @param {object} [context] - Tool context forwarded to connection and request operations.
 * @returns {Promise<Array<object>>} Remote tool definitions.
 * @throws {Error} If connecting or requesting the list fails.
 * @effects Initializes the connection and caches its tool list when not already cached.
 */
async function listTools(env, name, config, context) {
  const conn = await connect(env, name, config, context);
  if (conn.tools === null) {
    const result = await mcpRequest(conn, "tools/list", {}, timeoutOf(config), context);
    conn.tools = Array.isArray(result?.tools) ? result.tools : [];
  }
  return conn.tools;
}

/**
 * Call one tool on a reachable server; a supplied timeout is capped at the server's configured timeout.
 * @param {object} env - Environment containing settings and the MCP pool.
 * @param {{server: string, tool: string, arguments?: object, timeout?: number}} options - Call options; omitted arguments become `{}` and invalid/non-positive timeout uses the server timeout.
 * @param {object} [context] - Tool context forwarded to connection and request operations.
 * @returns {Promise<string>} Joined text content, or serialized structured/result content when no text is returned.
 * @throws {Error} If the server is unreachable, the request fails, or the remote result has `isError`; remote error detail is attached as `mcpDetail`.
 * @throws {TypeError} If `tool` is not a non-empty string.
 * @effects Connects to the server as needed and sends an MCP `tools/call` request.
 */
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
 * @param {object} env - Environment containing settings, tools, and the MCP pool.
 * @param {{action: "servers"|"tools"|"call", server?: string, tool?: string, arguments?: object, timeout?: number}} [args={}] - Action and its optional server/tool call parameters.
 * @param {object} [context] - Tool context (`safe` restricts visible/reachable servers; `signal` may cancel requests).
 * @returns {Promise<string>} Server status, formatted tool listings, or the remote tool result.
 * @throws {Error} For an unknown action, inaccessible server, or connection/request failure.
 * @throws {TypeError} If a call action lacks a non-empty server name or tool name.
 * @effects Updates catalog status; `tools` and `call` may connect to configured servers.
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
 * @param {object} env - Environment providing the tool registry and configured settings.
 * @returns {void}
 * @effects Initializes the MCP pool, removes previously registered shortcuts, and registers the built-in MCP tool and eligible per-server shortcuts. Registers nothing when no servers are configured; an existing tool name takes precedence over a shortcut.
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
 * Stop every pooled server (called by `env.close`). Idempotent and suppresses close errors.
 * @param {object} env - Environment holding the MCP connection pool.
 * @returns {void}
 * @effects Closes pooled connections when possible and removes all pool entries.
 */
export function mcpClose(env) {
  for (const [key, conn] of env._mcpPool ?? []) {
    try { conn.close?.("MCP pool closed"); } catch { /* already gone */ }
    env._mcpPool.delete(key);
  }
}
