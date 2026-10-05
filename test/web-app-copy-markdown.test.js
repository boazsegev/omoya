import { describe, expect, test } from "bun:test";
import { installMarkdownCopy } from "../lib/app/web/public/app/logic/copy.js";
import { sourceRangeForText } from "../lib/app/web/public/copy-markdown.js";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";


describe("web transcript select and copy", () => {
  test("copies original Markdown between selected rendered text boundaries", () => {
    const source = "# Heading\n\n**bold** and [link](https://example.com)";
    const parts = ["Heading", "bold", " and ", "link"];
    expect(sourceRangeForText(source, parts, 0, 7)).toBe("# Heading"); // a selection from the block start keeps leading syntax
    expect(sourceRangeForText(source, parts, 0, 20)).toBe(source);
    expect(sourceRangeForText(source, parts, 0, 16)).toBe("# Heading\n\n**bold** and ");
    expect(sourceRangeForText(source, parts, 2, 7)).toBe("ading");
    expect(sourceRangeForText(source, parts, 7, 19)).toBe("bold** and [lin");
    expect(sourceRangeForText(source, parts, 9, 20)).toBe("ld** and [link](https://example.com)");
  });

  test("preserves fenced code and adjacent markup", () => {
    const source = "Before\n```js\nconst x = 1;\n```\n**After**";
    const parts = ["Before", "const x = 1;", "After"];
    expect(sourceRangeForText(source, parts, 0, 23)).toBe(source);
  });

  test("display-only text maps only when the whole block is selected", () => {
    const source = "Half: $\\frac{1}{2}$ done";
    const parts = ["Half: ", "½", " done"];
    expect(sourceRangeForText(source, parts, 0, 12)).toBe(source);
    expect(sourceRangeForText(source, parts, 6, 7)).toBeNull();
    expect(sourceRangeForText(source, parts, 8, 12)).toBe("done");
  });

  test("block formatting text between tags never pushes the mapping past later text", () => {
    // renderMarkdown("1. **Read** it\n2. two\n\n- a\n- b") yields "<ol>\n<li>…": the DOM holds
    // "\n" text nodes before an item's text that the source has only after it.
    const source = "1. **Read** it\n2. two\n\n- a\n- b";
    const parts = ["\n", "Read", " it", "\n", "two", "\n", "\n", "\n", "a", "\n", "b", "\n"];
    const text = parts.join("");
    expect(sourceRangeForText(source, parts, text.indexOf("it"), text.lastIndexOf("a") + 1)).toBe("it\n2. two\n\n- a");
    expect(sourceRangeForText(source, parts, text.indexOf("two"), text.indexOf("b") + 1)).toBe("two\n\n- a\n- b");
    expect(sourceRangeForText(source, parts, 0, 1)).toBeNull(); // formatting alone: native copy
  });

  test("task boxes are styling, not text, so task lists stay mappable", () => {
    const html = renderMarkdown("- [x] themes\n- [ ] more");
    expect(html).toContain('<li class="task done">themes</li>');
    expect(html).toContain('<li class="task">more</li>');
    expect(html).not.toMatch(/[☑☐]/);
  });

  test("copy interception writes mapped Markdown and leaves unmappable selections alone", () => {
    let handler;
    const target = { addEventListener(type, callback) { expect(type).toBe("copy"); handler = callback; } };
    const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({}) };
    let mapped = "# Heading";
    installMarkdownCopy(target, () => selection, () => mapped);
    const writes = [];
    const event = { clipboardData: { setData: (...args) => writes.push(args) }, preventDefault() { writes.push("prevented"); } };
    selection.isCollapsed = true;
    handler(event);
    expect(writes).toEqual([]);
    selection.isCollapsed = false;
    handler({ clipboardData: null });
    expect(writes).toEqual([]);
    handler(event);
    expect(writes).toEqual([["text/plain", "# Heading"], "prevented"]);
    mapped = null;
    handler(event);
    expect(writes).toHaveLength(2);
  });
});
