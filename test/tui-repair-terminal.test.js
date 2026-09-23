import { expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";
import { TerminalInput, TerminalScreen } from "./terminal-screen.js";
import { createApp } from "../lib/tui-app/app.js";
import { USER } from "./fakes.js";
const turn = () => new Promise((resolve) => setImmediate(resolve));

for (const mode of ["inline", "alt"]) {
  test(`${mode} physical screen retains the latest completed exchange above input`, async () => {
    const input = new TerminalInput();
    const output = new TerminalScreen();
    const agent = { context: [USER("USER VISIBLE"), { type: 3, content: [{ type: "text", text: "ASSISTANT VISIBLE" }] }], pending: [], model: "test/model", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {} };
    const app = createApp(agent, { sources: {} });
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
    const run = ui.run(app);
    try {
      input.emit("data", Buffer.from("draft"));
      await turn();
      expect(output.text()).toContain("USER VISIBLE");
      expect(output.text()).toContain("ASSISTANT VISIBLE");
      expect(output.text()).toContain("draft");
    } finally { ui.stop(); await run; }
  });
}

for (const mode of ["inline", "alt"]) {
  test(`${mode} raw terminal selection is visibly and semantically replaced`, async () => {
    const input = new TerminalInput();
    const output = new TerminalScreen(80, 12);
    const agent = { context: [], pending: [], model: "test/model", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {} };
    const app = createApp(agent, { sources: {} });
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
    const run = ui.run(app);
    try {
      input.emit("data", Buffer.from("draft")); await turn();
      input.emit("data", Buffer.from("\x1b[1;2D\x1b[1;2D")); await turn();
      input.emit("data", Buffer.from("X")); await turn();
      expect(output.text()).toContain("draX");
      expect(output.text()).not.toContain("draft");
    } finally { ui.stop(); await run; }
  });

  test(`${mode} raw terminal completion keys preview, cycle, and accept the highlighted value`, async () => {
    const input = new TerminalInput();
    const output = new TerminalScreen(80, 12);
    const agent = { context: [], pending: [], model: "test/model", setQuestion() {}, toolMessages: () => [], contextUsage: {}, usage: {} };
    const app = createApp(agent, { sources: { listDir: () => ["alpha", "alpine", "alps"] } });
    const ui = new GTUI({ host: GTUI.host.terminal({ input, output, mode }), theme: app.theme });
    const run = ui.run(app);
    try {
      input.emit("data", Buffer.from("al")); await turn();
      input.emit("data", Buffer.from("\t")); await turn();
      expect(output.text()).toContain("alpha");
      input.emit("data", Buffer.from("\t")); await turn();
      expect(output.text()).toContain("alpine");
      input.emit("data", Buffer.from("\x1b[Z")); await turn();
      expect(output.text()).toContain("alpha");
      input.emit("data", Buffer.from("\x1b[B")); await turn();
      expect(output.text()).toContain("alpine");
      input.emit("data", Buffer.from("\r")); await turn();
      expect(output.text()).toContain("alpine");
    } finally { ui.stop(); await run; }
  });
}

test("terminal oracle distinguishes evicted history from visible rows", () => {
  const output = new TerminalScreen(10, 3);
  output.write("old\ncurrent\nlast\n");
  expect(output.history).toEqual(["old"]);
  expect(output.text()).not.toContain("old");
  output.write("\x1b[2A\r\x1b[Jreplacement");
  expect(output.lines()).toEqual(["replacement".slice(0, 10), "t", ""]);
});
