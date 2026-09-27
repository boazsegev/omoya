import { describe, expect, test } from "bun:test";
import { readPreview } from "../lib/app/web/public/read-preview.js";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";

const preview = (name, output) => readPreview(name, output);

describe("Web read tool collapsed preview", () => {
  test("renders Markdown and plain text files as safe Markdown", () => {
    for (const mime of ["text/markdown", "text/plain"]) {
      const result = preview("read", `[${mime}]\n# Heading\n**bold** <script>alert(1)</script>`);
      expect(result).toMatchObject({ mime, markdown: true });
      expect(renderMarkdown(result.text)).toContain("<strong>bold</strong> &lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  test("leaves other types, searches, base64 and unrelated tools as plain text", () => {
    for (const output of ["[text/javascript]\n**bold**", "[application/octet-stream]\n**bold**", "grep file /x/:\n**bold**", "[base64]\naGVsbG8="]) {
      expect(preview("read", output).markdown).toBe(false);
    }
    expect(preview("bash", "[text/markdown]\n**bold**")).toMatchObject({ markdown: false, mime: null });
    expect(preview("read", "[text/markdown] no newline")).toMatchObject({ markdown: false, mime: null });
  });
});
