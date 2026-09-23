// test/base-context.test.js — proof for lib/context.js
import { describe, expect, test } from "bun:test";
import {
  parseInput,
  createAssembler,
  assemblyCallbacks,
  at,
  blockAt,
  editMessage,
  editBlock,
  rebuildMessage,
  rollbackTo,
  pop,
  appendMessage,
  foldContent,
  mergeableMessages,
} from "../lib/context.js";
import Context, { normalizeCallbacks, dispatch } from "../lib/context.js";

const ctx = () => [
  { type: 1, content: [{ type: "text", text: "sys" }] },
  { type: 2, content: [{ type: "text", text: "hi" }] },
  { type: 3, content: [{ type: "text", text: "hello" }], responseId: "r-1" },
];

describe("CLI-input parsing (delegates to shared grammar)", () => {
  test("parses plain lines to user messages", () => {
    expect(parseInput("hello there")).toEqual([
      { type: 2, content: [{ type: "text", text: "hello there" }] },
    ]);
  });

  test("parses whole JSON context", () => {
    const input = JSON.stringify(ctx());
    expect(parseInput(input)).toEqual(ctx());
  });
});

describe("response-event assembly", () => {
  test("assembles ordered text/thinking/toolCall blocks from deltas", () => {
    const a = createAssembler();
    a.consume({ type: "start" });
    a.consume({ type: "thinking_start", contentIndex: 0 });
    a.consume({ type: "thinking_delta", contentIndex: 0, text: "let me " });
    a.consume({ type: "thinking_delta", contentIndex: 0, text: "think" });
    a.consume({ type: "thinking_end", contentIndex: 0 });
    a.consume({ type: "text_start", contentIndex: 1 });
    a.consume({ type: "text_delta", contentIndex: 1, text: "Hello" });
    a.consume({ type: "text_end", contentIndex: 1 });
    a.consume({ type: "toolcall_start", contentIndex: 2, callId: "c1", name: "file-read" });
    a.consume({ type: "toolcall_delta", contentIndex: 2, arguments: '{"path":' });
    a.consume({ type: "toolcall_delta", contentIndex: 2, arguments: '"x"}' });
    a.consume({ type: "toolcall_end", contentIndex: 2 });
    a.consume({ type: "done" });
    expect(a.message()).toEqual({
      type: 3,
      content: [
        { type: "thinking", text: "let me think" },
        { type: "text", text: "Hello" },
        { type: "toolCall", callId: "c1", name: "file-read", arguments: { path: "x" } },
      ],
    });
  });

  test("partial message available mid-stream (cancellation contract)", () => {
    const a = createAssembler();
    a.consume({ type: "start" });
    a.consume({ type: "text_start", contentIndex: 0 });
    a.consume({ type: "text_delta", contentIndex: 0, text: "partial ans" });
    // cancelled before done
    expect(a.message()).toEqual({
      type: 3,
      content: [{ type: "text", text: "partial ans" }],
    });
  });

  test("final text replaces a conflicting streamed block and retains its draft", () => {
    const a = createAssembler();
    a.consume({ type: "text_start", contentIndex: 0 });
    a.consume({ type: "text_delta", contentIndex: 0, text: "The draft." });
    a.consume({ type: "text_end", contentIndex: 0, text: "The corrected answer." });
    expect(a.message()).toEqual({
      type: 3,
      draft: "The draft.",
      content: [{ type: "text", text: "The corrected answer." }],
    });
  });

  test("matching final text does not create a draft or duplicate the text", () => {
    const a = createAssembler();
    a.consume({ type: "text_delta", contentIndex: 0, text: "Unchanged." });
    a.consume({ type: "text_end", contentIndex: 0, text: "Unchanged." });
    expect(a.message()).toEqual({ type: 3, content: [{ type: "text", text: "Unchanged." }] });
  });

  test("final thinking snapshots replace streamed thinking without duplication", () => {
    const a = createAssembler();
    a.consume({ type: "thinking_start", contentIndex: 0 });
    a.consume({ type: "thinking_delta", contentIndex: 0, text: "draft reasoning" });
    a.consume({ type: "thinking_end", contentIndex: 0, text: "final reasoning" });
    expect(a.message()).toEqual({ type: 3, content: [{ type: "thinking", text: "final reasoning" }] });
  });

  test("final snapshots consolidate every text block, including interleaved blocks", () => {
    const a = createAssembler();
    a.consume({ type: "text_start", contentIndex: 0 });
    a.consume({ type: "text_delta", contentIndex: 0, text: "first draft" });
    a.consume({ type: "thinking_start", contentIndex: 1 });
    a.consume({ type: "thinking_delta", contentIndex: 1, text: "reasoning" });
    a.consume({ type: "text_start", contentIndex: 2 });
    a.consume({ type: "text_delta", contentIndex: 2, text: "second draft" });
    a.consume({ type: "text_end", contentIndex: 2, text: "second final" });
    a.consume({ type: "text_end", contentIndex: 0, text: "first final" });
    expect(a.message()).toEqual({
      type: 3,
      draft: "first draft",
      content: [
        { type: "text", text: "first final" },
        { type: "thinking", text: "reasoning" },
        { type: "text", text: "second final" },
      ],
    });
  });

  test("unparseable tool arguments keep raw string", () => {
    const a = createAssembler();
    a.consume({ type: "toolcall_start", contentIndex: 0, callId: "c", name: "t" });
    a.consume({ type: "toolcall_delta", contentIndex: 0, arguments: "{bad" });
    a.consume({ type: "toolcall_end", contentIndex: 0 });
    expect(a.message().content[0].arguments).toBe("{bad");
  });

  test("assemblyCallbacks plugs into normalized routing", () => {
    const a = createAssembler();
    const set = normalizeCallbacks(assemblyCallbacks(a));
    dispatch(set, { type: "start" });
    dispatch(set, { type: "text_start", contentIndex: 0 });
    dispatch(set, { type: "text_delta", contentIndex: 0, text: "via callbacks" });
    dispatch(set, { type: "done" });
    expect(a.message().content[0].text).toBe("via callbacks");
  });

  test("done adopts a carried final message", () => {
    const a = createAssembler();
    const final = { type: 3, content: [{ type: "text", text: "whole" }] };
    a.consume({ type: "done", message: final });
    expect(a.message()).toBe(final);
  });
});

