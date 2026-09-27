import { describe, expect, test } from "bun:test";
import { findInlineMath, mathBlockAt, mathText, parseMath } from "../lib/app/markdown/math.js";
import { lexBuiltin } from "../lib/app/markdown/lexer.js";
import { parseInline, lexMarkdown, renderInline, renderMarkdown } from "../lib/app/markdown/index.js";
import { renderMarkdown as renderWeb } from "../lib/app/web/public/markdown.js";
import { markdownRows } from "../lib/app/tui/markdown-view.js";

describe("central math syntax", () => {
  test("fractions, radicals, grouped scripts and Greek produce a structured source-bearing tree", () => {
    const source = "\\frac{x_{i}^2}{\\sqrt{\\alpha}}";
    const tree = parseMath(source);
    expect(tree.source).toBe(source);
    expect(tree.children[0].type).toBe("fraction");
    expect(tree.children[0].numerator.children[0].type).toBe("script");
    expect(mathText(tree)).toBe("(x_i^2)/(√(α))");
    expect(mathText(parseMath("x^{n+1}"))).toBe("x^{n+1}");
  });
  test("unknown TeX remains visible, and code spans and fences are not math", async () => {
    expect(mathText(parseMath("\\unknown{q}"))).toBe("\\unknown{q}");
    expect(parseInline("`$x$` $x$ ").map((part) => part.type)).toEqual(["codespan", "text", "math_inline", "text"]);
    expect(lexBuiltin("```tex\n$x$\n$$\n```\n$x$ ")[0].type).toBe("code");
    expect((await lexMarkdown("`$x$`"))[0].tokens[0].type).toBe("codespan");
  });
  test("handles currency, escaped dollars, unmatched delimiters and block boundaries", async () => {
    expect(findInlineMath("$5 and $10")).toBeNull();
    expect(findInlineMath("$5 and $10 more")).toBeNull();
    expect(findInlineMath("$2/$10 and $4/$20")).toBeNull();
    expect(findInlineMath("$x + y$")?.text).toBe("x + y");
    expect(findInlineMath("$2+2$")?.text).toBe("2+2");
    expect(findInlineMath("$2$")).toBeNull();
    expect(findInlineMath("$2+2$ and $10").text).toBe("2+2");
    expect(findInlineMath("$x$")?.text).toBe("x");
    expect(findInlineMath("$x$ and $2+2$")?.text).toBe("x");
    expect(findInlineMath("$x + $y$")?.text).toBe("y");
    expect(findInlineMath("\\(x^2 + \\frac{a}{b}\\)")?.text).toBe("x^2 + \\frac{a}{b}");
    expect(findInlineMath("\\(x + \\$5\\)")?.text).toBe("x + \\$5");
    expect(findInlineMath("\\\\(literal\\)")).toBeNull();
    expect(findInlineMath("\\(unfinished")).toBeNull();
    expect(findInlineMath("\\$x$ ")).toBeNull();
    expect(findInlineMath("$x")).toBeNull();
    expect(mathBlockAt(["$$", "x", "$$"], 0)?.tree.type).toBe("row");
    expect(mathBlockAt(["$$", "x"], 0)).toBeNull();
    expect((await lexMarkdown("$$\n\\frac{a}{b}\n$$"))[0].type).toBe("math_block");
    expect(renderInline("$\\pi$", { mathInline: (_raw, tree) => mathText(tree) })).toBe("π");
    expect(await renderMarkdown("$x^2$", { mathInline: (raw) => `[${raw}]` })).toBe("[x^2]");
    expect(await renderMarkdown("\\(x^2\\)", { mathInline: (raw) => `[${raw}]` })).toBe("[x^2]");
  });
});

test("currency-rich Markdown stays prose in every renderer", async () => {
  const source = "### Value extraction\n\nAnthropic's own published numbers: median API-billed Claude Code spend is **$13/active day, $150–250/dev-month**. A daily user on the $20 Pro plan extracts roughly **7–12× the plan price** in API-equivalent value — the steepest bulk discount of the three providers, precisely because Claude's models carry premium API rates ($2/$10 and $4/$20) while the plan is only $20.";
  expect(findInlineMath(source)).toBeNull();
  expect((await lexMarkdown(source)).flatMap((token) => token.tokens ?? []).some((token) => token.type === "math_inline")).toBe(false);
  expect(renderWeb(source)).not.toContain('class="md-math"');
  expect(renderWeb(source)).toContain("<strong>$13/active day, $150–250/dev-month</strong>");
  expect(markdownRows(source)[2].content.some((span) => span.text.includes("$13/active day"))).toBe(true);
});

