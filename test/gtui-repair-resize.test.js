import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";

for (const mode of ["inline", "alt"]) {
  test(`${mode} resize repaints immediately even when update returns the same model`, async () => {
    const output = new TerminalScreen(20, 8);
    const input = new TerminalInput();
    let views = 0;
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }) });
    const run = ui.run({ init: () => ({ model: {} }), update: (model) => ({ model }), view: () => { views++; return GTUI.view.text({}, "resize target"); } });
    try {
      const before = views;
      output.columns = 16;
      output.emit("resize");
      expect(views).toBeGreaterThan(before);
    } finally { ui.stop(); await run; }
  });
}
