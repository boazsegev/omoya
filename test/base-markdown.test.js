// test/base-markdown.test.js — proof for lib/markdown.js (Markdown):
// the presentation-free markdown abstraction. Covers the builtin
// primitives (parseInline spans, classifyLine kinds), the marked-style
// callback walker (block callbacks receive rendered inner text; block
// joins are exactly ONE "\n"), engine ROUTING (marked when it
// resolves, builtin otherwise — same token shapes, same rendered
// output), and the default-renderer completeness property (an empty
// renderer still renders plain text).
import { describe, expect, test } from "bun:test";
import {
  markdownEngine, lexMarkdown, renderMarkdown, renderInline,
  parseInline, classifyLine, walkTokens,
} from "../lib/markdown.js";
import { lexBuiltin } from "../lib/markdown/lexer.js";

describe("markdown: parseInline spans (builtin inline tokenizer)", () => {
  test("plain text is one text span", () => {
    expect(parseInline("hello world")).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("bold, italic, code, link — markers stripped, structure kept", () => {
    expect(parseInline("**b**")).toEqual([{ type: "strong", text: "b" }]);
    expect(parseInline("*i*")).toEqual([{ type: "em", text: "i" }]);
    expect(parseInline("_i_")).toEqual([{ type: "em", text: "i" }]);
    expect(parseInline("`c`")).toEqual([{ type: "codespan", text: "c" }]);
    expect(parseInline("[l](http://x)")).toEqual([{ type: "link", text: "l", href: "http://x" }]);
  });

  test("mixed spans compose; surrounding prose stays text", () => {
    expect(parseInline("a **b** c `d` e")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", text: "b" },
      { type: "text", text: " c " },
      { type: "codespan", text: "d" },
      { type: "text", text: " e" },
    ]);
  });

  test("links retain balanced parentheses in their destination", () => {
    expect(parseInline("[docs](https://example.test/a_(b))")).toEqual([
      { type: "link", text: "docs", href: "https://example.test/a_(b)" },
    ]);
  });

  test("skips an unterminated link candidate for a later valid link", () => {
    expect(parseInline("[bad](unterminated [good](ok)")).toEqual([
      { type: "text", text: "[bad](unterminated " },
      { type: "link", text: "good", href: "ok" },
    ]);
  });

  test("markers inside a code span are literal (code wins)", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "codespan", text: "**not bold**" }]);
  });

  test("matching multi-backtick runs allow literal backticks in code", () => {
    expect(parseInline("``is `this` code``")).toEqual([
      { type: "codespan", text: "is `this` code" },
    ]);
    expect(parseInline("before ```a `` b``` after")).toEqual([
      { type: "text", text: "before " },
      { type: "codespan", text: "a `` b" },
      { type: "text", text: " after" },
    ]);
  });

  test("a code span closes only on an equal-length backtick run", () => {
    expect(parseInline("``a ` b``")).toEqual([{ type: "codespan", text: "a ` b" }]);
    expect(parseInline("``unclosed `single")).toEqual([
      { type: "text", text: "``unclosed `single" },
    ]);
  });
});

describe("markdown: classifyLine (single-line block structure)", () => {
  test("fence state toggles across calls; lines inside classify as code", () => {
    const state = { inFence: false };
    expect(classifyLine("```js", state).kind).toBe("fence");
    expect(state.inFence).toBe(true);
    expect(classifyLine("**not bold**", state).kind).toBe("code");
    expect(classifyLine("```", state).kind).toBe("fence");
    expect(state.inFence).toBe(false);
  });

  test("heading, list, quote, hr, text", () => {
    expect(classifyLine("### Sub", {}).kind).toBe("heading");
    expect(classifyLine("### Sub", {}).depth).toBe(3);
    expect(classifyLine("# Closing #", {})).toMatchObject({ kind: "heading", text: "Closing" });
    expect(classifyLine("  - item", {})).toMatchObject({ kind: "list", indent: "  ", marker: "-", ordered: false, text: "item" });
    expect(classifyLine("2. item", {})).toMatchObject({ kind: "list", ordered: true, marker: "2." });
    expect(classifyLine("> quoted", {})).toMatchObject({ kind: "quote", text: "quoted" });
    expect(classifyLine("---", {}).kind).toBe("hr");
    expect(classifyLine("just prose", {}).kind).toBe("text");
  });

  test("tilde fences work and only a valid matching delimiter closes them", () => {
    const state = { inFence: false };
    expect(classifyLine("~~~~js", state)).toMatchObject({ kind: "fence", lang: "js" });
    expect(classifyLine("```", state).kind).toBe("code");
    expect(classifyLine("~~~", state).kind).toBe("code");
    expect(classifyLine("~~~~not-info", state).kind).toBe("code");
    expect(classifyLine("~~~~", state).kind).toBe("fence");
    expect(state.inFence).toBe(false);
  });
});

