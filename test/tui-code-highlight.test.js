// test/tui-code-highlight.test.js — the minimal fenced-code highlighter:
// line-local tokens mapped onto EXISTING theme roles only.
import { expect, test } from "bun:test";
import { HIGHLIGHT_ROLE, highlightLine } from "../lib/app/tui/code-highlight.js";
import { markdownRows } from "../lib/app/tui/markdown-view.js";
import { DEFAULT_THEME } from "../lib/app/tui/theme-data.js";

const kinds = (line, lang) => highlightLine(line, lang).map((range) => `${range.kind}:${line.slice(range.start, range.end)}`);

test("keywords, numbers, strings, and line comments per the fence language", () => {
  expect(kinds("const answer = 42; // the answer", "js")).toEqual(["keyword:const", "number:42", "comment:// the answer"]);
  expect(kinds('url = "http://x#y"  # note', "python")).toEqual(['string:"http://x#y"', "comment:# note"]);
  expect(kinds('if (a /* b */) return "x";', "c")).toEqual(["keyword:if", "comment:/* b */", "keyword:return", 'string:"x"']);
  expect(kinds("SELECT id FROM t -- c", "sql")).toEqual(["keyword:SELECT", "keyword:FROM", "comment:-- c"]);
});

test("output, prose, diff, and unlabeled fences stay plain", () => {
  for (const lang of ["", "text", "log", "diff", "console"]) expect(highlightLine("if x // y", lang)).toEqual([]);
});

test("every highlight role is one the default theme already defines — no new theme keys", () => {
  for (const role of Object.values(HIGHLIGHT_ROLE)) expect(DEFAULT_THEME[role], role).toBeDefined();
});

test("highlighted code rows keep exact source offsets", () => {
  const raw = "```js\nconst s = \"a\"; // c\n```";
  const code = markdownRows(raw)[1];
  expect(code.content.map((span) => span.role ?? "")).toEqual(["muted", "accent", "", "md.em", "", "muted"]);
  for (const span of code.content.filter((part) => part.source)) expect(raw.slice(span.source.start, span.source.end)).toBe(span.text);
});