describe("addressing", () => {
  test("at / blockAt return validated objects", () => {
    const c = ctx();
    expect(at(c, 1).content[0].text).toBe("hi");
    expect(blockAt(c, 2, 0).text).toBe("hello");
  });

  test("out-of-range block access throws", () => {
    expect(() => blockAt(ctx(), 0, 5)).toThrow(RangeError);
  });

  test("blockAt rejects non-integer indexes", () => {
    expect(() => blockAt(ctx(), 0, Number.NaN)).toThrow(RangeError);
    expect(() => blockAt(ctx(), 0, 0.5)).toThrow(RangeError);
  });
});

describe("edit with stale identifier cleanup", () => {
  test("message edit drops provider/cache ids, keeps schema fields", () => {
    const c = ctx();
    const stored = editMessage(c, 2, {
      type: 3,
      content: [{ type: "text", text: "edited" }],
      responseId: "r-1",
      cacheId: "eph-9",
      provider: { block: "b1" },
    });
    expect(stored).toEqual({ type: 3, content: [{ type: "text", text: "edited" }] });
    expect(c[2]).toBe(stored);
    expect(c[2].responseId).toBeUndefined();
    expect(c[2].cacheId).toBeUndefined();
  });

  test("tool-result linkage (callId, name, error) is preserved", () => {
    const c = [
      { type: 3, content: [{ type: "toolCall", callId: "c1", name: "file-read", arguments: {} }] },
      { type: 4, callId: "c1", name: "file-read", error: false,
        content: [{ type: "text", text: "data" }], responseId: "stale" },
    ];
    const stored = editMessage(c, 1, { ...c[1], content: [{ type: "text", text: "fixed" }] });
    expect(stored).toEqual({
      type: 4, callId: "c1", name: "file-read", error: false,
      content: [{ type: "text", text: "fixed" }],
    });
  });

  test("assistant draft display metadata survives a context edit", () => {
    const clean = rebuildMessage({
      type: 3, draft: "streamed", content: [{ type: "text", text: "final" }],
    });
    expect(clean).toEqual({
      type: 3, draft: "streamed", content: [{ type: "text", text: "final" }],
    });
  });

  test("tool-result linkage is dropped from non-tool-result message edits", () => {
    expect(rebuildMessage({
      type: 3, callId: "provider-response-id", name: "stale", error: true, content: [],
    })).toEqual({ type: 3, content: [] });
  });

  test("thinking/toolCall block metadata survives (replay data)", () => {
    const clean = rebuildMessage({
      type: 3,
      content: [
        { type: "thinking", text: "t", signature: "sig-abc" },
        { type: "toolCall", callId: "c1", name: "n", arguments: {}, providerExtra: 1 },
      ],
      messageLevelId: "drop-me",
    });
    expect(clean.content[0]).toEqual({ type: "thinking", text: "t", signature: "sig-abc" });
    expect(clean.content[1]).toEqual({
      type: "toolCall", callId: "c1", name: "n", arguments: {}, providerExtra: 1,
    });
    expect(clean.messageLevelId).toBeUndefined();
  });

  test("unknown block types pass through untouched", () => {
    const clean = rebuildMessage({
      type: 3,
      content: [{ type: "redacted_thinking", data: "x" }],
    });
    expect(clean.content[0]).toEqual({ type: "redacted_thinking", data: "x" });
  });

  test("block edit rebuilds the containing message", () => {
    const c = ctx();
    const stored = editBlock(c, 2, 0, { type: "text", text: "block edited", junk: 1 });
    expect(stored).toEqual({ type: "text", text: "block edited" });
    expect(c[2]).toEqual({ type: 3, content: [{ type: "text", text: "block edited" }] });
    expect(c[2].responseId).toBeUndefined();
  });

  test("block edit rejects non-integer indexes without changing the message", () => {
    const c = ctx();
    expect(() => editBlock(c, 2, Number.NaN, { type: "text", text: "bad" })).toThrow(RangeError);
    expect(c[2].content[0].text).toBe("hello");
  });

  test("edit produces new objects (no aliasing of the input)", () => {
    const c = ctx();
    const input = { type: 2, content: [{ type: "text", text: "new" }], meta: 1 };
    const stored = editMessage(c, 1, input);
    expect(stored).not.toBe(input);
    expect(stored.content[0]).not.toBe(input.content[0]);
  });
});

