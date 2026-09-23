// test/base-validate.test.js — proof for lib/validate.js
import { describe, expect, test } from "bun:test";
import {
  isMessage,
  isRecord,
  isContext,
  validateMessage,
  validateContext,
} from "../lib/context.js";

describe("isMessage / isContext (tolerant reader)", () => {
  test("accepts the core shape", () => {
    expect(isMessage({ type: 2, content: [] })).toBe(true);
    expect(isContext([{ type: 1, content: [] }, { type: 3, content: [] }])).toBe(true);
  });

  test("unknown/metadata fields never invalidate a value", () => {
    const msg = {
      type: 3,
      content: [{ type: "text", text: "hi", providerBlockId: "b-9" }],
      responseId: "resp-123",
      cacheId: "ephemeral",
      anything: { nested: [1, 2] },
    };
    expect(isMessage(msg)).toBe(true);
  });

  test("rejects core-shape violations", () => {
    expect(isMessage(null)).toBe(false);
    expect(isMessage("text")).toBe(false);
    expect(isMessage([])).toBe(false);
    expect(isMessage({ content: [] })).toBe(false); // missing type
    expect(isMessage({ type: "user", content: [] })).toBe(false); // non-numeric type
    expect(isMessage({ type: 2 })).toBe(false); // missing content
    expect(isMessage({ type: 2, content: "x" })).toBe(false); // content not array
    expect(isContext({})).toBe(false);
    expect(isContext([{ type: 2, content: [] }, { type: 2 }])).toBe(false);
  });

  test("metadata RECORDS (a string `type`) are legal context entries, never messages", () => {
    const record = { type: "note-store", notes: { a: { content: "x" } } };
    expect(isMessage(record)).toBe(false); // not a message...
    expect(isRecord(record)).toBe(true); // ...but a record
    expect(isRecord({ type: 2, content: [] })).toBe(false); // messages are not records
    expect(isRecord({ notes: {} })).toBe(false); // no type at all: neither
    expect(isContext([{ type: 2, content: [] }, record])).toBe(true); // mixed contexts are valid
  });
});

describe("validateMessage / validateContext", () => {
  test("pass through untouched: same reference, metadata preserved", () => {
    const msg = { type: 2, content: [], custom: { a: 1 }, responseId: "r" };
    expect(validateMessage(msg)).toBe(msg);
    const ctx = [msg];
    expect(validateContext(ctx)).toBe(ctx);
    expect(ctx[0]).toBe(msg);
    expect(msg.custom).toEqual({ a: 1 });
    expect(msg.responseId).toBe("r");
  });

  test("validateContext skips records (only messages validate); validateMessage stays strict", () => {
    const ctx = [{ type: 2, content: [] }, { type: "note-store", notes: {} }];
    expect(validateContext(ctx)).toBe(ctx); // the record passes through
    expect(() => validateMessage(ctx[1], "context[1]")).toThrow(/context\[1\].*numeric "type"/);
    // a non-message non-record still fails in place
    expect(() => validateContext([{ type: 2, content: [] }, { notes: {} }])).toThrow(/context\[1\]/);
  });

  test("throw with address hints on violations", () => {
    expect(() => validateMessage({ content: [] }, "context[2]")).toThrow(
      /context\[2\].*numeric "type"/,
    );
    expect(() => validateMessage({ type: 1 }, "context[0]")).toThrow(
      /context\[0\].*"content" array/,
    );
    expect(() => validateContext("nope")).toThrow(/context: expected an array/);
    expect(() => validateContext([{ type: 2, content: [] }, null])).toThrow(
      /context\[1\]/,
    );
  });

  test("no provider-shape validation: foreign block types pass", () => {
    const msg = {
      type: 3,
      content: [{ type: "redacted_thinking", data: "..." }, { weird: true }],
    };
    expect(validateMessage(msg)).toBe(msg);
  });
});
