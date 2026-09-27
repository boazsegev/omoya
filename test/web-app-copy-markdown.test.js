import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceRangeForText } from "../lib/app/web/public/copy-markdown.js";

const app = readFileSync(join(import.meta.dir, "../lib/app/web/public/app.js"), "utf8");

describe("web transcript select and copy", () => {
  test("copies original Markdown between selected rendered text boundaries", () => {
    const source = "# Heading\n\n**bold** and [link](https://example.com)";
    const parts = ["Heading", "bold", " and ", "link"];
    expect(sourceRangeForText(source, parts, 0, 7)).toBe("Heading");
    expect(sourceRangeForText(source, parts, 0, 20)).toBe(source);
    expect(sourceRangeForText(source, parts, 0, 16)).toBe("Heading\n\n**bold** and ");
    expect(sourceRangeForText(source, parts, 7, 19)).toBe("bold** and [lin");
  });

  test("preserves fenced code and adjacent markup", () => {
    const source = "Before\n```js\nconst x = 1;\n```\n**After**";
    const parts = ["Before", "const x = 1;", "After"];
    expect(sourceRangeForText(source, parts, 0, 23)).toBe(source);
  });

  test("leaves non-source display text to native browser copy", () => {
    expect(sourceRangeForText("$\\frac{1}{2}$", ["½"], 0, 1)).toBeNull();
  });

  test("the client intercepts only a Markdown selection and preserves explicit copy controls", () => {
    expect(app).toContain('markdownSources.set(node, String(source ?? ""))');
    expect(app).toContain('document.addEventListener("copy", (event) => {');
    expect(app).toContain('event.clipboardData.setData("text/plain", text)');
    expect(app).toContain('if (text === null || !event.clipboardData) return;');
    expect(app).toContain('copyText(String(text ?? ""), "Copied")');
  });
});
