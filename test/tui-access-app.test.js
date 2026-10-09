import { expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { createApp } from "../lib/app/tui/app.js";
import { Context } from "../lib/context.js";
import Env from "../lib/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FORM_INPUT_PREFIX, FORM_MENU_ID } from "../lib/app/tui/form.js";
import { scriptedIO, testEnv } from "./fakes.js";

const tick = () => new Promise((done) => setImmediate(done));
async function until(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return true; await Bun.sleep(5); }
  return check();
}
async function harness() {
  const env = await testEnv();
  const agent = await Agent.create({ env, model: "p/m", context: [Context.messageUser("original")], createIO: () => scriptedIO([[{ type: "done" }]]) });
  const app = createApp(agent, { env });
  let latest;
  const update = app.update;
  app.update = (model, message) => { const result = update(model, message); latest = result.model; return result; };
  const memory = GTUI.host.memory({ width: 80, height: 20 });
  const ui = new GTUI({ host: memory });
  const running = ui.run(app);
  return { env, agent, app, memory, ui, model: () => latest, async close() { ui.stop(); await running; await app.closeWorkspace(); await env.close(); } };
}
function pick(ui, value) { ui.dispatch({ type: "menu.select", id: "overlay-menu", item: { kind: "action", label: value.type, value } }); }
function save(ui) { ui.dispatch({ type: "menu.select", id: FORM_MENU_ID, item: { value: { type: "form.submit" } } }); }

test("Ctrl+X exposes routine actions directly and searches nested settings by typing", async () => {
  const h = await harness();
  try {
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    await tick();
    const root = h.model().overlay.stack[0].items.map((item) => item.label);
    expect(root).toContain("Projects");
    expect(root).toContain("Saved sessions");
    expect(root).toContain("Agent settings");
    expect(h.memory.snapshot().lines.join("\n")).toContain("Themes");
    h.memory.send(GTUI.event.key({ key: "t", text: "t" }));
    h.memory.send(GTUI.event.key({ key: "h", text: "h" }));
    h.memory.send(GTUI.event.key({ key: "i", text: "i" }));
    h.memory.send(GTUI.event.key({ key: "n", text: "n" }));
    h.memory.send(GTUI.event.key({ key: "k", text: "k" }));
    await tick();
    expect(h.memory.snapshot().lines.join("\n")).toContain("thinking:");
  } finally { await h.close(); }
});

test("endpoint policy refresh preserves direct capacity forms instead of restoring a fourth menu", async () => {
  const h = await harness();
  try {
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.settings.endpoints" });
    pick(h.ui, { type: "endpoint-policy", endpoint: "p" });
    expect(h.model().overlay.stack).toHaveLength(3);
    const toggle = h.model().overlay.stack.at(-1).items.find((row) => row.value?.type === "endpoint-policy.set");
    expect(toggle).toBeDefined();
    pick(h.ui, toggle.value);
    const items = h.model().overlay.stack.at(-1).items;
    expect(items.some((row) => row.value?.type === "max-active-menu")).toBe(false);
    const capacity = items.find((row) => row.value?.type === "access.endpoint.max");
    expect(capacity).toBeDefined();
    pick(h.ui, capacity.value);
    expect(h.model().overlay).toMatchObject({ type: "form", title: "Endpoint maximum active", busy: false });
  } finally { await h.close(); }
});

test("viewer actions edit without mutating until Save and cancellation preserves the message", async () => {
  const h = await harness();
  try {
    h.ui.dispatch({ type: "key", key: "ctrl+o" });
    h.ui.dispatch({ type: "key", key: "a" });
    await tick();
    expect(h.memory.snapshot().lines.join("\n")).toContain("Edit");
    pick(h.ui, { type: "access.context.edit", agent: h.agent, block: { type: "user", message: 0, contentIndex: 0 }, viewer: { type: "viewer", index: 1, offset: 0 } });
    await tick();
    expect(h.memory.snapshot().lines.join("\n")).toContain("original");
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "text", value: "draft", caret: 5 });
    expect(h.agent.context.at(0).content[0].text).toBe("original");
    h.ui.dispatch({ type: "key", key: "escape" });
    expect(h.agent.context.at(0).content[0].text).toBe("original");
    h.ui.dispatch({ type: "agent.submit", text: "/context-edit 0" });
    expect(await until(() => h.memory.snapshot().lines.join("\n").includes("Message text"))).toBe(true);
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "text", value: "saved", caret: 5 });
    save(h.ui);
    expect(await until(() => h.agent.context.at(0).content[0].text === "saved")).toBe(true);
  } finally { await h.close(); }
});

