import { expect, test } from "bun:test";
import { autofitComposer, isFirstComposerWrite } from "../lib/app/web/public/app/logic/composer-scroll.js";

function harness({ scrollTop = 300, initialHeight = 300, nextHeight = 250, text = "draft", previousText = text }) {
  const scrollEl = { scrollTop, scrollHeight: 900, clientHeight: initialHeight };
  const textareaEl = { value: text, scrollHeight: 220, style: {} };
  Object.defineProperty(textareaEl.style, "height", {
    set(value) {
      if (value === "auto") return;
      scrollEl.clientHeight = nextHeight;
      scrollEl.scrollTop -= initialHeight - nextHeight;
    },
  });
  autofitComposer(textareaEl, scrollEl, isFirstComposerWrite(previousText, text));
  return scrollEl.scrollTop;
}

test("composer growth leaves the current transcript position alone for an existing draft", () => {
  expect(harness({})).toBe(300);
});
test("composer growth preserves a position near the top for an existing draft", () => {
  expect(harness({ scrollTop: 120 })).toBe(120);
});
test("composer growth preserves an earlier reading position for a long draft", () => {
  expect(harness({ scrollTop: 80 })).toBe(80);
});
test("composer first write goes to the bottom", () => {
  expect(harness({ previousText: "" })).toBe(900);
});
test("editing an existing draft does not jump even if the dock does not grow", () => {
  expect(harness({ scrollTop: 80, nextHeight: 300 })).toBe(80);
});
test("clearing the draft does not jump", () => {
  expect(harness({ text: "", previousText: "draft" })).toBe(300);
});
test("first-write detection precedes recording the new text", () => {
  expect(isFirstComposerWrite("", "a")).toBe(true);
  expect(isFirstComposerWrite("a", "ab")).toBe(false);
  expect(isFirstComposerWrite("a", "")).toBe(false);
});
