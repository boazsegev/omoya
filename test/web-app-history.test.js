// Web composer history recall (lib/web-app/public/app.js): drafts must never
// be replaced or lost while moving through history with Up/Down. The logic is
// extracted from app.js verbatim and driven against a fake textarea, so the
// test fails if the shipped code drifts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "lib", "web-app", "public", "app.js"), "utf8");

function section(name, next) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js no longer defines ${name}`);
  const end = source.indexOf(`\nfunction ${next ?? ""}`, start);
  if (end < 0) throw new Error(`cannot bound ${name}`);
  return source.slice(start, end);
}

// Build a tiny harness with the same globals app.js uses.
function makeSession(userTexts) {
  const textarea = {
    value: "", selectionStart: 0, selectionEnd: 0, style: {},
    dispatchEvent() { session.input(); }, // app.js used to rely on this
  };
  const session = {
    agent: { id: "a1" },
    blocks: userTexts.map((text) => ({ kind: "user", text })),
    composerByAgent: new Map(),
    textareaEl: textarea,
    hideAutocompleteCalls: 0,
    input() {
      // The composer input handler, mirrored 1:1 from app.js.
      session.noteComposerInput();
    },
  };
  const body = [
    "const { agent, blocks, composerByAgent } = session;",
    "let { textareaEl } = session;",
    "const hideAutocomplete = () => { session.hideAutocompleteCalls++; };",
    section("autofit", "noteComposerInput"),
    section("noteComposerInput", "recallHistory"),
    section("composerDraft", "saveComposerDraft"),
    section("messageHistory", "recallHistory"),
    section("recallHistory", "toolLabel"),
    "session.noteComposerInput = noteComposerInput;",
    "session.api = { composerDraft, messageHistory, recallHistory, noteComposerInput };",
  ].join("\n");
  new Function("session", body)(session);
  return { ...session.api, textarea, session };
}

const type = (s, text) => {
  s.textarea.value = text;
  s.textarea.selectionStart = s.textarea.selectionEnd = text.length;
  s.textarea.dispatchEvent();
};
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

  test("Up on a soft-wrapped (single newline-free) draft still recalls", () => {
    const s = makeSession(["history entry"]);
    type(s, "a long draft without any newline that merely wraps visually in the browser");
    caret(s, 40); // mid-text, but no newline before the caret
    expect(up(s)).toBe(true);
    expect(s.textarea.value).toBe("history entry");
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