describe("rollback / pop", () => {
  test("rollbackTo truncates in place and returns removed", () => {
    const c = ctx();
    const removed = rollbackTo(c, 1);
    expect(c).toHaveLength(1);
    expect(removed).toHaveLength(2);
    expect(removed[0].type).toBe(2);
  });

  test("pop removes the last message in place", () => {
    const c = ctx();
    const last = pop(c);
    expect(last.type).toBe(3);
    expect(c).toHaveLength(2);
  });

  test("rollbackTo validates the index", () => {
    expect(() => rollbackTo(ctx(), 9)).toThrow(RangeError);
  });

  test("rollbackTo(count) is out of range — only existing indexes are valid", () => {
    // ctx() holds 3 messages: indexes 0..2. Passing the COUNT (3) used
    // to slip past the boundary check as a silent no-op (the < vs <=
    // mixup) — it throws now; rollbackTo(0) is the way to clear all.
    expect(() => rollbackTo(ctx(), 3)).toThrow(RangeError);
    const c = ctx();
    expect(rollbackTo(c, 0)).toHaveLength(3); // index 0 clears everything
    expect(c).toHaveLength(0);
  });

  test("rollbackTo on an empty context throws", () => {
    expect(() => rollbackTo([], 0)).toThrow(RangeError);
  });

  test("rollbackTo rejects non-integer indexes without mutating", () => {
    const c = ctx();
    expect(() => rollbackTo(c, Number.NaN)).toThrow(RangeError);
    expect(() => rollbackTo(c, 1.5)).toThrow(RangeError);
    expect(c).toHaveLength(3);
  });
});

