/**
 * tools/mcp.js — the `mcp` tool: MCP (Model Context Protocol) CLIENT
 * capabilities over stdio, zero dependencies (bun + Env only).
 *
 * Servers are USER-CONFIGURED at `settings.mcp` (the trust
 * anchor — only the package/settings-scoped settings files can name
 * a server; a project-scoped `mcp` key is REJECTED at load,
 * see lib/env/load.js; the live settings tree is read at call time,
 * so a file written mid-session can never inject one):
 *   "mcp": {
 *     "notes": { "command": "bun", "args": ["./mcp/notes.js"],
 *                "env": { "FOO": "1" }, "timeout": 30000,
 *                "safe": true, "description": "Personal notes" }
 *   }
 *
 * Actions:
 *   servers  list the configured servers and their connection state;
 *   tools    list one server's tools (every configured server's when
 *            `server` is omitted) — connects lazily;
 *   call     invoke one tool on one server: its text content is the
 *            answer; an `isError` result surfaces as a tool error.
 *
 * PER-SERVER SHORTCUTS: toolDescription(env) also publishes one
 * `mcp-<name>` tool per configured server (env.settings.mcp — read at
 * SCAN time, so it follows the same tool-refresh cadence as every
 * other tool; a settings edit needs a refresh to be seen). Each
 * shortcut is `{tool, arguments}` — action "call" with its server
 * fixed — so the model can reach a known server directly without
 * spelling out `server` on every call; the config's own `description`
 * (if any) is folded into the shortcut's own. A shortcut inherits its
 * server's `safe` mark and is otherwise identical in behavior to
 * calling the general `mcp` tool with that server name.
 *
 * Protocol: JSON-RPC 2.0, newline-delimited, over the spawned
 * process's stdio — initialize handshake, then tools/list and
 * tools/call; notifications and server-initiated requests are
 * ignored. Servers spawn with the working folder as their cwd,
 * WITHOUT the OS write sandbox on purpose: an MCP server is a
 * user-installed package whose own writes (caches, configs,
 * self-updates, app integrations) a write-deny jail would break —
 * the trust anchor (only settings can name a server) and the env
 * layer are the guards here. The environment is built by the shared
 * env layer (tools/guard/env.js — the settings env-allow/env-refuse
 * stages filter the INHERITED variables, the config's own `env`
 * merges last).
 *
 * SAFE MODE: the tool is published as safe (safe: true) but the
 * safety decision belongs to the SERVER, never the tool — a server
 * that only searches the web cannot mutate data, one that writes to
 * a cloud app can. The user marks read-only servers with
 * `"safe": true` (the trust anchor again); under the safe view this
 * tool reaches ONLY safe-marked servers — listings hide the rest and
 * a call to an unmarked server is refused with an ordinary error.
 *
 * the core module lib/env/mcp.js — MCP is a core feature, and Bun
 * preserves module identity across the tool's cache-busted
 * re-imports, so a tool refresh reuses live connections instead of
 * leaking orphaned server processes.
 */

import { spawn } from "node:child_process";
import { mcpPool, toolRevision } from "../lib/tool-runtime.js"; // the tool-runtime leaf: pool + shared revision, no whole-library load
import { NAMES } from "../lib/namespace.js";

const timestamp = toolRevision(); // shared tool-registry revision
const { childEnv } = await import(`./guard/env.js?now=${timestamp}`);

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: NAMES.agentName, version: "1" };
const DEFAULT_TIMEOUT = 30_000; // ms per request (config may override)

/** The core-owned connection pool (lib/env/mcp.js has ONE import
 * identity across the tool's cache-busted re-imports — refresh-safe). */
const pool = mcpPool; // key -> connection

/** The pool key: a server's identity is its name + launch command. */
function keyOf(name, config) {
  return `${name}${config.command} ${(config.args ?? []).join(" ")}`;
}

/**
 * One stdio connection: the child process, the id→promise map of
 * in-flight requests, and the line buffer. Never throws on process
 * death — every pending request rejects and the pool entry drops.
 * The server child inherits the settings-filtered environment plus
 * the config's own `env` additions — and is deliberately NOT
 * wrapped in the OS write sandbox (a jail would break the server's
 * own package writes: caches, configs, self-updates).
 */
