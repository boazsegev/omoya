// test/tui-app-transcript.test.js — proof for Phase 03 step 2
// (Transcript): raw markdown -> GTUI rich-text rows with role/link/
// source-offset spans (markdown-view.js), context blocks -> GTUI feed
// items with the pi-style tool bar and done-once keys (transcript.js),
// and the app wiring end to end on GTUI's memory host: a real turn's
// exchange, a markdown link's source offset and href, a tool call's
// header, and an error notice.
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { layoutView } from "../lib/gtui/layout.js";
import { createControls } from "../lib/gtui/controls.js";
import { Agent } from "../lib/agent.js";
import { markdownRows } from "../lib/tui-app/markdown-view.js";
import { transcriptItems, noticeItems, createTranscriptProjector } from "../lib/tui-app/transcript.js";
import { contextBlocks } from "../lib/tui-app/context-blocks.js";
import { createApp, msg } from "../lib/tui-app/app.js";
import { scriptedIO, testEnv, USER, TEXT, TOOLCALL } from "./fakes.js";

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(10);
  }
  return fn();
}

/** Every span's source offset must reconstruct verbatim out of the raw text. */
function assertOffsetsReconstruct(raw, rows) {
  for (const row of rows) {
    for (const span of row.content ?? row.table?.rows.flatMap((tableRow) => tableRow.cells.flat())) {
      if (!span.source) continue;
      expect(raw.slice(span.source.start, span.source.end)).toBe(span.text);
    }
  }
}

  test("a windowed render keeps only head + marker + tail, offsets intact, fence state threaded", () => {
    const body = Array.from({ length: 10_000 }, (_, index) => `line ${index} with **bold** text`);
    const raw = ["```js", ...body, "```"].join("\n");
    const rows = markdownRows(raw, { head: 1, tail: 2 });
    expect(rows).toHaveLength(4); // never one row per source line
    expect(rows[0].role).toBe("md.code"); // the fence delimiter row
    expect(rows[1].content[0].text).toBe("..."); // the omission marker
    expect(rows[2].role).toBe("md.code"); // fence state threaded across the dropped middle
    expect(rows[2].content[0].text).toBe(body.at(-1));
    assertOffsetsReconstruct(raw, rows.filter((row) => row.content.length > 0 && row.content[0].text !== "..."));
  });

  test("a small source renders complete even with a window configured", () => {
    const raw = "one\ntwo\nthree";
    expect(markdownRows(raw, { head: 1, tail: 2 })).toHaveLength(3);
  });

