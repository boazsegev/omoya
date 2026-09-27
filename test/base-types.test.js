// test/base-types.test.js — proof for lib/types.js
import { describe, expect, test } from "bun:test";
import {
  MessageType,
  ContentType,
  contentText,
  messageUser,
  messageSystem,
  messageAssistant,
} from "../lib/context.js";

describe("MessageType", () => {
  test("numeric types 0-4 with 0 reserved", () => {
    expect(MessageType.Reserved).toBe(0);
    expect(MessageType.System).toBe(1);
    expect(MessageType.User).toBe(2);
    expect(MessageType.Assistant).toBe(3);
    expect(MessageType.ToolResult).toBe(4);
  });

  test("frozen constants", () => {
    expect(Object.isFrozen(MessageType)).toBe(true);
    expect(Object.isFrozen(ContentType)).toBe(true);
  });
});

describe("ContentType", () => {
  test("core block discriminators", () => {
    expect(ContentType.Text).toBe("text");
    expect(ContentType.Image).toBe("image");
    expect(ContentType.Thinking).toBe("thinking");
    expect(ContentType.ToolCall).toBe("toolCall");
  });
});

describe("constructors", () => {
  test("contentText shape", () => {
    expect(contentText("hi")).toEqual({ type: "text", text: "hi" });
  });

  test("messageUser wraps plain text into a typed message", () => {
    expect(messageUser("hello")).toEqual({
      type: 2,
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("messageSystem wraps plain text into a typed message", () => {
    expect(messageSystem("be terse")).toEqual({
      type: 1,
      content: [{ type: "text", text: "be terse" }],
    });
  });

  test("messageAssistant holds an ordered block mix", () => {
    const blocks = [
      { type: "thinking", text: "hmm" },
      { type: "text", text: "answer" },
      { type: "toolCall", callId: "c1", name: "file-read", arguments: {} },
    ];
    const msg = messageAssistant(blocks);
    expect(msg.type).toBe(3);
    expect(msg.content).toBe(blocks);
  });

  test("array/block addressing: no local ids needed", () => {
    const ctx = [messageUser("a"), messageAssistant([contentText("b")])];
    expect(ctx[1].content[0].text).toBe("b");
  });
});