function openConnection(name, config, settings) {
  const conn = {
    name,
    buffer: "",
    nextId: 0,
    pending: new Map(),
    tools: null, // the cached tools/list result
    closed: false,
    failure: null, // the death report (requests fail fast afterwards)
  };
  let child;
  try {
    child = spawn(config.command, config.args ?? [], {
      cwd: process.cwd(), // the working folder, same as every tool
      env: childEnv(settings, config.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    conn.closed = true;
    conn.failure = `spawn failed: ${err.message}`;
    return conn;
  }
  conn.child = child;
  // NEVER let a server hold the event loop: an unref'd child (and its
  // pipes) doesn't block process exit — without this, a used pool made
  // every exit hang until ^C. Well-behaved servers still get a clean
  // shutdown: on exit their stdin closes and they exit on EOF.
  child.unref?.();
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    conn.buffer += chunk;
    for (;;) {
      const nl = conn.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = conn.buffer.slice(0, nl).trim();
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server's stdout noise is not protocol — skip it
      }
      if (msg?.id === undefined || msg.id === null) continue; // notifications
      const entry = conn.pending.get(msg.id);
      if (!entry) continue;
      conn.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  });
  let stderr = "";
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on?.("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", () => {}); // the server may already be gone
  const die = (detail) => {
    if (conn.closed) return;
    conn.closed = true;
    conn.failure = detail;
    for (const [, entry] of conn.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(detail));
    }
    conn.pending.clear();
  };
  child.on("error", (err) => die(`spawn failed: ${err.message}`));
  child.on("close", (code) => die(
    `server "${name}" exited (code ${code ?? "?"})${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
  ));
  return conn;
}

/**
 * One JSON-RPC request. The per-request timeout (server config
 * `timeout`, default 30s) rejects without killing the connection.
 */
function request(conn, method, params, timeout) {
  if (conn.closed) return Promise.reject(new Error(conn.failure ?? "connection closed"));
  const id = ++conn.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`mcp: "${conn.name}" ${method} timed out after ${timeout}ms`));
    }, timeout);
    timer.unref?.();
    conn.pending.set(id, { resolve, reject, timer });
    conn.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/**
 * Connect (lazily) and handshake one configured server. A live pooled
 * connection is reused; a dead one is replaced.
 */
async function connect(name, config, settings) {
  const key = keyOf(name, config);
  let conn = pool.get(key);
  if (conn && !conn.closed) return conn;
  conn = openConnection(name, config, settings);
  pool.set(key, conn);
  const timeout = Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT;
  try {
    await request(conn, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeout);
    conn.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return conn;
  } catch (err) {
    conn.child?.kill?.("SIGKILL");
    pool.delete(key);
    throw new Error(`mcp: server "${name}" handshake failed: ${err.message}`);
  }
}

/** The configured servers from the live settings tree. */
function configuredServers(context) {
  const servers = context?.env?.settings?.mcp;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers).filter(([, c]) => typeof c?.command === "string" && c.command !== ""),
  );
}

/** Report the pool state to the registry (/agent-status, the TUI info area). */
function reportStatus(context, servers) {
  const connected = [];
  for (const [key, conn] of pool) {
    if (!conn.closed) connected.push(conn.name ?? key);
  }
  try {
    context?.env?.updateToolStatus?.("mcp", { configured: Object.keys(servers).length, connected });
  } catch { /* status reporting is best-effort */ }
}

/** One server's tool list (handshake + tools/list, cached per connection). */
async function listTools(name, config, settings) {
  const conn = await connect(name, config, settings);
  if (conn.tools === null) {
    const timeout = Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT;
    const result = await request(conn, "tools/list", {}, timeout);
    conn.tools = Array.isArray(result?.tools) ? result.tools : [];
  }
  return conn.tools;
}

/**
 * The mcp tool.
 * @param {Object} args
 * @param {"servers"|"tools"|"call"} args.action
 * @param {string} [args.server] - the configured server (tools/call)
 * @param {string} [args.tool] - the remote tool's name (call)
 * @param {Object} [args.arguments] - the remote tool's arguments (call)
 * @param {Object} [context] - the harness tool context ({env}) — the
 *   SAFE VIEW in safe mode (`env.safe` is itself: safe of safe is
 *   the same view), which restricts every action to safe-marked
 *   servers
 * @returns {Promise<string>}
 */
export async function callMcp({ server, tool, arguments: toolArgs, timeout, signal } = {}, context) {
  const settings = context?.env?.settings;
  const safeMode = context?.env != null && context.env === context.env.safe;
  const all = configuredServers(context);
  const servers = safeMode
    ? Object.fromEntries(Object.entries(all).filter(([, c]) => c.safe === true))
    : all;
  const config = servers[server];
  if (!config) throw new Error("Choose a server listed by servers, then try again.");
  if (typeof tool !== "string" || tool === "") throw new TypeError("Choose a tool name: call tools for the selected server, then try again.");
  if (signal?.aborted) throw signal.reason ?? new Error("MCP call cancelled");
  const conn = await connect(server, config, settings);
  const configured = Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : DEFAULT_TIMEOUT;
  const duration = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, configured) : configured;
  const pending = request(conn, "tools/call", { name: tool, arguments: toolArgs ?? {} }, duration);
  const result = signal ? await Promise.race([
    pending,
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("MCP call cancelled")), { once: true })),
  ]) : await pending;
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

export async function mcp({ action, server, tool, arguments: toolArgs } = {}, context) {
  const settings = context?.env?.settings;
  const safeMode = context?.env != null && context.env === context.env.safe; // the safe view's own fingerprint
  const all = configuredServers(context);
  // SAFE MODE: the SERVER's config carries the safety decision — only
  // `"safe": true` servers (user-marked read-only, the trust anchor)
  // are reachable; the rest are hidden from listings and refused on
  // a direct call
  const servers = safeMode
    ? Object.fromEntries(Object.entries(all).filter(([, c]) => c.safe === true))
    : all;
  /** The named server, or the reason it is unreachable. */
  const named = (name) => {
    if (servers[name]) return servers[name];
    if (all[name]) throw new Error("Choose a server listed by servers, then try again.");
    throw new Error("Choose a server listed by servers, then try again.");
  };
  reportStatus(context, servers);
  if (action === "servers") {
    const names = Object.keys(servers);
    if (names.length === 0) {
      return "No MCP servers are available. Ask the user to configure a server, then call servers again.";
    }
    const lines = names.map((name) => {
      const config = servers[name];
      const conn = pool.get(keyOf(name, config));
      const state = conn ? (conn.closed ? "unavailable" : "connected") : "not connected";
      return `${name}: ${state}`;
    });
    return lines.join("\n");
  }
  if (action === "tools") {
    const names = server !== undefined ? [server] : Object.keys(servers);
    if (names.length === 0) return "No MCP servers are available. Ask the user to configure one, then try again.";
    const sections = await Promise.all(names.map(async (name) => {
      const config = named(name);
      const tools = await listTools(name, config, settings);
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
    if (typeof tool !== "string" || tool === "") throw new TypeError("Choose a tool name: call tools for the selected server, then try again.");
    named(server);
    return callMcp({ server, tool, arguments: toolArgs }, context);
  }
  throw new Error("Choose action servers, tools, or call, then try again.");
}

/** This tool's own contribution to env.defaultsSchema() — see the
 *  tools.js module contract's `settingsSchema()`. */
export function settingsSchema() {
  return {
    mcp: {
      default: {},
      description:
        "MCP servers this Agent can reach (name -> {command, args?, " +
        "env?, timeout?, safe?, description?}) — package/settings " +
        "scope only, never the project folder.",
    },
  };
}

/**
 * The per-server shortcut tools: one `mcp-<name>` entry per configured
 * server, each a `{tool, arguments}` call fixed to that server (see
 * the module doc's PER-SERVER SHORTCUTS section). Built at SCAN time
 * from the live settings tree, so it follows the tool-refresh cadence
 * like every other tool.
 * @param {object|undefined} env - the owning Env, handed to
 *   toolDescription(env) by the scan (undefined before an env exists)
 * @returns {Object}
 */
function serverShortcuts(env) {
  const servers = configuredServers({ env });
  const out = {};
  for (const [name, config] of Object.entries(servers)) {
    const description = String(config.description ?? "").trim();
    out[`mcp-${name}`] = {
      ...(config.safe === true ? { safe: true } : {}),
      description: `Call a tool on configured MCP server "${name}".${description ? ` ${description}` : ""}`,
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The remote tool's name" },
          arguments: { type: "object", description: "The remote tool's arguments" },
        },
        required: ["tool"],
      },
      // no static export carries this name — the module contract lets
      // an entry supply its own scan-time closure (lib/env/tools.js)
      fn: (args, context) => mcp({ action: "call", server: name, tool: args?.tool, arguments: args?.arguments }, context),
    };
  }
  return out;
}

export function toolDescription(env) {
  return {
    mcp: {
      // SAFE under a condition: safe mode publishes this tool, but the
      // safety decision belongs to the SERVER (a web search cannot
      // mutate data; a cloud writer can) — only servers the user
      // marked "safe": true are reachable under the safe view
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
    },
    ...serverShortcuts(env),
  };
}