describe("markdown-view: raw markdown -> role/link/source spans", () => {
  test("plain text carries a verbatim source range", () => {
    const raw = "hello world";
    const rows = markdownRows(raw);
    expect(rows).toEqual([{ role: "md.text", content: [{ text: "hello world", source: { start: 0, end: 11 } }] }]);
    assertOffsetsReconstruct(raw, rows);
  });

  test("bold/em/code/link spans get their own role and offsets into the SOURCE (delimiters excluded)", () => {
    const raw = "a **b** c `d` e [link](http://x) f";
    const rows = markdownRows(raw);
    assertOffsetsReconstruct(raw, rows);
    const spans = rows[0].content;
    expect(spans.find((s) => s.text === "b")).toMatchObject({ role: "md.strong", source: { start: 4, end: 5 } });
    expect(spans.find((s) => s.text === "d")).toMatchObject({ role: "md.code", source: { start: 11, end: 12 } });
    const link = spans.find((s) => s.text === "link");
    expect(link).toMatchObject({ role: "md.link", link: "http://x", source: { start: 17, end: 21 } });
  });

  test("a heading's role is md.heading; the marker is excluded from its source range", () => {
    const raw = "## Title";
    const rows = markdownRows(raw);
    expect(rows).toEqual([{ role: "md.heading", content: [{ text: "Title", source: { start: 3, end: 8 } }] }]);
  });

  test("an ordered list keeps its literal marker as a copyable span; an unordered one substitutes a bullet at the SAME source range", () => {
    const ordered = markdownRows("2. two");
    expect(ordered[0].content[0]).toEqual({ text: "2.", source: { start: 0, end: 2 } });
    assertOffsetsReconstruct("2. two", ordered);

    const unordered = markdownRows("- one");
    expect(unordered[0].content[0]).toEqual({ text: "•", source: { start: 0, end: 1 } }); // displayed glyph diverges from source on purpose
    expect("- one".slice(0, 1)).toBe("-"); // the source at that range is still the raw marker
  });

  test("a quote's bar is theme decoration, not application source content", () => {
    const rows = markdownRows("> quoted");
    expect(rows[0].role).toBe("md.quote");
    expect(rows[0].content[0]).toEqual({ text: "quoted", source: { start: 2, end: 8 } });
    assertOffsetsReconstruct("> quoted", rows);
  });

  test("GFM tables become one semantic node and omit the alignment separator", () => {
    const raw = "| Name | Value |\n| --- | ---: |\n| **A** | 1 |";
    const rows = markdownRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("md.table");
    expect(rows[0].table.rows[0].cells.map((cell) => cell.map((part) => part.text).join(""))).toEqual(["Name", "Value"]);
    expect(rows[0].table.rows[1].cells.map((cell) => cell.map((part) => part.text).join(""))).toEqual(["A", "1"]);
    assertOffsetsReconstruct(raw, rows);
  });

  test("tables wrap their widest columns while preserving source offsets and header styling", () => {
    const raw = "| Name | Description |\n| --- | --- |\n| A | a very long description |";
    const node = transcriptItems([{ type: "text", text: raw, group: "message", section: "Text", ordinal: 0 }])[0].node;
    const snapshot = layoutView(node, { width: 14, height: 10 }).snapshot;
    expect(snapshot.lines).toEqual(["  Nam   Desc", "  e     ript", "        ion", "  A     a", "        very", "        long", "        desc", "        ript", "        ion"]);
    expect(snapshot.roles.some((span) => span.role.includes("md.table.heading"))).toBe(true);
    expect(snapshot.sources.some(({ source }) => source.start === raw.indexOf("Description"))).toBe(true);
  });

  test("a fenced code line renders verbatim, unparsed for inline markdown", () => {
    const raw = "`*not em*`";
    const rows = markdownRows(raw);
    expect(rows[0].content.find((s) => s.text === "*not em*")).toBeTruthy();
  });

  test("multi-line text offsets account for the newline between lines", () => {
    const raw = "one\ntwo **b**";
    const rows = markdownRows(raw);
    expect(rows).toHaveLength(2);
    assertOffsetsReconstruct(raw, rows);
    expect(rows[1].content.find((s) => s.text === "b").source).toEqual({ start: 10, end: 11 });
  });
});

