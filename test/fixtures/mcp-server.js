/**
 * test/fixtures/mcp-server.js — TEST-ONLY stdio MCP server: newline-
 * delimited JSON-RPC 2.0. Answers initialize / tools/list / tools/call
 * for the fixture tools (echo, add, fail, getenv) and exits on the
 * "die" tool (connection-death handling). Runtime-agnostic (node/bun).
 */

const TOOLS = [
  { name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  { name: "fail", description: "Always fails with isError.", inputSchema: { type: "object", properties: {} } },
  { name: "die", description: "Exit the server process.", inputSchema: { type: "object", properties: {} } },
  { name: "getenv", description: "Echo one environment variable of the SERVER process.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function answer(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function handle(msg) {
  if (!msg || msg.id === undefined) return; // notifications need no answer
  const { id, method, params } = msg;
  if (method === "initialize") {
    return answer(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
  }
  if (method === "tools/list") return answer(id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name === "echo") return answer(id, { content: [{ type: "text", text: String(args?.text ?? "") }] });
    if (name === "add") return answer(id, { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] });
    if (name === "fail") return answer(id, { content: [{ type: "text", text: "the fixture failed on purpose" }], isError: true });
    if (name === "die") process.exit(3);
    if (name === "getenv") return answer(id, { content: [{ type: "text", text: process.env[args?.name] ?? "" }] });
    return answer(id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${method}` } }) + "\n");
}
