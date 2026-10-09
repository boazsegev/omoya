/** Private access execution contracts. Tasks are driven directly, never through real tools/network. */
import { describe, expect, test } from "bun:test";
import Env from "../lib/env.js";
import { MessageType, ContentType } from "../lib/context.js";
import { createAccessController } from "../lib/app/tui/access-controller.js";
import { formView, FORM_INPUT_PREFIX } from "../lib/app/tui/form.js";
import { openMenu } from "../lib/app/tui/overlay-controller.js";

const key = (name) => ({ type: "key", key: name });
const change = (name, value) => ({ type: "input.change", id: FORM_INPUT_PREFIX + name, value });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function environment(folder = "/alpha") {
  return {
    folder, name: folder.split("/").pop() || folder, settings: { providers: { endpoint: { models: { model: { keep: true } } } } },
    models: () => new Map([["endpoint/model", { endpoint: "endpoint", model: "model", listed: true }]]),
    async settingsFlush() {},
  };
}

function agent(env = environment(), name = "alpha") {
  return { env, name, model: "endpoint/model", can: { write: false }, context: { id: "saved", save: true, async flush() {} } };
}

function fixture(overrides = {}) {
  const initial = agent();
  let current = initial;
  const calls = [];
  let projects = [{ path: initial.env.folder, env: initial.env, name: "Alpha", current: true, open: true, groups: [] }];
  const workspace = {
    projects: () => projects,
    remember: (target) => { calls.push(["remember", target]); return target; },
    own: (target) => { calls.push(["own", target]); return target; },
    enroll: (target) => { calls.push(["enroll", target]); return target; },
    async open(path) { calls.push(["open", path]); return environment(path); },
    async select(path) { calls.push(["select", path]); return agent(environment(path)); },
    async add(options) { calls.push(["add", options]); return agent(options.env, "added"); },
    pin(...args) { calls.push(["pin", ...args]); },
    describe(...args) { calls.push(["describe", ...args]); },
    group(...args) { calls.push(["group", ...args]); },
    async closeProject(path) { calls.push(["closeProject", path]); return agent(environment("/other")); },
    async sessions() { calls.push(["sessions"]); return []; },
    async resume(record) { calls.push(["resume", record]); return record.live ?? agent(record.env); },
    async renameSession(...args) { calls.push(["renameSession", ...args]); },
    async deleteSession(record) { calls.push(["deleteSession", record]); },
    ...overrides,
  };
  const controller = createAccessController({
    workspace, getAgent: () => current, getEnv: () => current.env,
    getOptions: () => ({ agent: current, currentEnv: current.env, projects, agents: [], savedSessions: [] }),
    runCommandEffect: (lines) => { calls.push(["command", lines, current]); return { type: "command", lines }; },
    copyEffect: (text) => ({ type: "copy", text }),
    openContext: (model, index, blockIndex) => ({ model: { ...model, overlay: { type: "viewer", index, blockIndex } }, effects: [] }),
    runTool: async (...args) => { calls.push(["tool", ...args]); return "Tool result"; },
  });
  return {
    controller, workspace, calls, initial,
    current: (value) => { current = value; },
    projects: (value) => { projects = value; },
  };
}

function edit(controller, model, values) {
  for (const [name, value] of Object.entries(values)) model = controller.update(model, change(name, value)).model;
  return model;
}

async function tasks(transition) {
  const messages = [];
  for (const task of transition.effects) {
    if (task.type === "task") await task.run({ send: (message) => messages.push(message), signal: new AbortController().signal });
  }
  return messages;
}

async function complete(controller, transition) {
  let model = transition.model;
  const messages = await tasks(transition);
  for (const message of messages) model = controller.update(model, message)?.model ?? model;
  return { model, messages };
}

