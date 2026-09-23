// test/io-ollama-tools.test.js — proof for the Ollama tool-call mapping:
// tool-call requests and tool-result messages to/from the normalized
// shape (required by the file-read smoke test).
import { describe, expect, test } from "bun:test";
import OllamaPlugin from "../providers/ollama.js";
import { defineProvider } from "../lib/io.js";

const Ollama = defineProvider(OllamaPlugin, { name: "ollama" });
const connector = (aiio = {}) => new Ollama(aiio.url, aiio);
const ollama = {
  context2msg: (context, aiio) => connector(aiio).context2msg(context, aiio),
  msg2events: (message, state, aiio) => connector(aiio).msg2events(message, state, aiio),
};
import { createAssembler } from "../lib/context.js";

const aiio = { currentModel: "m", settings: {}, tools: () => [] };

describe("Ollama thinking: wire -> normalized shape", () => {
  test("message.thinking frames become thinking events at block 0; text follows at 1", () => {
    const state = {};
    const e1 = ollama.msg2events({ message: { role: "assistant", thinking: "hmm" }, done: false }, state);
    const e2 = ollama.msg2events({ message: { role: "assistant", thinking: "..." }, done: false }, state);
    const e3 = ollama.msg2events({ message: { role: "assistant", content: "answer" }, done: false }, state);
    const e4 = ollama.msg2events({ message: { role: "assistant", content: "" }, done: true }, state);

    expect(e1).toEqual([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, text: "hmm" },
    ]);
    expect(e2).toEqual([{ type: "thinking_delta", contentIndex: 0, text: "..." }]);
    expect(e3).toEqual([
      { type: "thinking_end", contentIndex: 0 },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, text: "answer" },
    ]);
    expect(e4[0]).toMatchObject({ type: "text_end", contentIndex: 1 });
    expect(e4.at(-1)).toMatchObject({ type: "done" });

    // the assembled message holds the thinking block at 0, text at 1
    const assembler = createAssembler();
    for (const e of [...e1, ...e2, ...e3, ...e4]) assembler.consume(e);
    expect(assembler.message().content).toEqual([
      { type: "thinking", text: "hmm..." },
      { type: "text", text: "answer" },
    ]);
  });

  test("thinking before tool calls: calls index after the thinking block", () => {
    const state = {};
    ollama.msg2events({ message: { role: "assistant", thinking: "plan" }, done: false }, state);
    const events = ollama.msg2events(
      { message: { role: "assistant", tool_calls: [{ function: { name: "file-read", arguments: {} } }] }, done: false },
      state,
    );
    expect(events[0]).toMatchObject({ type: "thinking_end", contentIndex: 0 });
    expect(events[1]).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
  });

  test("the think request option passes from settings into the body", () => {
    const withThink = { currentModel: "m", settings: { think: "low" }, tools: () => [] };
    const [, body] = ollama.context2msg([], withThink);
    expect(body.think).toBe("low");
    const off = { currentModel: "m", settings: { think: false }, tools: () => [] };
    expect(ollama.context2msg([], off)[1].think).toBe(false);
    const plain = { currentModel: "m", settings: {}, tools: () => [] };
    expect("think" in ollama.context2msg([], plain)[1]).toBe(false);
  });
});

describe("Ollama tool calls: wire -> normalized shape", () => {
  test("tool_calls become toolcall start/end pairs with generated call ids", () => {
    const events = ollama.msg2events(
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "file-read", arguments: { path: "./a.txt" } } }],
        },
        done: false,
      },
      {},
    );
    expect(events).toEqual([
      {
        type: "toolcall_start",
        contentIndex: 0,
        callId: "ollama-1",
        name: "file-read",
        arguments: { path: "./a.txt" },
      },
      { type: "toolcall_end", contentIndex: 0, arguments: { path: "./a.txt" } },
    ]);
  });

  test("multiple tool calls get distinct ids and sequential content indexes", () => {
    const events = ollama.msg2events(
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "a", arguments: {} } },
            { function: { name: "b", arguments: { x: 1 } } },
          ],
        },
        done: false,
      },
      {},
    );
    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts.map((e) => e.callId)).toEqual(["ollama-1", "ollama-2"]);
    expect(starts.map((e) => e.contentIndex)).toEqual([0, 1]);
  });

  test("tool call after text lands at contentIndex 1", () => {
    const state = {};
    ollama.msg2events({ message: { role: "assistant", content: "checking" }, done: false }, state);
    const events = ollama.msg2events(
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "file-read", arguments: {} } }] }, done: false },
      state,
    );
    expect(events[0]).toMatchObject({ type: "text_end", contentIndex: 0 }); // text closes first
    expect(events[1]).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
  });

  test("assembled toolCall block replays arguments as an object", () => {
    const state = {};
    const assembler = createAssembler();
    for (const frame of [
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "file-read", arguments: { path: "./x" } } }] }, done: false },
      { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]) {
      for (const event of ollama.msg2events(frame, state)) assembler.consume(event);
    }
    const [block] = assembler.message().content;
    expect(block).toEqual({
      type: "toolCall",
      callId: "ollama-1",
      name: "file-read",
      arguments: { path: "./x" },
    });
  });
});

describe("Ollama tool results: normalized shape -> wire", () => {
  test("tool-result message maps by name", () => {
    const [, body] = ollama.context2msg(
      [
        { type: 2, content: [{ type: "text", text: "read a.txt" }] },
        { type: 3, content: [{ type: "toolCall", callId: "ollama-1", name: "file-read", arguments: { path: "./a.txt" } }] },
        { type: 4, callId: "ollama-1", name: "file-read", content: [{ type: "text", text: "file body" }] },
      ],
      aiio,
    );
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "file-read", arguments: { path: "./a.txt" } } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", name: "file-read", content: "file body" });
  });

  test("tool-result name resolves from the linked toolCall when omitted", () => {
    const [, body] = ollama.context2msg(
      [
        { type: 3, content: [{ type: "toolCall", callId: "ollama-7", name: "file-read", arguments: {} }] },
        { type: 4, callId: "ollama-7", content: [{ type: "text", text: "data" }] },
      ],
      aiio,
    );
    expect(body.messages[1]).toEqual({ role: "tool", name: "file-read", content: "data" });
  });

  test("string arguments on replay parse back to objects", () => {
    const [, body] = ollama.context2msg(
      [
        { type: 3, content: [{ type: "toolCall", callId: "c", name: "file-read", arguments: '{"path":"./y"}' }] },
      ],
      aiio,
    );
    expect(body.messages[0].tool_calls[0].function.arguments).toEqual({ path: "./y" });
  });

  test("unparseable arguments degrade to an empty object, never a crash", () => {
    const [, body] = ollama.context2msg(
      [{ type: 3, content: [{ type: "toolCall", callId: "c", name: "t", arguments: "{oops" }] }],
      aiio,
    );
    expect(body.messages[0].tool_calls[0].function.arguments).toEqual({});
  });
});
