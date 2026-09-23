// test/base-signals.test.js — proof for lib/signals.js
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { armCancelSignals } from "../lib/cli.js";
import { createAssembler } from "../lib/context.js";

const fakeProc = () => new EventEmitter();

describe("armCancelSignals", () => {
  test("invokes onCancel with the caught signal", () => {
    const proc = fakeProc();
    const seen = [];
    armCancelSignals({ onCancel: (s) => seen.push(s), process: proc });
    proc.emit("SIGINT");
    expect(seen).toEqual(["SIGINT"]);
  });

  test("fires exactly once across both signals", () => {
    const proc = fakeProc();
    const seen = [];
    armCancelSignals({ onCancel: (s) => seen.push(s), process: proc });
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    proc.emit("SIGTERM");
    expect(seen).toEqual(["SIGTERM"]);
  });

  test("disarm removes the listeners (and is idempotent)", () => {
    const proc = fakeProc();
    const seen = [];
    const disarm = armCancelSignals({ onCancel: (s) => seen.push(s), process: proc });
    disarm();
    disarm();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    proc.emit("SIGINT");
    expect(seen).toEqual([]);
  });

  test("requires an onCancel function", () => {
    expect(() => armCancelSignals({})).toThrow(/onCancel must be a function/);
  });
});

describe("partial-assembly contract (cancellation)", () => {
  test("the assembler holds the partial assistant message when cancel lands mid-stream", () => {
    // Contract per Decisions: Context assembles the partial; Agent
    // persists it. aiio.kill() itself is built in AI-IO on top of this.
    const proc = fakeProc();
    const assembler = createAssembler();
    assembler.consume({ type: "start" });
    assembler.consume({ type: "text_start", contentIndex: 0 });
    assembler.consume({ type: "text_delta", contentIndex: 0, text: "half an ans" });

    let persisted = null;
    armCancelSignals({
      process: proc,
      onCancel: () => { persisted = assembler.message(); },
    });
    proc.emit("SIGINT");

    expect(persisted).toEqual({
      type: 3,
      content: [{ type: "text", text: "half an ans" }],
    });
  });
});