/** Replace only the global facade boundary; no settings files are touched by these unit cases. */
async function personalSettings(run) {
  const settings = Object.getOwnPropertyDescriptor(Env, "settings");
  const flush = Object.getOwnPropertyDescriptor(Env, "settingsFlush");
  const personal = { tui: { alt: true, mouse: true, cursor: { shape: "block", blink: 450 }, keep: "untouched" }, projects: {} };
  let flushes = 0;
  Object.defineProperty(Env, "settings", { configurable: true, get: () => personal });
  Object.defineProperty(Env, "settingsFlush", { configurable: true, value: async () => { flushes++; } });
  try { await run(personal, () => flushes); }
  finally {
    Object.defineProperty(Env, "settings", settings);
    Object.defineProperty(Env, "settingsFlush", flush);
  }
}

describe("access controller operation lifetime", () => {
  test("unsupported descriptors and messages remain available to the parent", () => {
    const { controller } = fixture();
    const model = { overlay: null };
    for (const value of [undefined, null, {}, { type: "not-supported" }, { type: "access.no-such-action" }, { type: "insert", text: "/mcp-login example" }]) {
      expect(controller.resolve(model, value)).toBeUndefined();
    }
    expect(controller.update(model, { type: "task.done" })).toBeUndefined();
    const opened = controller.resolve(model, { type: "access.project.open" }).model;
    expect(controller.update({ ...opened, question: { active: true } }, key("escape"))).toBeUndefined();
  });

  test("pending selection is cancelable and stale completion never steals another overlay", async () => {
    const gate = deferred();
    const selected = agent(environment("/beta"), "beta");
    const { controller, calls, initial } = fixture({ select: async () => gate.promise });
    const back = openMenu("Projects", []);
    const transition = controller.resolve({ overlay: back }, { type: "access.project.select", path: "/beta" });
    const operation = transition.model.overlay;
    expect(operation).toMatchObject({ type: "form", fields: [], busy: true, back });
    expect(calls).toEqual([]);
    const messages = [];
    const running = transition.effects[0].run({ send: (message) => messages.push(message), signal: new AbortController().signal });
    const canceled = controller.update(transition.model, key("escape"));
    expect(canceled.model.overlay.stack[0].title).toBe("Projects");
    const later = { ...canceled.model, overlay: openMenu("Different menu", []) };
    gate.resolve(selected);
    await running;
    expect(messages[0]).toMatchObject({ type: "access.operation.done", operation, origin: initial, agent: selected });
    expect(controller.update(later, messages[0])).toEqual({ model: later, effects: [] });
    expect(calls.at(-1)).toEqual(["remember", initial]);
    const matching = controller.update(transition.model, messages[0]);
    expect(matching.model.overlay).toBeNull();
    expect(matching.model.accessSelectedAgent).toBe(selected);
  });

  test("validation and rejected operations retain inputs without clearing the prior view", async () => {
    const { controller, calls } = fixture({ select: async () => { throw new Error("No such project"); } });
    const back = openMenu("Projects", []);
    let model = controller.resolve({ overlay: back, input: { value: "unsent draft" } }, { type: "access.project.open" }).model;
    const required = controller.update(model, key("ctrl+s"));
    expect(required.effects).toEqual([]);
    expect(required.model.overlay.errors.path).toContain("required");
    model = edit(controller, required.model, { path: "/missing" });
    const submitted = controller.update(model, key("ctrl+s"));
    const finished = await complete(controller, submitted);
    expect(finished.model.overlay).toMatchObject({ type: "form", busy: false, values: { path: "/missing" }, errors: { path: "No such project" }, back });
    expect(finished.model.input.value).toBe("unsent draft");
    expect(calls.filter(([name]) => name === "command")).toEqual([]);
  });

  test("closing invalidates both queued tasks and late open continuations", async () => {
    const gate = deferred();
    const { controller, calls } = fixture({ open: async () => gate.promise });
    const transition = controller.resolve({ overlay: null }, { type: "access.agent.add", path: "/beta" });
    const messages = [];
    const running = transition.effects[0].run({ send: (message) => messages.push(message) });
    controller.close();
    controller.close();
    gate.resolve(environment("/beta"));
    await running;
    expect(messages).toEqual([]);
    expect(calls.filter(([name]) => name === "add")).toEqual([]);
    expect(controller.resolve({ overlay: null }, { type: "access.projects" })).toBeUndefined();
    expect(controller.update(transition.model, key("escape"))).toBeUndefined();
    await transition.effects[0].run({ send: (message) => messages.push(message) });
    expect(messages).toEqual([]);
  });
});

