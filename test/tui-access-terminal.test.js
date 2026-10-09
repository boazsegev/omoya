// test/tui-access-terminal.test.js — the new TUI access UI (the ^X shallow
// root + global action search, the project-open form, the /context-edit
// form) proven on GTUI's REAL terminal host in BOTH modes, the same way
// test/tui-app-parity.test.js proved the base app: raw keystrokes as
// actual bytes through the real decoder (Ctrl+X = 0x18, Escape = 0x1b,
// Tab = 0x09, Ctrl+S = 0x13, printable text as UTF-8), never synthesized
// semantic key messages. Root navigation tests enter AND select using raw
// bytes only. Direct descriptor/msg.submit dispatch is used only to enter
// the unrelated project/context forms; their interactions are raw bytes.
//
// Assertion discipline for the differential terminal writer: never
// require a whole phrase after a redraw (unchanged cells are skipped, so
// inter-word spacing is not stable). State comes from the app's live
// model — createApp does not expose it, so the harness wraps app.update
// to capture the current model while preserving every app export — and
// terminal bytes are checked for single words painted contiguously.
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { Context } from "../lib/context.js";
import { createApp, msg } from "../lib/app/tui/app.js";
import { MENU_ID } from "../lib/app/tui/overlay-view.js";
import { scriptedIO, testEnv } from "./fakes.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  resume() {}
  pause() {}
}
class FakeOutput extends EventEmitter {
  columns = 80;
  rows = 24;
  chunks = [];
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  bytes() { return this.chunks.join(""); }
}

const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function until(fn, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(5);
  }
  return fn();
}

/** Wrap the app so tests can read the current model without changing any
 *  app export: init/update are overridden on a prototype that delegates
 *  everything else (view, bindings, dispose, currentAgent, closeWorkspace,
 *  the live theme getter) to the real app. */
function watchModel(app) {
  let current = null;
  const watched = Object.create(app, {
    init: { value: () => { const result = app.init(); current = result.model; return result; } },
    update: { value: (model, message) => {
      const result = app.update(model, message);
      if (result && typeof result === "object" && "model" in result) current = result.model;
      return result;
    } },
  });
  return { app: watched, model: () => current };
}

async function harness(mode, { context = [], settings = {} } = {}) {
  const env = await testEnv(settings);
  await env.ready();
  const io = scriptedIO([[{ type: "done" }]]); // no turn ever runs: every entry below is a menu/command/form path
  const agent = await Agent.create({ env, model: "p/m", context, createIO: () => io });
  const base = createApp(agent, { env });
  const { app, model } = watchModel(base);
  const input = new FakeInput();
  const output = new FakeOutput();
  const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
  const running = ui.run(app);
  return {
    env, agent, app, model, input, output, ui,
    async close() {
      ui.stop();
      await running;
      await app.closeWorkspace();
      await agent.close();
      await env.close();
    },
  };
}

/** Type printable text the way a real terminal delivers it: one "data"
 *  event per UTF-8 character, a microtask between keystrokes (key
 *  processing is immediate — no timer waits). */
async function typeRaw(input, text) {
  for (const ch of text) { input.emit("data", Buffer.from(ch, "utf8")); await tick(); }
}

/** Select a row in a freshly opened, unfiltered menu using only raw Down
 *  and Enter bytes. Reading descriptors locates the row; it never dispatches
 *  them. Counting selectable rows avoids depending on headers or viewport size.
 *  @param {object} h Real terminal harness (retained only during this call).
 *  @param {Function} matches Predicate identifying a row already in the menu.
 *  @param {number} depth Required menu stack depth before selection.
 *  @returns {Promise<void>} Resolves after the raw Enter has been processed.
 */
async function selectRawMenuRow(h, matches, depth) {
  expect(h.model().overlay?.type).toBe("menu");
  expect(h.model().overlay.stack).toHaveLength(depth);
  const rows = h.model().overlay.stack.at(-1).items.filter((item) =>
    item.kind !== "header" && item.kind !== "info" && item.disabled !== true);
  const index = rows.findIndex(matches);
  expect(index).toBeGreaterThanOrEqual(0); // must exist before any navigation/filter text
  for (let step = 0; step < index; step++) {
    h.input.emit("data", Buffer.from("\x1b[B")); // raw CSI Down
    await tick();
    expect(h.model().overlay.stack).toHaveLength(depth);
  }
  h.input.emit("data", Buffer.from([0x0d])); // raw Enter
  await tick();
}

