// Context.contentIndexer: the producer side of `contentIndex` for provider
// translators (msg2events). Same wire item -> same block; a new segment ->
// a new block, so the assembled message keeps its order.
import { describe, expect, test } from "bun:test";
import Context from "../lib/context.js";
import KimiProvider from "../providers/kimi.js";
import OllamaProvider from "../providers/ollama.js";

/** Run translated events through the assembler; return the content blocks. */
function assembled(events) {
  const assembler = Context.assemblerCreate();
  for (const event of events) assembler.consume(event);
  return assembler.message().content;
}

describe("Context.contentIndexer", () => {
  test("a key keeps its block; next() always opens a fresh one; indexes stay dense", () => {
    const index = Context.contentIndexer();
    expect(index.of("text:0")).toBe(0);
    expect(index.next()).toBe(1);
    expect(index.of("call:0")).toBe(2);
    expect(index.of("text:0")).toBe(0);
    expect(index.next()).toBe(3);
    expect(Context.contentIndexer().next()).toBe(0); // one indexer per request
  });
});

describe("text that resumes after a tool call is its own block, in order", () => {
  const ORDER = [
    { type: "text", text: "before" },
    { type: "toolCall", name: "read", arguments: { path: "a" } },
    { type: "text", text: "after" },
  ];

  test("kimi: chat-completions chunks (the call also closes on ITS block, so its arguments parse)", () => {
    const provider = new KimiProvider("https://api.moonshot.ai/v1", { settings: {}, modelCurrent: "test/m" });
    const state = {};
    const events = [
      { choices: [{ delta: { content: "before" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{\"path\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a\"}" } }] } }] },
      { choices: [{ delta: { content: "after" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ].flatMap((chunk) => provider.msg2events(chunk, state));
    expect(assembled(events)).toMatchObject(ORDER);
  });

  test("ollama: complete message chunks", () => {
    const provider = new OllamaProvider("http://localhost:11434", { settings: {}, modelCurrent: "test/m" });
    const state = {};
    const events = [
      { message: { content: "before" } },
      { message: { tool_calls: [{ function: { name: "read", arguments: { path: "a" } } }] } },
      { message: { content: "after" } },
      { message: {}, done: true },
    ].flatMap((chunk) => provider.msg2events(chunk, state));
    expect(assembled(events)).toMatchObject(ORDER);
  });
});
