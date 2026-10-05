import { describe, expect, test } from "bun:test";
import { previewWindow } from "../lib/app/web/public/app/logic/preview.js";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";

test("authoritative final Markdown and math repaint the streamed preview", () => {
  expect(renderMarkdown("**draft")).toContain("**draft");
  const final = renderMarkdown("**final** and $x^2$");
  expect(final).toContain("<strong>final</strong>");
  expect(final).toContain('role="math"');
});

test("user bubble content renders safe Markdown, including attachments text", () => {
  const html = renderMarkdown("**hello** <img src=x onerror=alert(1)>");
  expect(html).toContain("<strong>hello</strong>");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

describe("web thinking Markdown", () => {
  test("collapsed thinking and expanded body render Markdown", () => {
    const source = "**bold** and `code`";
    const preview = previewWindow(source, 4);
    expect(renderMarkdown(preview.head)).toContain("<strong>bold</strong> and <code>code</code>");
    expect(renderMarkdown(source)).toContain("<strong>bold</strong> and <code>code</code>");
  });

  test("streamed collapsed thinking windows head and tail before rendering a cut fence", () => {
    const preview = previewWindow("**first**\n```js\nconst x = 1;\nline\n- last", 4);
    expect(renderMarkdown(preview.head)).toContain("<strong>first</strong>");
    expect(preview.hidden).toBe(2);
    expect(renderMarkdown(preview.tail)).toContain("<li>last</li>");
  });

  test("preview escapes untrusted markup and keeps non-thinking source plain", () => {
    const thinking = previewWindow("**safe** <img src=x onerror=alert(1)>", 8);
    expect(renderMarkdown(thinking.head)).toContain("<strong>safe</strong>");
    expect(renderMarkdown(thinking.head)).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const tool = previewWindow("**plain**", 8);
    expect(tool.head).toBe("**plain**");
  });
});
