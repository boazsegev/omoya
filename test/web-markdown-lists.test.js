import { expect, test } from "bun:test";
import { renderMarkdown } from "../lib/app/web/public/markdown.js";

test("ordered lists honor their first explicit number", () => {
  expect(renderMarkdown("2. text")).toBe('<ol start="2">\n<li>text</li>\n</ol>');
  expect(renderMarkdown("1. one\n2. two")).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>");
  expect(renderMarkdown("0) zero\n1) one")).toBe('<ol start="0">\n<li>zero</li>\n<li>one</li>\n</ol>');
});

test("tight and spaced lists each stay a single list", () => {
  expect(renderMarkdown("Tight list:\n1. item one\n2. item two \n\nSpaced list:\n\n1. item one\n\n2. item two ")).toBe(
    '<p>Tight list:</p>\n<ol>\n<li>item one</li>\n<li>item two </li>\n</ol>\n<p>Spaced list:</p>\n<ol>\n<li>item one</li>\n<li>item two </li>\n</ol>'
  );
});

test("spacing after the first two items does not change a list's style", () => {
  expect(renderMarkdown("- one\n- two\n\n- three")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ul>\n<li>three</li>\n</ul>");
  expect(renderMarkdown("- one\n\n- two\n\n- three\n\nend")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>\n<p>end</p>");
  expect(renderMarkdown("- one\n\nprose\n\n- two")).toBe("<ul>\n<li>one</li>\n</ul>\n<p>prose</p>\n<ul>\n<li>two</li>\n</ul>");
  expect(renderMarkdown("2. one\n\n3. two\n\n- another")).toBe('<ol start="2">\n<li>one</li>\n<li>two</li>\n</ol>\n<ul>\n<li>another</li>\n</ul>');
});
