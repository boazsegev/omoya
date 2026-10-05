import { expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import { AgentSession } from "../lib/app/web/session.js";
import { displaySource } from "../lib/app/web/public/app/logic/tool-display.js";
import { testEnv } from "./fakes.js";

const patch = "```diff\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n```";

test("live tool.result keeps a scalar edit diff display as Markdown source", () => {
  expect(displaySource([{ type: "text", text: patch }])).toEqual([patch]);
  expect(displaySource(patch)).toEqual([patch]);
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
    expect(displaySource(history.find((item) => item.kind === "tool-answer")?.display)).toEqual([patch]);
    expect(session.contextSnapshot().at(-1).content.at(-1).text).toBe(patch);
    session.dispose();
  } finally { await agent.close(); }
});
