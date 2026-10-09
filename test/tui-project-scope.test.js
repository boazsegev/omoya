import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Env from "../lib/env.js";
import Agent from "../lib/agent.js";
import { createApp } from "../lib/app/tui/app.js";

async function fixture() {
  const root = resolve(mkdtempSync("./ai-tmp/tui-scope-"));
  for (const [name, theme] of [["a", "launch"], ["b", "viewed"]]) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "ai-settings.json"), JSON.stringify({ providers: { [name]: { provider: "test", url: "test://script" } }, tui: { theme } }));
  }
  const first = await Env.open(join(root, "a"));
  const second = await Env.open(join(root, "b"));
  const a = await Agent.create({ env: first, model: "a/test-model", context: [] });
  const b = await Agent.create({ env: second, model: "b/test-model", context: [] });
  return { first, second, a, b };
}
function choose(app, model, value) {
  const opened = app.update(model, { type: "key", key: "ctrl+x" }).model;
  return app.update(opened, { type: "menu.select", id: "overlay-menu", item: { value } }).model;
}

test("switching projects applies themes to the viewed project, not the launch project", async () => {
  const { first, second, a, b } = await fixture();
  const app = createApp(a, { env: first, cwd: first.folder });
  try {
    let model = choose(app, app.init().model, { type: "agent.switch", agent: b });
    model = choose(app, model, { type: "theme.set", value: "default" });
    expect(app.currentAgent()).toBe(b);
    expect(first.settings.tui.theme).toBe("launch");
    expect(second.settings.tui.theme).toBe("default");
  } finally { app.dispose(); await Promise.all([a.close(), b.close()]); await Promise.all([first.close(), second.close()]); }
});

test("switching agents preserves each draft and transcript scroll without leaking completions", async () => {
  const { first, second, a, b } = await fixture();
  const app = createApp(a, { env: first });
  try {
    let model = app.init().model;
    model = app.update(model, { type: "input.change", id: "draft", value: "draft A", caret: 7 }).model;
    model = app.update(model, { type: "scroll.change", id: "transcript", offset: 9 }).model;
    model = choose(app, model, { type: "agent.switch", agent: b });
    expect(model.input.value).toBe("");
    model = app.update(model, { type: "input.change", id: "draft", value: "draft B", caret: 7 }).model;
    model = choose(app, model, { type: "agent.switch", agent: a });
    expect(model.input.value).toBe("draft A");
    expect(model.input.completions).toEqual([]);
    expect(model.transcriptOffset).toBe(9);
    model = choose(app, model, { type: "agent.switch", agent: b });
    expect(model.input.value).toBe("draft B");
  } finally { app.dispose(); await Promise.all([a.close(), b.close()]); await Promise.all([first.close(), second.close()]); }
});

test("path completion captures the viewed agent folder before asynchronous work", async () => {
  const { first, second, a, b } = await fixture();
  const requests = [];
  const app = createApp(a, { env: first, completionIO: { listDir: async (dir, options) => { requests.push({ dir, folder: options?.cwd }); return []; } } });
  try {
    let model = choose(app, app.init().model, { type: "agent.switch", agent: b });
    model = app.update(model, { type: "input.change", id: "draft", value: "./fi", caret: 4 }).model;
    const transition = app.update(model, { type: "key", key: "tab" });
    const task = transition.effects.find((value) => value.type === "task");
    expect(task).toBeDefined();
    await task.run({ send() {}, signal: new AbortController().signal });
    expect(requests).toEqual([{ dir: ".", folder: second.folder }]);
  } finally { app.dispose(); await Promise.all([a.close(), b.close()]); await Promise.all([first.close(), second.close()]); }
});

test("background questions survive switching and timeouts only dismiss their origin", async () => {
  const { first, second, a, b } = await fixture();
  const app = createApp(a, { env: first });
  try {
    const questions = [{ header: "Origin B", question: "Pick", options: [{ label: "Yes", description: "yes" }, { label: "No", description: "no" }] }];
    let model = app.update(app.init().model, { type: "agent.question.opened", requestId: "B", questions, origin: b }).model;
    expect(model.question).toBeNull();
    model = choose(app, model, { type: "agent.switch", agent: b });
    expect(model.question.requestId).toBe("B");
    model = app.update(model, { type: "agent.question.timed-out", origin: a }).model;
    expect(model.question.requestId).toBe("B");
    model = app.update(model, { type: "agent.question.timed-out", origin: b }).model;
    expect(model.question).toBeNull();
  } finally { app.dispose(); await Promise.all([a.close(), b.close()]); await Promise.all([first.close(), second.close()]); }
});
