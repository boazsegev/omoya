// test/base-validate.test.js — proof for lib/validate.js
import { describe, expect, test } from "bun:test";
import {
  messageValid,
  messageIsRecord,
  messagesValid,
  messageValidate,
  messagesValidate,
} from "../lib/context.js";

describe("messageValid / messagesValid (tolerant reader)", () => {
  test("accepts the core shape", () => {
    expect(messageValid({ type: 2, content: [] })).toBe(true);
    expect(messagesValid([{ type: 1, content: [] }, { type: 3, content: [] }])).toBe(true);
  });

  test("unknown/metadata fields never invalidate a value", () => {
    const msg = {
      type: 3,
      content: [{ type: "text", text: "hi", providerBlockId: "b-9" }],
      responseId: "resp-123",
      cacheId: "ephemeral",
      anything: { nested: [1, 2] },
    };
    expect(messageValid(msg)).toBe(true);
  });

  test("rejects core-shape violations", () => {
    expect(messageValid(null)).toBe(false);
    expect(messageValid("text")).toBe(false);
    expect(messageValid([])).toBe(false);
    expect(messageValid({ content: [] })).toBe(false); // missing type
    expect(messageValid({ type: "user", content: [] })).toBe(false); // non-numeric type
    expect(messageValid({ type: 2 })).toBe(false); // missing content
    expect(messageValid({ type: 2, content: "x" })).toBe(false); // content not array
    expect(messagesValid({})).toBe(false);
    expect(messagesValid([{ type: 2, content: [] }, { type: 2 }])).toBe(false);
  });

  test("metadata RECORDS (a string `type`) are legal context entries, never messages", () => {
    const record = { type: "note-store", notes: { a: { content: "x" } } };
    expect(messageValid(record)).toBe(false); // not a message...
    expect(messageIsRecord(record)).toBe(true); // ...but a record
    expect(messageIsRecord({ type: 2, content: [] })).toBe(false); // messages are not records
    expect(messageIsRecord({ notes: {} })).toBe(false); // no type at all: neither
    expect(messagesValid([{ type: 2, content: [] }, record])).toBe(true); // mixed contexts are valid
  });
});

describe("messageValidate / messagesValidate", () => {
  test("pass through untouched: same reference, metadata preserved", () => {
    const msg = { type: 2, content: [], custom: { a: 1 }, responseId: "r" };
    expect(messageValidate(msg)).toBe(msg);
    const ctx = [msg];
    expect(messagesValidate(ctx)).toBe(ctx);
    expect(ctx[0]).toBe(msg);
    expect(msg.custom).toEqual({ a: 1 });
    expect(msg.responseId).toBe("r");
  });

  test("messagesValidate skips records (only messages validate); messageValidate stays strict", () => {
    const ctx = [{ type: 2, content: [] }, { type: "note-store", notes: {} }];
    expect(messagesValidate(ctx)).toBe(ctx); // the record passes through
    expect(() => messageValidate(ctx[1], "context[1]")).toThrow(/context\[1\].*numeric "type"/);
    // a non-message non-record still fails in place
    expect(() => messagesValidate([{ type: 2, content: [] }, { notes: {} }])).toThrow(/context\[1\]/);
  });

  test("throw with address hints on violations", () => {
    expect(() => messageValidate({ content: [] }, "context[2]")).toThrow(
      /context\[2\].*numeric "type"/,
    );
    expect(() => messageValidate({ type: 1 }, "context[0]")).toThrow(
      /context\[0\].*"content" array/,
    );
    expect(() => messagesValidate("nope")).toThrow(/context: expected an array/);
    expect(() => messagesValidate([{ type: 2, content: [] }, null])).toThrow(
      /context\[1\]/,
    );
  });

  test("no provider-shape validation: foreign block types pass", () => {
    const msg = {
      type: 3,
      content: [{ type: "redacted_thinking", data: "..." }, { weird: true }],
    };
    expect(messageValidate(msg)).toBe(msg);
  });
});
