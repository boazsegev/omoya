// Cancellation fixture: protocol requests can hang at each phase.
const phase = process.argv[2] ?? "tools/call";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
  }
});

function handle({ id, method, params }) {
  if (id === undefined) return;
  if (method === phase && params?.name !== "echo") {
    process.stderr.write(`pending:${process.pid}\n`);
    return;
  }
  const result = method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cancel", version: "1" } }
    : method === "tools/list" ? { tools: [] }
    : { content: [{ type: "text", text: String(params?.arguments?.text ?? process.pid) }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
