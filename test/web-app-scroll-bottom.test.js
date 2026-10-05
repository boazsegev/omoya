import { expect, test } from "bun:test";
import { historyScrollFlags, isNearBottom, jumpVisibility, shouldStickToBottom, appendTranscriptBlock } from "../lib/app/web/public/app/logic/transcript-scroll.js";

test("a reset lands at bottom only when explicitly armed", () => {
  expect(shouldStickToBottom({ stickBottom: true, resetTranscript: true }, false)).toBe(true);
  expect(shouldStickToBottom({ stickBottom: false, resetTranscript: true }, true)).toBe(false);
  expect(shouldStickToBottom({ stickBottom: false, resetTranscript: false }, true)).toBe(true);
});

test("full history reload arms reset and bottom; same-agent refresh preserves rows", () => {
  expect(historyScrollFlags(false)).toEqual({ resetTranscript: true, stickBottom: true });
  expect(historyScrollFlags(true)).toEqual({ resetTranscript: false, stickBottom: false });
});

test("jump buttons show oldest away from top and latest away from bottom", () => {
  expect(jumpVisibility({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 })).toEqual({ topHidden: true, bottomHidden: false });
  expect(jumpVisibility({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 })).toEqual({ topHidden: false, bottomHidden: false });
  expect(jumpVisibility({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toEqual({ topHidden: false, bottomHidden: true });
});

test("pushing a user message arms stickBottom and schedules its render", () => {
  const state = { stickBottom: false, blocks: [] };
  const touched = [];
  const block = { kind: "user", text: "hi", done: true };
  appendTranscriptBlock(state, block, (item) => touched.push(item));
  expect(state.stickBottom).toBe(true);
  expect(state.blocks).toEqual([block]);
  expect(touched).toEqual([block]);
});

for (const kind of ["tool", "text", "thinking", "error", "command", "system"]) {
  test(`appending ${kind} preserves reading position but follows the bottom magnet`, () => {
    const state = { stickBottom: false, resetTranscript: false, blocks: [] };
    const block = { kind, text: "incoming" };
    const touched = [];
    appendTranscriptBlock(state, block, (item) => touched.push(item));
    expect(shouldStickToBottom(state, false)).toBe(false);
    expect(shouldStickToBottom(state, true)).toBe(true);
    expect(state.blocks).toEqual([block]);
    expect(touched).toEqual([block]);
  });
}

test("a tool block does not cancel an explicit history or user-message jump", () => {
  const state = { stickBottom: true, blocks: [] };
  appendTranscriptBlock(state, { kind: "tool" }, () => {});
  expect(shouldStickToBottom(state, false)).toBe(true);
});

test("bottom magnet follows geometry at render time, including scrolling away and back", () => {
  const state = { stickBottom: false, resetTranscript: false, blocks: [] };
  const scroll = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  appendTranscriptBlock(state, { kind: "tool" }, () => {});
  for (const [top, expected] of [[800, true], [721, true], [720, false], [100, false], [799.5, true]]) {
    scroll.scrollTop = top;
    expect(shouldStickToBottom(state, isNearBottom(scroll))).toBe(expected);
    expect(jumpVisibility(scroll).bottomHidden).toBe(expected);
  }
  expect(isNearBottom(null)).toBe(true);
  expect(isNearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 })).toBe(true);
});