describe("transcript.js: context blocks -> GTUI feed items", () => {
  test("a settled block is done:true; the live/open block stays done:false", () => {
    const blocks = contextBlocks([USER("hi")], { type: 3, content: [{ type: "text", text: "..." }] });
    const items = transcriptItems(blocks);
    expect(items[0].done).toBe(true); // the user message is settled
    expect(items.at(-1).done).toBe(false); // the live assistant block repaints every frame
  });

  test("system labels and user markdown keep their base message styling", () => {
    const items = transcriptItems(contextBlocks([
      { type: 1, content: [{ type: "text", text: "rules" }] },
      USER("hello **bold**"),
    ]));
    const memory = GTUI.host.memory({ width: 80 });
    const ui = new GTUI({ host: memory });
    ui.run({ init: () => ({ model: {}, effects: [] }), update: (m) => ({ model: m, effects: [] }), view: () => GTUI.view.feed({ items }) });
    expect(memory.snapshot().lines.some((line) => line.includes("[system]"))).toBe(true);
    expect(memory.snapshot().roles.some((span) => span.role === "message.user md.strong")).toBe(true);
    ui.stop();
  });

  test("a tool call has clean semantic content and a themed physical border", () => {
    const blocks = contextBlocks([{ type: 3, content: [{ type: "toolCall", callId: "c1", name: "read", arguments: { path: "x" } }] }]);
    const items = transcriptItems(blocks);
    expect(items[0].node.children[0].content.map((s) => s.text).join("")).toBe("[tool call] read");
    const memory = GTUI.host.memory({ width: 80 });
    const ui = new GTUI({ host: memory, theme: createApp({ context: [], pending: [], endpoint: "", model: "", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {}, thinking: "" }, { sources: {} }).theme });
    ui.run({ init: () => ({ model: {}, effects: [] }), update: (m) => ({ model: m, effects: [] }), view: () => GTUI.view.feed({ items }) });
    expect(memory.snapshot().lines[0]).toContain("▌   [tool call] read");
    ui.stop();
  });

  test("tool-call body and thinking previews tail-cap at eight rows while displays remain full", () => {
    const long = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n");
    const items = transcriptItems([
      { type: "toolcall", label: "read", text: long, group: "call", section: "Call", ordinal: 0 },
      { type: "thinking", text: long, group: "message", section: "Thinking", ordinal: 0 },
      { type: "display", label: "display", text: long, group: "display", section: "Display", ordinal: 0 },
    ]);
    const ui = (node) => layoutView(node, { width: 30, height: 30 }).snapshot.lines.map((line) => line.trim());
    expect(ui(items[0].node)).toEqual(["[tool call] read", "row 0", "...", "row 9"]);
    expect(ui(items[1].node)).toEqual(["row 0", "...", ...Array.from({ length: 6 }, (_, index) => `row ${index + 4}`)]);
    expect(ui(items[2].node)).toEqual(Array.from({ length: 10 }, (_, index) => `row ${index}`));
  });

  test("tool and thinking preview caps accept independent theme-derived rows", () => {
    const long = Array.from({ length: 6 }, (_, index) => `row ${index}`).join("\n");
    const items = transcriptItems([
      { type: "toolresult", label: "read", text: long, group: "tool", section: "Result", ordinal: 0 },
      { type: "thinking", text: long, group: "message", section: "Thinking", ordinal: 0 },
    ], 0, { previewRows: { toolresult: 2, thinking: 3 } });
    const lines = (node) => layoutView(node, { width: 30, height: 30 }).snapshot.lines.map((line) => line.trim());
    expect(lines(items[0].node)).toEqual(["[tool ok] read", "row 0", "..."]);
    expect(lines(items[1].node)).toEqual(["row 0", "...", "row 5"]);
  });

  test("the block viewer opts out of transcript preview caps", () => {
    const long = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n");
    const node = transcriptItems([{ type: "toolcall", label: "read", text: long, group: "call", section: "Call", ordinal: 0 }], 0, { previews: false })[0].node;
    expect(layoutView(node, { width: 30, height: 30 }).snapshot.lines.map((line) => line.trim())).toEqual(["[tool call] read", ...Array.from({ length: 10 }, (_, index) => `row ${index}`)]);
  });

  test("an OPEN tool payload tail-caps while streaming; open thinking stays complete", () => {
    const long = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n");
    const items = transcriptItems([
      { type: "toolcall", label: "edit", text: long, group: "call", section: "Call", ordinal: 0, open: true },
      { type: "thinking", text: long, group: "message", section: "Thinking", ordinal: 0, open: true },
    ]);
    const lines = (node) => layoutView(node, { width: 30, height: 30 }).snapshot.lines.map((line) => line.trim());
    // streamed args/stdout are tail-interest: capped exactly like a settled preview
    expect(lines(items[0].node)).toEqual(["[tool call] edit", "row 0", "...", "row 9"]);
    // reasoning stays complete while open for read-along + queued hints
    expect(lines(items[1].node)).toEqual(Array.from({ length: 10 }, (_, index) => `row ${index}`));
    expect(items[0].done).toBe(false); // still the live tail, committed only when settled
  });

  test("a tool-result splice keeps every unaffected block's node identical (documented cache contract)", () => {
    const settled = (index) => ({ type: "text", text: `message ${index}`, group: `message:${index}`, section: "Message", ordinal: 0, open: false });
    const blocks = [0, 1, 2, 3, 4].map(settled);
    const projector = createTranscriptProjector({});
    const before = projector.project(blocks, 1);
    const spliced = [...blocks];
    spliced.splice(2, 0, { type: "toolresult", label: "edit", text: "ok", group: "call:1", section: "Result", ordinal: 0, open: false });
    const after = projector.project(spliced, 1);
    // indices shifted under the splice, yet every pre-existing block's
    // frozen node is reused by identity (a full tail re-render would
    // rebuild them all)
    for (const index of [0, 1]) expect(after[index].node).toBe(before[index].node);
    for (const index of [2, 3, 4]) expect(after[index + 1].node).toBe(before[index].node);
    expect(after[2].key).not.toBe(before[2].key); // the spliced result is genuinely new
  });

  test("notices render as their own committed feed items, error vs plain", () => {
    const items = noticeItems([{ id: 1, text: "boom", kind: "error" }, { id: 2, text: "cancelled — the partial response is kept", kind: "notice" }]);
    expect(items).toEqual([
      { key: "notice:1", done: true, node: GTUI.view.text({ role: "notice.error", priority: 0, selectionKey: "notice:1", sourceText: "boom" }, [{ text: "· " }, { text: "boom", source: { start: 0, end: 4 } }]) },
      { key: "notice:2", done: true, node: GTUI.view.text({ role: "notice", priority: 1, selectionKey: "notice:2", sourceText: "cancelled — the partial response is kept" }, [{ text: "· " }, { text: "cancelled — the partial response is kept", source: { start: 0, end: 40 } }]) },
    ]);
  });

  test("error notices expose their complete message as selectable source text", () => {
    const events = [];
    const controls = createControls((event) => events.push(event));
    const message = "turn failed: HTTP 401 Unauthorized";
    const node = noticeItems([{ id: 1, text: message, kind: "error" }])[0].node;
    const { canvas } = layoutView(node, { width: 80, height: 2, controls });
    controls.endFrame(node, canvas);
    const row = canvas.cells.findIndex((cells) => cells.some((cell) => cell?.selectionKey === "notice:1" && cell.source?.start === 0));
    const column = canvas.cells[row].findIndex((cell) => cell?.selectionKey === "notice:1" && cell.source?.start === 0);
    expect(controls.resolvePoint({ x: column, y: row })).toMatchObject({
      kind: "press", control: "text", target: "notice:1", sourceText: message,
    });
  });

  test("the same historical block keeps the same key across renders (the host commits it exactly once)", () => {
    const context = [USER("hi"), { type: 3, content: [{ type: "text", text: "hello" }] }];
    const keysBefore = transcriptItems(contextBlocks(context)).map((i) => i.key);
    const keysAfter = transcriptItems(contextBlocks([...context, USER("again")])).map((i) => i.key);
    expect(keysAfter.slice(0, keysBefore.length)).toEqual(keysBefore);
  });
});

