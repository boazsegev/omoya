import { expect, test } from "bun:test";
import Agent from "../lib/agent.js";
import { createApp } from "../lib/app/tui/app.js";
import { viewerTitle } from "../lib/app/tui/overlay-view.js";
import { toolCatalogText } from "../lib/app/shared/tool-catalog.js";
import { testEnv, USER } from "./fakes.js";

const key = (app, model, value) => app.update(model, { type: "key", key: value });
async function complete(app, result) {
  let model = result.model;
  for (const task of result.effects.filter((item) => item.key === "viewer.tools")) {
    const messages = [];
    await task.run({ send: (message) => messages.push(message), signal: new AbortController().signal });
    for (const message of messages) model = app.update(model, message).model;
  }
  return model;
}

test("TUI catalog precedes real system blocks without entering the transcript or context", async () => {
  const env = await testEnv();
  env.toolAdd("reader", () => "ok", { safe: true, description: "Read", inputSchema: { type: "object" } });
  const agent = await Agent.create({ env, can: { write: false } });
  agent.context.append({ type: 1, content: [{ type: "text", text: "real system" }] });
  agent.context.append(USER("hello"));
  const app = createApp(agent, { env });
  const initial = app.init().model;
  try {
    expect(JSON.stringify(app.view(initial))).not.toContain("Published tools");
    let model = await complete(app, key(app, initial, "ctrl+o"));
    expect(model.overlay.index).toBe(2);
    model = key(app, model, "left").model;
    expect(key(app, model, "c").effects[0].text).toBe("real system");
    model = key(app, model, "left").model;
    const copied = key(app, model, "c").effects[0].text;
    const tools = await agent.tools;
    expect(tools).toBeInstanceOf(Map);
    expect(Array.isArray(tools)).toBe(false);
    expect(copied).toBe(toolCatalogText(tools));
    expect(copied).toContain("## `reader`\n\nRead\n\n```json\n{");
    expect(copied).toContain(JSON.stringify(tools.get("reader"), null, 2));
    expect(JSON.stringify(app.view(model))).toContain("virtual system block");
    expect(agent.context.messages().map((message) => message.content[0].text)).toEqual(["real system", "hello"]);
    model = key(app, model, "escape").model;
    expect(JSON.stringify(app.view(model))).not.toContain("Published tools");
  } finally { await agent.close(); }
});

test("TUI publication refreshes on reopen, filters/searches, and rejects stale safety results", async () => {
  const env = await testEnv();
  const agent = await Agent.create({ env, can: { write: false } });
  const app = createApp(agent, { env });
  try {
    let model = await complete(app, key(app, app.init().model, "ctrl+o"));
    expect(key(app, model, "c").effects[0].text).toContain("Published tools (1)");
    model = key(app, model, "escape").model;
    env.toolAdd("late", () => "ok", { safe: true, description: "Late reader", inputSchema: { type: "object" } });
    model = await complete(app, key(app, model, "ctrl+o"));
    expect(key(app, model, "c").effects[0].text).toContain('"name": "late"');
    model = { ...model, overlay: { ...model.overlay, filters: ["system"], search: "late" } };
    expect(key(app, model, "c").effects).toHaveLength(1);
    const oldRequest = model.toolCatalog.request;
    agent.model = "p/m";
    const changed = key(app, model, "left");
    expect(changed.effects.some((task) => task.key === "viewer.tools")).toBe(true);
    expect(app.update(changed.model, { type: "viewer.tools.ready", request: oldRequest, text: "STALE" }).model.toolCatalog.text).not.toBe("STALE");
    model = await complete(app, changed);
    expect(model.toolCatalog.selector).toBe("p/m");
  } finally { await agent.close(); }
});

test("TUI agent switching discards the previous catalog and late viewer task results", async () => {
  const env = await testEnv();
  env.toolAdd("one", () => "ok", { safe: true, description: "one", inputSchema: {} });
  env.toolAdd("two", () => "ok", { safe: true, description: "two", inputSchema: {} });
  const first = await Agent.create({ env, tools: ["one"], can: { write: false } });
  const second = await Agent.create({ env, tools: ["two"], can: { write: false } });
  const app = createApp(first, { env });
  try {
    let model = await complete(app, key(app, app.init().model, "ctrl+o"));
    const request = model.toolCatalog.request;
    expect(model.toolCatalog.text).toContain('"name": "one"');
    model = key(app, model, "alt+ctrl+right").model;
    expect(app.currentAgent()).toBe(second);
    expect(model.toolCatalog).toBeUndefined();
    model = await complete(app, key(app, model, "ctrl+o"));
    model = app.update(model, { type: "viewer.tools.ready", request, text: "OLD AGENT" }).model;
    expect(model.toolCatalog.text).toContain('"name": "two"');
    expect(model.toolCatalog.text).not.toContain("OLD AGENT");
  } finally { await first.close(); await second.close(); }
});

test("TUI catalog errors are visible and virtual fork preserves all real messages", async () => {
  const env = await testEnv();
  const agent = await Agent.create({ env, can: { write: false } });
  agent.context.append(USER("keep"));
  Object.defineProperty(agent, "tools", { get: () => Promise.reject(new Error("catalog failed")) });
  const app = createApp(agent, { env });
  try {
    let model = await complete(app, key(app, app.init().model, "ctrl+o"));
    model = key(app, model, "left").model;
    expect(key(app, model, "c").effects[0].text).toContain("catalog failed");
    key(app, model, "alt+shift+f");
    expect(agent.context.messages().map((message) => message.content[0].text)).toEqual(["keep"]);
    expect(viewerTitle({ type: "system", label: "Tools", virtual: true, message: -1 }, 0, 2)).toContain("virtual system block");
  } finally { await agent.close(); }
});