describe("access controller scoped settings and navigation", () => {
  test("project and session filters replace their list without accumulating menu levels", () => {
    const { controller } = fixture();
    for (const type of ["access.projects", "access.sessions"]) {
      const root = openMenu("Menu", [], { type: "master" });
      let model = controller.resolve({ overlay: root }, { type }).model;
      expect(model.overlay.stack).toHaveLength(2);
      for (const filter of ["first", "second", undefined, "first"]) {
        const source = { type, [type === "access.projects" ? "group" : "project"]: filter };
        model = controller.resolve(model, source).model;
        expect(model.overlay.stack).toHaveLength(2);
        expect(model.overlay.stack[0]).toBe(root.stack[0]);
        expect(model.overlay.stack.at(-1).source).toEqual(source);
      }
    }
  });

  test("refreshes only access sources while preserving source identity, preview and foreign levels", async () => {
    const { controller, projects, calls } = fixture();
    const source = { type: "access.projects" };
    const foreign = { title: "Foreign", items: [{ kind: "info", label: "live" }], source: { type: "provider", value: "endpoint" } };
    const preview = { type: "agent-description", description: "preserved" };
    let model = controller.resolve({ overlay: { type: "menu", stack: [foreign] } }, source).model;
    model.overlay.stack.at(-1).preview = preview;
    projects([{ path: "/beta", name: "Beta", groups: [] }]);
    const refreshed = controller.refresh(model.overlay);
    expect(refreshed.stack[0]).toBe(foreign);
    expect(refreshed.stack.at(-1).source).toBe(source);
    expect(refreshed.stack.at(-1).preview).toBe(preview);
    expect(refreshed.stack.at(-1).items.some((item) => item.label === "Beta")).toBe(true);
    const form = { type: "form", busy: true };
    expect(controller.refresh(form)).toBe(form);
    const navigation = controller.resolve(model, { type: "access.sessions" });
    expect(calls).toEqual([]);
    expect(await tasks(navigation)).toEqual([{ type: "access.sessions.ready", sessions: [] }]);
  });

  test("writes only allowed personal terminal leaves, flushes, and retains the terminal menu", async () => personalSettings(async (personal, flushes) => {
    const { controller, initial } = fixture();
    initial.env.settings.tui = { mouse: "project override" };
    const opened = controller.resolve({ overlay: null }, { type: "access.settings.terminal" }).model;
    let transition = controller.resolve(opened, { type: "access.terminal.set", key: "tui.mouse", value: false });
    expect(personal.tui.mouse).toBe(true);
    let done = await complete(controller, transition);
    expect(personal.tui).toMatchObject({ mouse: false, alt: true, keep: "untouched", cursor: { shape: "block", blink: 450 } });
    expect(initial.env.settings.tui.mouse).toBe("project override");
    expect(flushes()).toBe(1);
    expect(done.model.overlay.stack.at(-1).source.type).toBe("access.settings.terminal");
    transition = controller.resolve(done.model, { type: "access.terminal.set", key: "tui.cursor.shape", value: undefined });
    done = await complete(controller, transition);
    expect(personal.tui.cursor.shape).toBeUndefined();
    expect(personal.tui.cursor.blink).toBe(450);
    expect(controller.resolve(done.model, { type: "access.terminal.set", key: "providers.password", value: "bad" }).effects).toEqual([]);
    expect(personal.providers).toBeUndefined();
  }));

  test("endpoint limits validate before effects and mutate only the captured environment", async () => {
    const { controller, initial, current } = fixture();
    let flushed = 0;
    initial.env.settingsFlush = async () => { flushed++; };
    const back = controller.resolve({ overlay: null }, { type: "access.settings.endpoints" }).model;
    let model = controller.resolve(back, { type: "access.endpoint.max", selector: "endpoint/model", value: 2 }).model;
    const other = agent(environment("/beta"));
    current(other);
    model = edit(controller, model, { maxActive: "-1" });
    const invalid = controller.update(model, key("ctrl+s"));
    expect(invalid.effects).toEqual([]);
    expect(invalid.model.overlay.errors.maxActive).toContain("non-negative integer");
    model = edit(controller, invalid.model, { maxActive: "0" });
    const done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(initial.env.settings.providers.endpoint.models.model).toEqual({ keep: true, maxActive: false });
    expect(other.env.settings.providers.endpoint.models.model).toEqual({ keep: true });
    expect(flushed).toBe(1);
    expect(done.model.overlay.stack.at(-1).source.type).toBe("access.settings.endpoints");
    model = controller.resolve(done.model, { type: "access.endpoint.max", selector: "endpoint", value: 4 }).model;
    model = edit(controller, model, { maxActive: "" });
    await complete(controller, controller.update(model, key("ctrl+s")));
    expect(other.env.settings.providers.endpoint.maxActive).toBeUndefined();
  });

  test("project metadata targets paths, group scope is explained and close requires explicit confirmation", async () => personalSettings(async (_personal, flushes) => {
    const { controller, calls, initial } = fixture();
    let model = controller.resolve({ overlay: null }, { type: "access.project.details", path: "/alpha" }).model;
    const group = controller.resolve(model, { type: "access.project.group.new", path: "/beta" });
    expect(group.model.overlay.details).toContain("lets its agents reach");
    model = edit(controller, group.model, { group: "team" });
    let done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(calls).toContainEqual(["group", "/beta", "team", true]);
    expect(flushes()).toBe(1);
    const close = controller.resolve(done.model, { type: "access.project.close", path: "/beta" });
    expect(close.effects).toEqual([]);
    expect(close.model.overlay.submitLabel).toBe("Confirm");
    expect(close.model.overlay.details).toContain("stays pinned");
    done = await complete(controller, controller.update(close.model, key("ctrl+s")));
    expect(calls).toContainEqual(["closeProject", "/beta"]);
    expect(done.model.accessSelectedAgent).toBe(initial);
    expect(calls.some(([name]) => name === "pin")).toBe(false);
  }));
});

