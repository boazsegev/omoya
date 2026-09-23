import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { transcriptItems } from "../lib/tui-app/transcript.js";
import { contextBlocks } from "../lib/tui-app/context-blocks.js";
import { markdownRows } from "../lib/tui-app/markdown-view.js";
import { layoutView } from "../lib/gtui/layout.js";

for (const type of ["toolresult", "toolerror"]) {
  for (const label of ["write", undefined]) {
    test(`${type} ${label ? "with" : "without"} a label caps only its body at three visual rows`, () => {
      const text = Array.from({ length: 20 }, (_, i) => `data line ${i}`).join("\n");
      const item = transcriptItems([{ type, text, label, group: "g", section: "body", ordinal: 0 }])[0];
      const scene = layoutView(item.node, { width: 60, height: 40 });
      const lines = scene.snapshot.lines;
      expect(lines.filter((line) => line.includes("data line"))).toHaveLength(2);
      expect(lines.join("\n")).toContain("data line 0");
      expect(lines.join("\n")).toContain("data line 19");
      expect(lines.join("\n")).toContain("...");
      if (label) expect(lines[0]).toContain(`[${type === "toolresult" ? "tool ok" : "tool error"}] ${label}`);
      else expect(lines[0]).toContain("data line 0");
    });
  }
}

test("block viewer keeps full tool result and error bodies", () => {
  const text = Array.from({ length: 20 }, (_, i) => `data line ${i}`).join("\n");
  for (const type of ["toolresult", "toolerror"]) {
    const item = transcriptItems([{ type, text, label: "write", group: "g", section: "body", ordinal: 0 }], 0, { previews: false })[0];
    const lines = layoutView(item.node, { width: 60, height: 40 }).snapshot.lines;
    expect(lines.filter((line) => line.includes("data line"))).toHaveLength(20);
    expect(lines.join("\n")).toContain("data line 0");
  }
});

test("large actual write arguments remain capped after JSON serialization and wrapping", () => {
  const text = Array.from({ length: 80 }, (_, i) => `source line ${i}`).join("\n");
  const context = [{ type: 3, content: [{ type: "toolCall", callId: "w", name: "write", arguments: { path: "example.js", content: text } }] }];
  const node = transcriptItems(contextBlocks(context))[0].node;
  const scene = layoutView(GTUI.view.scroll({ anchor: "end" }, [GTUI.view.feed({ items: [{ key: "w", done: true, node }] })]), { width: 40, height: 30 });
  expect(scene.snapshot.lines.length).toBeLessThanOrEqual(9);
});

test("fenced diff code is rendered through Markdown with semantic added removed and hunk roles", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const raw = `${fence}diff\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n${fence}`;
  const rows = markdownRows(raw);
  expect(rows.some((row) => row.role === "md.diff.add")).toBe(true);
  expect(rows.some((row) => row.role === "md.diff.remove")).toBe(true);
  expect(rows.some((row) => row.role === "md.diff.hunk")).toBe(true);
  for (const row of rows) for (const span of row.content) if (span.source) expect(raw.slice(span.source.start, span.source.end)).toBe(span.text);
});