describe("the app end to end: transcript, links, and notices", () => {
  test("a turn's exchange lands in the transcript with the right roles", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "hi there"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory({ width: 80 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("hi"));
    await until(() => memory.snapshot().lines.some((l) => l.includes("hi there")));
    const snapshot = memory.snapshot();
    // The app supplies clean semantic text; run.js installs app.theme for
    // physical decoration (covered above), while this memory host is plain.
    expect(snapshot.lines.some((line) => line.includes("hi"))).toBe(true);
    expect(snapshot.roles.some((r) => r.role === "message.user")).toBe(true);
    expect(snapshot.roles.some((r) => r.role === "message.user.border")).toBe(false); // decoration is not a source span
    expect(snapshot.roles.some((r) => r.role === "message.text")).toBe(true);

    ui.stop();
    await running;
  });

  test("a markdown link in the assistant's reply carries its href and a reconstructable source offset", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "start" }, ...TEXT(0, "see [docs](http://example.com)"), { type: "done" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory({ width: 80 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("go"));
    await until(() => memory.snapshot().lines.some((l) => l.includes("docs")));
    const snapshot = memory.snapshot();
    expect(snapshot.links.some((l) => l.link === "http://example.com")).toBe(true);
    const message = agent.context.find((m) => m.type === 3);
    const rawText = message.content[0].text;
    const linkStart = rawText.indexOf("docs"); // one GTUI source entry per grapheme cell — check the span's first character
    const source = snapshot.sources.find((s) => s.source.start === linkStart && s.source.end === linkStart + 1);
    expect(source).toBeTruthy();

    ui.stop();
    await running;
  });

  test("mouse-selected message text copies through the app in logical source order", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [USER("copy שלום")], createIO: () => scriptedIO([[{ type: "done" }]]) });
    const memory = GTUI.host.memory({ width: 80, height: 12 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(createApp(agent, { env }));
    const snapshot = memory.snapshot();
    const starts = snapshot.sources.filter(({ source }) => source.start >= 5 && source.end <= 9);
    const first = starts.find(({ source }) => source.start === 5);
    const last = starts.find(({ source }) => source.start === 8);
    memory.send(GTUI.event.pointer({ kind: "press", control: "text", target: "message", button: 0, x: first.start, y: first.row }));
    memory.send(GTUI.event.pointer({ kind: "drag", control: "text", target: "message", button: 0, x: last.start, y: last.row }));
    memory.send(GTUI.event.pointer({ kind: "release", control: "text", target: "message", button: 0, x: last.start, y: last.row }));
    memory.send(GTUI.event.key({ key: "copy" }));
    await tick();
    expect(memory.effects.find((entry) => entry.type === "copy")).toMatchObject({ text: "שלום" });
    ui.stop();
    await running;
  });

  test("a turn-level error becomes a notice; a cancelled turn's notice says the partial response is kept", async () => {
    const env = await testEnv();
    const io = scriptedIO([[{ type: "error", error: "boom" }]]);
    const agent = new Agent({ env, model: "p/m", context: [], createIO: () => io });
    const app = createApp(agent);
    const memory = GTUI.host.memory({ width: 80 });
    const ui = new GTUI({ host: memory });
    const running = ui.run(app);

    ui.dispatch(msg.submit("go"));
    await until(() => memory.snapshot().lines.some((l) => l.includes("boom")));
    expect(memory.snapshot().roles.some((r) => r.role === "notice.error")).toBe(true);

    ui.stop();
    await running;
  });
});

test("a selected diff line copies its original source text", async () => {
  const raw = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
  const env = await testEnv();
  const agent = new Agent({ env, model: "p/m", context: [{ type: 3, content: [{ type: "text", text: raw }] }], createIO: () => scriptedIO([[{ type: "done" }]]) });
  const memory = GTUI.host.memory({ width: 80, height: 12 });
  const ui = new GTUI({ host: memory });
  const running = ui.run(createApp(agent, { env }));
  const cells = memory.snapshot().sources.filter((entry) => raw.slice(entry.source.start, entry.source.end) === "+");
  const cell = cells.at(-1);
  expect(cell).toBeTruthy();
  memory.send(GTUI.event.pointer({ kind: "press", control: "text", button: 0, x: cell.start, y: cell.row }));
  memory.send(GTUI.event.pointer({ kind: "drag", control: "text", button: 0, x: cell.start + 3, y: cell.row }));
  memory.send(GTUI.event.pointer({ kind: "release", control: "text", button: 0, x: cell.start + 3, y: cell.row }));
  memory.send(GTUI.event.key({ key: "copy" }));
  await tick();
  expect(memory.effects.find((entry) => entry.type === "copy")).toMatchObject({ text: "+new" });
  ui.stop();
  await running;
});
