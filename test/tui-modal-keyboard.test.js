import { describe, expect, test } from "bun:test";
import { compileBindings, matchesBinding } from "../lib/app/gtui/keymap.js";
import { appBindings } from "../lib/app/tui/bindings.js";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { Agent } from "../lib/agent.js";
import { createApp } from "../lib/app/tui/app.js";
import { scriptedIO, testEnv } from "./fakes.js";

for (const extra of [[], ["alt+shift+f"]]) {
  test(`an open menu keeps arrows and Enter even with composer completions (${extra.length} overrides)`, () => {
    const model = { input: { completions: ["/help", "/history"] }, overlay: { type: "menu" } };
    const bindings = compileBindings(appBindings(model, extra));
    for (const key of ["up", "down", "enter", "escape"]) expect(matchesBinding(bindings, { key })).toBe(false);
  });
}

test("viewer filters retain their Tab and dismissal bindings with configured app shortcuts", () => {
  const bindings = compileBindings(appBindings({ input: { completions: ["/help"] }, overlay: { type: "viewer-filter" } }, ["alt+shift+f"]));
  for (const key of ["tab", "escape", "ctrl+c"]) expect(matchesBinding(bindings, { key })).toBe(true);
  for (const key of ["up", "down", "enter"]) expect(matchesBinding(bindings, { key })).toBe(false);
});

describe("modal input ownership", () => {
  test("opening actions from a completion popup leaves menu navigation and selection responsive", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, model: "p/m", createIO: () => scriptedIO([[{ type: "done" }]]) });
    const app = createApp(agent, { env, sources: { commands: ["/help", "/history"], prompts: [], tools: [], models: [] } });
    let latest;
    const update = app.update;
    app.update = (model, message) => { const outcome = update(model, message); latest = outcome.model; return outcome; };
    const host = GTUI.host.memory({ width: 50, height: 16 });
    const ui = new GTUI({ host });
    const running = ui.run(app);
    const send = (key, text) => host.send(GTUI.event.key({ key, ...(text ? { text } : {}) }));
    try {
      send("/", "/");
      send("tab");
      expect(latest.input.completions.length).toBeGreaterThan(0);
      send("ctrl+x");
      expect(latest.overlay.stack).toHaveLength(1);
      send("down"); // New chat -> Add agent
      send("down"); // Add agent -> Themes
      send("enter");
      expect(latest.overlay?.type).toBe("menu");
      expect(latest.overlay.stack.at(-1).title).toBe("Themes");
      send("escape");
      expect(latest.overlay).toBeNull();
    } finally {
      ui.stop();
      await running;
      await app.closeWorkspace();
      await agent.close();
      await env.close();
    }
  });
});
