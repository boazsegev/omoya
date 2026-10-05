/** Env-private MCP tool source. `settings.mcp` is package/user scope only:
 * project settings cannot name an unsandboxed child process or remote endpoint.
 * Config: name -> {command, args?, env?} OR {url, headers?}, with shared
 * timeout?, safe?, description?. Stdio starts in env.cwd without the OS write
 * sandbox: installed server packages need their own caches/config/write access;
 * settings trust scope and the settings-filtered child environment are guards.
 * HTTP allows HTTPS or loopback HTTP; headers expand ${VAR} from childEnv.
 * Modern requests are stateless; legacy servers initialize and retain a session.
 * Cancellation stops one request, never the pooled server. Safe mode exposes
 * only servers with safe:true; the mcp tool itself is always safe. The catalog
 * reports {configured: all configured names, connected: handshake/probe done}.
 */
import { createServers } from "./mcp/servers.js";

const UNREACHABLE = "Choose a server listed by servers, then try again.";
function registry(env) {
  env._mcpServers ??= createServers(env, (status) => {
    const entry = env._tools.get("mcp");
    if (entry) entry.status = { ...entry.status, ...status };
  });
  return env._mcpServers;
}
function visible(env, context) {
  return [...registry(env).entries].filter(([, entry]) => context?.safe !== true || entry.config?.safe === true);
}
function accessible(env, name, context) {
  const entry = registry(env).entries.get(name);
  if (!entry || (context?.safe === true && entry.config?.safe !== true) || entry.state === "invalid") {
    throw new Error(entry?.state === "invalid" ? entry.error : UNREACHABLE);
  }
  return entry;
}
async function connection(env, name, context) {
  accessible(env, name, context);
  return registry(env).connect(name, context?.signal);
}
function formatResult(result) {
  const text = (Array.isArray(result?.content) ? result.content : []).filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
  if (result?.isError === true) {
    const error = new Error("Fix the remote tool arguments, then try again. If it still fails, ask the user to check that server's access and configuration.");
    error.mcpDetail = text || JSON.stringify(result?.structuredContent ?? result ?? null);
    throw error;
  }
  return text || JSON.stringify(result?.structuredContent ?? result ?? null);
}
/** Dispatch one MCP action; caller safety filters listings and reachability. */
function contentBlocks(blocks) {
  const result = []; let bytes = 0;
  for (const block of blocks.slice(0, 32)) {
    if (block.type === "text") {
      const text = String(block.text ?? "");
      bytes += Buffer.byteLength(text);
      if (bytes > 1024 * 1024) throw new Error("MCP content exceeds 1 MiB");
      result.push({ type: "text", text });
    } else if (block.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) && typeof block.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
      bytes += block.data.length * 3 / 4;
      if (bytes > 1024 * 1024) throw new Error("MCP content exceeds 1 MiB");
      result.push({ type: "image", content: block.data, mimetype: block.mimeType });
    } else result.push({ type: "text", text: `[MCP ${block.type ?? "binary"} content omitted]` });
  }
  return result;
}
function readContent(contents) {
  const blocks = [];
  for (const item of contents ?? []) {
    if (typeof item.text === "string") blocks.push({ type: "text", text: `${item.uri ?? "resource"}: ${item.text}` });
    else if (typeof item.blob === "string") blocks.push({ type: "image", data: item.blob, mimeType: item.mimeType });
  }
  return blocks;
}
/** Format remote blocks as untrusted tool-result data; images retain native image blocks. */
function resultBlocks(blocks) {
  const content = contentBlocks(blocks);
  return content.some((block) => block.type === "image") ? { content } : content.map((block) => block.text).join("\n");
}
async function mcp(env, { action, server, tool, name, uri, arguments: toolArgs, timeout } = {}, context) {
  const serversRegistry = registry(env);
  const servers = visible(env, context);
  if (action === "servers") {
    if (!servers.length) return "No MCP servers are available. Ask the user to configure a server, then call servers again.";
    return servers.map(([name, entry]) => {
      if (entry.state === "invalid") return `${name}: invalid config — ${entry.error}`;
      if (entry.state === "needs-sign-in" || entry.auth?.needsLogin) return `${name}: needs sign-in — run om --mcp-login ${name}`;
      if (entry.state === "failed") return `${name}: failed — ${entry.error} (retries on next use)`;
      if (entry.state === "connected" && !entry.client?.closed) {
        const count = entry.client.tools?.length;
        return `${name}: connected${count == null ? "" : ` (${count} tools)`}`;
      }
      return `${name}: ready (connects on first use)`;
    }).join("\n");
  }
  if (action === "tools") {
    const names = server !== undefined ? [server] : servers.map(([name]) => name);
    if (!names.length) return "No MCP servers are available. Ask the user to configure one, then try again.";
    return (await Promise.all(names.map(async (name) => {
      const client = await connection(env, name, context);
      let tools;
      try { tools = await client.listTools({ signal: context?.signal }); }
      catch (error) { serversRegistry.authFailure(name, error); serversRegistry.failure(name, client, error, context?.signal); throw error; }
      const lines = tools.map((t) => {
        const description = String(t.description ?? "").replace(/\s+/g, " ").trim();
        return `  ${t.name}${description ? ` — ${description}` : ""}`;
      });
      lines.push(...client.dropped.map(({ name: dropped, reason }) => `  dropped: ${dropped} — ${reason}`));
      return `${name} (${tools.length} tool${tools.length === 1 ? "" : "s"}):${lines.length ? `\n${lines.join("\n")}` : " (none)"}`;
    }))).join("\n");
  }
  if (action === "resources" || action === "prompts") {
    const names = server === undefined ? servers.map(([key]) => key) : [server];
    if (!names.length) return "No MCP servers are available.";
    const kind = action;
    return (await Promise.all(names.map(async (key) => {
      const client = await connection(env, key, context);
      try {
        const items = await (kind === "resources" ? client.listResources({ signal: context?.signal }) : client.listPrompts({ signal: context?.signal }));
        return `${key} (${items.length} ${kind}):${items.length ? "\n" + items.map((item) => `  ${item.uri ?? item.name}${item.description ? ` — ${item.description}` : ""}`).join("\n") : " (none)"}`;
      } catch (error) { serversRegistry.authFailure(key, error); serversRegistry.failure(key, client, error, context?.signal); throw error; }
    }))).join("\n");
  }
  if (action === "resource" || action === "prompt") {
    if (typeof server !== "string" || !server) throw new TypeError("Choose a server name: call servers first.");
    if (action === "resource" && (typeof uri !== "string" || !uri)) throw new TypeError("Choose a resource URI: list resources first.");
    if (action === "prompt" && (typeof name !== "string" || !name)) throw new TypeError("Choose a prompt name: list prompts first.");
    if (action === "prompt" && (toolArgs !== undefined && (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs) || Object.values(toolArgs).some((arg) => typeof arg !== "string")))) throw new TypeError("Prompt arguments must be strings.");
    const client = await connection(env, server, context);
    try {
      if (action === "resource") return resultBlocks(readContent((await client.readResource(uri, { signal: context?.signal })).contents));
      const prompt = await client.getPrompt(name, toolArgs, { signal: context?.signal });
      const blocks = [{ type: "text", text: `Remote prompt ${name} (untrusted data): ${prompt?.description ?? ""}` }];
      for (const message of prompt?.messages ?? []) {
        blocks.push({ type: "text", text: `[${message.role === "assistant" ? "assistant" : "user"} message]` });
        const content = message.content;
        if (content?.type === "resource") blocks.push(...readContent([content.resource]));
        else if (content?.type === "resource_link") blocks.push({ type: "text", text: `[resource link: ${content.uri}]` });
        else blocks.push(content);
      }
      return resultBlocks(blocks);
    } catch (error) { serversRegistry.authFailure(server, error); serversRegistry.failure(server, client, error, context?.signal); throw error; }
  }
  if (action === "call") {
    if (typeof server !== "string" || !server) throw new TypeError("Choose a server name: call servers first, then try again.");
    accessible(env, server, context);
    if (typeof tool !== "string" || !tool) throw new TypeError("Choose a tool name: call tools for the selected server, then try again.");
    const client = await serversRegistry.connect(server, context?.signal);
    const limit = serversRegistry.timeout(server);
    try {
      const result = await client.callTool(tool, toolArgs ?? {}, {
        signal: context?.signal,
        timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, limit) : limit,
      });
      if (result?.isError === true) return formatResult(result);
      if (Array.isArray(result?.content) && result.content.some((block) => block?.type === "image")) return resultBlocks(result.content);
      return formatResult(result);
    } catch (error) { serversRegistry.authFailure(server, error); serversRegistry.failure(server, client, error, context?.signal); throw error; }
  }
  throw new Error("Choose action servers, tools, or call; resources/resource or prompts/prompt are also available.");
}
const MCP_SCHEMA = {
  safe: true,
  description: "Use an MCP server in three steps: call servers to discover names, " +
    "call tools with a server to discover its tools, then call with that server, tool, " +
    "and arguments. Use resources/resource or prompts/prompt to list and read remote untrusted content.",
  inputSchema: { type: "object", properties: {
    action: { type: "string", enum: ["servers", "tools", "call", "resources", "resource", "prompts", "prompt"], description: "What to do" },
    server: { type: "string", description: "Configured server name (tools, call, resource, prompt; optional for listings)" },
    tool: { type: "string", description: "The remote tool's name (call)" },
    uri: { type: "string", description: "Resource URI (resource)" },
    name: { type: "string", description: "Remote prompt name (prompt)" },
    arguments: { type: "object", description: "Remote tool arguments (call) or string-valued prompt arguments (prompt)" },
  }, required: ["action"] },
};
/** Reconcile configured shortcuts on each tool scan and publish registry status. */
export function mcpRegister(env) {
  const serversRegistry = registry(env);
  for (const name of env._mcpShortcuts ?? []) env._tools.delete(name);
  env._mcpShortcuts = new Set();
  serversRegistry.refresh();
  if (!serversRegistry.entries.size) return;
  if (!env._tools.has("mcp")) {
    env.toolAdd("mcp", (args, context) => mcp(env, args, context), MCP_SCHEMA, { builtin: true });
    env._mcpShortcuts.add("mcp");
  }
  for (const [server, entry] of serversRegistry.entries) {
    if (entry.state === "invalid") continue;
    const name = `mcp-${server}`;
    if (env._tools.has(name)) continue;
    const description = String(entry.config.description ?? "").trim();
    env.toolAdd(name, (args, context) => mcp(env, { action: "call", server, tool: args?.tool, arguments: args?.arguments }, context), {
      ...(entry.config.safe === true ? { safe: true } : {}),
      description: `Call a tool on configured MCP server "${server}".${description ? ` ${description}` : ""}`,
      inputSchema: { type: "object", properties: {
        tool: { type: "string", description: "The remote tool's name" },
        arguments: { type: "object", description: "The remote tool's arguments" },
      }, required: ["tool"] },
    }, { builtin: true });
    env._mcpShortcuts.add(name);
  }
  env._tools.get("mcp").status = serversRegistry.status();
}
/** Stop registry-owned clients when Env closes. */
export function mcpClose(env) { env._mcpServers?.closeAll(); }
export function mcpLogin(env, name, options) { return registry(env).login(name, options); }
export function mcpPaste(env, input) { return registry(env).paste(input); }
export function mcpStatus(env) { return [...registry(env).entries].map(([name, entry]) => ({ name,
  state: entry.auth?.needsLogin ? "needs-sign-in" : entry.state })); }
