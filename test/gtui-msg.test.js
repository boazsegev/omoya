// test/gtui-msg.test.js — proof for lib/gtui/msg.js: DEAD CODE (see
// AI-GTUI.md) — the Msg/Cmd/Sub plain-object contracts.
import { describe, expect, test } from "bun:test";
import { msg, cmd, NONE, batchCmds, sub } from "../lib/gtui/msg.js";

describe("msg/cmd/sub: plain tagged objects", () => {
  test("msg() tags a payload with its type", () => {
    expect(msg("inc", { by: 2 })).toEqual({ type: "inc", by: 2 });
    expect(msg("tick")).toEqual({ type: "tick" });
  });
  test("cmd() wraps a run() side effect verbatim", () => {
    const run = async () => null;
    expect(cmd(run)).toEqual({ run });
  });
  test("sub() tags a payload with its id", () => {
    expect(sub("wave", { ms: 50 })).toEqual({ id: "wave", ms: 50 });
  });
});

describe("batchCmds", () => {
  test("no cmds (all NONE): NONE", () => {
    expect(batchCmds([NONE, NONE])).toBe(NONE);
    expect(batchCmds([])).toBe(NONE);
  });
  test("one surviving cmd: returned unwrapped (no needless batching)", () => {
    const one = cmd(async () => msg("x"));
    expect(batchCmds([NONE, one])).toBe(one);
  });
  test("several cmds: one Cmd whose run() flattens every result", async () => {
    const a = cmd(async () => msg("a"));
    const b = cmd(async () => [msg("b1"), msg("b2")]);
    const c = cmd(async () => null); // contributes nothing
    const batched = batchCmds([a, b, c]);
    const results = await batched.run();
    expect(results).toEqual([msg("a"), msg("b1"), msg("b2")]);
  });
});
