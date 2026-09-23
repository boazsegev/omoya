import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { attachmentParts, attachmentMessage, attachmentPaste } from "../lib/tui-app/attachment-draft.js";

describe("TUI attachment drafts", () => {
  test("turns only whole absolute file-path pastes into canonical markers", async () => {
    const cwd = await mkdtemp("./ai-tmp/tui-paste-");
    const absoluteCwd = resolve(cwd);
    const folder = join(absoluteCwd, "folder");
    await mkdir(folder);
    expect(attachmentPaste("/tmp/my\\ file.pdf")).toBe("{{@/tmp/my file.pdf}}");
    // a drag can escape more than spaces (\#, \;, \&, parens, ...) — every
    // \x unescapes; a whitelist can never be complete. (Paths are inert test
    // strings, never touched.)
    expect(attachmentPaste("/tmp/offer\\ #85\\ final.pdf")).toBe("{{@/tmp/offer #85 final.pdf}}");
    expect(attachmentPaste("/tmp/a\\;b\\&c\\(d\\).pdf")).toBe("{{@/tmp/a;b&c(d).pdf}}");
    expect(attachmentPaste("'/tmp/report.pdf'")).toBe("{{@/tmp/report.pdf}}");
    expect(attachmentPaste(folder, { cwd: absoluteCwd })).toBe("`./folder`");
    expect(attachmentPaste("see /tmp/report.pdf")).toBe("see /tmp/report.pdf");
    expect(attachmentPaste("relative/report.pdf")).toBe("relative/report.pdf");
  });

  test("resolves both bracketed and short markers in text/file/text order", async () => {
    const dir = await mkdtemp("./ai-tmp/tui-attachment-");
    const file = join(dir, "note.txt");
    await writeFile(file, "file bytes");
    const draft = `before {{@${file}}} after`;
    expect(attachmentParts(draft)).toEqual([
      { type: "text", text: "before " }, { type: "file", path: file }, { type: "text", text: " after" },
    ]);
    expect(attachmentParts(`{{@${file}}}`)).toEqual([{ type: "file", path: file }]);
    const message = await attachmentMessage(draft);
    expect(message.content.map((block) => block.type)).toEqual(["text", "binary", "text"]);
    expect(message.content[0].text).toBe("before ");
    expect(message.content[1].filename).toBe("note.txt");
    expect(message.content[2].text).toBe(" after");
  });
});