describe("access controller captured actions and secure submission", () => {
  test("opening Add agent for an open project is synchronous preparation, not admitted work", () => {
    const { controller, initial, calls } = fixture();
    const back = openMenu("Menu", []);
    const transition = controller.resolve({ overlay: back }, { type: "access.add.form", path: initial.env.folder });
    expect(transition.effects).toEqual([]);
    expect(transition.model.overlay).toMatchObject({ type: "form", title: "Add agent", busy: false, action: { type: "access.agent.add", env: initial.env }, back });
    // Model choices carry their endpoint prefix as a group header, and the
    // details name the project instead of leaking its folder path.
    expect(transition.model.overlay.fields[0].options).toEqual([{ label: "endpoint/model", value: "endpoint/model", group: "endpoint" }]);
    expect(transition.model.overlay.details).toContain("Project: alpha");
    expect(transition.model.overlay.details).not.toContain(initial.env.folder);
    expect(calls).toEqual([]);
    const canceled = controller.update(transition.model, key("escape"));
    expect(canceled.model.overlay).toEqual(back);
    expect(calls).toEqual([]);
  });

  test("add form loads target models asynchronously and boolean errors never create an agent", async () => {
    const { controller, calls, current } = fixture();
    const first = controller.resolve({ overlay: null }, { type: "access.add.form", path: "/beta" });
    expect(first.model.overlay).toMatchObject({ busy: true, preparing: true, fields: [] });
    expect(calls).toEqual([]);
    const loaded = await complete(controller, first);
    expect(loaded.model.overlay.values).toEqual({ model: "endpoint/model", safe: "false", anonymous: "false" });
    expect(loaded.model.overlay.details).toContain("beta");
    expect(loaded.model.overlay.details).not.toContain("/beta"); // the name identifies the project, not its folder
    let model = edit(controller, loaded.model, { safe: "yes", anonymous: "no" });
    const invalid = controller.update(model, key("ctrl+s"));
    expect(invalid.effects).toEqual([]);
    expect(invalid.model.overlay.errors).toEqual({ safe: "Enter true or false.", anonymous: "Enter true or false." });
    model = edit(controller, invalid.model, { safe: "true", anonymous: "true" });
    current(agent(environment("/gamma")));
    const done = await complete(controller, controller.update(model, key("ctrl+s")));
    const added = calls.find(([name]) => name === "add")[1];
    expect(added.env.folder).toBe("/beta");
    expect(added).toMatchObject({ model: "endpoint/model", safe: true, anonymous: true });
    expect(done.model.accessSelectedAgent.env).toBe(added.env);
  });

  test("agent rename and saved-session actions retain their original target across UI changes", async () => {
    const { controller, calls, initial, current } = fixture();
    const other = agent(environment("/beta"), "beta");
    const session = { id: "saved", name: "Saved", project: initial.env.folder, env: initial.env, live: initial };
    let model = controller.resolve({ overlay: null }, { type: "access.agent.rename", agent: initial }).model;
    current(other);
    model = edit(controller, model, { name: "renamed" });
    await complete(controller, controller.update(model, key("ctrl+s")));
    expect(initial.name).toBe("renamed");
    expect(other.name).toBe("beta");
    model = controller.resolve({ overlay: null }, { type: "access.session.rename", session }).model;
    model = edit(controller, model, { name: "session-renamed" });
    let done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(calls).toContainEqual(["renameSession", session, "session-renamed"]);
    expect(done.messages.some((message) => message.type === "access.sessions.ready")).toBe(true);
    done = await complete(controller, controller.resolve({ overlay: null }, { type: "access.session.resume", session }));
    expect(calls).toContainEqual(["resume", session]);
    expect(done.model.accessSelectedAgent).toBe(initial);
    expect(calls.filter(([name]) => name === "own")).toEqual([]);
    const unlogged = controller.resolve({ overlay: null }, { type: "access.session.rename", session: { ...session, live: { context: { save: false } } } });
    expect(unlogged.model.overlay.errors._form).toContain("Unlogged");
  });

  test("deleting the viewed live session confirms first and returns a replacement in its project", async () => {
    let initial;
    const setup = fixture({ async deleteSession() { initial.closed = true; } });
    initial = setup.initial;
    const { controller, calls } = setup;
    const session = { id: "saved", live: initial, env: initial.env, project: initial.env.folder };
    const confirm = controller.resolve({ overlay: null }, { type: "access.session.delete", session });
    expect(confirm.effects).toEqual([]);
    const canceled = controller.update(confirm.model, key("escape"));
    expect(canceled.model.overlay).toBeNull();
    expect(initial.closed).toBeUndefined();
    const done = await complete(controller, controller.update(confirm.model, key("ctrl+s")));
    expect(calls).toContainEqual(["select", initial.env.folder]);
    expect(done.model.accessSelectedAgent).not.toBe(initial);
    expect(done.model.accessSelectedAgent.env.folder).toBe(initial.env.folder);
  });

  test("manual login masks tokens and calls captured Env.login without command history", async () => {
    const { controller, initial, current, calls } = fixture();
    const loginCalls = [];
    initial.env.login = async (...args) => { loginCalls.push(args); return { name: "endpoint" }; };
    let model = controller.resolve({ overlay: openMenu("Login", []) }, { type: "insert", text: "/endpoint-login package endpoint provider https://endpoint.invalid " }).model;
    expect(model.overlay.values).toMatchObject({ scope: "package", name: "endpoint", provider: "provider", url: "https://endpoint.invalid", token: "" });
    expect(model.overlay.fields.find((entry) => entry.name === "token").secret).toBe(true);
    model = edit(controller, model, { token: "private-credential" });
    expect(JSON.stringify(formView(model.overlay))).not.toContain("private-credential");
    const other = agent(environment("/beta"));
    current(other);
    const done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(loginCalls).toEqual([["endpoint", { provider: "provider", url: "https://endpoint.invalid", token: "private-credential" }, { scope: "package" }]]);
    expect(done.model.overlay).toBeNull();
    expect(calls.some(([name]) => name === "command")).toBe(false);
    expect(other.model).toBe("endpoint/model");
  });

  test("login failures redact credentials in completion messages and retain fields for correction", async () => {
    const { controller, initial } = fixture();
    initial.env.login = async () => { throw new Error("Rejected credential private-credential"); };
    let model = controller.resolve({ overlay: null }, { type: "insert", text: "/endpoint-login " }).model;
    model = edit(controller, model, { scope: "user", name: "endpoint", provider: "provider", url: "https://invalid.test", token: "private-credential" });
    const invalid = controller.update(model, key("ctrl+s"));
    expect(invalid.effects).toEqual([]);
    expect(invalid.model.overlay.errors.scope).toContain("package or local");
    model = edit(controller, invalid.model, { scope: "local" });
    const done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(done.model.overlay.values.token).toBe("private-credential");
    expect(done.model.overlay.errors._form).toBe("Rejected credential [masked]");
    expect(done.messages[0].error).not.toContain("private-credential");
    expect(JSON.stringify(formView(done.model.overlay))).not.toContain("private-credential");
  });

  test("tool forms require explicit Run, object JSON and schema-required arguments before the injected pipeline", async () => {
    const { controller, initial, current, calls } = fixture();
    const opened = controller.resolve({ overlay: null }, { type: "access.tool", name: "tool-example", schema: { description: "Example tool", parameters: { required: ["path"] } } });
    expect(opened.effects).toEqual([]);
    expect(opened.model.overlay.submitLabel).toBe("Run");
    expect(opened.model.overlay.details).toContain("path");
    let model = edit(controller, opened.model, { json: "[]" });
    let invalid = controller.update(model, key("ctrl+s"));
    expect(invalid.effects).toEqual([]);
    expect(invalid.model.overlay.errors.json).toContain("JSON object");
    model = edit(controller, invalid.model, { json: "{}" });
    invalid = controller.update(model, key("ctrl+s"));
    expect(invalid.model.overlay.errors.json).toContain("path");
    model = edit(controller, invalid.model, { json: '{"path":"file.txt"}' });
    current(agent(environment("/beta")));
    const done = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(calls).toContainEqual(["tool", "tool-example", { path: "file.txt" }, initial]);
    expect(calls.some(([name]) => name === "command")).toBe(false);
    expect(done.messages[0].text).toBe("Tool result");
  });
});

