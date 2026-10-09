// test/io-openai-final.test.js -- final text snapshot reaches the assembler.
import { describe, expect, test } from "bun:test";
import { msg2events } from "../lib/io/openai.js";

describe("OpenAI final text emission", () => {
  test("passes the final snapshot to text_end", () => {
    const events = msg2events({
      type: "response.output_text.done", output_index: 0, text: "final answer",
    }, {}, { context: { set contextUsage(value) {} } });
    expect(events).toEqual([{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, text: "final answer" }, { type: "text_end", contentIndex: 0, text: "final answer" }]);
  });
});
