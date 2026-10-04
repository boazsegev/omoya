import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Agent from "../lib/agent.js";
import { AgentSession } from "../lib/app/web/session.js";
import { toolDisplay } from "../lib/app/shared/format.js";
import { testEnv } from "./fakes.js";

const patch = "```diff\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n```";
const source = readFileSync("lib/app/web/public/app.js", "utf8");

function clientFunction(name, next, globals) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n/**`, start);
  if (start < 0 || end < 0) throw new Error(`missing ${name}`);
  return new Function(...Object.keys(globals), `${source.slice(start, end)}; return ${name};`)(...Object.values(globals));
}

test("live tool.result keeps a scalar edit diff display as Markdown source", () => {
  const blocks = [{ kind: "tool", name: "edit", callId: "edit-1", state: "running", output: "" }];
  const finishTool = clientFunction("finishTool", "", {
    blocks, toolKey: (call) => call.callId, toolSanitizers: new Map(),
    liveTool: (match) => blocks.find(match), resultText: () => "edited",
    sanitizeText: (text) => text, toolDisplay, touch: () => {},
  });
  finishTool({ result: { name: "edit", callId: "edit-1" }, display: [{ type: "text", text: patch }] });
  expect(blocks[0].display).toEqual([patch]);
  finishTool({ result: { name: "edit", callId: "edit-1" }, display: patch });
  expect(blocks[0].display).toEqual([patch]);
});

test("history replay includes the edit diff on its tool answer", async () => {
  const env = await testEnv();
  const agent = new Agent({ env });
  try {
    agent.context.update((messages) => { messages.push(
      { type: 3, content: [{ type: "toolCall", name: "edit", callId: "edit-1", arguments: {} }] },
      { type: 4, name: "edit", callId: "edit-1", content: [{ type: "text", text: "edited" }], display: [{ type: "text", text: patch }] },
    ); return true; });
    const session = new AgentSession(agent);
    const history = session.historySnapshot();
    expect(history.find((item) => item.kind === "tool-answer")?.display).toEqual([{ type: "text", text: patch }]);
    const normalizeHistory = clientFunction("normalizeHistory", "", { toolDisplay, sanitizeText: (text) => text });
    expect(normalizeHistory(history).find((item) => item.kind === "tool")?.display).toEqual([patch]);
    expect(session.contextSnapshot().at(-1).content.at(-1).text).toBe(patch);
    session.dispose();
  } finally { await agent.close(); }
});
