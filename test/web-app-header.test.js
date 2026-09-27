import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const headerSource = source.slice(source.indexOf("function updateHeader() {"), source.indexOf("const shortId =", source.indexOf("function updateHeader() {")));

function runHeader(throttledUntil) {
  const attributes = {};
  const state = { replaceChildren() {}, setAttribute(key, value) { attributes[key] = value; }, append() {} };
  const identity = { replaceChildren() {}, append() {} };
  const document = { querySelector: (selector) => selector === "#identity" ? identity : state, title: "" };
  const updateHeader = new Function("document", "ws", "WebSocket", "aggregateAgentState", "el", "agentList", "throttledUntil", "updateAppearanceSwitch", "button", "agent", "settings", "shortId", "stopBtn", "sendBtn", `${headerSource}; return updateHeader;`)(
    document, { readyState: 1 }, { OPEN: 1 }, () => "idle", () => ({}), () => [], throttledUntil,
    () => {}, () => ({}), null, { sessionSave: false }, () => "", null, null,
  );
  updateHeader();
  return { attributes, state };
}

test("header reports readiness before a throttle countdown is available", () => {
  expect(runHeader(null).attributes["aria-label"]).toBe("Connection: Ready");
});

test("header includes a pending throttle countdown in its accessible label", () => {
  const result = runHeader(Date.now() + 5000);
  expect(result.attributes["aria-label"]).toMatch(/^Connection: Ready · continuing in [45]s$/);
  expect(result.state.title).toContain("continuing in");
});
