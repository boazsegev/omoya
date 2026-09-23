import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { createTheme } from "../lib/gtui/theme.js";
import { createInlineTerminalRenderer } from "../lib/gtui/terminal-inline-host.js";
import { contextBlocks } from "../lib/tui-app/context-blocks.js";
import { transcriptItems } from "../lib/tui-app/transcript.js";
import { markdownRows } from "../lib/tui-app/markdown-view.js";
import { createApp } from "../lib/tui-app/app.js";
import { USER } from "./fakes.js";

function stubAgent(context = []) {
  return { context, pending: [], model: "test/model", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, thinking: "high" };
}
const plain = (bytes) => bytes.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

describe("supervisor reproductions for reported TUI failures", () => {
  test("a completed short exchange stays visible beside the input in inline mode", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 12 });
    const root = GTUI.view.column({}, [
      GTUI.view.feed({ items: [{ key: "reply", done: true, node: GTUI.view.text({ margin: 0 }, "VISIBLE REPLY") }] }),
      GTUI.view.input({ id: "draft", value: "", focus: true }),
    ]);
    renderer.render(root, createTheme(), { width: 40, height: 12 });
    // The settled exchange remains in the existing physical viewport.
    // Native-inline tail diff must not erase/reprint it on an identical frame.
    expect(plain(writes.at(-1))).toContain("VISIBLE REPLY");
    renderer.render(root, createTheme(), { width: 40, height: 12 });
    expect(writes.at(-1)).toBe("");
  });

  test("an authoritative revision repaints an already seen feed block", () => {
    const writes = [];
    const renderer = createInlineTerminalRenderer({ write: (bytes) => writes.push(bytes), rows: () => 8 });
    const root = (text) => GTUI.view.feed({ items: [{ key: "stable", done: true, node: GTUI.view.text({}, text) }] });
    renderer.render(root("before"), createTheme(), { width: 40, height: 8 });
    renderer.render(root("after"), createTheme(), { width: 40, height: 8 });
    expect(plain(writes.at(-1))).toContain("after");
  });

  test("all blocks of an unfinished response remain revisable", () => {
    const live = { type: 3, content: [{ type: "text", text: "**unfinished" }, { type: "toolCall", callId: "c", name: "read", arguments: "{" }] };
    expect(contextBlocks([], live).every((block) => block.open)).toBe(true);
  });

  test("application text contains no hand-inserted message borders", () => {
    const item = transcriptItems(contextBlocks([USER("plain source")]))[0];
    const contents = item.node.children.flatMap((row) => row.content).map((span) => span.text).join("");
    expect(contents).toBe("plain source");
  });

  test("fenced markdown renders code content rather than raw fence delimiters", () => {
    const rows = markdownRows("```js\nconst value = 1;\n```");
    const visible = rows.flatMap((row) => row.content).map((span) => span.text).join("\n");
    expect(visible).toContain("const value = 1;");
    expect(visible).not.toContain("```");
  });

  test("closing heading hashes never corrupt logical source offsets", () => {
    const raw = "# Heading #";
    const span = markdownRows(raw)[0].content.find((part) => part.text === "Heading");
    expect(raw.slice(span.source.start, span.source.end)).toBe("Heading");
  });

  test("Alt+Shift+Left extends a word selection rather than invoking session navigation", async () => {
    const app = createApp(stubAgent(), { sources: {} });
    const host = GTUI.host.memory({ width: 60, height: 12 });
    const ui = new GTUI({ host });
    const run = ui.run(app);
    try {
      host.send({ type: "paste", text: "one two" });
      host.send({ type: "key", key: "alt+shift+left" });
      host.send({ type: "key", key: "copy" });
      expect(host.effects.some((value) => value.type === "copy" && value.text === "two")).toBe(true);
    } finally { ui.stop(); await run; }
  });
});
