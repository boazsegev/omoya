// Test-only HTTP MCP fixture; import startMcpHttp and stop it in finally.
const TOOLS = [
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } } },
  { name: "invalid", inputSchema: { type: "object", properties: { count: { type: "number", "x-mcp-header": "Count" } } } },
];
export function startMcpHttp(mode = "dual") {
  const seen = [];
  let session = 0;
  let expire = false;
  let offline = false;
  let failNext = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (offline) return new Response("unavailable", { status: 503 });
    if (failNext) { failNext = false; return new Response("temporarily unavailable", { status: 503 }); }
    if (request.method === "DELETE") { seen.push({ method: "DELETE", headers: Object.fromEntries(request.headers) }); return new Response(null, { status: 202 }); }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json();
    const headers = Object.fromEntries(request.headers);
    seen.push({ method: message.method, params: message.params, headers });
    const modern = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
    const error = (code, text, status) => Response.json({ jsonrpc: "2.0", id: message.id, error: { code, message: text } }, { status });
    if (modern && mode === "legacy") return error(-32601, "legacy server", 400);
    if (!modern && mode === "modern" && message.method === "initialize") return error(-32601, "modern only", 400);
    if (message.method === "server/discover") return Response.json({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } });
    if (message.method === "initialize") {
      session++;
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } } }, { headers: { "Mcp-Session-Id": `session-${session}` } });
    }
    if (mode === "legacy" && message.method !== "notifications/initialized") {
      if (expire || headers["mcp-session-id"] !== `session-${session}`) { expire = false; return new Response(null, { status: 404 }); }
    }
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (message.method === "tools/list") result = message.params?.cursor ? { tools: [TOOLS[1]], ttlMs: 0 } : { tools: [TOOLS[0]], nextCursor: "page2", ttlMs: 0 };
    else if (message.method === "tools/call") result = { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] };
    else return error(-32601, "method not found", 404);
    const answer = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "tools/list") return new Response(`:keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${answer}\ndata: \n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return Response.json(JSON.parse(answer));
  } });
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen,
    expireSession: () => { expire = true; }, failOnce: () => { failNext = true; },
    setOffline: (value) => { offline = value; }, stop: () => server.stop(true) };
}
