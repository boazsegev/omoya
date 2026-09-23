import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../lib/markdown.js";

describe("git diff markdown blocks", () => {
  const diff = "--- a/file.js\n+++ b/file.js\n context\n-old\n+new";

  test("emits semantic git-diff callbacks with filenames and totals", async () => {
    const calls = [];
    await renderMarkdown(diff, {
      gitdiff: (a, b, added, removed, body) => { calls.push([a, b, added, removed, body]); return body; },
      gitdiffAdd: (text) => `A:${text}`,
      gitdiffRemove: (text) => `R:${text}`,
      gitdiffEdit: (text) => `E:${text}`,
    });
    expect(calls[0].slice(0, 4)).toEqual(["a/file.js", "b/file.js", 1, 1]);
    expect(calls[0][4]).toContain("R:-old");
    expect(calls[0][4]).toContain("A:+new");
  });
});

test("parseGitDiff exposes metadata, offsets, fences, and rejects lists", async () => {
  const { default: Markdown } = await import("../lib/markdown.js");
  const raw = "diff --git a/file.js b/file.js\nindex 111..222 100644\n--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n same";
  const token = Markdown.parseGitDiff(raw);
  expect(token).toMatchObject({ type: "gitdiff", aFilename: "a/file.js", bFilename: "b/file.js", totalAdd: 1, totalRemove: 1 });
  expect(token.sourceLines.map(({ kind }) => kind)).toEqual(["header", "header", "header", "header", "hunk", "remove", "add", "context"]);
  for (const line of token.sourceLines) expect(raw.slice(line.start, line.end)).toBe(line.text);
  const fence = String.fromCharCode(96).repeat(3);
  expect(Markdown.parseGitDiff(`${fence}diff\n--- a/a\n+++ b/a\n+x\n${fence}`)?.sourceLines.map(({ kind }) => kind)).toEqual(["fence", "header", "header", "add", "fence"]);
  expect(Markdown.parseGitDiff("- item\n+ item")).toBeNull();
});

test("parseGitDiff accepts trailing fenced newlines, CRLF headers, and triple-sign body lines", async () => {
  const { default: Markdown } = await import("../lib/markdown.js");
  const fence = String.fromCharCode(96).repeat(3);
  const fenced = `${fence}diff\n--- a/a\n+++ b/a\n+ok\n${fence}\n`;
  expect(Markdown.parseGitDiff(fenced)?.sourceLines.map(({ kind }) => kind)).toEqual(["fence", "header", "header", "add", "fence", "context"]);
  const crlf = "--- a/a\r\n+++ b/a\r\n+++body\r\n---body\r\n";
  const token = Markdown.parseGitDiff(crlf);
  expect(token).toMatchObject({ aFilename: "a/a", bFilename: "b/a", totalAdd: 1, totalRemove: 1 });
  expect(token.sourceLines.map(({ kind }) => kind)).toEqual(["header", "header", "add", "remove", "context"]);
  for (const line of token.sourceLines) expect(crlf.slice(line.start, line.end)).toBe(line.text);
});
