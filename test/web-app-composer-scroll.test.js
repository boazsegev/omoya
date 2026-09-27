import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("function autofit()"), app.indexOf("// Typing always exits history"));

function harness({ lastTop, lastBottom, scrollTop = 300, initialHeight = 300, nextHeight = 250 }) {
  const scrollEl = { scrollTop, clientHeight: initialHeight, getBoundingClientRect: () => ({ top: 0 }) };
  const textareaEl = { scrollHeight: 220, style: {} };
  const last = { getBoundingClientRect: () => ({ top: lastTop - scrollEl.scrollTop, bottom: lastBottom - scrollEl.scrollTop }) };
  const nodes = [last];
  Object.defineProperty(textareaEl.style, "height", {
    set(value) {
      if (value === "auto") return;
      scrollEl.clientHeight = nextHeight;
      scrollEl.scrollTop -= initialHeight - nextHeight; // browser anchoring during composer growth
    },
  });
  const fit = new Function("scope", `with (scope) { ${source}; return autofit; }`)({ textareaEl, scrollEl, nodes });
  fit();
  return scrollEl.scrollTop;
}

test("composer growth leaves scroll position alone when the last message remains partly visible", () => {
  expect(harness({ lastTop: 510, lastBottom: 680 })).toBe(300);
});

test("composer growth leaves scroll position alone when the last message is fully visible", () => {
  expect(harness({ lastTop: 340, lastBottom: 490 })).toBe(300);
});

test("composer growth permits scrolling when the last message falls below the viewport", () => {
  expect(harness({ lastTop: 570, lastBottom: 680 })).toBe(250);
});
