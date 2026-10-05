import { describe, expect, test } from "bun:test";
import { historyEntries, historyRecall, onEdgeRow, editHistoryDraft } from "../lib/app/web/public/app/logic/history.js";

const WRAP = 20;
function makeSession(userTexts) {
  const textarea = { value: "", selectionStart: 0, selectionEnd: 0 };
  const session = {
    agent: { id: "a1" },
    blocks: userTexts.map((text) => ({ kind: "user", text })),
    draft: { text: "", attachments: [], submitted: [], historyIndex: null, historyDraft: null },
    textarea,
    composerDraft() { return this.draft; },
    messageHistory() { return historyEntries(this.blocks, this.draft.submitted); },
    noteComposerInput() { editHistoryDraft(this.draft, textarea.value); },
    recallHistory(direction) {
      const entries = this.messageHistory();
      if (!entries.length || (direction > 0 && this.draft.historyIndex === null)) return false;
      const caret = direction < 0 ? textarea.selectionStart : textarea.selectionEnd;
      const row = (at) => {
        const lines = textarea.value.slice(0, at).split("\n");
        return lines.slice(0, -1).reduce((sum, line) => sum + Math.floor(line.length / WRAP) + 1, 0) + Math.floor(lines.at(-1).length / WRAP);
      };
      const tops = { start: 0, caret: row(caret), end: row(textarea.value.length) };
      const result = historyRecall({ value: textarea.value, caret, direction, entries, draft: this.draft, tops });
      if (!result) return false;
      if (direction < 0 && this.draft.historyIndex === 0) return true;
      this.draft.historyIndex = result.index;
      this.draft.historyDraft = result.historyDraft;
      textarea.value = result.value;
      return true;
    },
  };
  return { ...session, composerDraft: session.composerDraft.bind(session), messageHistory: session.messageHistory.bind(session), recallHistory: session.recallHistory.bind(session) };
}
const type = (s, text) => { s.textarea.value = text; s.textarea.selectionStart = s.textarea.selectionEnd = text.length; s.noteComposerInput(); };
const caret = (s, index) => { s.textarea.selectionStart = s.textarea.selectionEnd = index; };
const up = (s) => s.recallHistory(-1);
const down = (s) => s.recallHistory(1);

describe("web composer history recall", () => {
  test("Up recalls newest first, Down walks back to the working draft", () => {
    const s = makeSession(["first", "second"]);
    type(s, "my draft");
    expect(up(s)).toBe(true);
    expect(s.textarea.value).toBe("second");
    expect(up(s)).toBe(true);
    expect(s.textarea.value).toBe("first");
    expect(up(s)).toBe(true); // oldest entry: stays
    expect(s.textarea.value).toBe("first");
    expect(down(s)).toBe(true);
    expect(s.textarea.value).toBe("second");
    expect(down(s)).toBe(true);
    expect(s.textarea.value).toBe("my draft"); // the draft survived the round trip
    expect(s.composerDraft().historyIndex).toBe(null);
  });

  test("typing while browsing edits the draft, and browsing again keeps it", () => {
    const s = makeSession(["first", "second"]);
    type(s, "original draft");
    up(s); // -> "second"
    type(s, "second edited"); // exits browsing, edited text is the draft now
    expect(s.composerDraft().text).toBe("second edited");
    up(s); // -> "second" again
    expect(down(s)).toBe(true);
    expect(s.textarea.value).toBe("second edited"); // edit is never lost
  });

  test("Up past a recalled entry still returns to the LATEST typed draft", () => {
    const s = makeSession(["one", "two"]);
    up(s); // -> "two"
    type(s, "two plus edits");
    up(s); // -> "two"
    up(s); // -> "one"
    down(s); // -> "two"
    down(s); // -> back to the edited draft, not the recalled entry
    expect(s.textarea.value).toBe("two plus edits");
  });

  test("Up/Down keep native caret movement inside multi-line text", () => {
    const s = makeSession(["history entry"]);
    type(s, "line one\nline two\nline three");
    caret(s, 12); // middle line
    expect(up(s)).toBe(false);   // native: caret up one line
    expect(down(s)).toBe(false); // native: caret down one line
    caret(s, 0); // first line start
    expect(up(s)).toBe(true);
    expect(s.textarea.value).toBe("history entry");
  });

  test("Up/Down move between soft-wrapped rows first; recall only from the edge rows", () => {
    const s = makeSession(["history entry"]);
    const draft = "a long draft without any newline that merely wraps visually in the browser";
    type(s, draft); // caret at the end: the last visual row
    expect(up(s)).toBe(false);   // native: caret up one visual row
    caret(s, 45);                // a middle visual row
    expect(up(s)).toBe(false);
    caret(s, 5);                 // the first visual row
    expect(up(s)).toBe(true);
    expect(s.textarea.value).toBe("history entry");
    expect(down(s)).toBe(true);  // back to the draft
    expect(s.textarea.value).toBe(draft);
    up(s);                       // browsing again, then a wrapped entry
    s.textarea.value = draft;    // (as if the recalled entry were long)
    caret(s, 5);
    expect(down(s)).toBe(false); // native: caret down one visual row
    caret(s, draft.length - 1);
    expect(down(s)).toBe(true);
  });

  test("a rebuilt composer restores the working draft, never a recalled entry", () => {
    const s = makeSession(["first", "second"]);
    type(s, "precious draft");
    up(s); // browsing: "second"
    // buildComposer: reseed from draft state and drop the browsing session.
    const draft = s.composerDraft();
    s.textarea.value = draft.text;
    draft.historyIndex = null; draft.historyDraft = null;
    expect(s.textarea.value).toBe("precious draft");
  });

  test("the draft state is never polluted by recalled entries", () => {
    const s = makeSession(["first", "second"]);
    type(s, "precious draft");
    up(s); up(s); down(s);
    expect(s.composerDraft().text).toBe("precious draft"); // apply() must not touch draft.text
  });

  test("recall never fires the composer input handler (no draft clobbering)", () => {
    const s = makeSession(["first"]);
    type(s, "draft");
    const before = s.composerDraft().text;
    up(s);
    expect(s.composerDraft().text).toBe(before);
  });

  test("empty history or empty agent: arrows are inert", () => {
    const s = makeSession([]);
    type(s, "draft");
    expect(up(s)).toBe(false);
    expect(down(s)).toBe(false);
    expect(s.textarea.value).toBe("draft");
  });

  test("history dedups locally remembered submits once echoed into context", () => {
    const s = makeSession(["older", "sent message"]);
    s.composerDraft().submitted.push("sent message");
    expect(s.messageHistory()).toEqual(["older", "sent message"]);
  });
});
