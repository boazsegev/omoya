import { describe, expect, test } from "bun:test";
import Context from "../lib/context.js";
import { contextBlocks } from "../lib/tui-app/context-blocks.js";
import { createStreamRenderer } from "../lib/tui-app/stream.js";

// A binary block carries `mimetype` (Context.binaryContent); the display
// placeholders must render it, never fall back to "unknown".
const PDF = Context.binaryContent("quote.pdf", new TextEncoder().encode("%PDF-1.7"));

describe("binary attachment display mimetype", () => {
  test("the transcript viewer labels a binary block with its mimetype", () => {
    const blocks = contextBlocks([Context.userMessage([PDF])]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("application/pdf");
    expect(blocks[0].text).not.toContain("unknown");
  });

  test("the piped stream renderer labels a binary tool result with its mimetype", () => {
    let out = "";
    const renderer = createStreamRenderer({ write: (chunk) => { out += chunk; }, ansi: false });
    renderer.toolResult({ type: 4, name: "read", content: [PDF] });
    expect(out).toContain("application/pdf");
    expect(out).not.toContain("unknown");
  });
});
