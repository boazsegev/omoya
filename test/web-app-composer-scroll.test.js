import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const start = app.indexOf("function autofit(firstWrite = false)");
const end = app.indexOf("\n/**", start);
if (start < 0 || end < 0) throw new Error("Could not extract autofit");
const source = app.slice(start, end);

function harness({ scrollTop = 300, initialHeight = 300, nextHeight = 250, text = "draft", previousText = text }) {
  const scrollEl = { scrollTop, scrollHeight: 900, clientHeight: initialHeight, getBoundingClientRect: () => ({ top: 0 }) };
  const textareaEl = { value: text, scrollHeight: 220, style: {} };
  Object.defineProperty(textareaEl.style, "height", {
    set(value) {
      if (value === "auto") return;
      scrollEl.clientHeight = nextHeight;
      scrollEl.scrollTop -= initialHeight - nextHeight; // browser anchoring during composer growth
    },
  });
  const fit = new Function("scope", `with (scope) { ${source}; return autofit; }`)({ textareaEl, scrollEl });
  fit(!previousText && !!text);
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

test("input handler captures the empty draft before saving the first write", () => {
  const inputHandler = app.match(/textareaEl\.addEventListener\("input", \(\) => \{([^\n]*)/)?.[1];
  expect(inputHandler).toContain("!composerDraft().text && !!textareaEl.value");
  expect(inputHandler.indexOf("composerDraft().text")).toBeLessThan(inputHandler.indexOf("noteComposerInput()"));
  expect(inputHandler).toContain("autofit(firstWrite)");
});