for (const mode of ["inline", "alt"]) {
  describe(`the access UI over the real terminal byte pipeline (${mode})`, () => {
    test("raw Ctrl+X exposes routine actions at the root, global search finds Compact, and Escape preserves the draft", async () => {
      const h = await harness(mode);
      try {
        await typeRaw(h.input, "keep draft");
        expect(h.model().input.value).toBe("keep draft");
        h.input.emit("data", Buffer.from([0x18])); // Ctrl+X, one raw C0 byte
        await tick();
        expect(h.model().overlay?.type).toBe("menu");
        expect(h.model().overlay.stack).toHaveLength(1);
        const rootItems = h.model().overlay.stack[0].items;
        const rootLabels = rootItems.filter((item) => item.kind === "action")
          .map((item) => item.label.split(/[|—…]/)[0].trim());
        for (const label of ["Themes", "Models", "Projects", "Saved sessions", "Agent settings", "Terminal settings", "Endpoint settings", "Tools", "Prompts", "Add agent", "Close agent", "Login"]) {
          expect(rootLabels).toContain(label);
        }
        for (const label of ["Settings", "Tools & prompts", "Agents"]) expect(rootLabels).not.toContain(label);
        for (const type of ["themes", "access.models", "access.settings.agent", "access.settings.terminal", "access.settings.endpoints", "access.tools.list", "access.add.form", "session-close-menu", "login"]) {
          expect(rootItems.some((item) => item.value?.type === type)).toBe(true);
        }
        expect(rootItems.some((item) => item.value?.type === "agent.switch" && item.value.agent === h.agent)).toBe(true);
        expect(rootItems.find((item) => item.value?.type === "access.add.form").value.path).toBe(h.env.folder);
        // Words, never a joined phrase: the differential writer skips
        // unchanged cells, so inter-word spacing is not stable.
        expect(h.output.bytes()).toContain("Themes");
        await typeRaw(h.input, "compact"); // the root menu's global search
        expect(h.output.bytes()).toContain("Compact"); // the "Compact context" action matched
        const beforeClose = h.output.chunks.length;
        h.input.emit("data", Buffer.from([0x1b])); // bare Escape, decoded without readline's delay
        await tick();
        expect(h.model().overlay).toBeNull();
        expect(h.model().input.value).toBe("keep draft"); // the composer retained the draft
        expect(h.output.chunks.length).toBeGreaterThan(beforeClose); // a real repaint ran
      } finally { await h.close(); }
    });

    test("raw arrows and Enter still navigate a menu opened over composer completions", async () => {
      const h = await harness(mode);
      try {
        await typeRaw(h.input, "/");
        h.input.emit("data", Buffer.from([0x09]));
        await tick();
        expect(h.model().input.completions.length).toBeGreaterThan(0);
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "themes", 1);
        expect(h.model().overlay.stack).toHaveLength(2);
        expect(h.model().overlay.stack[1].title).toBe("Themes");
        h.input.emit("data", Buffer.from([0x1b]));
        await tick();
        expect(h.model().overlay).toBeNull();
      } finally { await h.close(); }
    });

    test("root Themes opens exactly one submenu: raw Escape preserves the draft and raw Enter applies the theme", async () => {
      const themeName = "terminal regression";
      const h = await harness(mode, { settings: {
        tui: { theme: "default" },
        themes: { [themeName]: { accent: { fg: "#123456" } } },
      } });
      try {
        await typeRaw(h.input, "theme draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        const rootTheme = h.model().overlay.stack[0].items.find((item) => item.value?.type === "themes");
        expect(rootTheme?.value).toMatchObject({ type: "themes", value: "default" });
        expect(rootTheme.value.themes).toContain(themeName);
        await selectRawMenuRow(h, (item) => item.value?.type === "themes", 1);
        expect(h.model().overlay.stack).toHaveLength(2);
        expect(h.model().overlay.stack[1].title).toBe("Themes");
        expect(h.model().overlay.stack[1].items.some((item) => item.value?.type === "theme.set" && item.value.value === themeName)).toBe(true);
        h.input.emit("data", Buffer.from([0x1b]));
        await tick();
        expect(h.model().overlay).toBeNull();
        expect(h.model().input.value).toBe("theme draft");
        expect(h.env.settings.tui.theme).toBe("default");

        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "themes", 1);
        await selectRawMenuRow(h, (item) => item.value?.type === "theme.set" && item.value.value === themeName, 2);
        expect(await until(() => h.model().overlay === null && h.env.settings.tui.theme === themeName)).toBe(true);
        expect(h.env.settings.theme).toBe(themeName);
        expect(h.env.settings.web.theme).toBe(themeName);
        expect(h.app.theme.accent.fg).toBe("#123456"); // applied tokens, not just the persisted name
        expect(h.model().input.value).toBe("theme draft");
        expect(h.app.currentAgent()).toBe(h.agent);
      } finally { await h.close(); }
    });

    test("a root endpoint opens its models at depth two and a raw selection changes the model without losing the draft", async () => {
      const endpoint = "terminalendpoint";
      const h = await harness(mode, { settings: {
        providers: {
          p: { provider: "test", url: "test://script", models: { m: {} } },
          [endpoint]: { provider: "test", url: "test://script", models: { first: {}, second: {} } },
        },
      } });
      try {
        await typeRaw(h.input, "model draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "provider" && item.value.value === endpoint, 1);
        expect(h.model().overlay.stack).toHaveLength(2);
        expect(h.model().overlay.stack[1].title).toBe(endpoint);
        await selectRawMenuRow(h, (item) => item.value?.type === "model" && item.value.value === `${endpoint}/second`, 2);
        expect(await until(() => h.agent.model === `${endpoint}/second` && h.model().overlay === null)).toBe(true);
        expect(h.app.currentAgent()).toBe(h.agent);
        expect(h.model().input.value).toBe("model draft");
      } finally { await h.close(); }
    });

    test("a root live-agent row switches directly with raw Enter and switching back restores each composer draft", async () => {
      const h = await harness(mode);
      let other;
      try {
        other = await h.env.agentCreate({ model: "p/m", createIO: () => scriptedIO([[{ type: "done" }]]) });
        await typeRaw(h.input, "original agent draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "agent.switch" && item.value.agent === other, 1);
        expect(await until(() => h.app.currentAgent() === other)).toBe(true);
        expect(h.model().overlay).toBeNull(); // no Agents submenu or confirmation
        expect(h.agent.closed).toBe(false);
        expect(h.model().input.value).toBe("");
        await typeRaw(h.input, "other agent draft");

        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "agent.switch" && item.value.agent === h.agent, 1);
        expect(await until(() => h.app.currentAgent() === h.agent)).toBe(true);
        expect(h.model().overlay).toBeNull();
        expect(h.model().input.value).toBe("original agent draft");
        expect(other.closed).toBe(false);

        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "agent.switch" && item.value.agent === other, 1);
        expect(await until(() => h.app.currentAgent() === other)).toBe(true);
        expect(h.model().overlay).toBeNull();
        expect(h.model().input.value).toBe("other agent draft");
      } finally {
        try { await h.close(); } finally { await other?.close(); }
      }
    });

    test("root Add agent opens the current project's form directly and raw Escape creates no agent or draft changes", async () => {
      const h = await harness(mode);
      try {
        const agentsBefore = h.env.agents();
        await typeRaw(h.input, "add agent draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "access.add.form" && item.value.path === h.env.folder, 1);
        expect(h.model().overlay?.type).toBe("form"); // no project-picker/options submenu
        expect(await until(() => h.model().overlay?.type === "form" && h.model().overlay.busy === false)).toBe(true);
        const form = h.model().overlay;
        expect(form.title).toBe("Add agent");
        expect(form.fields.map((field) => field.name)).toEqual(["model", "safe", "anonymous"]);
        expect(form.values).toEqual({
          model: h.agent.model,
          safe: String(h.agent.can.write === false),
          anonymous: String(h.agent.context.save === false),
        });
        expect(form.action.type).toBe("access.agent.add");
        expect(form.action.env).toBe(h.env);
        expect(form.action.origin).toBe(h.agent);
        expect(h.env.agents()).toEqual(agentsBefore);
        h.input.emit("data", Buffer.from([0x1b]));
        await tick();
        expect(h.model().overlay?.type ?? null).not.toBe("form");
        expect(h.app.currentAgent()).toBe(h.agent);
        expect(h.model().input.value).toBe("add agent draft");
        expect(h.env.agents()).toEqual(agentsBefore);
        expect(h.agent.closed).toBe(false);
      } finally { await h.close(); }
    });

    test("Add agent remains keyboard-operable with hundreds of models at 40x12 and creates only after explicit submit", async () => {
      const models = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`choice-${index}`, {}]));
      const h = await harness(mode, { settings: { providers: { p: { provider: "test", url: "test://script", models: { m: {}, ...models } } } } });
      try {
        await typeRaw(h.input, "original draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "access.add.form", 1);
        expect(h.model().overlay).toMatchObject({ type: "form", busy: false, focus: 0 });
        h.output.columns = 40;
        h.output.rows = 12;
        h.output.emit("resize");
        await tick();
        await typeRaw(h.input, "choice-299");
        expect(h.env.agents()).toHaveLength(1);
        h.input.emit("data", Buffer.from([0x0d])); // choose the filtered model
        await tick();
        expect(h.model().overlay.values.model).toBe("p/choice-299");
        expect(h.model().overlay.focus).toBe(1);
        h.input.emit("data", Buffer.from("\x1b[B")); // Read-only
        h.input.emit("data", Buffer.from([0x0d]));
        await tick();
        expect(h.model().overlay.values.safe).toBe("true");
        expect(h.model().overlay.focus).toBe(2);
        // Test Envs may default to unlogged already; choose Unlogged without toggling it off.
        if (h.model().overlay.values.anonymous !== "true") h.input.emit("data", Buffer.from("\x1b[B"));
        h.input.emit("data", Buffer.from([0x0d]));
        await tick();
        expect(h.model().overlay.values.anonymous).toBe("true");
        expect(h.model().overlay.focus).toBe(3);
        expect(h.env.agents()).toHaveLength(1);
        h.input.emit("data", Buffer.from([0x0d])); // explicit Add agent
        expect(await until(() => h.app.currentAgent() !== h.agent && h.model().overlay === null)).toBe(true);
        expect(h.app.currentAgent().model).toBe("p/choice-299");
        expect(h.app.currentAgent().can.write).toBe(false);
        expect(h.app.currentAgent().context.save).toBe(false);
        expect(h.agent.closed).toBe(false);
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        await selectRawMenuRow(h, (item) => item.value?.type === "agent.switch" && item.value.agent === h.agent, 1);
        expect(h.model().input.value).toBe("original draft");
      } finally { await h.close(); }
    });

    test("a direct access.project.open descriptor opens its form: raw path typing lands and Escape cancels with no Agent replacement", async () => {
      const h = await harness(mode);
      try {
        h.input.emit("data", Buffer.from([0x18])); // descriptors route through the open master menu
        await tick();
        expect(h.model().overlay?.type).toBe("menu");
        h.ui.dispatch({ type: "menu.select", id: MENU_ID, item: { kind: "action", label: "Open project", value: { type: "access.project.open" } } });
        expect(await until(() => h.model().overlay?.type === "form")).toBe(true);
        await typeRaw(h.input, "some/path"); // raw bytes into the focused path field
        expect(h.model().overlay?.values?.path).toBe("some/path");
        expect(h.output.bytes()).toContain("some/path"); // the field echoed through the real renderer
        h.input.emit("data", Buffer.from([0x1b])); // Escape cancels the form
        await tick();
        expect(h.model().overlay?.type ?? null).not.toBe("form");
        expect(h.app.currentAgent()).toBe(h.agent); // no project opened, no Agent replaced
      } finally { await h.close(); }
    });

    test("a long tool explanation leaves arguments and Cancel usable at 40x12 without implying submission", async () => {
      const h = await harness(mode);
      try {
        await typeRaw(h.input, "tool draft");
        h.input.emit("data", Buffer.from([0x18]));
        await tick();
        h.ui.dispatch({ type: "menu.select", id: MENU_ID, item: { value: { type: "access.tool", name: "never-run", schema: {
          description: "Long tool explanation with required safety guidance. ".repeat(200), type: "object", required: ["path"],
        } } } });
        expect(h.model().overlay).toMatchObject({ type: "form", busy: false });
        h.output.columns = 40;
        h.output.rows = 12;
        h.output.emit("resize");
        await tick();
        const before = h.output.chunks.length;
        h.input.emit("data", Buffer.from([0x15])); // Ctrl+U clears the arguments line
        await typeRaw(h.input, '{"path":"visible"}');
        expect(h.model().overlay.values.json).toBe('{"path":"visible"}');
        expect(h.output.chunks.slice(before).join("")).toContain("visible");
        expect(h.model().overlay.busy).toBe(false);
        h.input.emit("data", Buffer.from([0x09]));
        await tick();
        expect(h.model().overlay.focus).toBe(1);
        h.input.emit("data", Buffer.from([0x1b]));
        await tick();
        expect(h.model().overlay?.type).not.toBe("form");
        expect(h.model().input.value).toBe("tool draft");
        expect(h.app.currentAgent()).toBe(h.agent);
      } finally { await h.close(); }
    });

    test("/context-edit: a raw edit + Escape keeps the original; reopen + raw Ctrl+S changes exactly one block", async () => {
      const h = await harness(mode, { context: [Context.messageUser("original")] });
      try {
        h.ui.dispatch(msg.submit("/context-edit 0"));
        // The command runs on an async task before the controller opens the
        // form: wait bounded for the form and its heading word.
        expect(await until(() => h.model().overlay?.type === "form" && h.output.bytes().includes("Message"))).toBe(true);
        await typeRaw(h.input, " EDIT");
        expect(h.model().overlay?.values?.text).toBe("original EDIT");
        h.input.emit("data", Buffer.from([0x1b])); // Escape cancels: nothing is applied
        await tick();
        expect(h.model().overlay?.type ?? null).not.toBe("form");
        expect(h.agent.context.at(0).content[0].text).toBe("original");

        h.ui.dispatch(msg.submit("/context-edit 0"));
        expect(await until(() => h.model().overlay?.type === "form")).toBe(true);
        await typeRaw(h.input, " changed");
        expect(h.model().overlay?.values?.text).toBe("original changed");
        h.input.emit("data", Buffer.from([0x13])); // Ctrl+S saves the form
        expect(await until(() => h.agent.context.at(0).content[0].text === "original changed")).toBe(true);
        expect(h.agent.context.at(0).content).toHaveLength(1); // one block changed, none added
        expect(h.agent.context.messages()).toHaveLength(1);
      } finally { await h.close(); }
    });

    test("a 40x12 resize with a form open retains the focused field and Tab still reaches Save/Cancel", async () => {
      const h = await harness(mode, { context: [Context.messageUser("original")] });
      try {
        h.ui.dispatch(msg.submit("/context-edit 0"));
        expect(await until(() => h.model().overlay?.type === "form")).toBe(true);
        expect(h.model().overlay.focus).toBe(0); // the text field owns focus
        const beforeResize = h.output.chunks.length;
        h.output.columns = 40;
        h.output.rows = 12;
        h.output.emit("resize");
        await tick();
        expect(h.model().overlay?.type).toBe("form"); // the form survived the resize
        expect(h.model().overlay.focus).toBe(0); // ...with the same focused field
        expect(h.model().overlay.values.text).toBe("original"); // ...and its value intact
        // The resize invalidated the whole screen, so the freshly repainted
        // bytes must contain the focused field's value as one painted word.
        expect(h.output.chunks.slice(beforeResize).join("")).toContain("original");
        h.input.emit("data", Buffer.from([0x09])); // Tab, one raw byte
        await tick();
        expect(h.model().overlay?.type).toBe("form");
        expect(h.model().overlay.focus).toBe(1); // the action menu owns focus now
        // Single words only: Tab scrolled the menu into view on the small
        // screen and the differential writer repainted the visible region.
        expect(h.output.bytes()).toContain("Save");
        expect(h.output.bytes()).toContain("Cancel");
      } finally { await h.close(); }
    });
  });
}
