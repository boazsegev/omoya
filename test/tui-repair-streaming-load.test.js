import { expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { GTUI } from "../lib/gtui/gtui.js";
import { createApp } from "../lib/tui-app/app.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";
const turn = () => new Promise((resolve) => setImmediate(resolve));

for (const mode of ["inline", "alt"]) {
  test(`${mode}: scrolling and typing remain responsive during a sustained token stream`, async () => {
    const context = Array.from({ length: 100 }, (_, i) => ({ type: 3, content: [{ type: "text", text: `MESSAGE ${i}\n` + "historical words ".repeat(100) }] }));
    const agent = { context, pending: [], model: "test/model", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {} };
    const input = new TerminalInput();
    const output = new TerminalScreen(100, 32);
    const app = createApp(agent, { sources: {} });
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
    const run = ui.run(app);
    const latencies = [];
    try {
      ui.dispatch({ type: "agent.turn.event", event: { type: "start" } });
      ui.dispatch({ type: "agent.turn.event", event: { type: "text_start", contentIndex: 0 } });
      for (let batch = 0; batch < 12; batch++) {
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
          ui.dispatch({ type: "agent.turn.event", event: { type: "text_delta", contentIndex: 0, text: `stream${batch} ` } });
        }
        const start = performance.now();
        input.emit("data", Buffer.from(batch === 0 ? "x" : "\x1b[5~"));
        await turn();
        latencies.push(performance.now() - start);
        expect(output.text()).toContain("x");
      }
      expect(Math.max(...latencies)).toBeLessThan(150);
      // We must be able to navigate away from a still-streaming tail.
      expect(output.text()).toContain("historical words");
    } finally { ui.stop(); await run; }
  });
}
