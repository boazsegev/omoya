import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contextEntries, viewerWhere, canEditViewerBlock } from "../lib/app/web/public/app/logic/viewer.js";
import Agent from "../lib/agent.js";
import { serve } from "../lib/app/web/server.js";
import { parseClientMessage } from "../lib/app/web/protocol.js";
import { testEnv, USER } from "./fakes.js";
import { toolCatalogText } from "../lib/app/shared/tool-catalog.js";

test("Web viewer prepends a virtual system catalog and offers copy but no mutations", () => {
  const stored = [{ messageIndex: 0, content: [{ messageIndex: 0, blockIndex: 0, viewerType: "system", text: "real system" }] }];
  const tools = { messageIndex: -1, blockIndex: 0, virtual: true, viewerType: "system", name: "Tools", text: "schema" };
  const entries = contextEntries(stored, tools);
  expect(entries.map((block) => block.source)).toEqual(["schema", "real system"]);
  expect(entries[1].messageIndex).toBe(0);
  expect(viewerWhere(entries[0], entries)).toBe("virtual system block");
  expect(viewerWhere(entries[1], entries)).toBe("message 1");
  expect(canEditViewerBlock(entries[0])).toBe(false);
  expect(canEditViewerBlock(entries[1])).toBe(true);
  expect(canEditViewerBlock({ ...entries[1], viewerType: "tool display" })).toBe(false);
  for (const type of ["context.rollback", "context.delete", "context.edit-text"]) {
    const packet = type === "context.delete" ? { type, messageIndexes: [-1] } : { type, messageIndex: -1, blockIndex: 0, text: "x" };
    expect(() => parseClientMessage(JSON.stringify(packet))).toThrow();
  }
});

test("Web async catalog results cannot overwrite a newer request or a switched Agent", async () => {
  const server = readFileSync("lib/app/web/workspace.js", "utf8");
  const start = server.indexOf("  async function sendContext(");
  const code = server.slice(start, server.indexOf("\n  /**", start));
  const sent = [];
  const sendContext = new Function("toolCatalogText", "send", `${code}; return sendContext;`)(toolCatalogText, (_entry, packet) => sent.push(packet));
  const releases = [];
  const agent = { model: "p/m", safe: true, get tools() { return new Promise((resolve) => releases.push(resolve)); } };
  const entry = { agent, session: { contextSnapshot: () => [] } };
  const old = sendContext(entry);
  const current = sendContext(entry);
  releases[1](new Map([["new", { name: "new" }]]));
  await current;
  releases[0](new Map([["old", { name: "old" }]]));
  await old;
  expect(sent).toHaveLength(1);
  expect(sent[0].tools.text).toContain('"name": "new"');
  const switched = sendContext(entry);
  entry.session = { contextSnapshot: () => [] };
  releases[2](new Map());
  await switched;
  expect(sent).toHaveLength(1);
});

test("Web context inspection publishes filtered schemas separately and preserves editing indices", async () => {
  const env = await testEnv();
  const schema = { description: "Read a value", safe: true, inputSchema: { type: "object", properties: { value: { type: "string", description: "The value." } } } };
  env.toolAdd("reader", () => "ok", schema);
  env.toolAdd("other", () => "ok", schema);
  env.toolAdd("hidden", () => "ok", { ...schema, secret: true });
  const agent = new Agent({ env, safe: true, tools: ["reader", "hidden"] });
  agent.context.append(USER("before"));
  const web = await serve({ port: 0, env, createSession: async () => ({ agent }) });
  const packets = [];
  let wake;
  const socket = new WebSocket(`ws://127.0.0.1:${web.port}/ws`, { headers: { Origin: `http://127.0.0.1:${web.port}` } });
  socket.onmessage = (event) => { const packet = JSON.parse(event.data); packets.push(packet); if (wake?.type === packet.type) { const resolve = wake.resolve; wake = null; resolve(packet); } };
  const next = (type) => new Promise((resolve) => { wake = { type, resolve }; });
  const request = async (packet) => { const result = next("context"); socket.send(JSON.stringify(packet)); return result; };
  try {
    const hello = next("hello");
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    await hello;
    const snapshot = await request({ type: "context.inspect" });
    expect(snapshot.tools).toMatchObject({ virtual: true, viewerType: "system", name: "Tools", messageIndex: -1 });
    const tools = await agent.tools;
    expect(tools).toBeInstanceOf(Map);
    expect(Array.isArray(tools)).toBe(false);
    expect(snapshot.tools.text).toBe(toolCatalogText(tools));
    expect(snapshot.tools.text).toContain("## `reader`\n\nRead a value\n\n```json\n{");
    expect(JSON.parse(snapshot.tools.text.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual(tools.get("reader"));
    expect(snapshot.tools.text).toContain('"name": "reader"');
    expect(snapshot.tools.text).not.toContain('"name": "hidden"');
    expect(snapshot.tools.text).not.toContain('"name": "other"');
    expect(snapshot.blocks[0].content[0].text).toBe("before");
    expect(agent.context.length).toBe(1);
    const edited = await request({ type: "context.edit-text", messageIndex: 0, blockIndex: 0, text: "after" });
    expect(edited.blocks[0].content[0].text).toBe("after");
    expect(edited.tools.virtual).toBe(true);
    Object.defineProperty(agent, "tools", { get: () => Promise.reject(new Error("catalog error")) });
    const failed = await request({ type: "context.inspect" });
    expect(failed.tools.text).toContain("catalog error");
    expect(agent.context.messages().map((message) => message.content[0].text)).toEqual(["after"]);
    expect(packets.find((packet) => packet.type === "hello").history).not.toContain("Published tools");
  } finally { socket.close(); web.stop(); await agent.close(); }
}, 10_000);
