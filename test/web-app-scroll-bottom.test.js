// Web transcript scroll-on-load (lib/app/web/public/app.js): switching
// agents and reloading a session must land at the latest message, reusing
// the same stick-to-bottom path that a newly pushed (own/streamed) block
// takes. The nearBottom() check alone cannot do this: a transcript reset
// empties the container, so scrollTop === scrollHeight === 0 would look
// "near the bottom" even when the user had scrolled up.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");

function extract(name, from, to) {
  const start = app.indexOf(from);
  if (start < 0) throw new Error(`app.js no longer defines ${name} (${from})`);
  const end = app.indexOf(to, start);
  if (end < 0) throw new Error(`cannot bound ${name}`);
  return app.slice(start, end);
}

const FLUSH = extract("flushRender", "function flushRender()", "\n/**\n * Show a \"Working\" indicator");
const JUMPS = extract("syncJumpButtons", "function syncJumpButtons()", "\n/**\n * Wrap a rendered block");
const PUSH = extract("pushBlock", "function pushBlock(", "\n");
const SETHISTORY = extract("setHistory", "function setHistory(", "\n/**");

function flushHarness({ scrollTop = 0, scrollHeight = 500, clientHeight = 200 } = {}) {
  const state = { stickBottom: false, resetTranscript: false, fullRender: false };
  const scrollEl = { scrollTop, scrollHeight, clientHeight };
  const jumpBtn = { hidden: true }, jumpTopBtn = { hidden: true };
  const nearBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  const flush = new Function("scope", `with (scope) { ${FLUSH}; return flushRender; }`)({
    get stickBottom() { return state.stickBottom; }, set stickBottom(value) { state.stickBottom = value; },
    get resetTranscript() { return state.resetTranscript; }, set resetTranscript(value) { state.resetTranscript = value; },
    get fullRender() { return state.fullRender; }, set fullRender(value) { state.fullRender = value; },
    frame: 0, frameTimer: 0, transcriptContainer: { replaceChildren() {} }, nodes: [],
    renderMessages() {}, dirty: new Set(), syncWelcome() {}, renderWorkingIndicator() {},
    syncJumpButtons() { jumpBtn.hidden = nearBottom(); jumpTopBtn.hidden = scrollEl.scrollTop < scrollEl.clientHeight; },
    scrollEl, jumpBtn, jumpTopBtn, nearBottom,
    cancelAnimationFrame() {}, clearTimeout() {},
  });
  return { scrollEl, state, flush };
}

function setHistoryHarness(preserveRows) {
  const state = { resetTranscript: false, stickBottom: false, scheduled: 0 };
  const scope = {
    get resetTranscript() { return state.resetTranscript; }, set resetTranscript(value) { state.resetTranscript = value; },
    get stickBottom() { return state.stickBottom; }, set stickBottom(value) { state.stickBottom = value; },
    blocks: [], agent: { busy: false, state: "idle" }, current: null,
    normalizeHistory: (list) => list, scheduleRender: () => state.scheduled++,
  };
  new Function("scope", `with (scope) { ${SETHISTORY}; return setHistory; }`)(scope)([{ kind: "user", text: "hi", done: true }], preserveRows);
  return state;
}

test("a flush with stickBottom lands at the bottom even when nearBottom() is false (agent switch)", () => {
  const view = flushHarness({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 });
  view.state.resetTranscript = true; // hello for a different agent resets the transcript
  view.state.stickBottom = true;
  view.flush();
  expect(view.scrollEl.scrollTop).toBe(view.scrollEl.scrollHeight);
  expect(view.state.stickBottom).toBe(false); // consumed once
});

test("without stickBottom a reset flush does not scroll a scrolled-up view", () => {
  const view = flushHarness({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 });
  view.state.resetTranscript = true;
  view.flush();
  expect(view.scrollEl.scrollTop).toBe(0);
});

test("a full history reload (session resume) sets stickBottom; a same-agent refresh does not", () => {
  expect(setHistoryHarness(false).stickBottom).toBe(true);
  expect(setHistoryHarness(false).resetTranscript).toBe(true);
  expect(setHistoryHarness(true).stickBottom).toBe(false);
  expect(setHistoryHarness(true).resetTranscript).toBe(false);
});

test("syncJumpButtons shows ↑ away from the top and ↓ away from the bottom", () => {
  const cases = [
    [{ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }, { top: true, bottom: false }],
    [{ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 }, { top: false, bottom: false }],
    [{ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }, { top: false, bottom: true }],
  ];
  for (const [scrollEl, want] of cases) {
    const jumpBtn = { hidden: false }, jumpTopBtn = { hidden: false };
    new Function("scope", `with (scope) { ${JUMPS}; return syncJumpButtons; }`)({
      jumpBtn, jumpTopBtn, scrollEl,
      nearBottom: () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80,
    })();
    expect(jumpTopBtn.hidden).toBe(want.top);
    expect(jumpBtn.hidden).toBe(want.bottom);
  }
});

test("pushing a block (own message) arms stickBottom", () => {
  const state = { stickBottom: false, scheduled: 0 };
  const blocks = [];
  new Function("scope", `with (scope) { ${PUSH}; return pushBlock; }`)({
    get stickBottom() { return state.stickBottom; }, set stickBottom(value) { state.stickBottom = value; },
    blocks, touch: () => state.scheduled++,
  })({ kind: "user", text: "hi", done: true });
  expect(state.stickBottom).toBe(true);
  expect(blocks).toHaveLength(1);
  expect(state.scheduled).toBe(1);
});