test("project navigation keeps the previous view on an invalid open and preserves its draft", async () => {
  const h = await harness();
  try {
    h.ui.dispatch({ type: "input.change", id: "draft", value: "keep this", caret: 9 });
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.project.open" });
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "path", value: "definitely-missing-project", caret: 26 });
    save(h.ui);
    expect(await until(() => /does not exist|directory|failed/i.test(h.memory.snapshot().lines.join("\n")))).toBe(true);
    expect(h.app.currentAgent()).toBe(h.agent);
    h.memory.send(GTUI.event.key({ key: "escape" }));
    h.memory.send(GTUI.event.key({ key: "escape" }));
    await tick();
    expect(h.memory.snapshot().lines.join("\n")).toContain("keep this");
  } finally { await h.close(); }
});

test("opening and managing a project preserves the prior agent and does not silently pin", async () => {
  const h = await harness();
  const target = join(h.env.folder, "other-project");
  await mkdir(target);
  await writeFile(join(target, "ai-settings.json"), JSON.stringify({ providers: { target: { provider: "test", url: "test://script" } } }));
  try {
    h.ui.dispatch({ type: "input.change", id: "draft", value: "project A draft", caret: 15 });
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.project.select", path: target });
    expect(await until(() => h.app.currentAgent().env.folder === target)).toBe(true);
    const selected = h.app.currentAgent();
    expect(h.agent.closed).toBe(false);
    expect(Env.settings.projects[target]).toBeUndefined();
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.project.group.new", path: target });
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "group", value: "team", caret: 4 });
    save(h.ui);
    expect(await until(() => Env.settings.projects[target]?.groups?.team === true && h.model()?.overlay?.type === "menu")).toBe(true);
    h.memory.send(GTUI.event.key({ key: "escape" }));
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "agent.switch", agent: h.agent });
    expect(h.app.currentAgent()).toBe(h.agent);
    expect(selected.closed).toBe(false);
    expect(h.memory.snapshot().lines.join("\n")).toContain("project A draft");
  } finally { delete Env.settings.projects[target]; await Env.settingsFlush(); await h.close(); }
});

test("saved-session rename and delete work offline through the TUI without replacing the current agent", async () => {
  const h = await harness();
  const context = new Context({ id: "offline-before", dir: h.env.settings.sessions, origin: h.env.folder });
  context.append(Context.messageUser("offline preview"));
  await context.close();
  try {
    const session = (await Context.listAsync({ dir: h.env.settings.sessions, cwd: h.env.folder })).find(({ id }) => id === "offline-before");
    Object.assign(session, { env: h.env, dir: h.env.settings.sessions, project: h.env.folder, projectName: h.env.name, live: null });
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.session.rename", session });
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "name", value: "offline-after", caret: 13 });
    save(h.ui);
    expect(await until(() => h.model()?.overlay?.type === "menu" && Context.fileOf({ id: "offline-after", dir: h.env.settings.sessions }))).toBe(true);
    expect(h.app.currentAgent()).toBe(h.agent);
    pick(h.ui, { type: "access.session.delete", session: { ...session, id: "offline-after" } });
    expect(Context.fileOf({ id: "offline-after", dir: h.env.settings.sessions })).toBeTruthy();
    save(h.ui);
    expect(await until(() => !Context.fileOf({ id: "offline-after", dir: h.env.settings.sessions }))).toBe(true);
    expect(h.app.currentAgent()).toBe(h.agent);
  } finally { await h.close(); }
});

test("session-resume command reuses the live writer instead of creating another", async () => {
  const h = await harness();
  const live = await Agent.create({ env: h.env, model: "p/m", contextId: "already-live", createIO: () => scriptedIO([[{ type: "done" }]]) });
  live.context.append(Context.messageUser("saved"));
  live.context.flush();
  try {
    const before = h.env.agents().length;
    h.ui.dispatch({ type: "agent.submit", text: "/session-resume already-live" });
    expect(await until(() => h.app.currentAgent() === live)).toBe(true);
    expect(h.env.agents()).toHaveLength(before);
    expect(h.agent.closed).toBe(false);
  } finally { await live.close(); await h.close(); }
});

test("custom endpoint limit validates inline and applies to the captured endpoint", async () => {
  const h = await harness();
  try {
    h.ui.dispatch({ type: "key", key: "ctrl+x" });
    pick(h.ui, { type: "access.endpoint.max", selector: "p", value: undefined, effective: 3 });
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "maxActive", value: "-1", caret: 2 });
    save(h.ui);
    expect(await until(() => /whole|integer|non-negative|≥/i.test(h.memory.snapshot().lines.join("\n")))).toBe(true);
    h.ui.dispatch({ type: "input.change", id: FORM_INPUT_PREFIX + "maxActive", value: "5", caret: 1 });
    save(h.ui);
    expect(await until(() => h.env.settings.providers.p.maxActive === 5)).toBe(true);
  } finally { await h.close(); }
});
