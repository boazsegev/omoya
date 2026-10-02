import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";

const source = readFileSync(join(import.meta.dir, "..", "lib/app/web/public/app.js"), "utf8");
function extractFunction(name, nextDeclaration) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextDeclaration, start);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${name}`);
  return source.slice(start, end);
}
const previewSource = extractFunction("previewNode", "\n/**\n * A collapsible card");
const thinkingSource = extractFunction("renderThinking", "\nconst TOOL_STATE");
const turnSource = source.slice(source.indexOf("function onDelta("), source.indexOf("\n/* ------------------------------------------------------------- transcript */", source.indexOf("function onDelta(")));

function node(tag, className, text = "") {
  return { tag, className, textContent: text, children: [], append(...children) { this.children.push(...children); } };
}

function harness() {
  const el = node;
  const markdownNode = (tag, className, text) => ({ ...node(tag, className), html: renderMarkdown(text) });
  const previewNode = new Function("el", "markdownNode", `${previewSource}; return previewNode;`)(el, markdownNode);
  const cardShell = (_block, _className, isOpen) => {
    const shell = node("details"); shell.open = isOpen;
    const summary = node("summary"); const head = node("span");
    shell.append(summary); summary.append(head);
    return { node: shell, summary, head };
  };
  const prefs = { collapse: { thinking: true } };
  const renderThinking = new Function("cardShell", "el", "previewNode", "previewRows", "markdownNode", "blockControls", "prefs", `${thinkingSource}; return renderThinking;`)(cardShell, el, previewNode, () => 4, markdownNode, () => node("controls"), prefs);
  return { previewNode, renderThinking };
}

test("web turn completion repaints final Markdown/math instead of streamed preview", () => {
  const client = new Function("renderMarkdown", `
    let blocks = [], current = null, agent = null, usage = null, rendered = [], fullRenders = 0;
    const touch = () => {};
    const setHistory = (history) => {
      blocks = history.map((block) => ({ ...block })); current = null;
      rendered = blocks.map((block) => renderMarkdown(block.text)); fullRenders++;
    };
    const pushBlock = (block) => blocks.push(block);
    const agentList = () => [];
    const updateUsage = () => {}, updateHeader = () => {}, updateComposerActivity = () => {}, scheduleRender = () => {}, updateSidebar = () => {};
    ${turnSource}
    return { onDelta, onTurnEnd, state: () => ({ blocks, rendered, fullRenders }) };
  `)(renderMarkdown);
  client.onDelta({ kind: "text", text: "**draft" });
  expect(renderMarkdown(client.state().blocks[0].text)).toContain("**draft");
  client.onTurnEnd({ terminal: { type: "done" }, history: [{ kind: "text", text: "**final** and $x^2$", done: true }] });
  expect(client.state().rendered[0]).toContain("<strong>final</strong>");
  expect(client.state().rendered[0]).toContain('role="math"');
  expect(client.state().fullRenders).toBe(1);
  client.onDelta({ kind: "thinking", text: "draft thought" });
  client.onTurnEnd({ terminal: { type: "error", error: "socket hang up" }, history: [
    { kind: "thinking", text: "final thought", done: true },
    { kind: "error", text: "socket hang up", done: true },
  ] });
  expect(client.state().blocks.filter((block) => block.kind === "error")).toHaveLength(1);
  expect(client.state().blocks[0].text).toBe("final thought");
});

describe("web thinking Markdown", () => {
  test("collapsed thinking renders Markdown and keeps the expanded body", () => {
    const { renderThinking } = harness();
    const card = renderThinking({ text: "**bold** and `code`", done: true });
    expect(card.open).toBe(false);
    expect(card.children[0].children[1].children[0].html).toContain("<strong>bold</strong> and <code>code</code>");
    expect(card.children[1].html).toContain("<strong>bold</strong> and <code>code</code>");
  });

  test("streamed collapsed thinking renders head and tail without hiding them in a cut fence", () => {
    const { renderThinking } = harness();
    const card = renderThinking({ text: "**first**\n```js\nconst x = 1;\nline\n- last", done: false });
    const preview = card.children[0].children[1];
    expect(preview.children[0].html).toContain("<strong>first</strong>");
    expect(preview.children[1].textContent).toContain("2 more lines");
    expect(preview.children[2].html).toContain("<li>last</li>");
  });

  test("preview escapes untrusted markup and preserves non-thinking plain previews", () => {
    const { previewNode } = harness();
    const thinking = previewNode("**safe** <img src=x onerror=alert(1)>", 8, "thinking-preview", true);
    expect(thinking.children[0].html).toContain("<strong>safe</strong>");
    expect(thinking.children[0].html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const tool = previewNode("**plain**", 8, "tool-preview");
    expect(tool.textContent).toBe("**plain**");
    expect(tool.children).toEqual([]);
  });
});
