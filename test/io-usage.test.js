// test/io-usage.test.js — proof for usage accounting:
// provider-reported numbers; word-count × token-per-word fallback.
import { describe, expect, test } from "bun:test";
import {
  TOKENS_PER_WORD,
  wordCount,
  estimateTokens,
  estimateUsage,
  finalizeUsage,
  usageSummary,
} from "../lib/context.js";

describe("word count and token estimation", () => {
  test("wordCount splits on whitespace, tolerates junk", () => {
    expect(wordCount("one two three")).toBe(3);
    expect(wordCount("  padded   gaps ")).toBe(2);
    expect(wordCount("")).toBe(0);
    expect(wordCount(null)).toBe(0);
    expect(wordCount(42)).toBe(0);
  });

  test("estimateTokens applies the token-per-word likelihood ratio", () => {
    expect(TOKENS_PER_WORD).toBe(4 / 3);
    expect(estimateTokens("one two three")).toBe(Math.ceil(3 * (4 / 3))); // 4
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateUsage", () => {
  test("estimates input from context, output from the assembled message", () => {
    const context = [
      { type: 2, content: [{ type: "text", text: "one two three" }] }, // 3 words
      { type: 1, content: [{ type: "text", text: "sys" }] }, // 1 word
    ];
    const message = { type: 3, content: [{ type: "text", text: "a b c d e f" }] }; // 6 words
    const usage = estimateUsage(context, message);
    expect(usage.source).toBe("estimate");
    expect(usage.inputTokens).toBe(Math.ceil(4 * (4 / 3))); // 6
    expect(usage.outputTokens).toBe(Math.ceil(6 * (4 / 3))); // 8
  });

  test("tool-call arguments count toward output text", () => {
    const message = {
      type: 3,
      content: [{ type: "toolCall", callId: "c1", name: "file-read", arguments: '{"path":"x"}' }],
    };
    expect(estimateUsage([], message).outputTokens).toBeGreaterThan(0);
  });
});

describe("finalizeUsage", () => {
  const context = [{ type: 2, content: [{ type: "text", text: "hello world" }] }];
  const message = { type: 3, content: [{ type: "text", text: "hi" }] };

  test("provider-reported numbers win, tagged as provider source", () => {
    expect(finalizeUsage({ inputTokens: 10, outputTokens: 5 }, context, message)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      source: "provider",
    });
  });

  test("absent report falls back to estimation", () => {
    const usage = finalizeUsage(null, context, message);
    expect(usage.source).toBe("estimate");
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  test("partial/invalid reports are treated as absent (no mixed sources)", () => {
    for (const bad of [
      { inputTokens: 10 }, // missing output
      { inputTokens: "10", outputTokens: 5 },
      { inputTokens: NaN, outputTokens: 5 },
      "10/5",
      42,
    ]) {
      expect(finalizeUsage(bad, context, message).source).toBe("estimate");
    }
  });
});

describe("usageSummary", () => {
  test("one-line stderr summary", () => {
    expect(usageSummary({ inputTokens: 10, outputTokens: 5, source: "provider" })).toBe(
      "usage: in=10 out=5 (provider)",
    );
    expect(usageSummary(null)).toBe("usage: unknown");
  });
});

describe("provider-reported cost", () => {
  const context = [{ type: 2, content: [{ type: "text", text: "hello world" }] }];
  const message = { type: 3, content: [{ type: "text", text: "hi" }] };

  test("a finite reported cost rides the envelope (never estimated)", () => {
    const usage = finalizeUsage({ inputTokens: 10, outputTokens: 5, cost: 0.0123 }, context, message);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, source: "provider", cost: 0.0123 });
    // estimates never invent a cost
    expect(finalizeUsage(null, context, message).cost).toBeUndefined();
  });

  test("the summary appends the cost when present", () => {
    expect(usageSummary({ inputTokens: 10, outputTokens: 5, source: "provider", cost: 0.0123 }))
      .toBe("usage: in=10 out=5 (provider) $0.0123");
    expect(usageSummary({ inputTokens: 10, outputTokens: 5, source: "provider" }))
      .toBe("usage: in=10 out=5 (provider)");
  });
});