describe("append with merging (appendMessage / foldContent)", () => {
  const user = (text) => ({ type: 2, content: [{ type: "text", text }] });

  test("consecutive same-type messages with identical metadata merge into one", () => {
    const c = [user("first")];
    const stored = appendMessage(c, user("second"));
    expect(c).toHaveLength(1);
    expect(stored).toBe(c[0]); // the PREVIOUS message, grown
    expect(c[0].content).toEqual([{ type: "text", text: "first\nsecond" }]);
  });

  test("chat user messages are a metadata border and never merge with real user input", () => {
    const c = [user("real user")];
    appendMessage(c, { ...user("chat"), subtype: "chat" });
    appendMessage(c, user("next real user"));
    expect(c).toHaveLength(3);
    expect(c.map((message) => message.subtype ?? "user")).toEqual(["user", "chat", "user"]);
  });

  test("user messages merge only when all non-message metadata match", () => {
    const c = [{ ...user("first"), source: "import" }];
    appendMessage(c, { ...user("second"), source: "import" });
    appendMessage(c, { ...user("third"), source: "chat" });
    expect(c).toHaveLength(2);
    expect(c[0].content[0].text).toBe("first\nsecond");
  });

  test("different types never merge", () => {
    const c = [user("q")];
    appendMessage(c, { type: 3, content: [{ type: "text", text: "a" }] });
    expect(c).toHaveLength(2);
  });

  test("metadata RECORDS pass through untouched: no validation, no folding, never merged", () => {
    const record = { type: "note-store", notes: { a: { content: "x" } } };
    const c = [user("q")];
    const stored = appendMessage(c, record);
    expect(stored).toBe(record); // the SAME object, unmerged
    expect(c).toHaveLength(2);
    expect(c[1]).toBe(record);
    // a following message never folds INTO the record (types never match)
    appendMessage(c, user("next"));
    expect(c).toHaveLength(3);
    expect(c[2].content[0].text).toBe("next");
    // and a record sits comfortably ahead of messages for later appends
    appendMessage(c, user("more"));
    expect(c[2].content[0].text).toBe("next\nmore"); // the merge skipped the record
  });

  test("system messages merge like any same-type pair", () => {
    const c = [{ type: 1, content: [{ type: "text", text: "s1" }] }];
    appendMessage(c, { type: 1, content: [{ type: "text", text: "s2" }] });
    expect(c).toHaveLength(1);
    expect(c[0].content[0].text).toBe("s1\ns2");
  });

  test("tool results NEVER merge (call linkage is per-message)", () => {
    const c = [
      { type: 4, callId: "a", name: "t", content: [{ type: "text", text: "r1" }] },
    ];
    appendMessage(c, { type: 4, callId: "b", name: "t", content: [{ type: "text", text: "r2" }] });
    expect(c).toHaveLength(2);
  });

  test("messages carrying linkage fields never merge", () => {
    const c = [{ type: 3, callId: "x", content: [{ type: "text", text: "a" }] }];
    appendMessage(c, { type: 3, content: [{ type: "text", text: "b" }] });
    expect(c).toHaveLength(2);
  });

  test("adjacent thinking blocks fold across the merge (one logical block)", () => {
    const c = [{ type: 3, content: [{ type: "thinking", text: "part one" }] }];
    appendMessage(c, { type: 3, content: [{ type: "thinking", text: "part two" }] });
    expect(c).toHaveLength(1);
    expect(c[0].content).toEqual([{ type: "thinking", text: "part one\npart two" }]);
  });

  test("thinking and text blocks stay separate within a merge", () => {
    const c = [{ type: 3, content: [{ type: "thinking", text: "t" }] }];
    appendMessage(c, { type: 3, content: [{ type: "text", text: "answer" }] });
    expect(c[0].content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  test("toolCall blocks never fold with anything", () => {
    const c = [{
      type: 3,
      content: [{ type: "toolCall", callId: "1", name: "t", arguments: {} }],
    }];
    appendMessage(c, { type: 3, content: [{ type: "text", text: "after" }] });
    expect(c[0].content.map((b) => b.type)).toEqual(["toolCall", "text"]);
  });

  test("the appended message's own adjacent same-sub-type blocks fold", () => {
    const c = [];
    appendMessage(c, {
      type: 3,
      content: [
        { type: "thinking", text: "a" },
        { type: "thinking", text: "b" },
        { type: "text", text: "x" },
        { type: "text", text: "y" },
      ],
    });
    expect(c[0].content).toEqual([
      { type: "thinking", text: "a\nb" },
      { type: "text", text: "x\ny" },
    ]);
  });

  test("joining adds no extra newline when one side already ends with it", () => {
    expect(foldContent([
      { type: "text", text: "line\n" },
      { type: "text", text: "next" },
    ])).toEqual([{ type: "text", text: "line\nnext" }]);
    expect(foldContent([
      { type: "text", text: "" },
      { type: "text", text: "only" },
    ])).toEqual([{ type: "text", text: "only" }]);
  });

  test("provider metadata is a BORDER: metadata-carrying messages never merge", () => {
    // the harness adds no metadata — any extra field is provider data
    // (a cache id, replay info): a provider-defined message border
    const c = [{ type: 2, content: [{ type: "text", text: "one" }], cacheId: "p1" }];
    appendMessage(c, { type: 2, content: [{ type: "text", text: "two" }] });
    expect(c).toHaveLength(2); // the bordered message stays its own unit
    const d = [{ type: 2, content: [{ type: "text", text: "one" }] }];
    appendMessage(d, { type: 2, content: [{ type: "text", text: "two" }], native: { id: 7 } });
    expect(d).toHaveLength(2); // a border on EITHER side blocks the merge
  });

  test("provider metadata is a BORDER: metadata blocks never fold", () => {
    // a thinking block with a replay signature must survive verbatim —
    // folding it into a neighbor would lose the provider's data
    const folded = foldContent([
      { type: "thinking", text: "a" },
      { type: "thinking", text: "b", signature: "sig-1" },
    ]);
    expect(folded).toEqual([
      { type: "thinking", text: "a" },
      { type: "thinking", text: "b", signature: "sig-1" },
    ]);
  });

  test("user continuations merge: queued messages fold with newlines", () => {
    const c = [];
    appendMessage(c, user("first queued"));
    appendMessage(c, user("second queued"));
    appendMessage(c, user("third queued"));
    expect(c).toHaveLength(1);
    expect(c[0].content).toEqual([{ type: "text", text: "first queued\nsecond queued\nthird queued" }]);
  });

  test("mergeableMessages encodes the merge policy", () => {
    expect(mergeableMessages(user("a"), user("b"))).toBe(true);
    expect(mergeableMessages(user("a"), { type: 3, content: [] })).toBe(false);
    expect(mergeableMessages(
      { type: 4, callId: "x", content: [] },
      { type: 4, callId: "y", content: [] },
    )).toBe(false);
    expect(mergeableMessages({ type: 3, name: "t", content: [] }, { type: 3, content: [] })).toBe(false);
    expect(mergeableMessages(
      { type: 2, content: [], cacheId: "p1" },
      { type: 2, content: [] },
    )).toBe(false); // provider metadata = a border
  });

  test("appendMessage validates its inputs", () => {
    expect(() => appendMessage("nope", user("x"))).toThrow(TypeError);
    expect(() => appendMessage([], { content: [] })).toThrow(TypeError);
  });

  test("EMPTY-MESSAGE refusal: an unmergeable empty message never enters the context", () => {
    const c = [user("q")];
    // a bare empty assistant message (a cancel-partial that produced
    // nothing) throws — explicit emptiness is a bug, never a silent drop
    expect(() => appendMessage(c, { type: 3, content: [] })).toThrow(/empty message/);
    expect(() => appendMessage(c, { type: 3, content: [{ type: "text", text: "" }] })).toThrow(/empty message/);
    expect(c).toHaveLength(1); // nothing entered
  });

  test("EMPTY-MESSAGE refusal: a MERGEABLE empty message merges away silently (a pure continuation)", () => {
    const c = [{ type: 3, content: [{ type: "text", text: "partial ans" }] }];
    // the next turn's first deltas produced nothing before the
    // terminal — a pure continuation of the previous assistant
    // message, so it merges away instead of throwing
    const stored = appendMessage(c, { type: 3, content: [] });
    expect(stored).toBe(c[0]);
    expect(c).toHaveLength(1);
    expect(c[0].content).toEqual([{ type: "text", text: "partial ans" }]);
  });

  test("hasContent: payload-bearing blocks count; payload-less ones do not", () => {
    expect(Context.hasContent({ type: 3, content: [] })).toBe(false);
    expect(Context.hasContent({ type: 3, content: [{ type: "text", text: "" }] })).toBe(false);
    expect(Context.hasContent({ type: 3, content: [{ type: "thinking", text: "" }] })).toBe(false);
    expect(Context.hasContent({ type: 3, content: [{ type: "text", text: "x" }] })).toBe(true);
    expect(Context.hasContent({ type: 3, content: [{ type: "toolCall", callId: "c", name: "n", arguments: "" }] })).toBe(true);
    expect(Context.hasContent({ type: 2, content: [{ type: "image", mime: "image/png", content: "..." }] })).toBe(true);
  });
});