describe("access controller context actions", () => {
  test("copy restores its viewer, edits preserve exact text scope and fork adopts only the new Agent", async () => {
    const { controller, initial, calls } = fixture();
    const message = { type: MessageType.User, content: [{ type: ContentType.Text, text: "original" }] };
    const edits = [];
    initial.context = { length: 1, at: () => message, editBlock: (...args) => { edits.push(args); } };
    const viewer = { type: "viewer", index: 0, filters: [], search: "" };
    const block = { type: "user", text: "original", message: 0, contentIndex: 0 };
    const menu = controller.resolve({ overlay: viewer }, { type: "access.context.actions", agent: initial, block, viewer });
    expect(menu.model.overlay.stack[0].title).toBe("Actions");
    const copy = controller.resolve(menu.model, { type: "access.context.copy", agent: initial, block, viewer });
    expect(copy.model.overlay).toBe(viewer);
    expect(copy.effects).toEqual([{ type: "copy", text: "original" }]);
    let model = controller.update({ overlay: viewer }, { type: "access.context.edit", agent: initial, index: 0 }).model;
    model = edit(controller, model, { text: "changed" });
    expect(edits).toEqual([]);
    const saved = await complete(controller, controller.update(model, key("ctrl+s")));
    expect(edits).toEqual([[0, 0, { type: ContentType.Text, text: "changed" }]]);
    expect(saved.model.overlay).toBe(viewer);
    const fresh = agent(initial.env, "forked");
    initial.fork = async (options) => { calls.push(["fork", options]); return fresh; };
    const done = await complete(controller, controller.resolve({ overlay: menu.model.overlay }, { type: "access.context.fork", agent: initial, through: 1, viewer }));
    expect(calls).toContainEqual(["fork", { through: 1 }]);
    expect(calls).toContainEqual(["own", fresh]);
    expect(done.model.accessSelectedAgent).toBe(fresh);
  });
});