describe("target math presentations", () => {
  test("web typesets only known structure, escapes attributes and unknown commands, and keeps raw source on hover", () => {
    const html = renderWeb("$\\frac{a}{b}$ and $\\unknown<svg onload=alert(1)>$\n\n$$\nx^2\n$$");
    expect(html).toContain('title="$\\frac{a}{b}$"');
    expect(html).toContain('class="md-frac"');
    expect(html).toContain('class="md-math-block"');
    expect(html).not.toContain("<svg");
    expect(renderWeb("`$x$`\n\n```\n$x$\n```")).not.toContain('class="md-math"');
    expect(renderWeb("**$x$** and [hi $y$](https://example.com)")).toContain('<strong><span class="md-math"');
    expect(renderWeb("\\(x^2\\)")).toContain('title="\\(x^2\\)"');
    expect(markdownRows("\\(x^2\\)")[0].content[0].source).toEqual({ start: 0, end: 7 });
    expect(renderWeb("`\\(x^2\\)`")).not.toContain('class="md-math"');
    expect(renderWeb("`` `$x$` ``")).not.toContain('class="md-math"');
    expect(renderWeb('$x$\u00010\u0001')).toContain('�0�');
  });
  test("standalone bracket display math shares block tokens and target rendering", async () => {
    const source = "before\n\\[\nx^2 + \\frac{a}{b}\n\\]\nafter";
    const lines = source.split("\n");
    const block = mathBlockAt(lines, 1);
    expect(block?.source).toBe("\\[\nx^2 + \\frac{a}{b}\n\\]");
    expect(block?.text).toBe("x^2 + \\frac{a}{b}");
    expect(block?.tree.children.some((node) => node.type === "fraction")).toBe(true);
    expect((await lexMarkdown(source)).map((token) => token.type)).toEqual(["paragraph", "math_block", "paragraph"]);
    expect(await renderMarkdown(source, { mathBlock: (text) => `[${text}]` })).toContain("[x^2 + \\frac{a}{b}]");
    expect(renderWeb(source)).toContain('class="md-math-block" title="\\[\nx^2 + \\frac{a}{b}\n\\]"');
    const rows = markdownRows(source);
    expect(rows.slice(1, 4).map((row) => row.role)).toEqual(["md.code", "md.code", "md.code"]);
    expect(source.slice(rows[2].content[0].source.start, rows[2].content[0].source.end)).toBe("x^2 + \\frac{a}{b}");
    expect(mathBlockAt(["\\[", "open"], 0)).toBeNull();
    expect(mathBlockAt(["\\[", "x", "$$"], 0)).toBeNull();
    expect(mathBlockAt(["$$", "x", "\\]"], 0)).toBeNull();
    expect(mathBlockAt(["\\[ extra", "x", "\\]"], 0)).toBeNull();
    expect(renderWeb("\\[\nopen")).not.toContain('class="md-math-block"');
    expect(renderWeb("\\[\nx^2\n\\]")).toContain('title="\\[\nx^2\n\\]"');
    expect(renderWeb("```tex\n\\[\nx\n\\]\n```")).not.toContain('class="md-math-block"');
    expect(renderWeb("$$\nx\n$$")).toContain('class="md-math-block"');
    expect(markdownRows("```tex\n\\[\nx\n\\]\n```")[1].role).toBe("md.code");
    expect((await lexMarkdown("```tex\n\\[\nx\n\\]\n```"))[0].type).toBe("code");
  });
  test("terminal text stays selectable through exact original source offsets", () => {
    const source = "a $\\frac{a}{b}$ tail\n$$\n\\pi\n$$";
    const rows = markdownRows(source);
    const fraction = rows[0].content.find((span) => span.text === "$\\frac{a}{b}$");
    expect(source.slice(fraction.source.start, fraction.source.end)).toBe("$\\frac{a}{b}$");
    expect(rows[2].content[0].text).toBe("\\pi");
    expect(source.slice(rows[2].content[0].source.start, rows[2].content[0].source.end)).toBe("\\pi");
    expect(markdownRows('$$\nopen')[1].content[0].text).toBe('open');
    expect(markdownRows('$$\n\\alpha\n$$', { head: 1, tail: 1 })).toHaveLength(3);
  });
});
