import { expect, test } from "bun:test";
import { runCommand } from "../lib/app/web/commands.js";
import Agent from "../lib/agent.js";
import { testEnv } from "./fakes.js";

// Exercise the real form submit and arrow handlers without a browser dependency.
function node(tag = "div") {
  const listeners = new Map();
  return {
    tag, value: "", style: {}, scrollHeight: 24, clientWidth: 400, offsetTop: 0,
    children: [], hidden: false, selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type, event = {}) { listeners.get(type)?.({ preventDefault() {}, ...event }); },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute() {}, focus() {}, remove() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    requestSubmit() { this.dispatch("submit"); },
  };
}

test("slash command and invalid prompt submissions survive arrow history, including long multiline input", async () => {
  const previous = { document: globalThis.document, navigator: globalThis.navigator, matchMedia: globalThis.matchMedia, getComputedStyle: globalThis.getComputedStyle };
  const errorRegion = node();
  globalThis.document = {
    createElement: node, createTextNode: (text) => text,
    querySelector: (selector) => selector === "#error-region" ? errorRegion : null,
    body: node(),
  };
  globalThis.navigator = { platform: "Linux" };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.getComputedStyle = () => ({});
  try {
    const { state } = await import("../lib/app/web/public/app/state.js");
    const { buildComposer, mount, composerRefs } = await import("../lib/app/web/public/app/views/composer/composer.js");
    const env = await testEnv();
    const agent = await Agent.create({ env, model: "p/m", context: [] });
    state.agent = { id: "history-test", project: "history-test" };
    state.blocks = [];
    state.draftAttachments = [];
    state.composerByAgent.clear();
    state.acItems = [];
    state.prefs.autocomplete = false;
    const pending = [];
    const submittedPackets = [];
    mount(null, { emit(type, packet) {
      if (type === "server" && packet.type === "chat.submit") {
        submittedPackets.push(packet.text);
        pending.push(runCommand(agent, packet.text).then(({ text }) => {
          if (text) errorRegion.append(node("error"));
          return text;
        }));
      }
    } });
    const form = buildComposer();
    const textarea = composerRefs.textareaEl;
    const command = "/agent-name build helper";
    const invalid = `  /team fix flaky deploy\n${"Keep detailed investigation notes. ".repeat(100)}\nDo not discard the draft. \n  `;
    for (const text of [command, invalid]) {
      textarea.value = text;
      textarea.dispatch("input");
      form.requestSubmit();
      expect(textarea.value).toBe("");
    }
    expect(await pending[0]).toBe("agent name: build helper");
    expect(await pending[1]).toBe("unknown command or prompt: /team (/help lists commands)");
    expect(submittedPackets).toEqual([command, invalid.trim()]); // wire still trims
    expect(errorRegion.children).toHaveLength(2); // server command feedback remains visible
    textarea.value = "unsent working draft";
    textarea.dispatch("input");
    textarea.setSelectionRange(0, 0);
    textarea.dispatch("keydown", { key: "ArrowUp" });
    expect(textarea.value).toBe(invalid);
    textarea.setSelectionRange(0, 0);
    textarea.dispatch("keydown", { key: "ArrowUp" });
    expect(textarea.value).toBe(command);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatch("keydown", { key: "ArrowDown" });
    expect(textarea.value).toBe(invalid);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatch("keydown", { key: "ArrowDown" });
    expect(textarea.value).toBe("unsent working draft");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
