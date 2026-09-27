// test/base-events.test.js — proof for lib/events.js
import { describe, expect, test, mock } from "bun:test";
import {
  EventType,
  eventCallbackName,
  eventValid,
  eventValidate,
  callbacksNormalize,
  eventDispatch,
} from "../lib/context.js";

describe("event vocabulary", () => {
  test("full normalized vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "start",
      "text_start", "text_delta", "text_end",
      "thinking_start", "thinking_delta", "thinking_end",
      "tool_call_start", "tool_call_delta", "tool_call_end",
      "done", "error",
    ]);
  });

  test("camelCase callback mapping", () => {
    expect(eventCallbackName("start")).toBe("onStart");
    expect(eventCallbackName("text_delta")).toBe("onTextDelta");
    expect(eventCallbackName("thinking_end")).toBe("onThinkingEnd");
    expect(eventCallbackName("tool_call_start")).toBe("onToolCallStart");
    expect(eventCallbackName("done")).toBe("onDone");
    expect(eventCallbackName("error")).toBe("onError");
  });
});

describe("eventValid / eventValidate", () => {
  test("accepts well-formed events", () => {
    expect(eventValid({ type: "start" })).toBe(true);
    expect(eventValid({ type: "text_delta", contentIndex: 0, text: "a" })).toBe(true);
    expect(eventValid({ type: "done", message: { type: 3, content: [] } })).toBe(true);
  });

  test("indexed events must carry a non-negative integer contentIndex", () => {
    expect(eventValid({ type: "text_start" })).toBe(false);
    expect(eventValid({ type: "tool_call_end", contentIndex: "0" })).toBe(false);
    expect(eventValid({ type: "text_delta", contentIndex: Number.NaN })).toBe(false);
    expect(eventValid({ type: "text_delta", contentIndex: 0.5 })).toBe(false);
    expect(eventValid({ type: "text_delta", contentIndex: -1 })).toBe(false);
  });

  test("unknown event types rejected", () => {
    expect(eventValid({ type: "message" })).toBe(false);
    expect(eventValid(null)).toBe(false);
    expect(eventValid("done")).toBe(false);
    expect(() => eventValidate({ type: "bogus" })).toThrow(/invalid response event/);
  });
});

describe("callbacksNormalize routing", () => {
  test("missing callbacks default to onData", () => {
    const data = [];
    const set = callbacksNormalize({}, { onData: (e) => data.push(e) });
    eventDispatch(set, { type: "start" });
    eventDispatch(set, { type: "text_delta", contentIndex: 0, text: "hi" });
    expect(data.map((e) => e.type)).toEqual(["start", "text_delta"]);
  });

  test("onError default also reports through onLog", () => {
    const data = [];
    const logs = [];
    const set = callbacksNormalize({}, {
      onData: (e) => data.push(e),
      onLog: (l) => logs.push(l),
    });
    eventDispatch(set, { type: "error", error: "boom" });
    expect(data).toHaveLength(1);
    expect(logs).toEqual(["boom"]);
  });

  test("explicit false/null selects no-op", () => {
    const data = [];
    const set = callbacksNormalize(
      { onTextDelta: false, onDone: null },
      { onData: (e) => data.push(e) },
    );
    eventDispatch(set, { type: "text_delta", contentIndex: 0, text: "x" });
    eventDispatch(set, { type: "done" });
    expect(data).toEqual([]);
  });

  test("consumer functions are used as-is", () => {
    const seen = [];
    const set = callbacksNormalize({
      onTextDelta: (e) => seen.push(e.text),
    });
    eventDispatch(set, { type: "text_delta", contentIndex: 0, text: "abc" });
    expect(seen).toEqual(["abc"]);
  });

  test("terminal callbacks complete the binding via onTerminal", () => {
    const order = [];
    const set = callbacksNormalize(
      { onDone: () => order.push("consumer") },
      { onTerminal: (e) => order.push(`terminal:${e.type}`) },
    );
    eventDispatch(set, { type: "done" });
    expect(order).toEqual(["consumer", "terminal:done"]);

    const order2 = [];
    const set2 = callbacksNormalize({}, {
      onTerminal: (e) => order2.push(e.type),
    });
    eventDispatch(set2, { type: "error", error: "x" });
    expect(order2).toEqual(["error"]);
  });

  test("complete set covers every event", () => {
    const set = callbacksNormalize();
    for (const name of Object.values(EventType)) {
      expect(typeof set[eventCallbackName(name)]).toBe("function");
    }
  });
});
