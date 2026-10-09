import { expect, test } from "bun:test";
import { session } from "../lib/app/web/public/app/orchestrators/session.js";
test("model settings refresh the already mounted welcome without replacing it", async () => {
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "", userAgent: "" } });
  const { state } = await import("../lib/app/web/public/app/state.js");
  const { syncWelcome } = await import("../lib/app/web/public/app/views/transcript/transcript.js");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousSettings = state.settings;
  const previousBlocks = state.blocks;
  let login = { remove: () => { login = null; } };
  const lead = { textContent: "Pick a model or sign in to an endpoint to begin.", after: (node) => { login = node; } };
  const welcome = { nextElementSibling: null, querySelector: (selector) => selector === ".empty-lead" ? lead : selector === ".primary-button" ? login : null };
  const transcript = { querySelector: () => welcome, insertBefore: () => { throw new Error("welcome remounted"); } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => transcript, createElement: (tag) => ({ tagName: tag, className: "", append() {}, addEventListener() {} }), createTextNode: (text) => ({ textContent: text }) } });
  const invalidations = [];
  const ctx = { state, invalidate: (region) => invalidations.push(region) };
  try {
    state.blocks = [];
    state.settings = { ...previousSettings, endpoint: null, model: null };
    session.packets.settings(ctx, { endpoint: "acme", model: "pro" });
    expect(invalidations).toContain("transcript");
    syncWelcome();
    expect(lead.textContent).toBe("Talking to acme/pro");
    expect(login).toBeNull();
    session.packets.settings(ctx, { endpoint: "acme", model: "mini" });
    syncWelcome();
    expect(lead.textContent).toBe("Talking to acme/mini");
    invalidations.length = 0;
    session.packets.settings(ctx, { endpoint: "acme", model: "mini", safe: true });
    expect(invalidations).not.toContain("transcript");
    session.packets.settings(ctx, { endpoint: null, model: null });
    syncWelcome();
    expect(lead.textContent).toBe("Pick a model or sign in to an endpoint to begin.");
    expect(login?.className).toBe("primary-button");
  } finally {
    state.settings = previousSettings;
    state.blocks = previousBlocks;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia);
    else delete globalThis.matchMedia;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
});
