import { expect, test } from "bun:test";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { parseClientMessage } from "../lib/app/web/protocol.js";
import { testEnv } from "./fakes.js";

function node(tag, text = "") {
  return {
    tagName: tag.toUpperCase(), textContent: text, className: "", children: [], style: {}, listeners: {}, disabled: false,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(key, value) { this[key] = value; },
    contains() { return false; },
    get childElementCount() { return this.children.length; },
    querySelector(selector) {
      for (const child of this.children) {
        const found = child.querySelector?.(selector);
        if (found) return found;
      }
      return null;
    },
  };
}
const text = (item) => `${item?.textContent ?? ""} ${item?.children?.map(text).join(" ") ?? ""}`;
const walk = (item) => [item, ...(item.children ?? []).flatMap(walk)];

test("group request protocol accepts Allow/Deny/Ask and rejects invalid choices", () => {
  for (const value of [true, false, null]) expect(parseClientMessage(JSON.stringify({ type: "agent.can.request", value }))).toEqual({ type: "agent.can.request", value });
  for (const value of ["Ask", 0, undefined]) expect(() => parseClientMessage(JSON.stringify({ type: "agent.can.request", value }))).toThrow("invalid group request permission");
});

test("workspace publishes live group request permission and handles all three choices", async () => {
  const env = await testEnv();
  const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
  const packets = [];
  const ws = { readyState: WebSocket.OPEN, send: (data) => packets.push(JSON.parse(data)) };
  try {
    await workspace.open(ws);
    const agent = env.agents().find((entry) => !entry.parent);
    const latest = () => packets.findLast((packet) => packet.type === "settings");
    expect(latest().can.request).toBeNull();
    expect(latest().requestLocked).toBe(false);
    for (const [value, expected] of [[true, true], [false, false], [null, undefined]]) {
      await workspace.message(ws, JSON.stringify({ type: "agent.can.request", value }));
      expect(agent.can.request).toBe(expected);
      expect(latest().can.request).toBe(value);
    }
    const child = await agent.childCreate({ name: "linked-request-test", model: "p/m", context: [] });
    const childPackets = [];
    const childWs = { readyState: WebSocket.OPEN, send: (data) => childPackets.push(JSON.parse(data)) };
    await workspace.open(childWs, { agentId: child.name });
    const childSettings = () => childPackets.findLast((packet) => packet.type === "settings");
    expect(childSettings().can.request).toBe(false);
    expect(childSettings().requestLocked).toBe(true);
    await workspace.message(childWs, JSON.stringify({ type: "agent.can.request", value: true }));
    expect(child.can.request).toBe(false);
    expect(childSettings().can.request).toBe(false);
  } finally { workspace.stop(); await env.close(); }
});

test("settings menu shows group request choices and locks child agents", async () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  globalThis.matchMedia = () => ({ matches: false });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { renderSettingsBody, mount } = await import("../lib/app/web/public/app/views/panels/panels.js");
  const original = state.settings;
  const body = node("div");
  const events = [];
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => selector === "#settings-panel .panel-body" ? body : null,
    createElement: (tag) => node(tag), createTextNode: (value) => node("text", value),
  };
  mount(null, { emit: (channel, packet) => events.push([channel, packet]) });
  try {
    state.settings = { ...original, can: { ...original.can, request: null }, requestLocked: false };
    renderSettingsBody();
    const request = walk(body).find((entry) => entry.className === "settings-row" && text(entry).includes("Allow group request"));
    expect(request).toBeDefined();
    expect(text(request)).toContain("Whether this agent may send requests to agents or access project group resources");
    const buttons = walk(request).filter((entry) => entry.tagName === "BUTTON");
    expect(buttons.map(text).map((label) => label.trim())).toEqual(["Allow", "Deny", "Ask"]);
    expect(buttons.map((button) => button["aria-checked"])).toEqual(["false", "false", "true"]);
    buttons[0].listeners.click(); buttons[1].listeners.click(); buttons[2].listeners.click();
    expect(events).toEqual([true, false, null].map((value) => ["server", { type: "agent.can.request", value }]));
    state.settings = { ...state.settings, can: { ...state.settings.can, request: false }, requestLocked: true };
    renderSettingsBody();
    const locked = walk(body).find((entry) => entry.className === "settings-row" && text(entry).includes("Allow group request"));
    expect(walk(locked).filter((entry) => entry.tagName === "BUTTON").every((button) => button.disabled)).toBe(true);
    expect(text(locked)).toContain("Linked (child) agents cannot send requests or access project resources");
  } finally {
    state.settings = original;
    mount(null, { emit() {} });
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else delete globalThis.document;
    if (savedMatchMedia) Object.defineProperty(globalThis, "matchMedia", savedMatchMedia); else delete globalThis.matchMedia;
  }
});