describe("markdown: the walker is marked-style callbacks", () => {
  test("block callbacks receive RENDERED inner text; blocks join with ONE newline", () => {
    const calls = [];
    const renderer = {
      strong: (t) => { calls.push(["strong", t]); return `<b>${t}</b>`; },
      paragraph: (t) => { calls.push(["paragraph", t]); return `<p>${t}</p>`; },
      space: () => "",
    };
    const out = walkTokens(lexBuiltin("a **b**\n\nc"), renderer);
    expect(calls).toEqual([["strong", "b"], ["paragraph", "a <b>b</b>"], ["paragraph", "c"]]);
    expect(out).toBe("<p>a <b>b</b></p>\n\n<p>c</p>"); // the space token keeps the blank line single
  });

  test("every callback is optional: an empty renderer renders plain text", async () => {
    const out = await renderMarkdown("# T\n\n**b** and `c`\n\n- one\n- two", {});
    expect(out).toBe("T\n\nb and `c`\n\none\ntwo");
  });

  test("detects GFM tables and emits marked-compatible table callbacks", () => {
    const source = "| Name | Value |\n| :--- | ---: |\n| **A** | `1` |\n| B | 2 |";
    const tokens = lexBuiltin(source);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: "table", align: ["left", "right"] });
    const calls = [];
    const out = walkTokens(tokens, {
      table: (header, body) => `<table>${header}${body}</table>`,
      tableRow: (body, token) => `<tr${token.header ? " head" : ""}>${body}</tr>`,
      tableCell: (text, flags) => `<${flags.header ? "th" : "td"} align="${flags.align}">${text}</${flags.header ? "th" : "td"}>`,
      strong: (text) => `<b>${text}</b>`,
      codespan: (text) => `<code>${text}</code>`,
    });
    expect(out).toBe('<table><tr head><th align="left">Name</th><th align="right">Value</th></tr><tr><td align="left"><b>A</b></td><td align="right"><code>1</code></td></tr>\n<tr><td align="left">B</td><td align="right">2</td></tr></table>');
    expect(calls).toEqual([]);
    expect(walkTokens(tokens, {
      table: (header, body) => `${header}/${body}`,
      tablerow: (body) => `[${body}]`,
      tablecell: (text) => `(${text})`,
    })).toBe("[(Name)(Value)]/[(A)(`1`)]\n[(B)(2)]");
  });

  test("separates adjacent unordered and ordered lists", () => {
    const tokens = lexBuiltin("- unordered\n1. ordered");
    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.ordered)).toEqual([false, true]);
  });

  test("renderInline styles one fragment synchronously, defaults plain", () => {
    expect(renderInline("a **b** `c`")).toBe("a b `c`");
    expect(renderInline("**b**", { strong: (t) => `<${t}>` })).toBe("<b>");
  });
});

describe("markdown: engine routing (marked when available, builtin otherwise)", () => {
  test("the engine is one of the two, and lexMarkdown matches it", async () => {
    const engine = await markdownEngine();
    expect(["marked", "builtin"]).toContain(engine);
    if (engine === "builtin") {
      expect(await lexMarkdown("# T\n\ntext")).toEqual(lexBuiltin("# T\n\ntext"));
    }
  });

  test("both engines render the SAME output through one renderer", async () => {
    const marked = await import("marked").then((m) => m.marked ?? m.default).catch(() => null);
    if (!marked) return; // marked unresolved here: the builtin path is covered above
    const renderer = {
      strong: (t) => `<b>${t}</b>`,
      em: (t) => `<i>${t}</i>`,
      codespan: (t) => `<c>${t}</c>`,
      link: (t, href) => `${t}<${href}>`,
      heading: (t, d) => `<h${d}>${t}</h${d}>`,
      code: (t, lang) => `<pre lang="${lang}">${t}</pre>`,
      blockquote: (t) => `<q>${t}</q>`,
      list: (body) => `<ul>${body}</ul>`,
      listItem: (t, { ordered, number }) => `<li${ordered ? ` n="${number}"` : ""}>${t}</li>`,
      space: () => "",
    };
    // hr excluded: the builtin lexer carries the source width, marked
    // drops it (a renderer-level default, documented in the walker)
    const source = "# Title\n\nSome *text* and **bold**.\n\n> quoted\n\n- a\n- b\n\n1. one\n2. two\n\n| Key | Value |\n| --- | ---: |\n| x | `1` |\n\n```js\nlet x = 1;\n```";
    const viaBuiltin = walkTokens(lexBuiltin(source), renderer);
    const viaMarked = walkTokens(marked.lexer(source, { gfm: true, breaks: true }), renderer);
    expect(viaMarked).toBe(viaBuiltin);
  });

  test("renderMarkdown output is engine-independent for chat markdown", async () => {
    const source = "line one\nline two\n\nnew paragraph\n\n- a\n- b";
    const out = await renderMarkdown(source, {});
    expect(out).toBe("line one\nline two\n\nnew paragraph\n\na\nb");
    expect(out).not.toContain("\n\n\n"); // blank lines never double-space
  });
});
