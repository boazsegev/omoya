// test/base-events.test.js — proof for lib/events.js
import { describe, expect, test, mock } from "bun:test";
import {
  EventType,
  callbackName,
  isResponseEvent,
  validateResponseEvent,
  normalizeCallbacks,
  dispatch,
} from "../lib/context.js";

describe("event vocabulary", () => {
  test("full normalized vocabulary", () => {
    expect(Object.values(EventType)).toEqual([
      "start",
      "text_start", "text_delta", "text_end",
      "thinking_start", "thinking_delta", "thinking_end",
      "toolcall_start", "toolcall_delta", "toolcall_end",
      "done", "error",
    ]);
  });

  test("camelCase callback mapping", () => {
    expect(callbackName("start")).toBe("onStart");
    expect(callbackName("text_delta")).toBe("onTextDelta");
    expect(callbackName("thinking_end")).toBe("onThinkingEnd");
    expect(callbackName("toolcall_start")).toBe("onToolcallStart");
    expect(callbackName("done")).toBe("onDone");
    expect(callbackName("error")).toBe("onError");
  });
});

describe("isResponseEvent / validateResponseEvent", () => {
  test("accepts well-formed events", () => {
    expect(isResponseEvent({ type: "start" })).toBe(true);
    expect(isResponseEvent({ type: "text_delta", contentIndex: 0, text: "a" })).toBe(true);
    expect(isResponseEvent({ type: "done", message: { type: 3, content: [] } })).toBe(true);
  });

  test("indexed events must carry a non-negative integer contentIndex", () => {
    expect(isResponseEvent({ type: "text_start" })).toBe(false);
    expect(isResponseEvent({ type: "toolcall_end", contentIndex: "0" })).toBe(false);
    expect(isResponseEvent({ type: "text_delta", contentIndex: Number.NaN })).toBe(false);
    expect(isResponseEvent({ type: "text_delta", contentIndex: 0.5 })).toBe(false);
    expect(isResponseEvent({ type: "text_delta", contentIndex: -1 })).toBe(false);
  });

  test("unknown event types rejected", () => {
    expect(isResponseEvent({ type: "message" })).toBe(false);
    expect(isResponseEvent(null)).toBe(false);
    expect(isResponseEvent("done")).toBe(false);
    expect(() => validateResponseEvent({ type: "bogus" })).toThrow(/invalid response event/);
  });
});

describe("normalizeCallbacks routing", () => {
  test("missing callbacks default to onData", () => {
    const data = [];
    const set = normalizeCallbacks({}, { onData: (e) => data.push(e) });
    dispatch(set, { type: "start" });
    dispatch(set, { type: "text_delta", contentIndex: 0, text: "hi" });
    expect(data.map((e) => e.type)).toEqual(["start", "text_delta"]);
  });

  test("onError default also reports through onLog", () => {
    const data = [];
    const logs = [];
    const set = normalizeCallbacks({}, {
      onData: (e) => data.push(e),
      onLog: (l) => logs.push(l),
    });
    dispatch(set, { type: "error", error: "boom" });
    expect(data).toHaveLength(1);
    expect(logs).toEqual(["boom"]);
  });

  test("explicit false/null selects no-op", () => {
    const data = [];
    const set = normalizeCallbacks(
      { onTextDelta: false, onDone: null },
      { onData: (e) => data.push(e) },
    );
    dispatch(set, { type: "text_delta", contentIndex: 0, text: "x" });
    dispatch(set, { type: "done" });
    expect(data).toEqual([]);
  });

  test("consumer functions are used as-is", () => {
    const seen = [];
    const set = normalizeCallbacks({
      onTextDelta: (e) => seen.push(e.text),
    });
    dispatch(set, { type: "text_delta", contentIndex: 0, text: "abc" });
    expect(seen).toEqual(["abc"]);
  });

  test("terminal callbacks complete the binding via onTerminal", () => {
    const order = [];
    const set = normalizeCallbacks(
      { onDone: () => order.push("consumer") },
      { onTerminal: (e) => order.push(`terminal:${e.type}`) },
    );
    dispatch(set, { type: "done" });
    expect(order).toEqual(["consumer", "terminal:done"]);

    const order2 = [];
    const set2 = normalizeCallbacks({}, {
      onTerminal: (e) => order2.push(e.type),
    });
    dispatch(set2, { type: "error", error: "x" });
    expect(order2).toEqual(["error"]);
  });

  test("complete set covers every event", () => {
    const set = normalizeCallbacks();
    for (const name of Object.values(EventType)) {
      expect(typeof set[callbackName(name)]).toBe("function");
    }
  });
});
