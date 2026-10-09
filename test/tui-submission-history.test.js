import { expect, test } from "bun:test";
import { createApp } from "../lib/app/tui/app.js";
import { Context } from "../lib/context.js";

function stubAgent() {
  return { can: { write: true }, context: new Context({ id: "history-test", messages: [] }), pending: [], model: "test/model", toolMessages: () => [], contextUsage: {}, usage: {}, thinking: "high", env: { prompts: () => new Map(), tools: async () => new Map() } };
}

test("an invalid slash prompt is recalled unchanged after submission", () => {
  const app = createApp(stubAgent(), { sources: {} });
  const initial = app.init().model;
  const submitted = app.update(initial, { type: "input.submit", value: "/team long prompt\nwith important details" }).model;
  const recalled = app.update(submitted, { type: "key", key: "up" }).model;
  expect(recalled.input.value).toBe("/team long prompt\nwith important details");
  const restored = app.update(recalled, { type: "key", key: "down" }).model;
  expect(restored.input.value).toBe("");
});
